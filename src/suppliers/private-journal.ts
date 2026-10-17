import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const nonBlock = constants.O_NONBLOCK ?? 0;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats) => sameInode(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Snapshot = { bytes: Buffer; stat: BigIntStats };
type JournalOptions<File> = { path: string; kind: string; schema: { parse(value: unknown): File }; maximum: number;
  binding?: string; lockPath?: string };
const markerSchema = z.object({ version: z.literal(1), kind: z.string().min(1).max(128), path: z.string().min(1).max(4096),
  bindingSha256: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().uuid() }).strict();

export class SupplierJournalLocked extends Error {
  constructor() { super('Supplier journal is locked; recover the prior writer before retrying'); }
}

/** Private local storage, not an authenticated external-liability oracle. A complete
 * journal/marker rollback or deletion is not supported recovery. Windows ACLs must
 * be provisioned by the operator; POSIX ownership and modes are checked here. */
export class PrivateSupplierJournal<File> {
  readonly path: string;
  readonly lockPath: string;
  readonly markerPath: string;
  private readonly markerIdentity: Omit<z.infer<typeof markerSchema>, 'generation'>;
  private directoryIdentity: BigIntStats | undefined;

  constructor(options: JournalOptions<File>) {
    this.options = options;
    for (const path of [options.path, options.lockPath ?? options.path + '.lock']) {
      if (!isAbsolute(path) || path.includes('\0') || path.length > 4096) throw new Error('Supplier journal requires an absolute private path');
    }
    this.path = resolve(options.path); this.lockPath = resolve(options.lockPath ?? this.path + '.lock');
    this.markerPath = this.path + '.initialized';
    if (dirname(this.lockPath) !== dirname(this.path) || new Set(this.paths()).size !== 3) throw new Error('Supplier journal storage paths overlap');
    this.markerIdentity = Object.freeze({ version: 1, kind: options.kind, path: this.path,
      bindingSha256: digest(Buffer.from(options.binding ?? '')) });
  }
  private readonly options: JournalOptions<File>;
  paths(): readonly string[] { return [this.path, this.markerPath, this.lockPath]; }

  private check(stat: BigIntStats, directory: boolean, maximum = this.options.maximum): void {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n
      || stat.size < 1n || stat.size > BigInt(maximum)) || process.platform !== 'win32' && ((stat.mode & 0o077n) !== 0n
      || (stat.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)
      || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) throw new Error('Private supplier journal storage rejected');
  }
  private async guardDirectory(): Promise<BigIntStats> {
    const directory = dirname(this.path), leaf = await lstat(directory, { bigint: true }); this.check(leaf, true);
    if (this.directoryIdentity && !sameInode(leaf, this.directoryIdentity)) throw new Error('Supplier journal directory changed');
    for (let path = directory;;) {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Supplier journal ancestor rejected');
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    this.directoryIdentity ??= leaf; return leaf;
  }
  private async syncDirectory(): Promise<void> {
    const original = await this.guardDirectory();
    if (process.platform !== 'win32') {
      const file = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | noFollow | nonBlock);
      try { const opened = await file.stat({ bigint: true }); this.check(opened, true);
        if (!sameInode(original, opened)) throw new Error('Supplier journal directory changed'); await file.sync();
      } finally { await file.close(); }
    }
    await this.guardDirectory();
  }
  private async snapshot(path: string, maximum: number): Promise<Snapshot> {
    await this.guardDirectory(); const named = await lstat(path, { bigint: true }); this.check(named, false, maximum);
    const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const before = await file.stat({ bigint: true }); this.check(before, false, maximum);
      if (!sameFile(named, before)) throw new Error('Supplier journal changed while opening');
      const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await file.stat({ bigint: true }), present = await lstat(path, { bigint: true });
      this.check(after, false, maximum); this.check(present, false, maximum);
      if (!sameFile(before, after) || !sameFile(after, present) || length !== Number(before.size)) throw new Error('Supplier journal changed while reading');
      await this.guardDirectory(); return { bytes: bytes.subarray(0, length), stat: present };
    } finally { await file.close(); }
  }
  private async checkMarker(): Promise<string> {
    const bytes = (await this.snapshot(this.markerPath, 8192)).bytes;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = markerSchema.parse(JSON.parse(text));
    if (JSON.stringify(value) !== text || value.version !== this.markerIdentity.version || value.kind !== this.markerIdentity.kind
      || value.path !== this.markerIdentity.path || value.bindingSha256 !== this.markerIdentity.bindingSha256) throw new Error('Supplier journal initialization identity differs');
    return value.generation;
  }
  private parse(bytes: Buffer): File {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
    // New stores use this exact encoding. This also rejects ambiguous duplicate keys.
    if (JSON.stringify(value) !== text) throw new Error('Supplier journal encoding is not canonical');
    return this.options.schema.parse(value);
  }
  private async load(): Promise<{ value: File; snapshot: Snapshot; generation: string }> {
    const generation = await this.checkMarker(), snapshot = await this.snapshot(this.path, this.options.maximum);
    const value = this.parse(snapshot.bytes);
    if (await this.checkMarker() !== generation) throw new Error('Supplier journal initialization changed');
    return { value, snapshot, generation };
  }
  async read(): Promise<File> { return (await this.load()).value; }
  async initializationGeneration(): Promise<string> { return (await this.load()).generation; }

  private async exclusive<Result>(work: (uncertain: () => void, checkLock: () => Promise<void>) => Promise<Result>): Promise<Result> {
    await this.guardDirectory(); let lock;
    try { lock = await open(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlock, 0o600); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new SupplierJournalLocked(); throw error; }
    let safe = false; let identity: Snapshot | undefined;
    try {
      const token = Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID() }));
      await lock.writeFile(token); await lock.sync(); await lock.close();
      identity = await this.snapshot(this.lockPath, 256); if (!identity.bytes.equals(token)) throw new Error('Supplier writer identity changed');
      await this.syncDirectory(); safe = true;
      const checkLock = async () => {
        const current = await this.snapshot(this.lockPath, 256);
        if (!identity || !sameFile(identity.stat, current.stat) || !identity.bytes.equals(current.bytes)) throw new Error('Supplier writer lock changed; recovery required');
      };
      const result = await work(() => { safe = false; }, checkLock); await checkLock(); safe = true; return result;
    } finally {
      await lock.close().catch(() => undefined);
      if (safe && identity) {
        const current = await this.snapshot(this.lockPath, 256);
        if (!sameFile(identity.stat, current.stat) || !identity.bytes.equals(current.bytes)) throw new Error('Supplier writer lock changed; recovery required');
        await unlink(this.lockPath); await this.syncDirectory();
      }
    }
  }

  /** Explicit new installation only. Existing or half-created stores are never imported. */
  async initializeFresh(empty: File): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(this.options.schema.parse(empty)));
    if (encoded.length < 1 || encoded.length > this.options.maximum) throw new Error('Supplier journal capacity exceeded');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.exclusive(async (uncertain, checkLock) => {
      for (const path of [this.path, this.markerPath]) {
        try { await lstat(path); } catch (error) { if (missing(error)) continue; throw error; }
        throw new Error('Supplier journal already exists or requires explicit recovery');
      }
      uncertain();
      const marker = Buffer.from(JSON.stringify({ ...this.markerIdentity, generation: randomUUID() }));
      for (const [path, bytes] of [[this.markerPath, marker], [this.path, encoded]] as const) {
        await checkLock();
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlock, 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await this.syncDirectory();
      }
      await this.load();
    });
  }

  async transact<Result>(change: (file: File, uncertain: () => void) => Promise<Result> | Result): Promise<Result> {
    return this.exclusive(async (uncertain, checkLock) => {
      const original = await this.load(), result = await change(original.value, uncertain);
      const encoded = Buffer.from(JSON.stringify(this.options.schema.parse(original.value)));
      if (encoded.length < 1 || encoded.length > this.options.maximum) throw new Error('Supplier journal capacity exceeded');
      uncertain(); await checkLock();
      const temporary = this.path + '.' + randomUUID() + '.tmp'; let created: BigIntStats | undefined, moved = false;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlock, 0o600);
        try { created = await file.stat({ bigint: true }); await file.writeFile(encoded); await file.sync(); }
        finally { await file.close(); }
        if (await this.checkMarker() !== original.generation) throw new Error('Supplier journal initialization changed');
        const current = await this.snapshot(this.path, this.options.maximum);
        if (!sameFile(original.snapshot.stat, current.stat) || !original.snapshot.bytes.equals(current.bytes)) throw new Error('Supplier journal changed before commit');
        await checkLock(); await rename(temporary, this.path); moved = true; await this.syncDirectory();
        const committed = await this.load();
        if (committed.generation !== original.generation || !committed.snapshot.bytes.equals(encoded)) throw new Error('Supplier journal commit differs');
        return result;
      } finally {
        if (!moved && created) {
          let current: BigIntStats | undefined;
          try { current = await lstat(temporary, { bigint: true }); } catch (error) { if (!missing(error)) throw error; }
          if (current) { if (!sameInode(created, current) || !current.isFile() || current.nlink !== 1n) throw new Error('Supplier temporary file changed; recovery required'); await unlink(temporary); }
        }
      }
    });
  }
}
