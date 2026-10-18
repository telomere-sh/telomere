import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECLARED_STATE_MAGIC, DECLARED_STATE_MAX_BYTES, DECLARED_STATE_RECEIPT } from '../src/cysts/declared-state-protocol.js';
import { restoreDeclaredStateBundle } from '../src/sdk/declared-state-restore.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
async function removeTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await readdir(path)) await removeTree(join(path, name));
    await rmdir(path);
  } else { await chmod(path, 0o600).catch(() => undefined); await unlink(path); }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) {
    const absolute = resolve(path);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('telomere-declared-restore-')
      || (await lstat(absolute)).isSymbolicLink()) throw new Error('Unexpected test cleanup scope');
    await removeTree(absolute);
  }
});
const payload = Buffer.from('counter=71\nagent memory\n');
const manifest = { protocol: 'telomere-declared-state-v1', directories: ['empty', 'nested'],
  files: [{ path: 'counter.txt', bytes: 11, sha256: sha(payload.subarray(0, 11)) },
    { path: 'nested/memory.txt', bytes: payload.length - 11, sha256: sha(payload.subarray(11)) },
    { path: 'zero.bin', bytes: 0, sha256: sha('') }], payloadBytes: payload.length };
function bundle(value: unknown = manifest, contents = payload, encoded?: Buffer): Buffer {
  const bytes = encoded ?? Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(12);
  DECLARED_STATE_MAGIC.copy(prefix); prefix.writeUInt32LE(bytes.length, 8); return Buffer.concat([prefix, bytes, contents]);
}
async function fixture(contents = bundle()) {
  const root = await mkdtemp(join(tmpdir(), 'telomere-declared-restore-')); roots.push(root);
  const bundlePath = join(root, 'state.bin'), destinationDirectory = join(root, 'restored');
  await writeFile(bundlePath, contents, { mode: 0o600 });
  return { root, contents, bundlePath, destinationDirectory,
    options: { bundlePath, destinationDirectory, expectedBytes: contents.length, expectedSha256: sha(contents) } };
}
async function nothingPublished(root: string, destination: string) {
  expect(existsSync(destination)).toBe(false);
  expect((await readdir(root)).filter(name => name.startsWith('.telomere-declared-state-'))).toEqual([]);
}

describe('bounded declared state restore inside the application Cell', () => {
  it('restores nested files, zero-byte files and empty directories with private modes and a completion receipt last', async () => {
    const f = await fixture(); const result = await restoreDeclaredStateBundle(f.options);
    expect(result).toEqual({ directory: f.destinationDirectory, manifest, bytes: f.contents.length, sha256: sha(f.contents) });
    expect(await readFile(join(result.directory, 'counter.txt'), 'utf8')).toBe('counter=71\n');
    expect(await readFile(join(result.directory, 'nested/memory.txt'), 'utf8')).toBe('agent memory\n');
    expect(await readFile(join(result.directory, 'zero.bin'))).toHaveLength(0);
    expect(await readdir(join(result.directory, 'empty'))).toEqual([]);
    const receipt = JSON.parse(await readFile(join(result.directory, DECLARED_STATE_RECEIPT), 'utf8')) as unknown;
    expect(receipt).toEqual({ protocol: 'telomere-declared-state-restore-v1', status: 'complete',
      bytes: f.contents.length, sha256: sha(f.contents), manifest });
    for (const path of [result.directory, join(result.directory, 'empty'), join(result.directory, 'nested')]) {
      if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of ['counter.txt', 'nested/memory.txt', 'zero.bin', DECLARED_STATE_RECEIPT]) {
      const stat = await lstat(join(result.directory, path)); expect(stat.nlink).toBe(1);
      if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    }
    expect((await readdir(f.root)).filter(name => name.startsWith('.telomere-declared-state-'))).toEqual([]);
  });

  it('accepts the read-only0444 input mount without requiring ownership of its source file', async () => {
    const f = await fixture(); await chmod(f.bundlePath, 0o444);
    expect((await restoreDeclaredStateBundle(f.options)).sha256).toBe(f.options.expectedSha256);
    expect(await readFile(f.bundlePath)).toEqual(f.contents);
  });

  it('restores a declared file across multiple bounded streaming chunks without materializing the whole payload', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 37);
    const f = await fixture(bundle({ protocol: manifest.protocol, directories: ['state'],
      files: [{ path: 'state/data.bin', bytes: bytes.length, sha256: sha(bytes) }], payloadBytes: bytes.length }, bytes));
    await restoreDeclaredStateBundle(f.options);
    expect((await readFile(join(f.destinationDirectory, 'state/data.bin'))).equals(bytes)).toBe(true);
  });

  it('refuses an existing destination even when empty or an exact earlier completed operation', async () => {
    const f = await fixture(); await mkdir(f.destinationDirectory, { mode: 0o700 });
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow(/^Declared state restore refused$/);
    expect(await readdir(f.destinationDirectory)).toEqual([]); await rmdir(f.destinationDirectory);
    await restoreDeclaredStateBundle(f.options);
    const before = await readFile(join(f.destinationDirectory, DECLARED_STATE_RECEIPT));
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow(/^Declared state restore refused$/);
    expect(await readFile(join(f.destinationDirectory, DECLARED_STATE_RECEIPT))).toEqual(before);
  });

  it.each(['whole-hash', 'file-hash', 'magic', 'truncated', 'extra', 'manifest-length'])('publishes nothing for %s corruption', async mode => {
    let bytes = bundle();
    if (mode === 'file-hash') bytes = bundle({ ...manifest, files: manifest.files.map((value, index) => index === 0 ? { ...value, sha256: '0'.repeat(64) } : value) });
    if (mode === 'magic') bytes[0] = 0;
    if (mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    if (mode === 'extra') bytes = Buffer.concat([bytes, Buffer.from('unexpected')]);
    if (mode === 'manifest-length') bytes.writeUInt32LE(65_537, 8);
    const f = await fixture(bytes);
    await expect(restoreDeclaredStateBundle({ ...f.options,
      expectedSha256: mode === 'whole-hash' ? '0'.repeat(64) : f.options.expectedSha256 })).rejects.toThrow('restore refused');
    await nothingPublished(f.root, f.destinationDirectory);
  });

  it.each(['../outside', '/absolute', 'C:/drive', 'nested\\escape', 'a/../../b', '.telomere-declared-state.json', 'NUL.txt'])
  ('rejects untrusted state path %s before destination creation', async path => {
    const f = await fixture(bundle({ ...manifest, files: [{ path, bytes: payload.length, sha256: sha(payload) }] }));
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused'); await nothingPublished(f.root, f.destinationDirectory);
  });

  it('refuses duplicate/case aliases, file-parent conflicts, undeclared parents, negative sizes and executable metadata', async () => {
    for (const value of [
      { ...manifest, directories: ['empty', 'empty', 'nested'] },
      { ...manifest, directories: ['empty', 'Empty', 'nested'] },
      { ...manifest, directories: ['counter.txt', 'empty', 'nested'] },
      { ...manifest, directories: ['empty'] },
      { ...manifest, files: [{ path: 'a', bytes: -1, sha256: sha('') }] },
      { ...manifest, files: manifest.files.map(file => ({ ...file, mode: 0o777 })) },
    ]) {
      const f = await fixture(bundle(value));
      await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused'); await nothingPublished(f.root, f.destinationDirectory);
    }
  });

  it('requires canonical manifest JSON without duplicate keys, whitespace variants or unknown fields', async () => {
    for (const encoded of [Buffer.from(JSON.stringify(manifest, null, 2)),
      Buffer.from(JSON.stringify(manifest).replace('{', '{"payloadBytes":0,')),
      Buffer.from(JSON.stringify({ ...manifest, unknown: true }))]) {
      const f = await fixture(bundle(manifest, payload, encoded));
      await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused'); await nothingPublished(f.root, f.destinationDirectory);
    }
  });

  it('enforces signed expected length, finite total size, and absolute source/destination paths', async () => {
    const f = await fixture();
    for (const value of [{ ...f.options, expectedBytes: -1 }, { ...f.options, expectedBytes: DECLARED_STATE_MAX_BYTES + 1 },
      { ...f.options, expectedBytes: f.contents.length - 1 }, { ...f.options, bundlePath: 'state.bin' },
      { ...f.options, destinationDirectory: 'restored' }]) await expect(restoreDeclaredStateBundle(value)).rejects.toThrow('restore refused');
    await nothingPublished(f.root, f.destinationDirectory);
  });

  it('refuses a directory or hardlinked source without reading or changing it', async () => {
    const f = await fixture(); const alias = join(f.root, 'alias.bin'); await link(f.bundlePath, alias);
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused'); await unlink(alias);
    await expect(restoreDeclaredStateBundle({ ...f.options, bundlePath: f.root })).rejects.toThrow('restore refused');
    await nothingPublished(f.root, f.destinationDirectory); expect(await readFile(f.bundlePath)).toEqual(f.contents);
  });

  it.skipIf(process.platform === 'win32')('refuses source/destination ancestor symlinks and exposed or executable POSIX entries', async () => {
    const f = await fixture(), alias = join(f.root, 'link.bin'); await symlink(f.bundlePath, alias);
    await expect(restoreDeclaredStateBundle({ ...f.options, bundlePath: alias })).rejects.toThrow('restore refused');
    const target = join(f.root, 'target'); await mkdir(target, { mode: 0o700 }); const parentLink = join(f.root, 'parent'); await symlink(target, parentLink);
    await expect(restoreDeclaredStateBundle({ ...f.options, destinationDirectory: join(parentLink, 'data') })).rejects.toThrow('restore refused');
    for (const mode of [0o644, 0o700]) {
      await chmod(f.bundlePath, mode); await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused');
    }
    await chmod(f.bundlePath, 0o600); await chmod(f.root, 0o755);
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused'); await chmod(f.root, 0o700);
    const fifo = join(f.root, 'special-input'); execFileSync('mkfifo', [fifo]);
    await expect(restoreDeclaredStateBundle({ ...f.options, bundlePath: fifo })).rejects.toThrow('restore refused');
    await nothingPublished(f.root, f.destinationDirectory); expect(await readdir(target)).toEqual([]);
  });

  it('discards its exact partial tree on caller abort, including an abort during streamed payload reads', async () => {
    const f = await fixture(), controller = new AbortController(); let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 7) controller.abort(); if (controller.signal.aborted) throw new Error('private cancellation reason');
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow(/^Declared state restore refused$/);
    expect(controller.signal.aborted).toBe(true); await nothingPublished(f.root, f.destinationDirectory);
  });

  it('refuses a source rewritten with identical bytes while reading because its original inode metadata changed', async () => {
    const f = await fixture(), controller = new AbortController(); let changed = false;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!changed && (existsSync(join(f.root, 'restored')) || (requireStage(f.root)))) {
        changed = true; writeFileSync(f.bundlePath, f.contents);
      }
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow('restore refused');
    expect(changed).toBe(true); await nothingPublished(f.root, f.destinationDirectory);
  });

  it('never replaces a destination created by another actor after its initial absence check', async () => {
    const f = await fixture(), controller = new AbortController(); let raced = false;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!raced && requireStage(f.root)) { raced = true; mkdirSync(f.destinationDirectory, { mode: 0o700 }); writeFileSync(join(f.destinationDirectory, 'foreign'), 'preserve'); }
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow('restore refused');
    expect(raced).toBe(true); expect(await readFile(join(f.destinationDirectory, 'foreign'), 'utf8')).toBe('preserve');
    expect(existsSync(join(f.destinationDirectory, DECLARED_STATE_RECEIPT))).toBe(false);
  });

  it('does not overwrite or recursively clean a foreign child inserted between destination claim and publication', async () => {
    const f = await fixture(), controller = new AbortController(); let raced = false;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!raced && existsSync(f.destinationDirectory)) { raced = true; writeFileSync(join(f.destinationDirectory, 'counter.txt'), 'foreign'); }
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow('restore refused');
    expect(raced).toBe(true); expect(await readFile(join(f.destinationDirectory, 'counter.txt'), 'utf8')).toBe('foreign');
    expect(JSON.parse(await readFile(join(f.destinationDirectory, DECLARED_STATE_RECEIPT), 'utf8'))).toMatchObject({ status: 'failed' });
    await expect(restoreDeclaredStateBundle(f.options)).rejects.toThrow('restore refused');
  });

  it('rechecks restored file hashes before completion when an owned stage file changes after source authentication', async () => {
    const f = await fixture(), controller = new AbortController(); let changed = false;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!changed && existsSync(f.destinationDirectory)) {
        const stage = readdirSync(f.root).find(name => name.startsWith('.telomere-declared-state-'));
        if (!stage) throw new Error('Expected retained stage');
        changed = true; writeFileSync(join(f.root, stage, 'counter.txt'), 'evil-state\n');
      }
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow('restore refused');
    expect(changed).toBe(true); await nothingPublished(f.root, f.destinationDirectory);
  });

  it('does not return success if cancellation arrives while the completion receipt is being fsynced', async () => {
    const f = await fixture(), controller = new AbortController(), probe = await open(f.bundlePath, 'r');
    const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe); await probe.close();
    const original = prototype.sync; let lateAbort = false;
    vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
      await original.call(this);
      if (!lateAbort && existsSync(join(f.destinationDirectory, DECLARED_STATE_RECEIPT))) { lateAbort = true; controller.abort(); }
    });
    await expect(restoreDeclaredStateBundle({ ...f.options, signal: controller.signal })).rejects.toThrow('restore refused');
    expect(lateAbort).toBe(true); await nothingPublished(f.root, f.destinationDirectory);
  });
});

// Synchronous fixture observation creates deterministic await-boundary races;
// it never changes the production API or reads unowned directories.
function requireStage(root: string): boolean { return readdirSync(root).some(name => name.startsWith('.telomere-declared-state-')); }

async function runCell(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/declared-state-cell.ts', ...args], { cwd: process.cwd(), windowsHide: true });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Cell CLI fixture timed out')); }, 10_000);
    child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined); child.stdin.end(input);
  });
}
it('Cell CLI refuses host extraction paths, changed/oversized stdin and extra receipt fields with sanitized output', async () => {
  const hash = '0x' + '1'.repeat(64), expected = { protocol: 'telomere-agent-current-cyst-file-restore-v1',
    agentId: hash, targetRunId: hash, checkpointId: hash, revision: '1', operationId: 'declared-fixture',
    plaintextBytes: 100, plaintextSha256: 'a'.repeat(64) };
  const args = [hash, hash, hash, '1', 'declared-fixture', 'a'.repeat(64), '/run/telomere-cyst/state.bin'];
  for (const value of [
    { args: [...args.slice(0, 6), '/private/host-secret'], input: JSON.stringify(expected) },
    { args, input: JSON.stringify({ ...expected, operationId: 'different' }) },
    { args, input: JSON.stringify({ ...expected, unknown: '/private/host-secret' }) },
    { args, input: ' '.repeat(4097) },
  ]) {
    const result = await runCell(value.args, value.input);
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('Declared state restore refused\n');
  }
}, 30_000);
