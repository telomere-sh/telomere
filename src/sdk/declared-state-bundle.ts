import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, open, opendir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DECLARED_STATE_MAGIC, DECLARED_STATE_MAX_BYTES, DECLARED_STATE_MAX_ENTRIES,
  DECLARED_STATE_PREFIX_BYTES, declaredStateManifestSchema, declaredStatePathSchema,
  encodeDeclaredStateManifest, type DeclaredStateManifest } from '../cysts/declared-state-protocol.js';

const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const noBlock = constants.O_NONBLOCK ?? 0;
const unavailable = () => new Error('Declared state capture is unavailable or changed');
const optionsSchema = z.object({ sourceDirectory: z.string().min(1).max(4096).refine(isAbsolute),
  destinationPath: z.string().min(1).max(4096).refine(isAbsolute),
  maxBytes: z.number().int().min(128).max(DECLARED_STATE_MAX_BYTES).optional(),
}).strict();
const identity = (value: BigIntStats) => [value.dev, value.ino, value.size, value.mtimeNs,
  value.ctimeNs, value.mode, value.uid, value.nlink].join(':');
const sameInode = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;
const owned = (value: BigIntStats) => process.platform === 'win32'
  || typeof process.getuid !== 'function' || value.uid === BigInt(process.getuid());
function regular(value: BigIntStats) {
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || !owned(value)
    || process.platform !== 'win32' && (value.mode & 0o111n) !== 0n) throw unavailable();
}
async function ancestors(path: string, privateLeaf: boolean) {
  for (let current = path;; current = dirname(current)) {
    const value = await lstat(current, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink() || current === path && (!owned(value)
      || privateLeaf && process.platform !== 'win32' && (value.mode & 0o777n) !== 0o700n)) throw unavailable();
    if (current === parse(current).root) return;
  }
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const file = await open(path, constants.O_RDONLY | noFollow | noBlock);
  try { await file.sync(); } finally { await file.close(); }
}
async function writeAll(file: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten < 1) throw unavailable(); offset += result.bytesWritten;
  }
}
type CapturedFile = { path: string; stat: BigIntStats; bytes: number; sha256: string };
type CapturedDirectory = { path: string; stat: BigIntStats };

/** Capture a quiesced declared data directory as one bounded application file.
 * Regular data files and empty directories only; no archive extraction, overlay,
 * process snapshot or sealed-host assertion. Encrypt the returned file using the
 * existing Large Cyst API and restore through the existing paid-file transport.
 */
export async function captureDeclaredStateBundle(input: { sourceDirectory: string; destinationPath: string;
  maxBytes?: number; signal?: AbortSignal }): Promise<{ path: string; bytes: number; sha256: string; manifest: DeclaredStateManifest }> {
  const { signal, ...raw } = input, options = optionsSchema.parse(raw);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable();
  const source = resolve(options.sourceDirectory), destination = resolve(options.destinationPath), parent = dirname(destination);
  const location = relative(source, destination);
  if (location === '' || location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location)) throw unavailable();
  if (source.includes('\0') || destination.includes('\0')) throw unavailable();
  const limit = options.maxBytes ?? DECLARED_STATE_MAX_BYTES;
  const files: CapturedFile[] = [], directories: CapturedDirectory[] = [];
  const folded = new Set<string>(); let payloadBytes = 0;
  await ancestors(source, true); await ancestors(parent, true);
  const rootStat = await lstat(source, { bigint: true }), parentStat = await lstat(parent, { bigint: true });
  const scratch = Buffer.alloc(65_536);
  const inspect = async (file: CapturedFile, consume?: (bytes: Uint8Array) => Promise<void>) => {
    signal?.throwIfAborted();
    const path = join(source, ...file.path.split('/')), named = await lstat(path, { bigint: true }); regular(named);
    if (identity(named) !== identity(file.stat)) throw unavailable();
    const handle = await open(path, constants.O_RDONLY | noFollow | noBlock);
    try {
      const opened = await handle.stat({ bigint: true }); regular(opened);
      if (identity(opened) !== identity(named)) throw unavailable();
      let offset = 0; const hash = createHash('sha256');
      while (offset < file.bytes) {
        signal?.throwIfAborted();
        const part = await handle.read(scratch, 0, Math.min(scratch.length, file.bytes - offset), offset);
        if (part.bytesRead < 1) throw unavailable();
        const bytes = scratch.subarray(0, part.bytesRead); hash.update(bytes); await consume?.(bytes); offset += part.bytesRead;
      }
      if (identity(await handle.stat({ bigint: true })) !== identity(opened)
        || identity(await lstat(path, { bigint: true })) !== identity(opened)) throw unavailable();
      return hash.digest('hex');
    } finally { await handle.close(); }
  };
  const walk = async (path: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    const directory = await opendir(path);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      const name = declaredStatePathSchema.parse(prefix ? prefix + '/' + entry.name : entry.name), key = name.toLowerCase();
      if (folded.has(key)) throw unavailable(); folded.add(key);
      const absolute = join(source, ...name.split('/')), stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink() || !owned(stat)) throw unavailable();
      if (stat.isDirectory()) {
        if (directories.length >= DECLARED_STATE_MAX_ENTRIES) throw unavailable();
        directories.push({ path: name, stat }); await walk(absolute, name);
      } else {
        regular(stat);
        if (files.length >= DECLARED_STATE_MAX_ENTRIES || stat.size > BigInt(limit) || stat.size < 0n) throw unavailable();
        payloadBytes += Number(stat.size); if (payloadBytes > limit) throw unavailable();
        files.push({ path: name, stat, bytes: Number(stat.size), sha256: '' });
      }
    }
  };
  let temporary: string | undefined, temporaryStat: BigIntStats | undefined, published = false;
  try {
    await walk(source, '');
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    directories.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    for (const file of files) file.sha256 = await inspect(file);
    const manifest = declaredStateManifestSchema.parse({ protocol: 'telomere-declared-state-v1',
      directories: directories.map(directory => directory.path),
      files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), payloadBytes });
    const manifestBytes = encodeDeclaredStateManifest(manifest), prefix = Buffer.alloc(DECLARED_STATE_PREFIX_BYTES);
    DECLARED_STATE_MAGIC.copy(prefix); prefix.writeUInt32LE(manifestBytes.length, 8);
    const totalBytes = prefix.length + manifestBytes.length + payloadBytes;
    if (totalBytes > limit) throw unavailable();
    temporary = join(parent, '.declared-state-' + randomUUID());
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | noBlock, 0o600);
    const hash = createHash('sha256');
    try {
      temporaryStat = await handle.stat({ bigint: true });
      const emit = async (bytes: Uint8Array) => { signal?.throwIfAborted(); await writeAll(handle, bytes); hash.update(bytes); };
      await emit(prefix); await emit(manifestBytes);
      for (const file of files) if (await inspect(file, emit) !== file.sha256) throw unavailable();
      signal?.throwIfAborted(); await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameInode(after, temporaryStat) || after.size !== BigInt(totalBytes) || after.nlink !== 1n) throw unavailable();
      temporaryStat = after;
    } finally { await handle.close(); }
    for (const directory of [{ path: '', stat: rootStat }, ...directories]) {
      if (identity(await lstat(join(source, ...directory.path.split('/').filter(Boolean)), { bigint: true })) !== identity(directory.stat)) throw unavailable();
    }
    for (const file of files) if (identity(await lstat(join(source, ...file.path.split('/')), { bigint: true })) !== identity(file.stat)) throw unavailable();
    await ancestors(parent, true);
    if (!sameInode(await lstat(parent, { bigint: true }), parentStat)
      || identity(await lstat(temporary, { bigint: true })) !== identity(temporaryStat!)) throw unavailable();
    signal?.throwIfAborted();
    await link(temporary, destination); published = true;
    if (!sameInode(await lstat(destination, { bigint: true }), temporaryStat!)) throw unavailable();
    await unlink(temporary); temporary = undefined;
    await syncDirectory(parent);
    signal?.throwIfAborted();
    return { path: destination, bytes: totalBytes, sha256: hash.digest('hex'), manifest };
  } catch {
    // Never replace an existing archive or delete a foreign/replaced path.
    if (published && temporaryStat) {
      const current = await lstat(destination, { bigint: true }).catch(() => undefined);
      if (current && sameInode(current, temporaryStat)) await unlink(destination).catch(() => undefined);
    }
    throw unavailable();
  } finally {
    scratch.fill(0);
    if (temporary && temporaryStat) {
      const current = await lstat(temporary, { bigint: true }).catch(() => undefined);
      if (current && sameInode(current, temporaryStat)) await unlink(temporary).catch(() => undefined);
    }
  }
}
