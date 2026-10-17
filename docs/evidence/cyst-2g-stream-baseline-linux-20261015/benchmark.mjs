import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { freemem, totalmem, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LARGE_CYST_CHUNK_BYTES, LARGE_CYST_MAX_PACKAGE_BYTES, LARGE_CYST_MAX_PLAINTEXT_BYTES,
  LargeCystPrivateStore, generateLargeCystId, saveLargeCystFile, restoreLargeCystFile }
  from '/opt/telomere-host-runtime/golem-protocol-20261015-dfad08e3322c/dist/src/cysts/large-checkpoints.js';

const base = '/opt/telomere-host-runtime/golem-protocol-20261015-dfad08e3322c';
const [work] = process.argv.slice(2), parent = '/opt/telomere-host-runtime';
if (!work || dirname(work) !== parent || !/^cyst-2g-stream-20261015-[a-f0-9]{24}$/.test(work.slice(parent.length + 1)) || resolve(work) !== work) throw new Error('Scope');
const bound = 2_147_221_504, expected = '8b72749fb55fb1903aa284ae89bcf241e9565d8fb1146e23f8954cbf5cd643bc';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const proofPaths = ['src/cysts/large-checkpoints.ts', 'dist/src/cysts/large-checkpoints.js', 'src/sdk/cyst-key-wrap.ts',
  'dist/src/sdk/cyst-key-wrap.js', 'src/cysts/types.ts', 'dist/src/cysts/types.js', 'package-lock.json',
  'node_modules/@noble/ciphers/package.json', 'node_modules/@noble/ciphers/chacha.js',
  'node_modules/@noble/ciphers/_arx.js', 'node_modules/@noble/ciphers/_poly1305.js', 'node_modules/@noble/ciphers/utils.js'];
async function inventory() {
  const rows = [];
  for (const path of proofPaths) { const bytes = await readFile(join(base, path)); rows.push({ path, bytes: bytes.length, sha256: sha(bytes) }); }
  return rows;
}
const inventoryBefore = await inventory();
if (inventoryBefore[0].sha256 !== expected || LARGE_CYST_MAX_PLAINTEXT_BYTES !== bound || LARGE_CYST_CHUNK_BYTES !== 4_194_304) throw new Error('Source pin');
const named = await lstat(work); if (!named.isDirectory() || named.isSymbolicLink() || (named.mode & 0o777) !== 0o700 || named.uid !== process.getuid()) throw new Error('Private work');
const startedAtUtc = new Date().toISOString(), started = performance.now(), deadline = started + 900_000;
let peakRssBytes = process.memoryUsage().rss, minFreeMemoryBytes = freemem(), minFreeDiskBytes = Number.MAX_SAFE_INTEGER, monitorBusy = false;
async function resources(stage) {
  if (performance.now() > deadline) throw new Error('Benchmark deadline');
  const fs = await statfs(work, { bigint: true }), freeDiskBytes = Number(fs.bavail * fs.bsize), availableMemoryBytes = freemem();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); minFreeMemoryBytes = Math.min(minFreeMemoryBytes, availableMemoryBytes);
  minFreeDiskBytes = Math.min(minFreeDiskBytes, freeDiskBytes);
  if (freeDiskBytes < 8 * 1024 ** 3 || availableMemoryBytes < 512 * 1024 ** 2) throw new Error('Headroom');
  return { stage, freeDiskBytes, freeMemoryBytes: availableMemoryBytes, rssBytes: process.memoryUsage().rss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024, cpu: process.cpuUsage() };
}
const resourceBefore = await resources('before');
if (resourceBefore.freeDiskBytes < 12 * 1024 ** 3 || resourceBefore.freeMemoryBytes < 2 * 1024 ** 3) throw new Error('Initial headroom');
const monitor = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); minFreeMemoryBytes = Math.min(minFreeMemoryBytes, freemem());
  if (monitorBusy) return; monitorBusy = true;
  void resources('sample').catch(() => undefined).finally(() => { monitorBusy = false; });
}, 250); monitor.unref();
const progress = async (phase, extra = {}) => writeFile(join(work, 'progress.json'), JSON.stringify({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...extra }), { mode: 0o600 });
const phases = [];
async function phase(name, action) {
  await progress(name); const wall = performance.now(), cpu = process.cpuUsage(), before = await resources(name + '-before');
  const value = await action(), durationMs = performance.now() - wall, usage = process.cpuUsage(cpu), after = await resources(name + '-after');
  phases.push({ name, durationMs, cpuUserMicros: usage.user, cpuSystemMicros: usage.system, before, after });
  await progress(name + '-complete', { durationMs }); return value;
}
const sourcePath = join(work, 'source.bin'), cipher = join(work, 'ciphertext'), restored = join(work, 'restored');
await mkdir(cipher, { mode: 0o700 }); await mkdir(restored, { mode: 0o700 });
const destinationPath = join(restored, 'state.bin'), id = generateLargeCystId(), recoveryKey = randomBytes(32);
const scope = { owner: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), applicationSchema: 'cyst-2g-full-regular-benchmark/v1' };
let store, sourceDigest, manifest, restoredReads = 0;
try {
  sourceDigest = await phase('generate-full-regular-source', async () => {
    const file = await open(sourcePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const whole = createHash('sha256'), buffer = Buffer.alloc(LARGE_CYST_CHUNK_BYTES);
    try {
      for (let index = 0, offset = 0; offset < bound; index++) {
        const bytes = Math.min(buffer.length, bound - offset), seed = createHash('sha256').update('telomere.cyst.2g-stream-20261015:' + index).digest();
        buffer.fill(seed); const part = buffer.subarray(0, bytes); whole.update(part); await file.writeFile(part); offset += bytes;
        if (index % 32 === 0) await resources('generate-' + index);
      }
      await file.sync(); return whole.digest('hex');
    } finally { buffer.fill(0); await file.close(); }
  });
  const source = await lstat(sourcePath, { bigint: true });
  if (!source.isFile() || source.nlink !== 1n || source.size !== BigInt(bound) || source.blocks * 512n < source.size) throw new Error('Sparse source');
  store = new LargeCystPrivateStore(cipher, { globalMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES, ownerMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES });
  manifest = await phase('save-encrypted-large-cyst', async () => {
    await store.initialize(); return saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey,
      onProgress: async completed => { if (completed % 16 === 0) await resources('save-' + completed); } });
  });
  await phase('close-store', () => store.close()); store = undefined;
  await phase('reopen-and-check-manifest', async () => {
    store = new LargeCystPrivateStore(cipher, { globalMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES, ownerMaxBytes: LARGE_CYST_MAX_PACKAGE_BYTES });
    await store.initialize(); const saved = await store.manifest(id);
    if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error('Manifest changed');
  });
  await phase('restore-authenticated-large-cyst', () => restoreLargeCystFile({ id, destinationPath, scope, recoveryKey,
    store: { header: (...args) => store.header(...args), manifest: (...args) => store.manifest(...args), part: async (...args) => {
      const value = await store.part(...args); restoredReads++; if (restoredReads % 16 === 0) await resources('restore-' + restoredReads); return value;
    } } }));
  const digests = await phase('independent-byte-and-sha256-verification', async () => {
    const left = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW), right = await open(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const a = Buffer.alloc(LARGE_CYST_CHUNK_BYTES), b = Buffer.alloc(LARGE_CYST_CHUNK_BYTES), ah = createHash('sha256'), bh = createHash('sha256');
    const readExact = async (file, buffer, length, offset) => {
      let completed = 0; while (completed < length) { const r = await file.read(buffer, completed, length - completed, offset + completed); if (!r.bytesRead) throw new Error('Truncated'); completed += r.bytesRead; }
    };
    try {
      for (let offset = 0; offset < bound; offset += a.length) {
        const bytes = Math.min(a.length, bound - offset); await readExact(left, a, bytes, offset); await readExact(right, b, bytes, offset);
        if (!a.subarray(0, bytes).equals(b.subarray(0, bytes))) throw new Error('Bytes differ');
        ah.update(a.subarray(0, bytes)); bh.update(b.subarray(0, bytes));
      }
      const sourceSha256 = ah.digest('hex'), restoredSha256 = bh.digest('hex');
      if (sourceSha256 !== sourceDigest || restoredSha256 !== sourceDigest) throw new Error('Digest differs');
      return { generationSha256: sourceDigest, sourceSha256, restoredSha256, everyByteCompared: true };
    } finally { a.fill(0); b.fill(0); await left.close(); await right.close(); }
  });
  await phase('final-store-close', () => store.close()); store = undefined;
  const inventoryAfter = await inventory(); if (JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter)) throw new Error('Code changed');
  const [sourceInfo, restoredInfo] = await Promise.all([lstat(sourcePath, { bigint: true }), lstat(destinationPath, { bigint: true })]);
  const checkpointDirectory = join(cipher, id.slice(2)), names = await readdir(checkpointDirectory), parts = names.filter(name => /^part-[0-9]{6}\.bin$/.test(name));
  let cipherBytes = 0, cipherAllocatedBytes = 0;
  for (const name of names) { const stat = await lstat(join(checkpointDirectory, name), { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Cipher inventory'); cipherBytes += Number(stat.size); cipherAllocatedBytes += Number(stat.blocks * 512n); }
  if (parts.length !== 512 || restoredReads !== 512 || sourceInfo.size !== BigInt(bound) || restoredInfo.size !== BigInt(bound)
    || restoredInfo.blocks * 512n < restoredInfo.size || cipherBytes > LARGE_CYST_MAX_PACKAGE_BYTES) throw new Error('Boundary mismatch');
  const resourceAfter = await resources('after');
  const report = { schema: 1, status: 'passed', startedAtUtc, finishedAtUtc: new Date().toISOString(), libraryRevision: '5b31957bce5c2dabc50a2ca23d43906a1612fc13',
    libraryBase: base, work, runtime: { node: process.version, openssl: process.versions.openssl, cpuModels: [...new Set(cpus().map(cpu => cpu.model))], logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    sourceBytes: bound, restoredBytes: Number(restoredInfo.size), chunkBytes: LARGE_CYST_CHUNK_BYTES, partCount: parts.length,
    sourceAllocatedBytes: Number(sourceInfo.blocks * 512n), restoredAllocatedBytes: Number(restoredInfo.blocks * 512n), cipherBytes, cipherAllocatedBytes,
    sourceGeneration: 'Every byte written; perchunk SHA256(namespace:index)32-byte pattern fills4MiBbuffer; no truncate/sparse generation.',
    phases, ...digests, inventoryBefore, inventoryAfter, sourceChangedDuringRun: false, resourceBefore, resourceAfter,
    peakRssBytes: Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024), minFreeMemoryBytes, minFreeDiskBytes, totalMs: performance.now() - started,
    limits: ['Local private-store encrypted streaming only; no HTTP/S3/provider/registry/paid admission/Cell restore/writable filesystem claim.',
      'Existing ordinary Cell bundle/scratch caps unchanged; not2GiB Cell writable-tree acceptance.', 'Shared VPS; concurrent unrelated workloads/cold-cache effects not controlled.',
      'Resource checks every16parts included in measured restore.', 'Ephemeral benchmark recovery key only in process memory and cleared; never logged/saved.'],
    ownedFilesPreserved: true };
  await writeFile(join(work, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await progress('complete');
  process.stdout.write(JSON.stringify({ status: 'passed', restoreMs: phases.find(row => row.name === 'restore-authenticated-large-cyst').durationMs,
    peakRssBytes: report.peakRssBytes, sourceSha256: digests.sourceSha256 }) + '\n');
} catch (error) {
  const report = { schema: 1, status: 'failed', at: new Date().toISOString(), code: typeof error?.code === 'string' ? error.code : 'benchmark_failed',
    phases, inventoryBefore, totalMs: performance.now() - started, ownedFilesPreserved: true };
  await writeFile(join(work, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); process.exitCode = 1;
} finally { clearInterval(monitor); recoveryKey.fill(0); if (store) await store.close(); }
