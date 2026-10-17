import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rmdir, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { canonical, Problem } from '../../common.js';
import { verifyDuplicateCystInput } from './cyst-input-stream.js';
import { cystInputBindingSchema, cystInputDescriptorHash, cystInputMaxBytesSchema,
  CYST_INPUT_STREAM_CHUNK_BYTES, type CystInputBinding } from './cyst-input-protocol.js';

const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const missing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';
const failure = () => new Problem(503, 'cyst_input_storage', 'The private paid input spool is unavailable.');
const idSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const identitySchema = z.object({ dev: z.string(), ino: z.string(), size: z.string(),
  mtimeNs: z.string(), ctimeNs: z.string() }).strict();
const recordSchema = z.object({ version: z.literal(1), binding: cystInputBindingSchema,
  specHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const statusSchema = z.object({ version: z.literal(1), state: z.enum(['waiting', 'staged', 'ready', 'cleaned']),
  committed: z.boolean(), file: identitySchema.optional() }).strict();
type Status = z.infer<typeof statusSchema>;
type Entry = { record: z.infer<typeof recordSchema>; status: Status; deadline: number;
  cleaning?: boolean;
  flight?: { abort: AbortController; done: Promise<void> } };
const policySchema = z.object({ maxInputBytes: cystInputMaxBytesSchema,
  globalBytes: z.number().int().min(1).safe(), maxOperations: z.number().int().min(1).max(256),
  minimumFreeBytes: z.number().int().min(0).safe() }).strict()
  .refine(p => p.globalBytes >= p.maxInputBytes);
export const paidCystInputSpoolConfigSchema = z.object({ directory: z.string().min(1).refine(isAbsolute),
  maxInputBytes: cystInputMaxBytesSchema, globalBytes: z.number().int().min(1).safe(),
  maxOperations: z.number().int().min(1).max(256), minimumFreeBytes: z.number().int().min(0).safe() }).strict()
  .refine(p => p.globalBytes >= p.maxInputBytes);
export type PaidCystInputSpoolConfig = z.infer<typeof paidCystInputSpoolConfigSchema>;
/** Pure/read-only operator scope calculation; never opens or scans plaintext. */
export function paidCystInputSpoolIdentity(raw: PaidCystInputSpoolConfig): string {
  const { directory, ...policy } = paidCystInputSpoolConfigSchema.parse(raw);
  return createHash('sha256').update(canonical(['telomere-paid-cyst-spool-v1', resolve(directory), policy])).digest('hex');
}
const lockSchema = z.object({ version: z.literal(1), pid: z.number().int().positive().safe(), token: z.string().uuid() }).strict();
const fileIdentity = (s: BigIntStats) => ({ dev: s.dev.toString(), ino: s.ino.toString(), size: s.size.toString(),
  mtimeNs: s.mtimeNs.toString(), ctimeNs: s.ctimeNs.toString() });
function regular(s: BigIntStats, readonly = false) {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || process.platform !== 'win32'
    && ((s.mode & 0o777n) !== (readonly ? 0o444n : 0o600n)
      || typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid()))) throw failure();
}
async function directory(path: string, ready = false): Promise<BigIntStats> {
  const absolute = resolve(path), ancestors: string[] = [];
  for (let p = absolute; p !== parse(p).root; p = dirname(p)) ancestors.push(p);
  for (const p of ancestors.reverse()) { const s = await lstat(p, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw failure(); }
  const s = await lstat(absolute, { bigint: true });
  if (process.platform !== 'win32' && ((s.mode & 0o777n) !== (ready ? 0o755n : 0o700n)
    || typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid()))) throw failure();
  return s;
}
async function sync(path: string) {
  if (process.platform === 'win32') return;
  const d = await open(path, constants.O_RDONLY | noFollow); try { await d.sync(); } finally { await d.close(); }
}
async function cancelBounded(input: { cancel(): Promise<unknown> }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([input.cancel().catch(() => undefined), new Promise<void>(done => { timer = setTimeout(done, 1000); })]); }
  finally { clearTimeout(timer); }
}
async function boundedJson<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.output<T>> {
  const before = await lstat(path, { bigint: true }); regular(before);
  if (before.size < 1n || before.size > 16_384n) throw failure();
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await file.stat({ bigint: true }); regular(stat);
    if (canonical(fileIdentity(before)) !== canonical(fileIdentity(stat))) throw failure();
    const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw failure(); offset += read.bytesRead; }
    const value = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (canonical(value) !== bytes.toString('utf8')
      || canonical(fileIdentity(await file.stat({ bigint: true }))) !== canonical(fileIdentity(stat))
      || canonical(fileIdentity(await lstat(path, { bigint: true }))) !== canonical(fileIdentity(stat))) throw failure();
    return value;
  } finally { await file.close(); }
}
async function atomicJson(path: string, value: unknown, immutable = false) {
  const bytes = Buffer.from(canonical(value)); if (bytes.length > 16_384) throw failure();
  const parent = dirname(path), temporary = join(parent, '.metadata-' + randomUUID());
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (immutable) await link(temporary, path); else await rename(temporary, path);
    await sync(parent);
  } finally { await unlink(temporary).catch(e => { if (!missing(e)) throw e; }); }
}

/** Private, finite plaintext transport scratch for one explicitly declared file.
 * Recovery cleanup is called only after the backend proves its container absent.
 * The ready directory is mounted read-only; its incoming file is never mounted.
 */
export class PaidCystInputSpool {
  readonly directory: string;
  readonly identity: string;
  readonly maxInputBytes: number;
  private readonly entries = new Map<string, Entry>();
  private gate: Promise<unknown> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private constructor(root: string, private readonly policy: z.infer<typeof policySchema>,
    private readonly rootIdentity: Pick<BigIntStats, 'dev' | 'ino'>, private readonly lock: FileHandle) {
    this.directory = root; this.maxInputBytes = policy.maxInputBytes;
    this.identity = paidCystInputSpoolIdentity({ directory: root, ...policy });
  }
  static async open(options: PaidCystInputSpoolConfig): Promise<PaidCystInputSpool> {
    if (!isAbsolute(options.directory)) throw failure();
    const root = resolve(options.directory), policy = policySchema.parse({ maxInputBytes: options.maxInputBytes,
      globalBytes: options.globalBytes, maxOperations: options.maxOperations, minimumFreeBytes: options.minimumFreeBytes });
    try { await mkdir(root, { mode: 0o700 }); } catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e; }
    const stat = await directory(root), lockPath = join(root, '.writer-lock');
    const acquire = () => open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    let lock: FileHandle;
    try { lock = await acquire(); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const before = await lstat(lockPath, { bigint: true }), saved = await boundedJson(lockPath, lockSchema);
      let dead = false;
      try { process.kill(saved.pid, 0); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') dead = true; }
      if (!dead || canonical(fileIdentity(before)) !== canonical(fileIdentity(await lstat(lockPath, { bigint: true })))) throw failure();
      await unlink(lockPath); lock = await acquire();
    }
    const spool = new PaidCystInputSpool(root, policy, stat, lock);
    try {
      await lock.writeFile(canonical({ version: 1, pid: process.pid, token: randomUUID() })); await lock.sync(); await sync(root);
      const marker = join(root, '.policy.json');
      try { const saved = await boundedJson(marker, policySchema);
        if (canonical(saved) !== canonical(policy)) throw failure(); }
      catch (e) { if (!missing(e)) throw e; await atomicJson(marker, policy, true); }
      const names = await readdir(root);
      if (names.length > policy.maxOperations + 2) throw failure();
      for (const name of names) {
        if (name === '.writer-lock' || name === '.policy.json') continue;
        if (!/^run-[a-f0-9]{64}$/.test(name)) throw failure();
        const path = join(root, name); await directory(path);
        const record = await boundedJson(join(path, 'binding.json'), recordSchema);
        if (name !== 'run-' + record.binding.runId.slice(2)) throw failure();
        const status = await boundedJson(join(path, 'status.json'), statusSchema);
        spool.entries.set(record.binding.runId, { record, status, deadline: 0 });
        await spool.auditEntry(record.binding.runId);
      }
      if (spool.reserved() > policy.globalBytes) throw failure();
      return spool;
    } catch (e) { await lock.close(); await unlink(lockPath); throw e; }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.gate.then(work); this.gate = result.catch(() => undefined); return result;
  }
  private async root() {
    if (this.closed || this.poisoned) throw failure();
    const stat = await directory(this.directory);
    if (stat.dev !== this.rootIdentity.dev || stat.ino !== this.rootIdentity.ino) throw failure();
    const named = await lstat(join(this.directory, '.writer-lock'), { bigint: true }), held = await this.lock.stat({ bigint: true });
    regular(named); if (named.dev !== held.dev || named.ino !== held.ino) throw failure();
    if (canonical(await boundedJson(join(this.directory, '.policy.json'), policySchema)) !== canonical(this.policy)) throw failure();
  }
  private path(runId: string) { return join(this.directory, 'run-' + idSchema.parse(runId).slice(2)); }
  private entry(runId: string): Entry { const e = this.entries.get(idSchema.parse(runId)); if (!e) throw failure(); return e; }
  private reserved() { return [...this.entries.values()].reduce((sum, e) =>
    sum + (e.status.state === 'cleaned' ? 0 : e.record.binding.descriptor.plaintextBytes), 0); }
  private async auditEntry(runId: string) {
    await this.root(); const path = this.path(runId); await directory(path);
    const entry = this.entry(runId);
    if (canonical(await boundedJson(join(path, 'binding.json'), recordSchema)) !== canonical(entry.record)
      || canonical(await boundedJson(join(path, 'status.json'), statusSchema)) !== canonical(entry.status)) throw failure();
    const names = await readdir(path);
    if (names.some(n => !['binding.json', 'status.json', 'incoming.bin', 'ready'].includes(n))) throw failure();
    if (names.includes('ready')) { await directory(join(path, 'ready'), true);
      const ready = await readdir(join(path, 'ready')); if (ready.some(n => n !== 'state.bin')) throw failure(); }
  }
  private checked(binding: CystInputBinding): Entry {
    const e = this.entry(binding.runId);
    if (canonical(e.record.binding) !== canonical(cystInputBindingSchema.parse(binding))) throw new Problem(409,
      'cyst_input_conflict', 'The paid file operation is already bound to another input.');
    return e;
  }
  private live(e: Entry, assertActive: () => void) {
    assertActive();
    if (this.closed || this.poisoned || e.cleaning || e.deadline <= performance.now() || Date.now() >= e.record.binding.expiresAt
      || e.status.state === 'cleaned') throw new Problem(409, 'cyst_input_expired', 'The original paid file lease is no longer active.');
  }
  async reserve(raw: CystInputBinding, specHash: string): Promise<void> {
    const record = recordSchema.parse({ version: 1, binding: raw, specHash });
    await this.serial(async () => {
      await this.root(); const previous = this.entries.get(record.binding.runId);
      if (previous) { if (canonical(previous.record) !== canonical(record)) throw new Problem(409, 'cyst_input_conflict', 'Paid input binding changed.');
        // A process restart must clean the old container and data, never rearm an old lease.
        if (previous.deadline <= 0 || previous.status.state === 'cleaned') throw failure(); return; }
      if (record.binding.descriptor.plaintextBytes > this.policy.maxInputBytes
        || this.entries.size >= this.policy.maxOperations
        || this.reserved() + record.binding.descriptor.plaintextBytes > this.policy.globalBytes) {
        throw new Problem(503, 'cyst_input_quota', 'The reviewed paid file spool has no reserved byte capacity.');
      }
      const available = await statfs(this.directory, { bigint: true });
      if (available.bavail * available.bsize < BigInt(this.reserved() + record.binding.descriptor.plaintextBytes + this.policy.minimumFreeBytes)) {
        throw new Problem(503, 'cyst_input_disk_headroom', 'The reviewed paid file spool lacks disk headroom.');
      }
      const remaining = record.binding.expiresAt - Date.now(); if (remaining <= 0 || remaining > 125_000) throw failure();
      const path = this.path(record.binding.runId); await mkdir(path, { mode: 0o700 });
      try {
        await atomicJson(join(path, 'binding.json'), record, true);
        const status: Status = { version: 1, state: 'waiting', committed: false };
        await atomicJson(join(path, 'status.json'), status, true);
        await mkdir(join(path, 'ready'), { mode: 0o755 }); await chmod(join(path, 'ready'), 0o755);
        await sync(path); await sync(this.directory);
        this.entries.set(record.binding.runId, { record, status, deadline: performance.now() + remaining });
      } catch (e) { this.poisoned = true; throw e; }
    });
  }
  /** Authenticated placement hint only; reserve() remains authoritative. */
  inventory(): Promise<readonly z.infer<typeof recordSchema>[]> {
    return this.serial(async () => {
      await this.root();
      for (const runId of this.entries.keys()) await this.auditEntry(runId);
      return structuredClone([...this.entries.values()].map(entry => entry.record));
    });
  }
  canReserve(rawBytes: number): Promise<boolean> {
    const bytes = cystInputMaxBytesSchema.parse(rawBytes);
    return this.serial(async () => {
      await this.root();
      if (bytes > this.policy.maxInputBytes || this.entries.size >= this.policy.maxOperations
        || this.reserved() + bytes > this.policy.globalBytes) return false;
      const free = await statfs(this.directory, { bigint: true });
      return free.bavail * free.bsize >= BigInt(this.reserved() + bytes + this.policy.minimumFreeBytes);
    });
  }
  async readyDirectory(runId: string, specHash: string): Promise<string> {
    const e = this.entry(runId); await this.auditEntry(runId);
    if (e.record.specHash !== specHash || e.deadline <= performance.now() || e.status.state === 'cleaned') throw failure();
    return join(this.path(runId), 'ready');
  }
  async status(raw: CystInputBinding): Promise<{ state: Status['state']; committed: boolean }> {
    const e = this.checked(raw);
    return this.serial(async () => {
      await this.auditEntry(raw.runId);
      if (e.status.state === 'ready') {
        const file = await lstat(join(this.path(raw.runId), 'ready', 'state.bin'), { bigint: true }); regular(file, true);
        if (!e.status.file || canonical(fileIdentity(file)) !== canonical(e.status.file)) throw failure();
      }
      return { state: e.status.state, committed: e.status.committed };
    });
  }
  async stage(raw: CystInputBinding, body: ReadableStream<Uint8Array>, signal: AbortSignal,
    assertActive: () => void): Promise<void> {
    const e = this.checked(raw); this.live(e, assertActive); await this.auditEntry(raw.runId);
    this.live(e, assertActive);
    if (e.flight) { await cancelBounded(body); throw new Problem(409, 'cyst_input_busy', 'The paid file upload is already active.'); }
    const abort = new AbortController(); let done!: () => void;
    e.flight = { abort, done: new Promise<void>(resolve => { done = resolve; }) };
    const combined = AbortSignal.any([abort.signal, signal, AbortSignal.timeout(Math.max(1, Math.floor(e.deadline - performance.now())))]);
    if (e.status.state === 'staged' || e.status.state === 'ready') {
      try { await verifyDuplicateCystInput(body, raw.descriptor, combined, () => this.live(e, assertActive)); }
      finally { delete e.flight; done(); }
      return;
    }
    const reader = body.getReader(); let file: FileHandle | undefined, created: BigIntStats | undefined, finished = false;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      combined.throwIfAborted();
      const incoming = join(this.path(raw.runId), 'incoming.bin');
      file = await open(incoming, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      created = await file.stat({ bigint: true }); regular(created);
      const hash = createHash('sha256'); let length = 0;
      for (;;) {
        combined.throwIfAborted(); this.live(e, assertActive);
        const item = await reader.read(); combined.throwIfAborted(); this.live(e, assertActive);
        if (item.done) break;
        if (item.value.byteLength > CYST_INPUT_STREAM_CHUNK_BYTES
          || item.value.byteLength > raw.descriptor.plaintextBytes - length) throw new Problem(422,
          'cyst_input_length', 'Paid file bytes exceed the declared size or streaming frame limit.');
        hash.update(item.value); await file.writeFile(item.value); length += item.value.byteLength;
      }
      if (length !== raw.descriptor.plaintextBytes || hash.digest('hex') !== raw.descriptor.plaintextSha256) {
        throw new Problem(422, 'cyst_input_integrity', 'Paid file length or digest differs from the original declaration.');
      }
      await file.sync(); const stat = await file.stat({ bigint: true }); regular(stat);
      if (canonical(fileIdentity(stat)) !== canonical(fileIdentity(await lstat(incoming, { bigint: true })))) throw failure();
      await file.close(); file = undefined;
      await this.serial(async () => {
        this.live(e, assertActive); await this.auditEntry(raw.runId);
        const status: Status = { version: 1, state: 'staged', committed: false, file: fileIdentity(stat) };
        await atomicJson(join(this.path(raw.runId), 'status.json'), status); e.status = status; finished = true;
      });
    } finally {
      combined.removeEventListener('abort', cancel); await file?.close().catch(() => undefined);
      await cancelBounded(reader); reader.releaseLock();
      if (!finished && created) {
        const incoming = join(this.path(raw.runId), 'incoming.bin');
        try { const current = await lstat(incoming, { bigint: true }); regular(current);
          if (current.dev !== created.dev || current.ino !== created.ino) throw failure(); await unlink(incoming); }
        catch (error) { if (!missing(error)) this.poisoned = true; }
      }
      delete e.flight; done();
    }
  }
  async commit(raw: CystInputBinding, assertActive: () => void): Promise<void> {
    const e = this.checked(raw);
    await this.serial(async () => {
      this.live(e, assertActive); await this.auditEntry(raw.runId);
      if (e.status.state === 'ready') return;
      if (e.status.state !== 'staged' || !e.status.file || e.flight) throw failure();
      const path = this.path(raw.runId), incoming = join(path, 'incoming.bin'), ready = join(path, 'ready');
      const stat = await lstat(incoming, { bigint: true }); regular(stat);
      if (canonical(fileIdentity(stat)) !== canonical(e.status.file)) throw failure();
      if ((await readdir(ready)).length !== 0) throw failure();
      this.live(e, assertActive);
      try {
        await chmod(incoming, 0o444);
        const publish = await lstat(incoming, { bigint: true }); regular(publish, true);
        if (publish.dev !== stat.dev || publish.ino !== stat.ino || publish.size !== stat.size || publish.mtimeNs !== stat.mtimeNs) throw failure();
        this.live(e, assertActive);
        await link(incoming, join(ready, 'state.bin')); await sync(ready);
        await unlink(incoming); await sync(path);
        const final = await lstat(join(ready, 'state.bin'), { bigint: true }); regular(final, true);
        const status: Status = { version: 1, state: 'ready', committed: true, file: fileIdentity(final) };
        await atomicJson(join(path, 'status.json'), status); e.status = status;
      } catch (error) { this.poisoned = true; throw error; }
    });
  }
  /** Call only after exact resource cleanup has succeeded. Never follows a link
   * or recursively removes an operator-provided path. Metadata stays bounded.
   */
  async cleanup(runId: string): Promise<void> {
    const e = this.entry(runId);
    // Close the upload admission gate before any await or flight snapshot.
    e.cleaning = true;
    e.flight?.abort.abort(); await e.flight?.done;
    await this.serial(async () => {
      await this.auditEntry(runId); const path = this.path(runId), ready = join(path, 'ready');
      for (const file of [join(path, 'incoming.bin'), join(ready, 'state.bin')]) {
        let stat: BigIntStats; try { stat = await lstat(file, { bigint: true }); } catch (error) { if (missing(error)) continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2n
          || stat.size > BigInt(e.record.binding.descriptor.plaintextBytes)) throw failure();
        await unlink(file);
      }
      try { await rmdir(ready); } catch (error) { if (!missing(error)) throw error; }
      const status: Status = { version: 1, state: 'cleaned', committed: e.status.committed };
      await atomicJson(join(path, 'status.json'), status); e.status = status; e.deadline = 0;
    });
  }
  descriptorHash(runId: string) { return cystInputDescriptorHash(this.entry(runId).record.binding.descriptor); }
  async close(): Promise<void> {
    if (this.closed) return;
    for (const entry of this.entries.values()) entry.flight?.abort.abort();
    await Promise.all([...this.entries.values()].map(entry => entry.flight?.done)); await this.gate;
    await this.root(); this.closed = true; await this.lock.close(); await unlink(join(this.directory, '.writer-lock')); await sync(this.directory);
  }
}
