import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DECLARED_STATE_MAX_BYTES, DECLARED_STATE_MAX_MANIFEST_BYTES, DECLARED_STATE_PREFIX_BYTES,
  DECLARED_STATE_RECEIPT, decodeDeclaredStateManifest, type DeclaredStateManifest } from '../cysts/declared-state-protocol.js';

const optionsSchema = z.object({ bundlePath: z.string().min(1).max(4096), destinationDirectory: z.string().min(1).max(4096),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedBytes: z.number().int().min(DECLARED_STATE_PREFIX_BYTES + 1).max(DECLARED_STATE_MAX_BYTES),
  signal: z.custom<AbortSignal>(value => value instanceof AbortSignal).optional() }).strict();
const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const noBlock = constants.O_NONBLOCK ?? 0;
const unavailable = () => new Error('Declared state restore refused');
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
type Owned = { path: string; directory: boolean; dev: bigint; ino: bigint };
const same = (entry: Pick<Owned, 'dev' | 'ino'>, stat: BigIntStats) => entry.dev === stat.dev && entry.ino === stat.ino;
const fingerprint = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs,
  stat.mode, stat.nlink, stat.uid, stat.gid].map(value => value.toString()).join(':');

function directory(stat: BigIntStats, privateEntry: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || privateEntry && process.platform !== 'win32'
    && ((stat.mode & 0o777n) !== 0o700n || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) throw unavailable();
}
function sourceFile(stat: BigIntStats, bytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size !== BigInt(bytes)
    || process.platform !== 'win32' && ![0o400n, 0o444n, 0o600n].includes(stat.mode & 0o777n)) throw unavailable();
}
async function ancestors(path: string, privateParent: boolean): Promise<Owned[]> {
  const values: Owned[] = [];
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current, { bigint: true }); directory(stat, privateParent && current === path);
    values.push({ path: current, directory: true, dev: stat.dev, ino: stat.ino });
    if (current === parse(current).root) return values;
  }
}
async function checkDirectories(entries: readonly Owned[]): Promise<void> {
  for (const entry of entries) {
    const stat = await lstat(entry.path, { bigint: true }); directory(stat, false);
    if (!same(entry, stat)) throw unavailable();
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try { await file.sync(); } finally { await file.close(); }
}
async function trackedDirectory(path: string, entries: Owned[]): Promise<Owned> {
  await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path, { bigint: true }); directory(stat, true);
  const entry = { path, directory: true, dev: stat.dev, ino: stat.ino }; entries.push(entry); return entry;
}
async function checkOwned(entry: Owned): Promise<BigIntStats> {
  const stat = await lstat(entry.path, { bigint: true });
  if (!same(entry, stat) || stat.isSymbolicLink()) throw unavailable();
  if (entry.directory) directory(stat, true);
  else if (!stat.isFile() || process.platform !== 'win32' && ((stat.mode & 0o777n) !== 0o600n
    || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) throw unavailable();
  return stat;
}
/** Remove only entries whose original inode and complete ancestor chain survive.
 * Unknown entries/links are left in place; no recursive delete is used. */
async function cleanup(entries: readonly Owned[], parent: readonly Owned[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    try {
      await checkDirectories(parent);
      const trackedParents = entries.filter(value => value.directory && entry.path.startsWith(value.path + sep));
      await checkDirectories(trackedParents);
      const stat = await checkOwned(entry);
      if (entry.directory) { if ((await readdir(entry.path)).length === 0) await rmdir(entry.path); }
      else {
        let knownLinks = 0n;
        for (const candidate of entries.filter(value => !value.directory && same(value, stat))) {
          try { if (same(candidate, await lstat(candidate.path, { bigint: true }))) knownLinks++; } catch (error) { if (!absent(error)) throw error; }
        }
        if (knownLinks === stat.nlink) await unlink(entry.path);
      }
    } catch { /* A replaced/unknown entry must remain held for explicit recovery. */ }
  }
}

export type DeclaredStateRestoreResult = { directory: string; manifest: DeclaredStateManifest; bytes: number; sha256: string };

/** Bounded application data only. The destination is exclusively claimed after
 * input verification; its completion receipt is published last. This is not an
 * atomic directory rename, an overlay/VM restore or a host-side archive extractor.
 * Existing destinations are always refused, including interrupted operations. */
export async function restoreDeclaredStateBundle(raw: {
  bundlePath: string; destinationDirectory: string; expectedSha256: string; expectedBytes: number; signal?: AbortSignal;
}): Promise<DeclaredStateRestoreResult> {
  const owned: Owned[] = []; let parent: Owned[] = [], source: FileHandle | undefined;
  let claimed: Owned | undefined, binding: { bytes: number; sha256: string } | undefined;
  try {
    const options = optionsSchema.parse(raw), { signal } = options;
    binding = { bytes: options.expectedBytes, sha256: options.expectedSha256 };
    if (!isAbsolute(options.bundlePath) || !isAbsolute(options.destinationDirectory)
      || options.bundlePath.includes('\0') || options.destinationDirectory.includes('\0')) throw unavailable();
    const bundlePath = resolve(options.bundlePath), destination = resolve(options.destinationDirectory), destinationParent = dirname(destination);
    if (destination === parse(destination).root || bundlePath === destination || bundlePath.startsWith(destination + sep)) throw unavailable();
    signal?.throwIfAborted();
    parent = await ancestors(destinationParent, true);
    const sourceParents = await ancestors(dirname(bundlePath), false);
    try { await lstat(destination); throw unavailable(); } catch (error) { if (!absent(error)) throw error; }
    const before = await lstat(bundlePath, { bigint: true }); sourceFile(before, options.expectedBytes);
    source = await open(bundlePath, constants.O_RDONLY | noFollow | noBlock);
    const originalSource = fingerprint(before);
    const unchangedSource = async () => {
      await checkDirectories(sourceParents); await checkDirectories(parent);
      const opened = await source!.stat({ bigint: true }), named = await lstat(bundlePath, { bigint: true });
      sourceFile(opened, options.expectedBytes); sourceFile(named, options.expectedBytes);
      if (fingerprint(opened) !== originalSource || fingerprint(named) !== originalSource) throw unavailable();
      signal?.throwIfAborted();
    };
    await unchangedSource();
    const whole = createHash('sha256'); let offset = 0;
    const read = async (length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length); let completed = 0;
      while (completed < length) {
        signal?.throwIfAborted();
        const part = await source!.read(buffer, completed, length - completed, offset + completed);
        if (!part.bytesRead) throw unavailable(); completed += part.bytesRead;
      }
      whole.update(buffer); offset += length; return buffer;
    };
    const prefix = await read(DECLARED_STATE_PREFIX_BYTES), manifestLength = prefix.readUInt32LE(8);
    if (manifestLength < 1 || manifestLength > DECLARED_STATE_MAX_MANIFEST_BYTES
      || manifestLength > options.expectedBytes - DECLARED_STATE_PREFIX_BYTES) throw unavailable();
    const manifestBytes = await read(manifestLength), manifest = decodeDeclaredStateManifest(prefix, manifestBytes);
    if (DECLARED_STATE_PREFIX_BYTES + manifestLength + manifest.payloadBytes !== options.expectedBytes) throw unavailable();
    const stage = await mkdtemp(join(destinationParent, '.telomere-declared-state-'));
    const stageStat = await lstat(stage, { bigint: true }); directory(stageStat, true);
    owned.push({ path: stage, directory: true, dev: stageStat.dev, ino: stageStat.ino });
    const parentsIntact = async (path: string) => {
      await checkDirectories(parent);
      for (const entry of owned.filter(value => value.directory && (path === value.path || path.startsWith(value.path + sep)))) await checkOwned(entry);
    };
    for (const path of manifest.directories) { signal?.throwIfAborted(); await parentsIntact(join(stage, path)); await trackedDirectory(join(stage, path), owned); }
    for (const item of manifest.files) {
      signal?.throwIfAborted();
      const path = join(stage, item.path); await parentsIntact(path);
      const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      try {
        const stat = await output.stat({ bigint: true }); owned.push({ path, directory: false, dev: stat.dev, ino: stat.ino });
        const digest = createHash('sha256'); let remaining = item.bytes;
        while (remaining > 0) {
          const bytes = await read(Math.min(65_536, remaining));
          try { digest.update(bytes); await output.writeFile(bytes); remaining -= bytes.length; } finally { bytes.fill(0); }
        }
        if (digest.digest('hex') !== item.sha256) throw unavailable();
        await output.sync();
      } finally { await output.close(); }
    }
    if (offset !== options.expectedBytes || whole.digest('hex') !== options.expectedSha256) throw unavailable();
    await unchangedSource();
    for (const entry of owned) await checkOwned(entry);
    const destinationEntry = await trackedDirectory(destination, owned); claimed = destinationEntry; // mkdir is the exclusive no-overwrite claim.
    for (const path of manifest.directories) { signal?.throwIfAborted(); await parentsIntact(join(destination, path)); await trackedDirectory(join(destination, path), owned); }
    for (const item of manifest.files) {
      signal?.throwIfAborted(); await checkOwned(destinationEntry);
      const from = join(stage, item.path), target = join(destination, item.path);
      await parentsIntact(from); await parentsIntact(target);
      const entry = owned.find(value => value.path === from)!; const stat = await checkOwned(entry);
      if (stat.nlink !== 1n) throw unavailable();
      await link(from, target); // Atomic EEXIST refusal, including an empty/foreign target.
      owned.push({ path: target, directory: false, dev: stat.dev, ino: stat.ino });
      if (!same(entry, await lstat(target, { bigint: true })) || (await checkOwned(entry)).nlink !== 2n) throw unavailable();
      await unlink(from);
    }
    // Verify the exact final tree, not just the names we intended to create.
    const expected = new Map<string, string[]>(); expected.set('', []);
    for (const path of [...manifest.directories, ...manifest.files.map(item => item.path)]) {
      const at = path.lastIndexOf('/'), directoryPath = at < 0 ? '' : path.slice(0, at), name = path.slice(at + 1);
      const names = expected.get(directoryPath) ?? []; names.push(name); expected.set(directoryPath, names);
      if (manifest.directories.includes(path) && !expected.has(path)) expected.set(path, []);
    }
    for (const [path, names] of expected) {
      const entry = owned.find(value => value.path === (path ? join(destination, path) : destination))!;
      await checkOwned(entry);
      if (JSON.stringify((await readdir(entry.path)).sort()) !== JSON.stringify(names.sort())) throw unavailable();
      await syncDirectory(entry.path);
    }
    for (const item of manifest.files) {
      const entry = owned.find(value => value.path === join(destination, item.path))!;
      const stat = await checkOwned(entry); if (stat.nlink !== 1n || stat.size !== BigInt(item.bytes)) throw unavailable();
      const input = await open(entry.path, constants.O_RDONLY | noFollow | noBlock);
      try {
        if (fingerprint(stat) !== fingerprint(await input.stat({ bigint: true }))) throw unavailable();
        const digest = createHash('sha256'), buffer = Buffer.alloc(65_536); let completed = 0;
        try { while (completed < item.bytes) {
          signal?.throwIfAborted(); const part = await input.read(buffer, 0, Math.min(buffer.length, item.bytes - completed), completed);
          if (!part.bytesRead) throw unavailable(); digest.update(buffer.subarray(0, part.bytesRead)); completed += part.bytesRead;
        } } finally { buffer.fill(0); }
        if (digest.digest('hex') !== item.sha256 || fingerprint(stat) !== fingerprint(await input.stat({ bigint: true }))
          || fingerprint(stat) !== fingerprint(await checkOwned(entry))) throw unavailable();
      } finally { await input.close(); }
    }
    await unchangedSource(); await checkOwned(destinationEntry);
    const receiptPath = join(destination, DECLARED_STATE_RECEIPT);
    const receipt = await open(receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      const stat = await receipt.stat({ bigint: true }); owned.push({ path: receiptPath, directory: false, dev: stat.dev, ino: stat.ino });
      await receipt.writeFile(JSON.stringify({ protocol: 'telomere-declared-state-restore-v1', status: 'complete',
        bytes: options.expectedBytes, sha256: options.expectedSha256, manifest })); await receipt.sync();
    } finally { await receipt.close(); }
    await syncDirectory(destination); await syncDirectory(destinationParent);
    // Only empty stage directories remain; cleanup cannot touch the published destination.
    await cleanup(owned.filter(entry => entry.path === stage || entry.path.startsWith(stage + sep)), parent);
    signal?.throwIfAborted();
    return { directory: destination, manifest, bytes: options.expectedBytes, sha256: options.expectedSha256 };
  } catch {
    await cleanup(owned, parent);
    // An uncertain cleanup must remain private and unusable. Never overwrite a
    // marker or remove an unknown child merely to make the directory reusable.
    if (claimed && binding) try {
      await checkDirectories(parent); await checkOwned(claimed);
      const marker = await open(join(claimed.path, DECLARED_STATE_RECEIPT), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      try { await marker.writeFile(JSON.stringify({ protocol: 'telomere-declared-state-restore-v1', status: 'failed', ...binding })); await marker.sync(); }
      finally { await marker.close(); }
      await syncDirectory(claimed.path);
    } catch { /* A missing/replaced root or foreign marker is never changed. */ }
    throw unavailable();
  }
  finally { await source?.close().catch(() => undefined); }
}
