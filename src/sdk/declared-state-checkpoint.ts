import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { captureDeclaredStateBundle } from './declared-state-bundle.js';

/** Whole application bundle, including its manifest; existing Lifeline bound. */
export const DECLARED_STATE_CHECKPOINT_MAX_BYTES = 4096;
const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const refused = () => new Error('Declared state checkpoint refused');
const optionsSchema = z.object({ sourceDirectory: z.string().min(1).max(4096).refine(isAbsolute),
  scratchDirectory: z.string().min(1).max(4096).refine(isAbsolute),
  sourceRunId: z.string().regex(/^0x[a-f0-9]{64}$/), operationId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
}).strict();
const inode = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;
const identity = (value: BigIntStats) => [value.dev, value.ino, value.mode, value.uid, value.gid,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(':');
const owner = (value: BigIntStats) => process.platform === 'win32' || value.uid === BigInt(process.getuid!());

async function privateDirectory(path: string): Promise<BigIntStats> {
  let result: BigIntStats | undefined;
  for (let current = path;; current = dirname(current)) {
    const value = await lstat(current, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink() || current === path && (!owner(value)
      || process.platform !== 'win32' && (value.mode & 0o777n) !== 0o700n)) throw refused();
    result ??= value;
    if (current === parse(current).root) return result;
  }
}

export type DeclaredStateCheckpointOutput = { protocol: 'telomere-paid-app-checkpoint-v1';
  sourceRunId: string; operationId: string; stateBase64: string };

/** An SDK onCyst executable can return a quiesced, small declared directory via
 * the existing paid command/output port. This accepts application data only;
 * restored roots containing the completion marker must not be captured whole.
 * The Cell CLI supplies fixed private paths. Plaintext stdout remains subject
 * to the existing non-sealed paid-session output/history contract.
 */
export async function captureDeclaredStateCheckpoint(input: {
  sourceDirectory: string; scratchDirectory: string; sourceRunId: string; operationId: string; signal?: AbortSignal;
}): Promise<DeclaredStateCheckpointOutput> {
  const { signal, ...raw } = input, checked = optionsSchema.parse(raw);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw refused();
  const source = resolve(checked.sourceDirectory), scratch = resolve(checked.scratchDirectory);
  if (source.includes('\0') || scratch.includes('\0')) throw refused();
  signal?.throwIfAborted();
  await privateDirectory(source); const parent = await privateDirectory(scratch);
  const directory = await mkdtemp(join(scratch, '.capture-'));
  let directoryInfo: BigIntStats | undefined, fileInfo: BigIntStats | undefined, file: FileHandle | undefined;
  let bytes: Buffer | undefined, result: DeclaredStateCheckpointOutput | undefined, failed = false;
  const path = join(directory, 'state.bin');
  try {
    directoryInfo = await privateDirectory(directory);
    const captured = await captureDeclaredStateBundle({ sourceDirectory: source, destinationPath: path,
      maxBytes: DECLARED_STATE_CHECKPOINT_MAX_BYTES, ...(signal ? { signal } : {}) });
    fileInfo = await lstat(path, { bigint: true });
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || !owner(fileInfo) || fileInfo.nlink !== 1n
      || fileInfo.size !== BigInt(captured.bytes) || fileInfo.size < 1n || fileInfo.size > BigInt(DECLARED_STATE_CHECKPOINT_MAX_BYTES)
      || process.platform !== 'win32' && (fileInfo.mode & 0o777n) !== 0o600n) throw refused();
    file = await open(path, constants.O_RDWR | noFollow | (constants.O_NONBLOCK ?? 0));
    if (identity(await file.stat({ bigint: true })) !== identity(fileInfo)) throw refused();
    bytes = Buffer.alloc(captured.bytes); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead < 1) throw refused(); offset += read.bytesRead;
    }
    if (identity(await file.stat({ bigint: true })) !== identity(fileInfo)
      || identity(await lstat(path, { bigint: true })) !== identity(fileInfo)
      || createHash('sha256').update(bytes).digest('hex') !== captured.sha256) throw refused();
    signal?.throwIfAborted();
    result = { protocol: 'telomere-paid-app-checkpoint-v1', sourceRunId: checked.sourceRunId,
      operationId: checked.operationId, stateBase64: bytes.toString('base64') };
  } catch { failed = true; }
  finally {
    bytes?.fill(0);
    try {
      if (file && fileInfo) {
        if (!directoryInfo || !inode(await privateDirectory(directory), directoryInfo)
          || !inode(await privateDirectory(scratch), parent)
          || !inode(await lstat(path, { bigint: true }), fileInfo)
          || (await file.stat({ bigint: true })).nlink !== 1n) throw refused();
        const zeros = Buffer.alloc(Number(fileInfo.size)); let offset = 0;
        while (offset < zeros.length) {
          const written = await file.write(zeros, offset, zeros.length - offset, offset);
          if (written.bytesWritten < 1) throw refused(); offset += written.bytesWritten;
        }
        await file.sync();
        if (!inode(await lstat(path, { bigint: true }), fileInfo)
          || (await file.stat({ bigint: true })).nlink !== 1n) throw refused();
        await file.close(); file = undefined;
        if (!inode(await privateDirectory(directory), directoryInfo)
          || !inode(await privateDirectory(scratch), parent)
          || !inode(await lstat(path, { bigint: true }), fileInfo)) throw refused();
        await unlink(path);
      }
      if (!directoryInfo || !inode(await privateDirectory(directory), directoryInfo)
        || !inode(await privateDirectory(scratch), parent)) throw refused();
      await rmdir(directory);
    } catch { failed = true; }
    finally { await file?.close().catch(() => undefined); }
  }
  signal?.throwIfAborted();
  if (failed || !result) throw refused();
  return result;
}
