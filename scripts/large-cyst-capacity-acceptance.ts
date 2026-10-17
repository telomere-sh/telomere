import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, stat, statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LARGE_CYST_CHUNK_BYTES, LARGE_CYST_MAX_PACKAGE_BYTES,
  LARGE_CYST_MAX_PLAINTEXT_BYTES, LargeCystPrivateStore, generateLargeCystId,
  restoreLargeCystFile, saveLargeCystFile } from '../src/cysts/large-checkpoints.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MIN_START_DISK = 12 * GIB;
const MIN_CONTINUE_DISK = 8 * GIB;
const MIN_START_MEMORY = 2 * GIB;
const MIN_CONTINUE_MEMORY = 512 * MIB;
const scope = { owner: `0x${'11'.repeat(20)}`, agent: `0x${'22'.repeat(20)}`,
  applicationSchema: 'capacity-acceptance/v1' };

async function availableDisk(path: string): Promise<number> {
  const value = await statfs(path, { bigint: true });
  return Number(value.bavail * value.bsize);
}

function requireHeadroom(disk: number, memory: number, phase: string,
  diskMinimum = MIN_CONTINUE_DISK, memoryMinimum = MIN_CONTINUE_MEMORY): void {
  if (disk < diskMinimum || memory < memoryMinimum) {
    throw new Error(`Capacity acceptance stopped at ${phase}: insufficient disk or memory headroom`);
  }
}

async function readExact(file: Awaited<ReturnType<typeof open>>, buffer: Buffer,
  length: number, offset: number): Promise<void> {
  let received = 0;
  while (received < length) {
    const result = await file.read(buffer, received, length - received, offset + received);
    if (result.bytesRead === 0) throw new Error(`Unexpected EOF at offset ${offset + received}`);
    received += result.bytesRead;
  }
}

async function compareEveryByte(sourcePath: string, restoredPath: string, expectedBytes: number) {
  const first = await open(sourcePath, 'r'), second = await open(restoredPath, 'r');
  const firstHash = createHash('sha256'), secondHash = createHash('sha256');
  const sourceBuffer = Buffer.alloc(LARGE_CYST_CHUNK_BYTES);
  const restoredBuffer = Buffer.alloc(LARGE_CYST_CHUNK_BYTES);
  try {
    for (let offset = 0; offset < expectedBytes; offset += LARGE_CYST_CHUNK_BYTES) {
      const length = Math.min(LARGE_CYST_CHUNK_BYTES, expectedBytes - offset);
      await readExact(first, sourceBuffer, length, offset);
      await readExact(second, restoredBuffer, length, offset);
      const sourceChunk = sourceBuffer.subarray(0, length);
      const restoredChunk = restoredBuffer.subarray(0, length);
      if (!sourceChunk.equals(restoredChunk)) throw new Error(`Restored bytes differ at chunk ${offset / LARGE_CYST_CHUNK_BYTES}`);
      firstHash.update(sourceChunk); secondHash.update(restoredChunk);
    }
    const originalSha256 = firstHash.digest('hex'), restoredSha256 = secondHash.digest('hex');
    if (originalSha256 !== restoredSha256) throw new Error('Whole-file digests differ');
    return { originalSha256, restoredSha256 };
  } finally {
    sourceBuffer.fill(0); restoredBuffer.fill(0);
    await Promise.all([first.close(), second.close()]);
  }
}

async function main() {
  const [mode, requestedRoot] = process.argv.slice(2);
  if ((mode !== 'smoke' && mode !== 'boundary') || !requestedRoot) {
    throw new Error('Usage: tsx scripts/large-cyst-capacity-acceptance.ts <smoke|boundary> <new-absolute-telomere-large-cyst-accept-* directory>');
  }
  const root = resolve(requestedRoot);
  if (root !== requestedRoot || !basename(root).startsWith('telomere-large-cyst-accept-')) {
    throw new Error('Acceptance directory must be a new absolute path with the expected basename prefix');
  }
  const parent = dirname(root), initialDisk = await availableDisk(parent), initialMemory = freemem();
  requireHeadroom(initialDisk, initialMemory, 'preflight', MIN_START_DISK, MIN_START_MEMORY);
  const sourceBytes = mode === 'boundary' ? LARGE_CYST_MAX_PLAINTEXT_BYTES : LARGE_CYST_CHUNK_BYTES + 19;
  const rootStart = performance.now();
  await mkdir(root);
  const cipherDir = join(root, 'ciphertext'), restoredDir = join(root, 'restored');
  await mkdir(cipherDir); await mkdir(restoredDir);
  const sourcePath = join(root, 'source.bin'), restoredPath = join(restoredDir, 'restored.bin');
  let peakRss = process.memoryUsage().rss, minFreeMemory = initialMemory, minFreeDisk = initialDisk;
  let critical: string | undefined;
  const check = async (phase: string) => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const disk = await availableDisk(root), memory = freemem();
    minFreeMemory = Math.min(minFreeMemory, memory); minFreeDisk = Math.min(minFreeDisk, disk);
    try { requireHeadroom(disk, memory, phase); }
    catch { critical = phase; throw new Error(`Capacity acceptance stopped at ${phase}: insufficient disk or memory headroom`); }
  };
  const monitor = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    minFreeMemory = Math.min(minFreeMemory, freemem());
  }, 250);
  monitor.unref();
  const key = randomBytes(32), id = generateLargeCystId();
  let store: LargeCystPrivateStore | undefined;
  try {
    const source = await open(sourcePath, 'wx');
    try {
      await source.truncate(sourceBytes);
      // Distinct deterministic marker in every chunk; the rest is zero-filled.
      // The Cyst writer still reads, encrypts, writes and verifies all bytes.
      const chunks = Math.ceil(sourceBytes / LARGE_CYST_CHUNK_BYTES);
      for (let index = 0; index < chunks; index++) {
        const marker = createHash('sha256').update(`telomere.large-cyst.capacity.v1:${index}`).digest();
        const remaining = sourceBytes - index * LARGE_CYST_CHUNK_BYTES;
        await source.write(marker, 0, Math.min(marker.length, remaining), index * LARGE_CYST_CHUNK_BYTES);
      }
      await source.sync();
    } finally { await source.close(); }
    await check('source-created');
    const publishStart = performance.now();
    store = new LargeCystPrivateStore(cipherDir, {
      globalMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES, ownerMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES,
    });
    await store.initialize();
    const manifest = await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key,
      onProgress: async completed => { if (completed % 16 === 0) await check(`publish-part-${completed}`); } });
    const publishMs = performance.now() - publishStart;
    await check('published');
    await store.close(); store = undefined;
    const reopenStart = performance.now();
    store = new LargeCystPrivateStore(cipherDir, {
      globalMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES, ownerMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES,
    });
    await store.initialize();
    const reopened = await store.manifest(id);
    if (!reopened || JSON.stringify(reopened) !== JSON.stringify(manifest)) throw new Error('Committed manifest changed after restart');
    const reopenMs = performance.now() - reopenStart;
    const restoreStart = performance.now();
    await restoreLargeCystFile({ store, id, destinationPath: restoredPath, scope, recoveryKey: key });
    const restoreMs = performance.now() - restoreStart;
    await check('restored');
    if (critical) throw new Error(`Headroom breached at ${critical}`);
    const compareStart = performance.now();
    const { originalSha256, restoredSha256 } = await compareEveryByte(sourcePath, restoredPath, sourceBytes);
    const compareMs = performance.now() - compareStart;
    const [sourceInfo, restoredInfo, entries] = await Promise.all([
      stat(sourcePath), stat(restoredPath), readdir(join(cipherDir, id.slice(2))),
    ]);
    const partCount = entries.filter(name => /^part-[0-9]{6}\.bin$/.test(name)).length;
    const packageBytes = Buffer.byteLength(JSON.stringify(manifest.header))
      + Buffer.byteLength(JSON.stringify(manifest)) + manifest.parts.reduce((sum, part) => sum + part.bytes, 0);
    if (sourceInfo.size !== sourceBytes || restoredInfo.size !== sourceBytes
      || partCount !== Math.ceil(sourceBytes / LARGE_CYST_CHUNK_BYTES)
      || packageBytes > LARGE_CYST_MAX_PACKAGE_BYTES) throw new Error('Boundary accounting mismatch');
    await store.close(); store = undefined;
    await check('complete');
    console.log(JSON.stringify({ status: 'passed', mode, sourceBytes, restoredBytes: restoredInfo.size,
      partCount, packageBytes, packageLimitBytes: LARGE_CYST_MAX_PACKAGE_BYTES,
      byteForByteCompared: true, originalSha256, restoredSha256,
      publishMs: Math.round(publishMs), reopenMs: Math.round(reopenMs),
      restoreMs: Math.round(restoreMs), compareMs: Math.round(compareMs),
      totalMs: Math.round(performance.now() - rootStart), peakRssBytes: peakRss,
      initialFreeMemoryBytes: initialMemory, minFreeMemoryBytes: minFreeMemory,
      initialFreeDiskBytes: initialDisk, minFreeDiskBytes: minFreeDisk }, null, 2));
  } finally { clearInterval(monitor); key.fill(0); if (store) await store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
