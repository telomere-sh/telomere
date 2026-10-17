import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, readlink, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { CYST_CAPABILITIES, cystAddressSchema, cystEnvelopeSchema, cystHeaderSchema, cystMetadataSchema,
  type CystEnvelope, type CystMetadata } from '../cysts/types.js';
import { decryptCheckpoint } from './cysts.js';
import type { CystCheckpointJournal, CystCheckpointRecord, CystCheckpointScope, CystCheckpointState,
  CystCheckpointVault } from './cyst-checkpoints.js';

const operationId = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema }).strict();
const timestamp = z.number().int().nonnegative().safe().max(8_640_000_000_000_000);
const trigger = z.enum(['periodic', 'owner_request', 'preemption', 'budget_exhaustion', 'metabolism_step_down']);
const metadata = cystMetadataSchema.refine(value => value.state === 'ready' && value.ciphertextBytes === value.plaintextBytes + 16);
const stateSchema = z.object({ version: z.literal(1), scope: scopeSchema, intervalMs: z.number().int().min(1000).max(86_400_000),
  paused: z.boolean(), nextDueAtMs: timestamp,
  pending: z.object({ operationId, trigger, startedAtMs: timestamp }).strict().nullable(),
  latest: z.object({ operationId, trigger, completedAtMs: timestamp, checkpoint: metadata }).strict().nullable() }).strict();
const lockSchema = z.object({ version: z.literal(1), lockId: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive().max(2 ** 31 - 1), platform: z.string().regex(/^[a-z0-9]{1,16}$/),
  bootId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).nullable(),
  pidNamespace: z.string().regex(/^pid:\[[0-9]{1,20}\]$/).nullable() }).strict();
type Lock = z.infer<typeof lockSchema>;
type Context = { scope: CystCheckpointScope; directory: string; rootIdentity: BigIntStats; identity: BigIntStats };
type OwnedLock = { value: Lock; identity: BigIntStats };
const magic = Buffer.from('TCV1'), overhead = 32, stateLimit = 8192, recordLimit = CYST_CAPABILITIES.maxUploadBodyBytes + 512;
const noFollow = constants.O_NOFOLLOW ?? 0, nonBlock = constants.O_NONBLOCK ?? 0;
const failed = (code: CystCheckpointFileVaultError['code'] = 'vault_unavailable') => new CystCheckpointFileVaultError(code);
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST'; }
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode && left.uid === right.uid
    && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function privateEntry(value: BigIntStats, directory: boolean, maximum = Number.MAX_SAFE_INTEGER): void {
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n)
    || !directory && (value.size < 0n || value.size > BigInt(maximum))
    || process.platform !== 'win32' && ((value.mode & 0o077n) !== 0n
      || (value.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)
      || typeof process.getuid === 'function' && value.uid !== BigInt(process.getuid()))) throw failed();
}
function scopeEqual(left: CystCheckpointScope, right: CystCheckpointScope): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function header(value: CystEnvelope | CystMetadata) {
  return cystHeaderSchema.parse({ version: value.version, algorithm: value.algorithm, id: value.id, owner: value.owner,
    agent: value.agent, applicationSchema: value.applicationSchema, plaintextBytes: value.plaintextBytes, nonce: value.nonce });
}

export class CystCheckpointFileVaultError extends Error {
  constructor(readonly code: 'vault_unavailable' | 'vault_integrity' | 'vault_invalid_data' | 'vault_record_conflict'
    | 'vault_lock_timeout' | 'vault_lock_recovery_unavailable' | 'vault_journal_expired' | 'vault_closed') {
    super(code); this.name = 'CystCheckpointFileVaultError';
  }
}
export type CystCheckpointFileLockStatus = { lockId: string; pid: number; process: 'live' | 'dead' | 'unknown';
  sameLinuxBoot: boolean };

/** Node-only owner storage on a local, owner-controlled filesystem. The master
 * key is mandatory and never written to disk or sent to the Cyst API.
 * A crash deliberately leaves its lock; recovery is explicit and fail closed.
 */
export class CystCheckpointFileVault implements CystCheckpointVault {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly acquireTimeoutMs: number;
  private readonly maxRecords: number;
  private active = 0;
  private closed = false;
  constructor(options: { directory: string; masterKey: Uint8Array; acquireTimeoutMs?: number; maxRecordsPerScope?: number }) {
    if (typeof options.directory !== 'string' || !isAbsolute(options.directory) || options.directory.length > 4096
      || options.directory.includes('\0') || Buffer.from(options.directory).toString('utf8') !== options.directory
      || !(options.masterKey instanceof Uint8Array) || options.masterKey.byteLength !== 32) throw failed('vault_invalid_data');
    this.directory = resolve(options.directory); this.key = Buffer.from(options.masterKey);
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 5000; this.maxRecords = options.maxRecordsPerScope ?? 512;
    if (!Number.isInteger(this.acquireTimeoutMs) || this.acquireTimeoutMs < 10 || this.acquireTimeoutMs > 60_000
      || !Number.isInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 4096) { this.key.fill(0); throw failed('vault_invalid_data'); }
  }
  /** Clear this instance's owning master-key copy. Active operations must finish first. */
  close(): void { if (this.active) throw failed(); this.closed = true; this.key.fill(0); }
  private enter(): void { if (this.closed) throw failed('vault_closed'); this.active++; }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw error instanceof CystCheckpointFileVaultError ? error : failed(); }
  }
  private async ancestors(): Promise<void> {
    const root = parse(this.directory).root, components = relative(root, dirname(this.directory)).split(/[\\/]/).filter(Boolean);
    let current = root;
    for (const component of ['', ...components]) {
      if (component) current = join(current, component);
      const value = await lstat(current, { bigint: true });
      if (!value.isDirectory() || value.isSymbolicLink()) throw failed();
    }
  }
  private async context(raw: CystCheckpointScope): Promise<Context> {
    const scope = scopeSchema.parse(raw); await this.ancestors();
    let createdRoot = false, createdScope = false;
    try { await mkdir(this.directory, { mode: 0o700 }); createdRoot = true; } catch (error) { if (!exists(error)) throw error; }
    const rootIdentity = await lstat(this.directory, { bigint: true }); privateEntry(rootIdentity, true);
    if (createdRoot) await this.syncParent(this.directory);
    const digest = createHash('sha256').update(JSON.stringify(['telomere.cyst-vault-scope', scope.owner, scope.agent, scope.applicationSchema])).digest('hex');
    const directory = join(this.directory, digest);
    try { await mkdir(directory, { mode: 0o700 }); createdScope = true; } catch (error) { if (!exists(error)) throw error; }
    const identity = await lstat(directory, { bigint: true }); privateEntry(identity, true);
    const context = { scope, directory, rootIdentity, identity }; await this.guard(context);
    if (createdScope) await this.syncParent(directory); return context;
  }
  private async syncParent(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    const parent = dirname(path), before = await lstat(parent, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw failed();
    const file = await open(parent, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isDirectory() || !sameIdentity(before, opened)) throw failed();
      await file.sync(); if (!sameIdentity(opened, await lstat(parent, { bigint: true }))) throw failed();
    } finally { await file.close(); }
  }
  private async guard(context: Context): Promise<void> {
    await this.ancestors();
    const root = await lstat(this.directory, { bigint: true }), scope = await lstat(context.directory, { bigint: true });
    privateEntry(root, true); privateEntry(scope, true);
    if (!sameIdentity(root, context.rootIdentity) || !sameIdentity(scope, context.identity)) throw failed();
  }
  private aad(context: Context, kind: 'identity' | 'state' | 'record' | 'lock', id: string | null): Buffer {
    return Buffer.from(JSON.stringify(['telomere.cyst-checkpoint-file-vault', 1, context.scope.owner, context.scope.agent,
      context.scope.applicationSchema, kind, id]));
  }
  private encrypt(context: Context, kind: 'identity' | 'state' | 'record' | 'lock', id: string | null, plaintext: Buffer): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(context, kind, id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
  }
  private decrypt(context: Context, kind: 'identity' | 'state' | 'record' | 'lock', id: string | null, value: Buffer): Buffer {
    let partial: Buffer | undefined;
    try {
      if (value.byteLength <= overhead || !value.subarray(0, 4).equals(magic)) throw failed('vault_integrity');
      const cipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(4, 16));
      cipher.setAAD(this.aad(context, kind, id)); cipher.setAuthTag(value.subarray(16, 32));
      partial = cipher.update(value.subarray(overhead)); return Buffer.concat([partial, cipher.final()]);
    } catch { throw failed('vault_integrity'); }
    finally { partial?.fill(0); }
  }
  private async read(context: Context, name: string, maximum: number): Promise<{ bytes: Buffer; identity: BigIntStats } | undefined> {
    await this.guard(context); const path = join(context.directory, name);
    let named: BigIntStats;
    try { named = await lstat(path, { bigint: true }); } catch (error) { if (missing(error)) { await this.guard(context); return undefined; } throw error; }
    privateEntry(named, false, maximum);
    const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const opened = await file.stat({ bigint: true }); privateEntry(opened, false, maximum);
      if (!sameFile(named, opened)) throw failed();
      const bytes = Buffer.alloc(Number(opened.size) + 1); let size = 0;
      while (size < bytes.length) { const result = await file.read(bytes, size, bytes.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
      const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
      privateEntry(after, false, maximum); privateEntry(current, false, maximum);
      if (size > maximum || BigInt(size) !== opened.size || !sameFile(opened, after) || !sameFile(after, current)) throw failed();
      await this.guard(context); return { bytes: bytes.subarray(0, size), identity: current };
    } finally { await file.close(); }
  }
  private async syncDirectory(context: Context): Promise<void> {
    await this.guard(context);
    if (process.platform !== 'win32') {
      const file = await open(context.directory, constants.O_RDONLY | noFollow | nonBlock);
      try { const stat = await file.stat({ bigint: true }); privateEntry(stat, true);
        if (!sameIdentity(stat, context.identity)) throw failed(); await file.sync(); } finally { await file.close(); }
    }
    await this.guard(context);
  }
  private async removeOwned(context: Context, name: string, identity: BigIntStats): Promise<void> {
    await this.guard(context); const path = join(context.directory, name), current = await lstat(path, { bigint: true });
    privateEntry(current, false); if (!sameIdentity(identity, current)) throw failed();
    await unlink(path); await this.syncDirectory(context);
  }
  private async atomic(context: Context, name: string, bytes: Buffer): Promise<void> {
    await this.guard(context);
    const target = await this.read(context, name, Math.max(recordLimit + overhead, bytes.length));
    const temporary = '.write-' + randomBytes(24).toString('hex') + '.tmp', path = join(context.directory, temporary);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlock, 0o600);
    let identity: BigIntStats | undefined, moved = false;
    try {
      identity = await file.stat({ bigint: true }); privateEntry(identity, false);
      await file.writeFile(bytes); await file.sync();
      const written = await file.stat({ bigint: true }); privateEntry(written, false, bytes.length);
      if (!sameIdentity(identity, written) || written.size !== BigInt(bytes.length)) throw failed();
      await file.close(); await this.guard(context);
      if (target) { const current = await lstat(join(context.directory, name), { bigint: true });
        privateEntry(current, false); if (!sameFile(target.identity, current)) throw failed(); }
      else { try { await lstat(join(context.directory, name)); throw failed(); } catch (error) { if (!missing(error)) throw error; } }
      await rename(path, join(context.directory, name)); moved = true; await this.syncDirectory(context);
      const saved = await this.read(context, name, bytes.length);
      if (!saved || !saved.bytes.equals(bytes)) throw failed('vault_integrity');
    } finally {
      await file.close().catch(() => undefined);
      if (!moved && identity) await this.removeOwned(context, temporary, identity).catch(() => undefined);
    }
  }
  private checkedState(raw: CystCheckpointState, scope: CystCheckpointScope): CystCheckpointState {
    try {
      const value = stateSchema.parse(raw);
      if (!scopeEqual(value.scope, scope) || value.pending && value.pending.operationId === value.latest?.operationId
        || value.latest && !scopeEqual(scopeSchema.parse({ owner: value.latest.checkpoint.owner, agent: value.latest.checkpoint.agent,
          applicationSchema: value.latest.checkpoint.applicationSchema }), scope)) throw failed('vault_invalid_data');
      return value;
    } catch { throw failed('vault_invalid_data'); }
  }
  private copiedRecord(raw: CystCheckpointRecord, scope: CystCheckpointScope): CystCheckpointRecord {
    let recoveryKey: Uint8Array | undefined;
    try {
      const envelope = cystEnvelopeSchema.parse(raw.envelope);
      if (!(raw.recoveryKey instanceof Uint8Array) || raw.recoveryKey.byteLength !== 32
        || !scopeEqual(scopeSchema.parse({ owner: envelope.owner, agent: envelope.agent, applicationSchema: envelope.applicationSchema }), scope)) throw failed('vault_invalid_data');
      recoveryKey = Uint8Array.from(raw.recoveryKey);
      return { envelope, recoveryKey };
    } catch { recoveryKey?.fill(0); throw failed('vault_invalid_data'); }
  }
  private async checkedRecord(raw: CystCheckpointRecord, scope: CystCheckpointScope): Promise<CystCheckpointRecord> {
    const record = this.copiedRecord(raw, scope);
    try { const verified = await decryptCheckpoint(record.envelope, record.recoveryKey); verified.fill(0); return record; }
    catch { record.recoveryKey.fill(0); throw failed('vault_invalid_data'); }
  }
  private async checkpoint(context: Context, id: string): Promise<CystCheckpointRecord | undefined> {
    const saved = await this.read(context, 'record-' + id + '.bin', recordLimit + overhead); if (!saved) return undefined;
    const plaintext = this.decrypt(context, 'record', id, saved.bytes); let key: Uint8Array | undefined;
    try {
      if (plaintext.length <= 32) throw failed('vault_integrity'); key = Uint8Array.from(plaintext.subarray(0, 32));
      const envelope = cystEnvelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(32))) as unknown);
      return await this.checkedRecord({ envelope, recoveryKey: key }, context.scope);
    } finally { key?.fill(0); plaintext.fill(0); }
  }
  private async latest(context: Context, value: CystCheckpointState): Promise<void> {
    if (!value.latest) return;
    const record = await this.checkpoint(context, value.latest.operationId);
    try {
      if (!record || JSON.stringify(header(record.envelope)) !== JSON.stringify(header(value.latest.checkpoint))
        || record.envelope.sha256 !== value.latest.checkpoint.sha256) throw failed('vault_invalid_data');
    } finally { record?.recoveryKey.fill(0); }
  }
  private async state(context: Context): Promise<CystCheckpointState | undefined> {
    const saved = await this.read(context, 'state.bin', stateLimit + overhead); if (!saved) return undefined;
    const plaintext = this.decrypt(context, 'state', null, saved.bytes);
    try { const value = this.checkedState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as CystCheckpointState, context.scope);
      await this.latest(context, value); return value; } finally { plaintext.fill(0); }
  }
  private async identity(context: Context): Promise<void> {
    const saved = await this.read(context, 'identity.bin', 128), expected = Buffer.from('telomere.cyst-checkpoint-file-vault/v1');
    if (saved) {
      const plaintext = this.decrypt(context, 'identity', null, saved.bytes);
      try { if (!plaintext.equals(expected)) throw failed('vault_integrity'); } finally { plaintext.fill(0); }
    } else {
      const directory = await opendir(context.directory);
      try { for await (const entry of directory) if (!['exclusive.lock', 'recovery.lock'].includes(entry.name)) throw failed('vault_integrity'); }
      finally { await directory.close().catch(() => undefined); }
      await this.atomic(context, 'identity.bin', this.encrypt(context, 'identity', null, expected));
    }
    await this.state(context);
  }
  private async recordCapacity(context: Context): Promise<void> {
    await this.guard(context); const directory = await opendir(context.directory); let count = 0, total = 0;
    try {
      for await (const entry of directory) {
        if (++total > this.maxRecords + 32) throw failed();
        if (/^record-cyst-hook-[a-f0-9]{64}\.bin$/.test(entry.name) && ++count >= this.maxRecords) throw failed('vault_invalid_data');
      }
    } finally { await directory.close().catch(() => undefined); }
    await this.guard(context);
  }
  private journal(context: Context) {
    let usable = true, queue: Promise<void> = Promise.resolve(), failure: unknown;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!usable) return Promise.reject(failed('vault_journal_expired'));
      const result = queue.then(() => this.safe(operation));
      queue = result.then(() => undefined, error => { failure ??= error; }); return result;
    };
    const journal: CystCheckpointJournal = {
      load: () => enqueue(() => this.state(context)),
      save: async raw => {
        const value = this.checkedState(raw, context.scope);
        return enqueue(async () => { await this.state(context); await this.latest(context, value); const plaintext = Buffer.from(JSON.stringify(value));
          try { if (plaintext.length > stateLimit) throw failed('vault_invalid_data');
            await this.atomic(context, 'state.bin', this.encrypt(context, 'state', null, plaintext)); } finally { plaintext.fill(0); } });
      },
      checkpoint: async rawId => { const id = operationId.parse(rawId); return enqueue(() => this.checkpoint(context, id)); },
      saveCheckpoint: async (rawId, raw) => {
        const id = operationId.parse(rawId), copied = this.copiedRecord(raw, context.scope);
        try { await enqueue(async () => {
          const verified = await decryptCheckpoint(copied.envelope, copied.recoveryKey); verified.fill(0);
          const current = await this.checkpoint(context, id);
          try {
            if (current) {
              if (JSON.stringify(current.envelope) !== JSON.stringify(copied.envelope)
                || !timingSafeEqual(Buffer.from(current.recoveryKey), Buffer.from(copied.recoveryKey))) throw failed('vault_record_conflict');
              return;
            }
          } finally { current?.recoveryKey.fill(0); }
          await this.recordCapacity(context);
          const plaintext = Buffer.concat([Buffer.from(copied.recoveryKey), Buffer.from(JSON.stringify(copied.envelope))]);
          try { if (plaintext.length > recordLimit) throw failed('vault_invalid_data');
            await this.atomic(context, 'record-' + id + '.bin', this.encrypt(context, 'record', id, plaintext)); } finally { plaintext.fill(0); }
        }); } finally { copied.recoveryKey.fill(0); }
      },
    };
    return { journal, async finish() { usable = false; await queue; if (failure) throw failure; } };
  }
  private async bootIdentity(): Promise<{ bootId: string | null; pidNamespace: string | null }> {
    if (process.platform !== 'linux') return { bootId: null, pidNamespace: null };
    try {
      const [boot, namespace] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid')]);
      return { bootId: lockSchema.shape.bootId.unwrap().parse(boot.trim()), pidNamespace: lockSchema.shape.pidNamespace.unwrap().parse(namespace) };
    } catch { return { bootId: null, pidNamespace: null }; }
  }
  private sameBoot(lock: Lock, current: { bootId: string | null; pidNamespace: string | null }): boolean {
    return process.platform === 'linux' && lock.platform === 'linux' && current.bootId !== null && current.pidNamespace !== null
      && current.bootId === lock.bootId && current.pidNamespace === lock.pidNamespace;
  }
  private processState(pid: number): 'live' | 'dead' | 'unknown' {
    try { process.kill(pid, 0); return 'live'; }
    catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  }
  private async readLock(context: Context, name: 'exclusive.lock' | 'recovery.lock' = 'exclusive.lock'): Promise<OwnedLock | undefined> {
    const saved = await this.read(context, name, 2048); if (!saved) return undefined;
    const plaintext = this.decrypt(context, 'lock', name, saved.bytes);
    try { return { value: lockSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown), identity: saved.identity }; }
    finally { plaintext.fill(0); }
  }
  private async acquire(context: Context, name: 'exclusive.lock' | 'recovery.lock' = 'exclusive.lock'): Promise<OwnedLock> {
    const deadline = performance.now() + this.acquireTimeoutMs;
    while (true) {
      await this.guard(context); let file;
      try { file = await open(join(context.directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlock, 0o600); }
      catch (error) {
        if (!exists(error)) throw error;
        if (performance.now() >= deadline) throw failed('vault_lock_timeout');
        await new Promise<void>(done => setTimeout(done, Math.min(25, Math.max(1, deadline - performance.now())))); continue;
      }
      let identity: BigIntStats | undefined;
      try {
        identity = await file.stat({ bigint: true }); privateEntry(identity, false);
        const value: Lock = { version: 1, lockId: randomBytes(32).toString('hex'), pid: process.pid, platform: process.platform, ...await this.bootIdentity() };
        const plaintext = Buffer.from(JSON.stringify(value));
        try { await file.writeFile(this.encrypt(context, 'lock', name, plaintext)); await file.sync(); } finally { plaintext.fill(0); }
        await file.close(); await this.syncDirectory(context); const saved = await this.readLock(context, name);
        if (!saved || !sameIdentity(saved.identity, identity) || saved.value.lockId !== value.lockId) throw failed(); return saved;
      } catch (error) {
        await file.close().catch(() => undefined);
        if (identity) await this.removeOwned(context, name, identity).catch(() => undefined); throw error;
      }
    }
  }
  private async release(context: Context, lock: OwnedLock, name: 'exclusive.lock' | 'recovery.lock' = 'exclusive.lock'): Promise<void> {
    const current = await this.readLock(context, name);
    if (!current || !sameFile(current.identity, lock.identity) || current.value.lockId !== lock.value.lockId) throw failed();
    await this.removeOwned(context, name, current.identity);
  }
  async exclusive<T>(scope: CystCheckpointScope, operation: (journal: CystCheckpointJournal) => Promise<T>): Promise<T> {
    this.enter();
    try {
      const context = await this.safe(() => this.context(scope)), lock = await this.safe(() => this.acquire(context));
      const { journal, finish } = this.journal(context);
      try { await this.safe(() => this.identity(context)); return await operation(journal); }
      finally { try { await finish(); } finally { await this.safe(() => this.release(context, lock)); } }
    } finally { this.active--; }
  }
  async lockStatus(scope: CystCheckpointScope): Promise<CystCheckpointFileLockStatus | undefined> {
    this.enter();
    try { return await this.safe(async () => {
      const context = await this.context(scope), lock = await this.readLock(context); if (!lock) return undefined;
      const sameLinuxBoot = this.sameBoot(lock.value, await this.bootIdentity());
      return { lockId: lock.value.lockId, pid: lock.value.pid, process: sameLinuxBoot ? this.processState(lock.value.pid) : 'unknown', sameLinuxBoot };
    }); } finally { this.active--; }
  }
  /** Never infers death from age. A live/reused PID or unknown platform/boot
   * cannot be recovered. The caller must supply the exact observed lockId.
   */
  async recoverStaleLock(scope: CystCheckpointScope, expectedLockId: string): Promise<void> {
    this.enter();
    try { await this.safe(async () => {
      if (!/^[a-f0-9]{64}$/.test(expectedLockId)) throw failed('vault_lock_recovery_unavailable');
      const context = await this.context(scope), recovery = await this.acquire(context, 'recovery.lock');
      try {
        const lock = await this.readLock(context), boot = await this.bootIdentity();
        if (!lock || lock.value.lockId !== expectedLockId || !this.sameBoot(lock.value, boot)
          || this.processState(lock.value.pid) !== 'dead') throw failed('vault_lock_recovery_unavailable');
        const fresh = await this.readLock(context);
        if (!fresh || !sameFile(fresh.identity, lock.identity) || fresh.value.lockId !== expectedLockId
          || this.processState(lock.value.pid) !== 'dead') throw failed('vault_lock_recovery_unavailable');
        await this.removeOwned(context, 'exclusive.lock', lock.identity);
      } finally { await this.release(context, recovery, 'recovery.lock'); }
    }); } finally { this.active--; }
  }
}
