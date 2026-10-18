import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, sha256 } from './release-manifest.mjs';

test('inventory binds bytes, exact membership and nested paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telomere-release-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/file.js'), 'first');
    const before = await inventory(root);
    assert.deepEqual(before, [{ path: 'nested/file.js', bytes: 5, sha256: sha256('first') }]);
    await writeFile(join(root, 'nested/file.js'), 'other');
    assert.notDeepEqual(await inventory(root), before);
    await writeFile(join(root, 'extra.js'), 'extra');
    assert.equal((await inventory(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inventory rejects symlinked release members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telomere-release-'));
  try {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inventory(root), /links are forbidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
