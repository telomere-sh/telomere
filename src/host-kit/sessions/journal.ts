import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { sessionIdSchema, sessionRecordSchema, SessionRuntimeError, type SessionJournal, type SessionRecord } from './types.js';

const maximum = 2_097_152, noFollow = constants.O_NOFOLLOW ?? 0, nonBlock = constants.O_NONBLOCK ?? 0;
const invalid = () => new SessionRuntimeError('session_journal_invalid');
const absent = (value: unknown) => value instanceof Error && 'code' in value && value.code === 'ENOENT';
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function check(value: BigIntStats, directory: boolean): void {
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n || value.size > BigInt(maximum))
    || process.platform !== 'win32' && ((value.mode & 0o077n) !== 0n
      || (value.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)
      || typeof process.getuid === 'function' && value.uid !== BigInt(process.getuid()))) throw invalid();
}
/** Private host-side journal, not owner-key storage. One process owns the lock;
 * crashed locks need administrative review, never age-based automatic stealing.
 * Windows ACL provisioning is the caller's responsibility.
 */
export class FileSessionJournal implements SessionJournal {
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly sessionId: string,
    private readonly directoryIdentity: BigIntStats, private readonly lockIdentity: BigIntStats, private readonly lockToken: string) {}
  static async open(directory: string, rawSessionId: string): Promise<FileSessionJournal> {
    try {
      const sessionId = sessionIdSchema.parse(rawSessionId);
      if (!isAbsolute(directory) || directory.length > 4096 || directory.includes('\0')) throw invalid();
      const root = resolve(directory);
      try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      const dir = await lstat(root, { bigint: true }); check(dir, true);
      const file = await open(join(root, 'session.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow | nonBlock, 0o600);
      const token = randomBytes(32).toString('hex'); let lock: BigIntStats;
      try { await file.writeFile(token); await file.sync(); lock = await file.stat({ bigint: true }); check(lock, false); }
      finally { await file.close(); }
      const result = new FileSessionJournal(root, sessionId, dir, lock, token); await result.syncDirectory();
      try { await result.load(); return result; } catch (error) { await result.close(); throw error; }
    } catch { throw invalid(); }
  }
  private async guard(checkLock = true): Promise<void> {
    if (this.closed) throw invalid(); const current = await lstat(this.directory, { bigint: true }); check(current, true);
    if (!identity(current, this.directoryIdentity)) throw invalid();
    if (checkLock) {
      const path = join(this.directory, 'session.lock'), named = await lstat(path, { bigint: true }); check(named, false);
      if (!identity(named, this.lockIdentity) || named.size !== 64n) throw invalid();
      const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
      try {
        const opened = await file.stat({ bigint: true }); check(opened, false);
        if (!identity(named, opened)) throw invalid(); const bytes = Buffer.alloc(65); let length = 0;
        while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
        const after = await file.stat({ bigint: true });
        const present = await lstat(path, { bigint: true }); check(after, false); check(present, false);
        if (length !== 64 || bytes.subarray(0, 64).toString('ascii') !== this.lockToken || !identity(opened, after)
          || !identity(after, present) || after.size !== 64n || after.ctimeNs !== present.ctimeNs) throw invalid();
      } finally { await file.close(); }
    }
  }
  private async syncDirectory(checkLock = true): Promise<void> {
    await this.guard(checkLock);
    if (process.platform !== 'win32') {
      const file = await open(this.directory, constants.O_RDONLY | noFollow | nonBlock);
      try { const value = await file.stat({ bigint: true }); check(value, true);
        if (!identity(value, this.directoryIdentity)) throw invalid(); await file.sync(); } finally { await file.close(); }
    }
    await this.guard(checkLock);
  }
  private async read(): Promise<SessionRecord | undefined> {
    await this.guard(); const path = join(this.directory, 'session.json'); let named: BigIntStats;
    try { named = await lstat(path, { bigint: true }); } catch (error) { if (absent(error)) return undefined; throw error; }
    check(named, false); const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    let bytes: Buffer | undefined;
    try {
      const before = await file.stat({ bigint: true }); check(before, false); if (!identity(named, before)) throw invalid();
      bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true }); check(after, false); check(current, false);
      if (!identity(before, after) || !identity(after, current) || before.size !== after.size || after.size !== current.size
        || before.mtimeNs !== after.mtimeNs || after.mtimeNs !== current.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.ctimeNs !== current.ctimeNs || length !== Number(before.size)) throw invalid();
      const value = sessionRecordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
      if (value.spec.sessionId !== this.sessionId) throw invalid(); await this.guard(); return value;
    } finally { bytes?.fill(0); await file.close(); }
  }
  async load(): Promise<SessionRecord | undefined> {
    await this.queue; try { return await this.read(); } catch { throw invalid(); }
  }
  async save(raw: SessionRecord): Promise<void> {
    const value = sessionRecordSchema.parse(raw);
    if (value.spec.sessionId !== this.sessionId) throw invalid();
    const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > maximum) { bytes.fill(0); throw invalid(); }
    const operation = this.queue.then(async () => {
      await this.guard(); const temporary = '.session-' + randomBytes(16).toString('hex') + '.tmp', path = join(this.directory, temporary);
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow | nonBlock, 0o600);
      let moved = false;
      try {
        await file.writeFile(bytes); await file.sync(); check(await file.stat({ bigint: true }), false); await file.close(); await this.guard();
        await this.read(); await rename(path, join(this.directory, 'session.json')); moved = true; await this.syncDirectory();
        if (JSON.stringify(await this.read()) !== JSON.stringify(value)) throw invalid();
      } finally { await file.close().catch(() => undefined); if (!moved) await unlink(path).catch(() => undefined); }
    });
    this.queue = operation.catch(() => undefined);
    try { await operation; } catch { throw invalid(); } finally { bytes.fill(0); }
  }
  async close(): Promise<void> {
    await this.queue; if (this.closed) return;
    try {
      await this.guard(); const path = join(this.directory, 'session.lock'), current = await lstat(path, { bigint: true }); check(current, false);
      if (!identity(current, this.lockIdentity) || await readFile(path, 'utf8') !== this.lockToken) throw invalid();
      await unlink(path); await this.syncDirectory(false); this.closed = true;
    } catch { throw invalid(); }
  }
}
