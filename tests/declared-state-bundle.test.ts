import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeDeclaredStateManifest, declaredStateManifestSchema, declaredStatePathSchema,
  DECLARED_STATE_PREFIX_BYTES } from '../src/cysts/declared-state-protocol.js';
import { captureDeclaredStateBundle } from '../src/sdk/declared-state-bundle.js';

const owned: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) {
    const absolute = resolve(path);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('telomere-declared-capture-')
      || (await lstat(absolute)).isSymbolicLink()) throw new Error('Temporary test directory is outside its owned scope');
    await rm(absolute, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'telomere-declared-capture-')); owned.push(root);
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  await mkdir(join(source, 'nested'), { mode: 0o700 }); await mkdir(join(source, 'empty'), { mode: 0o700 });
  await writeFile(join(source, 'counter.json'), '{"counter":71}', { mode: 0o600 });
  await writeFile(join(source, 'nested', 'memory.txt'), 'persistent agent memory\n', { mode: 0o600 });
  await writeFile(join(source, 'zero.bin'), '', { mode: 0o600 });
  return { root, source, destination: join(root, 'state.bin') };
}
describe('bounded declared directory capture for the existing encrypted Cyst file pipeline', () => {
  it('captures nested data and empty directories deterministically with per-file and complete hashes', async () => {
    const f = await fixture(), first = await captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination });
    const second = await captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: join(f.root, 'second.bin') });
    const raw = await readFile(first.path);
    expect(await readFile(second.path)).toEqual(raw);
    expect(first.sha256).toBe(createHash('sha256').update(raw).digest('hex')); expect(first.bytes).toBe(raw.length);
    const length = raw.readUInt32LE(8), offset = DECLARED_STATE_PREFIX_BYTES + length;
    const manifest = decodeDeclaredStateManifest(raw.subarray(0, DECLARED_STATE_PREFIX_BYTES), raw.subarray(DECLARED_STATE_PREFIX_BYTES, offset));
    expect(manifest.directories).toEqual(['empty', 'nested']);
    expect(manifest.files.map(file => file.path)).toEqual(['counter.json', 'nested/memory.txt', 'zero.bin']);
    let position = offset;
    for (const file of manifest.files) {
      const bytes = raw.subarray(position, position + file.bytes); position += file.bytes;
      expect(bytes).toEqual(await readFile(join(f.source, ...file.path.split('/'))));
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(position).toBe(first.bytes); expect(await readdir(f.root)).toEqual(expect.arrayContaining(['source', 'state.bin', 'second.bin']));
    expect((await readdir(f.root)).filter(name => name.startsWith('.declared-state-'))).toEqual([]);
  });
  it('never overwrites an existing archive and removes only its new staging file after refusal', async () => {
    const f = await fixture(); await writeFile(f.destination, 'original archive', { mode: 0o600 });
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination })).rejects.toThrow();
    expect(await readFile(f.destination, 'utf8')).toBe('original archive');
    expect((await readdir(f.root)).filter(name => name.startsWith('.declared-state-'))).toEqual([]);
  });
  it('refuses capture into its own source tree and a finite byte ceiling without publishing anything', async () => {
    const f = await fixture();
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: join(f.source, 'capture.bin') })).rejects.toThrow();
    await writeFile(join(f.source, 'large.bin'), Buffer.alloc(1024), { mode: 0o600 });
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination, maxBytes: 512 })).rejects.toThrow();
    await expect(lstat(f.destination)).rejects.toThrow();
  });
  it('cancels a requested capture without publishing an archive', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort();
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination, signal: abort.signal })).rejects.toThrow();
    await expect(lstat(f.destination)).rejects.toThrow();
  });
  it('refuses hardlinked state files rather than following another state identity', async () => {
    const f = await fixture(); await link(join(f.source, 'counter.json'), join(f.source, 'alias.json'));
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination })).rejects.toThrow();
    await expect(lstat(f.destination)).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('removes only its published archive if cancellation arrives during the final directory fsync', async () => {
    const f = await fixture(), abort = new AbortController(), probe = await open(join(f.source, 'counter.json'), 'r');
    const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe); await probe.close();
    const original = prototype.sync; let lateAbort = false;
    vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
      await original.call(this);
      if ((await this.stat()).isDirectory()) { lateAbort = true; abort.abort(); }
    });
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination, signal: abort.signal })).rejects.toThrow();
    expect(lateAbort).toBe(true); await expect(lstat(f.destination)).rejects.toThrow();
    expect((await readdir(f.root)).filter(name => name.startsWith('.declared-state-'))).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('refuses symbolic state paths and executable data files', async () => {
    const f = await fixture(); await symlink(join(f.source, 'counter.json'), join(f.source, 'symbolic.json'));
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination })).rejects.toThrow();
    await rm(join(f.source, 'symbolic.json')); await chmod(join(f.source, 'counter.json'), 0o700);
    await expect(captureDeclaredStateBundle({ sourceDirectory: f.source, destinationPath: f.destination })).rejects.toThrow();
    await expect(lstat(f.destination)).rejects.toThrow();
  });
  it.each(['../escape', '/absolute', 'C:/drive', 'a\\b', './name', 'a//b', 'a/../b', 'CON', 'a/NUL.txt', 'a.',
    '.telomere-declared-state.json', 'a/.telomere-declared-state.json'])('refuses nonportable declared path %s', value => {
    expect(declaredStatePathSchema.safeParse(value).success).toBe(false);
  });
  it('rejects duplicate/case aliases, file-parent collisions, undeclared parents and inconsistent manifest totals', () => {
    const file = { path: 'a', bytes: 0, sha256: createHash('sha256').digest('hex') };
    const base = { protocol: 'telomere-declared-state-v1', directories: [], files: [file], payloadBytes: 0 };
    for (const change of [{ files: [file, file] }, { directories: ['A'] }, { files: [{ ...file, path: 'a/b' }] },
      { directories: ['a'], files: [file] }, { payloadBytes: 1 }, { files: [{ ...file, bytes: -1 }] }]) {
      expect(declaredStateManifestSchema.safeParse({ ...base, ...change }).success).toBe(false);
    }
  });
});
