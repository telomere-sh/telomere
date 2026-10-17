import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import { decryptCystChunk, encryptCystChunk } from './chunk-aead.js';
import { z } from 'zod';
import { serializeWrappedCystKey, unwrapCystRecoveryKey, wrappedCystKeySchema,
  type CystWrappingIdentity, type WrappedCystKey } from '../sdk/cyst-key-wrap.js';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema } from './types.js';

/** The on-chain CystRegistry cap applies to ciphertext, not source bytes. */
export const LARGE_CYST_MAX_PACKAGE_BYTES = 2_147_483_648;
export const LARGE_CYST_MAX_PLAINTEXT_BYTES = LARGE_CYST_MAX_PACKAGE_BYTES - 262_144;
export const LARGE_CYST_CHUNK_BYTES = 4 * 1024 * 1024;
export const LARGE_CYST_MAX_PART_BYTES = LARGE_CYST_CHUNK_BYTES + 40;
const MAX_PARTS = Math.ceil(LARGE_CYST_MAX_PLAINTEXT_BYTES / LARGE_CYST_CHUNK_BYTES);
const MAX_MANIFEST_BYTES = 131_072;
const MAX_HEADER_BYTES = 2048;
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const lockSchema = z.object({ version: z.literal(1), token: hex32,
  pid: z.number().int().positive().max(2 ** 31 - 1), platform: z.string().regex(/^[a-z0-9]{1,16}$/) }).strict();
const remoteTopologySchema = z.object({ version: z.literal(1), sha256: hex32 }).strict();
const remoteCommitSchema = z.object({ version: z.literal(1), sha256: hex32 }).strict();
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema }).strict();
const headerSchema = scopeSchema.extend({ version: z.literal(1),
  algorithm: z.literal('xchacha20-poly1305-chunked'), id: cystIdSchema,
  plaintextBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES),
  chunkBytes: z.literal(LARGE_CYST_CHUNK_BYTES), chunkCount: z.number().int().min(1).max(MAX_PARTS),
  sourceMac: hex32, keyCommitment: hex32 }).strict().refine(value =>
  value.chunkCount === Math.ceil(value.plaintextBytes / value.chunkBytes), 'Invalid chunk count');
const partSchema = z.object({ index: z.number().int().min(0).max(MAX_PARTS - 1),
  bytes: z.number().int().min(41).max(LARGE_CYST_CHUNK_BYTES + 40), sha256: hex32 }).strict();
const manifestCoreShape = z.object({ header: headerSchema,
  parts: z.array(partSchema).min(1).max(MAX_PARTS), wrappedKey: wrappedCystKeySchema.optional() }).strict();
function validateManifestParts(value: z.infer<typeof manifestCoreShape>, context: z.RefinementCtx): void {
  if (value.wrappedKey && (value.wrappedKey.owner !== value.header.owner
    || value.wrappedKey.agent !== value.header.agent || value.wrappedKey.checkpointId !== value.header.id)) {
    context.addIssue({ code: 'custom', message: 'Wrapped key scope differs from the checkpoint' });
  }
  if (value.parts.length !== value.header.chunkCount) context.addIssue({ code: 'custom', message: 'Missing parts' });
  let packageBytes = 0;
  for (let index = 0; index < value.parts.length; index++) {
    const part = value.parts[index]!;
    const plaintextBytes = Math.min(value.header.chunkBytes, value.header.plaintextBytes - index * value.header.chunkBytes);
    if (part.index !== index || part.bytes !== plaintextBytes + 40) {
      context.addIssue({ code: 'custom', message: 'Invalid part order or length' });
    }
    packageBytes += part.bytes;
  }
  if (packageBytes > LARGE_CYST_MAX_PACKAGE_BYTES) context.addIssue({ code: 'custom', message: 'Package exceeds registry cap' });
}
const manifestCoreSchema = manifestCoreShape.superRefine(validateManifestParts);
const manifestSchema = manifestCoreShape.extend({ mac: hex32 }).strict().superRefine(validateManifestParts);
export type LargeCystScope = z.infer<typeof scopeSchema>;
export type LargeCystHeader = z.infer<typeof headerSchema>;
export type LargeCystManifest = z.infer<typeof manifestSchema>;
export interface LargeCystStore {
  begin(header: LargeCystHeader): Promise<void>;
  header(id: string, signal?: AbortSignal): Promise<LargeCystHeader | undefined>;
  putPart(id: string, index: number, bytes: Uint8Array): Promise<void>;
  part(id: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined>;
  commit(manifest: LargeCystManifest): Promise<void>;
  manifest(id: string, signal?: AbortSignal): Promise<LargeCystManifest | undefined>;
}
export function parseLargeCystHeader(value: unknown): LargeCystHeader { return headerSchema.parse(value); }
export function parseLargeCystManifest(value: unknown): LargeCystManifest { return manifestSchema.parse(value); }
export function largeCystPartBytes(header: LargeCystHeader, index: number): number { return partBytes(headerSchema.parse(header), index); }

export class LargeCystError extends Error {
  constructor(readonly code: 'invalid_source' | 'invalid_key' | 'storage_unavailable' | 'conflict'
    | 'integrity_failed' | 'incomplete' | 'destination_exists' | 'quota_exceeded') {
    super(code); this.name = 'LargeCystError';
  }
}
const fail = (code: LargeCystError['code']) => new LargeCystError(code);
const noFollow = constants.O_NOFOLLOW ?? 0;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const exists = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST';
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hmac = (key: Uint8Array, domain: string, bytes: Uint8Array | string): string =>
  createHmac('sha256', key).update(domain).update(bytes).digest('hex');
const equalHex = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const keyCopy = (value: Uint8Array): Buffer => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw fail('invalid_key');
  return Buffer.from(value);
};
const canonical = (value: object): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
function privateEntry(info: BigIntStats, directory: boolean, maxBytes = Number.MAX_SAFE_INTEGER): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
    || (!directory && (info.size < 0n || info.size > BigInt(maxBytes)))
    || process.platform !== 'win32' && ((info.mode & 0o077n) !== 0n
      || (info.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)
      || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())))) {
    throw fail('storage_unavailable');
  }
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function privateDirectory(path: string): Promise<BigIntStats> {
  const absolute = resolve(path); const ancestors: string[] = [];
  for (let current = absolute; current !== parse(current).root; current = dirname(current)) ancestors.push(current);
  for (const ancestor of ancestors.reverse()) {
    const info = await lstat(ancestor, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('storage_unavailable');
  }
  const info = await lstat(absolute, { bigint: true }); privateEntry(info, true); return info;
}
async function readBounded(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let named: BigIntStats;
  try { named = await lstat(path, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw fail('storage_unavailable'); }
  privateEntry(named, false, maxBytes);
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | noFollow); } catch { throw fail('storage_unavailable'); }
  try {
    const opened = await file.stat({ bigint: true }); privateEntry(opened, false, maxBytes);
    if (!sameFile(named, opened)) throw fail('storage_unavailable');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw fail('integrity_failed'); offset += read.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw fail('integrity_failed');
    const after = await file.stat({ bigint: true }); const current = await lstat(path, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, current)) throw fail('storage_unavailable');
    return bytes;
  } finally { await file.close(); }
}

/** Inspect the immutable topology marker without acquiring the active writer lock.
 * A missing or changed marker cannot prove this controller's S3 binding.
 */
export async function inspectLargeCystRemoteTopology(directory: string, expectedSha256: string): Promise<boolean> {
  if (!hex32.safeParse(expectedSha256).success) throw fail('storage_unavailable');
  const absolute = resolve(directory);
  const before = await privateDirectory(absolute);
  const bytes = await readBounded(resolve(absolute, '.remote-topology.json'), 128);
  const after = await privateDirectory(absolute);
  if (before.dev !== after.dev || before.ino !== after.ino || !bytes) return false;
  return parseCanonical(bytes, remoteTopologySchema).sha256 === expectedSha256;
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = await open(path, constants.O_RDONLY | noFollow);
  try { await dir.sync(); } finally { await dir.close(); }
}
async function createImmutable(directory: string, filename: string, bytes: Uint8Array): Promise<boolean> {
  const temporary = resolve(directory, '.tmp-' + randomUUID());
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  let created = false;
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, resolve(directory, filename)); created = true; }
    catch (error) { if (!exists(error)) throw error; }
    await syncDirectory(directory);
  } finally { await unlink(temporary); await syncDirectory(directory); }
  return created;
}
function parseCanonical<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const value = schema.parse(parsed);
    if (!canonical(value as object).equals(bytes)) throw fail('integrity_failed');
    return value;
  } catch { throw fail('integrity_failed'); }
}
function partBytes(header: LargeCystHeader, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= header.chunkCount) throw fail('integrity_failed');
  return Math.min(header.chunkBytes, header.plaintextBytes - index * header.chunkBytes) + 40;
}
function partName(index: number): string { return 'part-' + index.toString().padStart(6, '0') + '.bin'; }

/** Immutable private multipart store. This object never receives a recovery key or plaintext. */
export class LargeCystPrivateStore implements LargeCystStore {
  readonly directory: string;
  private identity: BigIntStats | undefined;
  private lock: { token: string; identity: BigIntStats } | undefined;
  private globalUsed = 0;
  private totalCheckpoints = 0;
  private readonly ownerUsed = new Map<string, number>();
  private readonly ownerCheckpoints = new Map<string, number>();
  private gate = Promise.resolve();
  private poisoned = false;
  constructor(directory: string, private readonly limits: { globalMaxBytes: number; ownerMaxBytes: number }) {
    this.directory = resolve(directory);
    if (!Number.isSafeInteger(limits.globalMaxBytes) || !Number.isSafeInteger(limits.ownerMaxBytes)
      || limits.globalMaxBytes < LARGE_CYST_MAX_PART_BYTES || limits.globalMaxBytes > 1_099_511_627_776
      || limits.ownerMaxBytes < LARGE_CYST_MAX_PART_BYTES || limits.ownerMaxBytes > limits.globalMaxBytes) {
      throw fail('storage_unavailable');
    }
  }
  private get lockPath(): string { return resolve(this.directory, '.writer.lock'); }
  private async lockFile(): Promise<{ value: z.infer<typeof lockSchema>; identity: BigIntStats } | undefined> {
    const bytes = await readBounded(this.lockPath, 512);
    if (!bytes) return undefined;
    return { value: parseCanonical(bytes, lockSchema), identity: await lstat(this.lockPath, { bigint: true }) };
  }
  /** A second writer cannot initialize this directory. A crash-left lock must
   * be recovered explicitly, only after proving its PID is absent.
   */
  async recoverStaleLock(expectedToken: string): Promise<void> {
    if (this.lock || !hex32.safeParse(expectedToken).success) throw fail('storage_unavailable');
    await privateDirectory(this.directory);
    const saved = await this.lockFile();
    if (!saved || saved.value.token !== expectedToken || saved.value.platform !== process.platform) throw fail('storage_unavailable');
    try { process.kill(saved.value.pid, 0); throw fail('storage_unavailable'); }
    catch (error) {
      if (error instanceof LargeCystError || !(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw fail('storage_unavailable');
      }
    }
    const current = await this.lockFile();
    if (!current || current.value.token !== expectedToken || !sameFile(current.identity, saved.identity)) throw fail('storage_unavailable');
    await unlink(this.lockPath); await syncDirectory(this.directory);
  }
  async lockStatus(): Promise<{ token: string; pid: number; platform: string } | undefined> {
    await privateDirectory(this.directory);
    const saved = await this.lockFile();
    return saved ? { ...saved.value, token: saved.value.token } : undefined;
  }
  private async acquireWriter(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    let file: FileHandle;
    try { file = await open(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
    catch { throw fail('storage_unavailable'); }
    try {
      await file.writeFile(canonical(lockSchema.parse({ version: 1, token, pid: process.pid, platform: process.platform })));
      await file.sync();
    } catch (error) {
      await file.close(); await unlink(this.lockPath); throw error;
    }
    await file.close(); await syncDirectory(this.directory);
    const saved = await this.lockFile();
    if (!saved || saved.value.token !== token) throw fail('storage_unavailable');
    this.lock = { token, identity: saved.identity };
  }
  async close(): Promise<void> {
    await this.gate;
    if (!this.lock) return;
    const saved = await this.lockFile();
    if (!saved || saved.value.token !== this.lock.token || !sameFile(saved.identity, this.lock.identity)) throw fail('storage_unavailable');
    await unlink(this.lockPath); await syncDirectory(this.directory);
    this.lock = undefined; this.identity = undefined;
  }
  async initialize(): Promise<void> {
    if (this.lock) throw fail('storage_unavailable');
    this.identity = await privateDirectory(this.directory);
    await this.acquireWriter();
    try {
    this.globalUsed = 0; this.totalCheckpoints = 0; this.ownerUsed.clear(); this.ownerCheckpoints.clear();
    for (const name of await readdir(this.directory)) {
      if (name === '.writer.lock') continue;
      if (name === '.remote-topology.json') {
        const bytes = await readBounded(resolve(this.directory, name), 128);
        if (!bytes) throw fail('storage_unavailable');
        parseCanonical(bytes, remoteTopologySchema);
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(name)) throw fail('storage_unavailable');
      const directory = resolve(this.directory, name);
      privateEntry(await lstat(directory, { bigint: true }), true);
      const entries = await readdir(directory);
      if (entries.length === 0) { await rmdir(directory); continue; }
      if (entries.includes('remote-intent.json') && entries.includes('remote-commit.json')) throw fail('storage_unavailable');
      const headerBytes = await readBounded(resolve(directory, 'header.json'), MAX_HEADER_BYTES);
      if (!headerBytes) throw fail('storage_unavailable');
      const header = parseCanonical(headerBytes, headerSchema);
      if (header.id.slice(2) !== name) throw fail('storage_unavailable');
      let used = 0;
      for (const entry of entries) {
        if (entry !== 'header.json' && entry !== 'manifest.json'
          && entry !== 'remote-intent.json' && entry !== 'remote-commit.json'
          && !/^part-[0-9]{6}\.bin$/.test(entry)
          && !/^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry)) {
          throw fail('storage_unavailable');
        }
        const info = await lstat(resolve(directory, entry), { bigint: true });
        privateEntry(info, false, entry === 'manifest.json' ? MAX_MANIFEST_BYTES : entry === 'header.json' ? MAX_HEADER_BYTES
          : entry === 'remote-intent.json' || entry === 'remote-commit.json' ? 128 : LARGE_CYST_MAX_PART_BYTES);
        if (entry === 'remote-intent.json' || entry === 'remote-commit.json') {
          const proofBytes = await readBounded(resolve(directory, entry), 128);
          const manifestBytes = await readBounded(resolve(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
          if (!proofBytes || !manifestBytes
            || parseCanonical(proofBytes, remoteCommitSchema).sha256 !== digest(manifestBytes)) throw fail('integrity_failed');
        }
        used += Number(info.size);
      }
      this.globalUsed += used; this.totalCheckpoints++;
      this.ownerUsed.set(header.owner, (this.ownerUsed.get(header.owner) ?? 0) + used);
      this.ownerCheckpoints.set(header.owner, (this.ownerCheckpoints.get(header.owner) ?? 0) + 1);
      if (this.globalUsed > this.limits.globalMaxBytes || this.totalCheckpoints > 4096
        || this.ownerUsed.get(header.owner)! > this.limits.ownerMaxBytes || this.ownerCheckpoints.get(header.owner)! > 32) {
        throw fail('quota_exceeded');
      }
    }
    this.poisoned = false;
    } catch (error) { await this.close(); throw error; }
  }
  /** Pins the remote storage identity before serving traffic. A legacy local
   * directory with checkpoints needs an explicit offline migration.
   */
  async remoteTopologyState(sha256: string): Promise<'new' | 'bound'> {
    await this.root();
    if (!hex32.safeParse(sha256).success) throw fail('storage_unavailable');
    const saved = await readBounded(resolve(this.directory, '.remote-topology.json'), 128);
    if (saved) {
      if (parseCanonical(saved, remoteTopologySchema).sha256 !== sha256) throw fail('storage_unavailable');
      return 'bound';
    }
    const entries = await readdir(this.directory);
    if (entries.some(name => name !== '.writer.lock')) throw fail('storage_unavailable');
    return 'new';
  }
  async assertRemoteTopology(sha256?: string): Promise<void> {
    await this.root();
    const path = resolve(this.directory, '.remote-topology.json');
    if (sha256 === undefined) {
      if (await readBounded(path, 128)) throw fail('storage_unavailable');
      return;
    }
    if (await this.remoteTopologyState(sha256) === 'bound') return;
    const bytes = canonical(remoteTopologySchema.parse({ version: 1, sha256 }));
    await createImmutable(this.directory, '.remote-topology.json', bytes);
    const confirmed = await readBounded(path, 128);
    if (!confirmed?.equals(bytes)) throw fail('storage_unavailable');
  }
  /** Persist the marker's exact quota before publishing either remote manifest.
   * The intent survives a crash between remote commit and local seal.
   */
  async reserveRemoteCommit(id: string): Promise<void> {
    const manifest = await this.manifest(id);
    if (!manifest) throw fail('incomplete');
    const bytes = canonical(remoteCommitSchema.parse({ version: 1, sha256: digest(canonical(manifest)) }));
    await this.exclusive(async () => {
      const directory = (await this.checkpoint(id))!;
      const existing = await readBounded(resolve(directory, 'remote-commit.json'), 128);
      if (existing) { if (!existing.equals(bytes)) throw fail('conflict'); return; }
      const intentPath = resolve(directory, 'remote-intent.json');
      const intent = await readBounded(intentPath, 128);
      if (intent) { if (!intent.equals(bytes)) throw fail('conflict'); return; }
      this.reserve(manifest.header.owner, bytes.length, false);
      try {
        await createImmutable(directory, 'remote-intent.json', bytes);
        const saved = await readBounded(intentPath, 128);
        if (!saved?.equals(bytes)) throw fail('conflict');
      } catch (error) { this.poisoned = true; throw error; }
    });
  }
  /** Written only after both immutable remote copies have been read back and
   * audited. This small local marker permits degraded restore after restart.
   */
  async sealRemoteCommit(id: string): Promise<void> {
    const manifest = await this.manifest(id);
    if (!manifest) throw fail('incomplete');
    const bytes = canonical(remoteCommitSchema.parse({ version: 1, sha256: digest(canonical(manifest)) }));
    await this.exclusive(async () => {
      const directory = (await this.checkpoint(id))!;
      const path = resolve(directory, 'remote-commit.json');
      const existing = await readBounded(path, 128);
      if (existing) { if (!existing.equals(bytes)) throw fail('conflict'); return; }
      const intentPath = resolve(directory, 'remote-intent.json');
      const intent = await readBounded(intentPath, 128);
      if (!intent?.equals(bytes)) throw fail('storage_unavailable');
      try {
        await rename(intentPath, path);
        await syncDirectory(directory);
        const saved = await readBounded(path, 128);
        if (!saved?.equals(bytes)) throw fail('conflict');
      } catch (error) { this.poisoned = true; throw error; }
    });
  }
  async hasRemoteCommit(id: string): Promise<boolean> {
    const manifest = await this.manifest(id);
    if (!manifest) return false;
    const directory = (await this.checkpoint(id))!;
    const bytes = await readBounded(resolve(directory, 'remote-commit.json'), 128);
    if (!bytes) return false;
    if (parseCanonical(bytes, remoteCommitSchema).sha256 !== digest(canonical(manifest))) throw fail('integrity_failed');
    return true;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.gate; let release!: () => void;
    this.gate = new Promise<void>(done => { release = done; });
    await previous;
    try { if (this.poisoned) throw fail('storage_unavailable'); return await action(); }
    finally { release(); }
  }
  private reserve(owner: string, bytes: number, checkpoint: boolean): void {
    if (this.globalUsed + bytes > this.limits.globalMaxBytes || (this.ownerUsed.get(owner) ?? 0) + bytes > this.limits.ownerMaxBytes
      || checkpoint && (this.totalCheckpoints >= 4096 || (this.ownerCheckpoints.get(owner) ?? 0) >= 32)) throw fail('quota_exceeded');
    this.globalUsed += bytes;
    this.ownerUsed.set(owner, (this.ownerUsed.get(owner) ?? 0) + bytes);
    if (checkpoint) {
      this.totalCheckpoints++;
      this.ownerCheckpoints.set(owner, (this.ownerCheckpoints.get(owner) ?? 0) + 1);
    }
  }
  private async root(): Promise<void> {
    if (!this.identity || !this.lock) throw fail('storage_unavailable');
    const current = await privateDirectory(this.directory);
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw fail('storage_unavailable');
    const lock = await this.lockFile();
    if (!lock || lock.value.token !== this.lock.token || !sameFile(lock.identity, this.lock.identity)) throw fail('storage_unavailable');
  }
  private async checkpoint(id: string, create = false): Promise<string | undefined> {
    cystIdSchema.parse(id); await this.root(); const directory = resolve(this.directory, id.slice(2));
    if (create) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!exists(error)) throw fail('storage_unavailable'); } }
    let info: BigIntStats;
    try { info = await lstat(directory, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw fail('storage_unavailable'); }
    privateEntry(info, true); await this.root(); return directory;
  }
  async begin(input: LargeCystHeader): Promise<void> {
    const header = headerSchema.parse(input), bytes = canonical(header);
    if (bytes.length > MAX_HEADER_BYTES) throw fail('integrity_failed');
    await this.exclusive(async () => {
      const existing = await this.checkpoint(header.id);
      if (!existing) this.reserve(header.owner, bytes.length, true);
      try {
        const directory = existing ?? (await this.checkpoint(header.id, true))!;
        await createImmutable(directory, 'header.json', bytes);
        const saved = await readBounded(resolve(directory, 'header.json'), MAX_HEADER_BYTES);
        if (!saved?.equals(bytes)) throw fail('conflict');
      } catch (error) { if (!existing) this.poisoned = true; throw error; }
    });
  }
  async header(id: string): Promise<LargeCystHeader | undefined> {
    const directory = await this.checkpoint(id); if (!directory) return undefined;
    const bytes = await readBounded(resolve(directory, 'header.json'), MAX_HEADER_BYTES);
    return bytes === undefined ? undefined : parseCanonical(bytes, headerSchema);
  }
  async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
    const header = await this.header(id); if (!header) throw fail('incomplete');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== partBytes(header, index)) throw fail('integrity_failed');
    await this.exclusive(async () => {
      const directory = (await this.checkpoint(id))!;
      const path = resolve(directory, partName(index));
      const previous = await readBounded(path, partBytes(header, index));
      if (previous) {
        if (previous.length !== bytes.byteLength || !timingSafeEqual(previous, bytes)) throw fail('conflict');
        return;
      }
      this.reserve(header.owner, bytes.byteLength, false);
      try {
        await createImmutable(directory, partName(index), bytes);
        const saved = await readBounded(path, partBytes(header, index));
        if (!saved || saved.length !== bytes.byteLength || !timingSafeEqual(saved, bytes)) throw fail('conflict');
      } catch (error) { this.poisoned = true; throw error; }
    });
  }
  async part(id: string, index: number): Promise<Buffer | undefined> {
    const header = await this.header(id); if (!header) throw fail('incomplete');
    const directory = (await this.checkpoint(id))!;
    const bytes = await readBounded(resolve(directory, partName(index)), partBytes(header, index));
    if (bytes && bytes.length !== partBytes(header, index)) throw fail('integrity_failed');
    return bytes;
  }
  async commit(value: LargeCystManifest): Promise<void> {
    const manifest = manifestSchema.parse(value); const header = await this.header(manifest.header.id);
    if (!header || JSON.stringify(header) !== JSON.stringify(manifest.header)) throw fail('conflict');
    const bytes = canonical(manifest);
    if (bytes.length > MAX_MANIFEST_BYTES || manifest.parts.reduce((sum, part) => sum + part.bytes,
      bytes.length + canonical(header).length) > LARGE_CYST_MAX_PACKAGE_BYTES) {
      throw fail('integrity_failed');
    }
    for (const part of manifest.parts) {
      const actual = await this.part(header.id, part.index);
      if (!actual || actual.length !== part.bytes || digest(actual) !== part.sha256) throw fail('integrity_failed');
    }
    await this.exclusive(async () => {
      const directory = (await this.checkpoint(header.id))!;
      const path = resolve(directory, 'manifest.json');
      const previous = await readBounded(path, MAX_MANIFEST_BYTES);
      if (previous) { if (!previous.equals(bytes)) throw fail('conflict'); return; }
      this.reserve(header.owner, bytes.length, false);
      try {
        await createImmutable(directory, 'manifest.json', bytes);
        const saved = await readBounded(path, MAX_MANIFEST_BYTES);
        if (!saved?.equals(bytes)) throw fail('conflict');
      } catch (error) { this.poisoned = true; throw error; }
    });
  }
  async manifest(id: string): Promise<LargeCystManifest | undefined> {
    const directory = await this.checkpoint(id); if (!directory) return undefined;
    const bytes = await readBounded(resolve(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
    if (!bytes) return undefined;
    const value = parseCanonical(bytes, manifestSchema);
    if (value.header.id !== id || value.parts.reduce((sum, part) => sum + part.bytes,
      bytes.length + canonical(value.header).length) > LARGE_CYST_MAX_PACKAGE_BYTES) {
      throw fail('integrity_failed');
    }
    return value;
  }
}

function sourceHmac(key: Uint8Array, id: string) { return createHmac('sha256', key).update('telomere.large-cyst.source.v1\0').update(id).update('\0'); }
function manifestMac(key: Uint8Array, value: z.infer<typeof manifestCoreSchema>): string {
  return hmac(key, 'telomere.large-cyst.manifest.v1\0', canonical(value));
}
/** Agent-side check of the owner-keyed manifest before accepting unsigned calldata.
 * The caller retains and clears its own recovery-key copy.
 */
export function verifyLargeCystManifestKey(value: unknown, recoveryKey: Uint8Array,
  scope: { id: string; owner: string; agent: string }): LargeCystManifest {
  const key = keyCopy(recoveryKey);
  try {
    const manifest = parseLargeCystManifest(value);
    const id = cystIdSchema.parse(scope.id), owner = cystAddressSchema.parse(scope.owner), agent = cystAddressSchema.parse(scope.agent);
    if (manifest.header.id !== id || manifest.header.owner !== owner || manifest.header.agent !== agent
      || !equalHex(manifest.header.keyCommitment, hmac(key, 'telomere.large-cyst.key.v1\0', id))) {
      throw fail('integrity_failed');
    }
    const core = manifestCoreSchema.parse({ header: manifest.header, parts: manifest.parts,
      ...(manifest.wrappedKey ? { wrappedKey: manifest.wrappedKey } : {}) });
    if (!equalHex(manifest.mac, manifestMac(key, core))) throw fail('integrity_failed');
    return manifest;
  } finally { key.fill(0); }
}
function associatedData(header: LargeCystHeader, index: number): Buffer {
  return canonical(['telomere.large-cyst.part.v1', header, index, partBytes(header, index) - 40]);
}
function decryptPart(header: LargeCystHeader, index: number, bytes: Buffer, key: Uint8Array): Uint8Array {
  if (bytes.length !== partBytes(header, index)) throw fail('integrity_failed');
  try { return decryptCystChunk(key, bytes.subarray(0, 24), associatedData(header, index), bytes.subarray(24)); }
  catch { throw fail('integrity_failed'); }
}
async function readSegment(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length); let read = 0;
  while (read < length) {
    const result = await file.read(bytes, read, length - read, offset + read);
    if (result.bytesRead === 0) throw fail('invalid_source'); read += result.bytesRead;
  }
  return bytes;
}
function sourceStat(info: BigIntStats): number {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n
    || info.size > BigInt(LARGE_CYST_MAX_PLAINTEXT_BYTES)) throw fail('invalid_source');
  return Number(info.size);
}
async function openSource(path: string): Promise<{ file: FileHandle; info: BigIntStats; bytes: number }> {
  let named: BigIntStats;
  try { named = await lstat(path, { bigint: true }); } catch { throw fail('invalid_source'); }
  const bytes = sourceStat(named);
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | noFollow); } catch { throw fail('invalid_source'); }
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameFile(named, opened) || sourceStat(opened) !== bytes) throw fail('invalid_source');
    return { file, info: opened, bytes };
  } catch (error) { await file.close(); throw error; }
}
function assertSourceStable(previous: BigIntStats, current: BigIntStats): void {
  if (!sameFile(previous, current)) throw fail('invalid_source');
}
export function generateLargeCystId(): string { return '0x' + randomBytes(32).toString('hex'); }

/** The caller durably saves id and recoveryKey first, and quiesces the source file. */
export async function saveLargeCystFile(options: { store: LargeCystStore; sourcePath: string;
  id: string; scope: LargeCystScope; recoveryKey: Uint8Array;
  wrappedKey?: { bundle: WrappedCystKey; ownerIdentity: CystWrappingIdentity; agentPublicKey: string };
  onProgress?: (completedParts: number, totalParts: number) => void | Promise<void> }): Promise<LargeCystManifest> {
  const id = cystIdSchema.parse(options.id), scope = scopeSchema.parse(options.scope), key = keyCopy(options.recoveryKey);
  let wrappedKey: WrappedCystKey | undefined;
  let source: Awaited<ReturnType<typeof openSource>>;
  try {
    if (options.wrappedKey) {
      // The caller must durably retain this exact random bundle before upload,
      // so a retry cannot silently change the immutable manifest commitment.
      wrappedKey = wrappedCystKeySchema.parse(options.wrappedKey.bundle);
      serializeWrappedCystKey(wrappedKey);
      const agentWrapping = wrappedKey.wrappings.find(item => item.recipient === 'agent');
      if (!agentWrapping || agentWrapping.recipientPublicKey !== options.wrappedKey.agentPublicKey
        || wrappedKey.owner !== scope.owner || wrappedKey.agent !== scope.agent || wrappedKey.checkpointId !== id) {
        throw fail('invalid_key');
      }
      const unwrapped = await unwrapCystRecoveryKey(wrappedKey,
        { owner: scope.owner, agent: scope.agent, checkpointId: id }, 'owner', options.wrappedKey.ownerIdentity);
      try { if (!timingSafeEqual(unwrapped, key)) throw fail('invalid_key'); }
      finally { unwrapped.fill(0); }
    }
    source = await openSource(options.sourcePath);
  } catch (error) { key.fill(0); throw error; }
  try {
    const chunkCount = Math.ceil(source.bytes / LARGE_CYST_CHUNK_BYTES);
    const mac = sourceHmac(key, id);
    for (let index = 0; index < chunkCount; index++) {
      const offset = index * LARGE_CYST_CHUNK_BYTES;
      const plaintext = await readSegment(source.file, offset, Math.min(LARGE_CYST_CHUNK_BYTES, source.bytes - offset));
      try { mac.update(plaintext); } finally { plaintext.fill(0); }
    }
    assertSourceStable(source.info, await source.file.stat({ bigint: true }));
    const header = headerSchema.parse({ ...scope, version: 1, algorithm: 'xchacha20-poly1305-chunked', id,
      plaintextBytes: source.bytes, chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount,
      sourceMac: mac.digest('hex'), keyCommitment: hmac(key, 'telomere.large-cyst.key.v1\0', id) });
    await options.store.begin(header);
    const parts: z.infer<typeof partSchema>[] = []; const verifiedSource = sourceHmac(key, id);
    for (let index = 0; index < chunkCount; index++) {
      const offset = index * LARGE_CYST_CHUNK_BYTES;
      const plaintext = await readSegment(source.file, offset, Math.min(LARGE_CYST_CHUNK_BYTES, source.bytes - offset));
      try {
        verifiedSource.update(plaintext);
        let stored = await options.store.part(id, index);
        if (!stored) {
          const nonce = randomBytes(24);
          const ciphertext = encryptCystChunk(key, nonce, associatedData(header, index), plaintext);
          const candidate = Buffer.concat([nonce, ciphertext]);
          try { await options.store.putPart(id, index, candidate); } finally { candidate.fill(0); }
          stored = await options.store.part(id, index);
        }
        if (!stored) throw fail('incomplete');
        const recovered = decryptPart(header, index, stored, key);
        try {
          if (recovered.length !== plaintext.length || !timingSafeEqual(recovered, plaintext)) throw fail('integrity_failed');
        } finally { recovered.fill(0); }
        parts.push({ index, bytes: stored.length, sha256: digest(stored) });
        await options.onProgress?.(index + 1, chunkCount);
      } finally { plaintext.fill(0); }
    }
    assertSourceStable(source.info, await source.file.stat({ bigint: true }));
    if (!equalHex(verifiedSource.digest('hex'), header.sourceMac)) throw fail('invalid_source');
    const core = manifestCoreSchema.parse({ header, parts, ...(wrappedKey ? { wrappedKey } : {}) });
    const manifest = manifestSchema.parse({ ...core, mac: manifestMac(key, core) });
    await options.store.commit(manifest);
    return manifest;
  } finally { key.fill(0); await source.file.close(); }
}

/** Restores only after every chunk and the whole-source MAC validate. A failed
 * restore removes its temporary plaintext and never publishes a destination. */
export async function restoreLargeCystFile(options: { store: Pick<LargeCystStore, 'header' | 'part' | 'manifest'>; id: string;
  destinationPath: string; scope: LargeCystScope; recoveryKey: Uint8Array;
  beforePublish?: () => Promise<void> }): Promise<void> {
  const id = cystIdSchema.parse(options.id), scope = scopeSchema.parse(options.scope), key = keyCopy(options.recoveryKey);
  let temporary: string | undefined;
  try {
    const manifest = await options.store.manifest(id); if (!manifest) throw fail('incomplete');
    const { header } = manifest;
    const storedHeader = await options.store.header(id);
    if (!storedHeader || JSON.stringify(storedHeader) !== JSON.stringify(header)) throw fail('integrity_failed');
    if (header.owner !== scope.owner || header.agent !== scope.agent || header.applicationSchema !== scope.applicationSchema
      || !equalHex(header.keyCommitment, hmac(key, 'telomere.large-cyst.key.v1\0', id))) throw fail('integrity_failed');
    const core = manifestCoreSchema.parse({ header, parts: manifest.parts,
      ...(manifest.wrappedKey ? { wrappedKey: manifest.wrappedKey } : {}) });
    if (!equalHex(manifest.mac, manifestMac(key, core))) throw fail('integrity_failed');
    const destination = resolve(options.destinationPath), parent = dirname(destination);
    if (basename(destination).startsWith('.cyst-restore-')) throw fail('storage_unavailable');
    await privateDirectory(parent);
    try { await lstat(destination); throw fail('destination_exists'); }
    catch (error) { if (!missing(error)) throw error; }
    temporary = resolve(parent, '.cyst-restore-' + randomUUID());
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      const mac = sourceHmac(key, id); let written = 0;
      for (const part of manifest.parts) {
        const bytes = await options.store.part(id, part.index);
        if (!bytes || bytes.length !== part.bytes || digest(bytes) !== part.sha256) throw fail('integrity_failed');
        const plaintext = decryptPart(header, part.index, bytes, key);
        try {
          mac.update(plaintext); await output.writeFile(plaintext); written += plaintext.length;
        } finally { plaintext.fill(0); }
      }
      if (written !== header.plaintextBytes || !equalHex(mac.digest('hex'), header.sourceMac)) throw fail('integrity_failed');
      await output.sync();
    } finally { await output.close(); }
    await options.beforePublish?.();
    await privateDirectory(parent);
    try { await link(temporary, destination); } catch (error) { if (exists(error)) throw fail('destination_exists'); throw error; }
    await syncDirectory(parent); await unlink(temporary); temporary = undefined; await syncDirectory(parent);
  } finally {
    key.fill(0);
    if (temporary) { try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; } }
  }
}

/** Restore through the immutable manifest's wrapped recovery key. An agent can
 * pass its own read-only store and X25519 identity without an owner session.
 */
export async function restoreLargeCystFileWithWrappedKey(options: {
  store: Pick<LargeCystStore, 'header' | 'part' | 'manifest'>; id: string;
  destinationPath: string; scope: LargeCystScope; recipient: 'owner' | 'agent';
  identity: CystWrappingIdentity; beforePublish?: () => Promise<void>;
}): Promise<void> {
  const id = cystIdSchema.parse(options.id), scope = scopeSchema.parse(options.scope);
  const manifest = await options.store.manifest(id);
  if (!manifest?.wrappedKey) throw fail('invalid_key');
  const key = await unwrapCystRecoveryKey(manifest.wrappedKey,
    { owner: scope.owner, agent: scope.agent, checkpointId: id }, options.recipient, options.identity);
  try {
    verifyLargeCystManifestKey(manifest, key, { id, owner: scope.owner, agent: scope.agent });
    await restoreLargeCystFile({ store: options.store, id, destinationPath: options.destinationPath,
      scope, recoveryKey: key, ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}) });
  } finally { key.fill(0); }
}
