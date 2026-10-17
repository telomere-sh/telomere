import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { Problem } from '../common.js';
import { CYST_CAPABILITIES } from './types.js';

export function ciphertextDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST'; }
function unavailable(): Problem { return new Problem(503, 'cyst_storage_unavailable', 'Checkpoint storage is unavailable.'); }
export class PrivateCystStorage {
  readonly directory: string;
  private identity: { dev: number; ino: number } | undefined;
  constructor(directory: string) { this.directory = resolve(directory); }
  async initialize(): Promise<void> {
    // Existing ancestor symlinks are refused; never chmod or follow an operator's linked tree.
    const ancestors: string[] = []; let current = this.directory;
    while (current !== parse(current).root) { ancestors.push(current); current = dirname(current); }
    for (const item of ancestors.reverse()) {
      try { const info = await lstat(item); if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable(); }
      catch (error) { if (!missing(error)) throw error; await mkdir(item, { mode: 0o700 }); }
    }
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw unavailable();
    const actual = await realpath(this.directory);
    // Windows realpath expands legitimate 8.3 names (for example ADMINI~1).
    // Ancestor lstat checks and the pinned inode still reject reparse-point roots.
    if (process.platform !== 'win32' && actual !== this.directory) throw unavailable();
    this.identity = { dev: info.dev, ino: info.ino };
    // Called only after the controller database lock has been acquired and before
    // accepting requests. No live uploader can own these crash-left temporary files.
    for (const name of await readdir(this.directory)) {
      if (!/^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
      await this.guard(); const path = resolve(this.directory, name); const temporary = await lstat(path);
      if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1
        || temporary.size > CYST_CAPABILITIES.maxCiphertextBytes || (process.platform !== 'win32' && (temporary.mode & 0o077) !== 0)) throw unavailable();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== temporary.dev || opened.ino !== temporary.ino || !opened.isFile()) throw unavailable();
      } finally { await handle.close(); }
      await this.guard(); const currentTemporary = await lstat(path);
      if (currentTemporary.dev !== temporary.dev || currentTemporary.ino !== temporary.ino) throw unavailable();
      await unlink(path);
    }
  }
  private async guard(): Promise<void> {
    if (!this.identity) throw unavailable();
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.identity.dev || info.ino !== this.identity.ino
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw unavailable();
  }
  private path(owner: string, digest: string): string {
    if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^[0-9a-f]{64}$/.test(digest)) throw unavailable();
    // Flat filenames are internal SHA-256 values, never a request-supplied path or filename.
    return resolve(this.directory, createHash('sha256').update('telomere-cyst-blob:' + owner + ':' + digest).digest('hex') + '.blob');
  }
  async read(owner: string, digest: string, expectedBytes: number): Promise<Uint8Array | undefined> {
    if (!Number.isInteger(expectedBytes) || expectedBytes < 17 || expectedBytes > CYST_CAPABILITIES.maxCiphertextBytes) throw unavailable();
    await this.guard(); const path = this.path(owner, digest);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw unavailable(); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expectedBytes || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw unavailable();
      await this.guard();
      // Allocate only the declared bounded size; readFile could grow unbounded if a
      // local actor appended after stat. Probe one extra byte before accepting it.
      const bytes = Buffer.alloc(expectedBytes); let offset = 0;
      while (offset < expectedBytes) {
        const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
        if (!result.bytesRead) break; offset += result.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, expectedBytes);
      if (offset !== expectedBytes || extra.bytesRead || ciphertextDigest(bytes) !== digest) throw new Problem(503, 'cyst_integrity_failed', 'Checkpoint ciphertext failed its integrity check.');
      return bytes;
    } finally { await handle.close(); }
  }
  async put(owner: string, digest: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength < 17 || bytes.byteLength > CYST_CAPABILITIES.maxCiphertextBytes || ciphertextDigest(bytes) !== digest) throw unavailable();
    if (await this.read(owner, digest, bytes.byteLength)) return;
    await this.guard(); const destination = this.path(owner, digest);
    const temporary = resolve(this.directory, '.tmp-' + randomUUID());
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await this.guard();
      // link is atomic and refuses to overwrite an existing immutable blob.
      try { await link(temporary, destination); }
      catch (error) { if (!exists(error)) throw unavailable(); }
    } finally { await unlink(temporary); }
    if (!await this.read(owner, digest, bytes.byteLength)) throw unavailable();
    // Persist the directory entry on POSIX. Windows does not expose directory fsync.
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
}
