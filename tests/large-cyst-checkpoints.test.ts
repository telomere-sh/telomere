import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARGE_CYST_CHUNK_BYTES, LARGE_CYST_MAX_PLAINTEXT_BYTES,
  LargeCystPrivateStore, generateLargeCystId, restoreLargeCystFile, saveLargeCystFile,
  restoreLargeCystFileWithWrappedKey, verifyLargeCystManifestKey } from '../src/cysts/large-checkpoints.js';
import { LargeCystAgentManifestStore } from '../src/sdk/large-cyst-agent-manifest.js';
import { generateCystWrappingIdentity, unwrapCystRecoveryKey, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';

const scope = { owner: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), applicationSchema: 'overlay.tar.zst/v1' };
const sentinel = 'owner-private-filesystem-checkpoint-secret';

describe('large encrypted file checkpoint multipart store', () => {
  let root: string, storageDir: string, outputDir: string, sourcePath: string;
  let store: LargeCystPrivateStore, id: string, key: Uint8Array;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-large-cyst-'));
    storageDir = join(root, 'ciphertext'); outputDir = join(root, 'restored'); sourcePath = join(root, 'overlay.tar.zst');
    await mkdir(storageDir, { mode: 0o700 }); await mkdir(outputDir, { mode: 0o700 });
    store = new LargeCystPrivateStore(storageDir, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 }); await store.initialize();
    id = generateLargeCystId(); key = randomBytes(32);
  });
  afterEach(async () => { key.fill(0); await store.close(); await rm(root, { recursive: true, force: true }); });

  it('streams a real multi-part payload, persists ciphertext only, and restores byte-for-byte after restart', async () => {
    const original = Buffer.concat([Buffer.from(sentinel), randomBytes(LARGE_CYST_CHUNK_BYTES * 2 + 123)]);
    await writeFile(sourcePath, original);
    const manifest = await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    expect(manifest.parts).toHaveLength(3);
    expect(manifest.header.plaintextBytes).toBe(original.length);
    const directory = join(storageDir, id.slice(2));
    expect((await readdir(directory)).filter(name => name.startsWith('part-'))).toHaveLength(3);
    for (const name of await readdir(directory)) {
      const contents = await readFile(join(directory, name));
      expect(contents.includes(sentinel)).toBe(false);
      if (process.platform !== 'win32') expect((await lstat(join(directory, name))).mode & 0o077).toBe(0);
    }
    await store.close();
    store = new LargeCystPrivateStore(storageDir, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 }); await store.initialize();
    await restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'restored.tar.zst'), scope, recoveryKey: key });
    expect(await readFile(join(outputDir, 'restored.tar.zst'))).toEqual(original);
    if (process.platform !== 'win32') expect((await lstat(join(outputDir, 'restored.tar.zst'))).mode & 0o077).toBe(0);
  }, 90_000);

  it('resumes after an interrupted multipart write without rewriting the immutable first part', async () => {
    await writeFile(sourcePath, randomBytes(LARGE_CYST_CHUNK_BYTES + 17));
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key,
      onProgress(completed) { if (completed === 1) throw new Error('simulated process interruption'); } }))
      .rejects.toThrow('simulated process interruption');
    expect(await store.manifest(id)).toBeUndefined();
    const first = join(storageDir, id.slice(2), 'part-000000.bin');
    const before = await lstat(first);
    await store.close();
    store = new LargeCystPrivateStore(storageDir, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 }); await store.initialize();
    const complete = await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    expect(complete.parts).toHaveLength(2);
    expect((await lstat(first)).ino).toBe(before.ino);
    await restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'recovered'), scope, recoveryKey: key });
    expect(await readFile(join(outputDir, 'recovered'))).toEqual(await readFile(sourcePath));
  }, 90_000);

  it('rejects a changed source on resume and does not publish a mixed checkpoint', async () => {
    await writeFile(sourcePath, randomBytes(LARGE_CYST_CHUNK_BYTES + 3));
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key,
      onProgress(completed) { if (completed === 1) throw new Error('stop'); } })).rejects.toThrow('stop');
    const file = await open(sourcePath, 'r+');
    try { await file.write(Buffer.from('mutated!'), 0, 8, LARGE_CYST_CHUNK_BYTES + 1); }
    finally { await file.close(); }
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key })).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.manifest(id)).toBeUndefined();
  });

  it('rejects tampered ciphertext and leaves no published or temporary plaintext output', async () => {
    await writeFile(sourcePath, randomBytes(LARGE_CYST_CHUNK_BYTES + 19));
    await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const part = join(storageDir, id.slice(2), 'part-000001.bin');
    const file = await open(part, 'r+');
    try { await file.write(Buffer.from([0]), 0, 1, 30); } finally { await file.close(); }
    await expect(restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'bad'), scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'integrity_failed' });
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('authenticates key, scope and manifest, and never overwrites an existing destination', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const destinationPath = join(outputDir, 'restore');
    await expect(restoreLargeCystFile({ store, id, destinationPath, scope, recoveryKey: randomBytes(32) }))
      .rejects.toMatchObject({ code: 'integrity_failed' });
    await expect(restoreLargeCystFile({ store, id, destinationPath,
      scope: { ...scope, agent: '0x' + '33'.repeat(20) }, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'integrity_failed' });
    const manifestPath = join(storageDir, id.slice(2), 'manifest.json');
    const original = await readFile(manifestPath);
    const altered = JSON.parse(original.toString('utf8')) as { mac: string };
    altered.mac = '0'.repeat(64); await writeFile(manifestPath, JSON.stringify(altered));
    await expect(restoreLargeCystFile({ store, id, destinationPath, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'integrity_failed' });
    await writeFile(manifestPath, original);
    await restoreLargeCystFile({ store, id, destinationPath, scope, recoveryKey: key });
    await expect(restoreLargeCystFile({ store, id, destinationPath, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'destination_exists' });
    expect(await readFile(destinationPath, 'utf8')).toBe(sentinel);
  });

  it('persists the owner and agent wraps inside the registry-bound manifest across restart', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    const owner = await generateCystWrappingIdentity(), agent = await generateCystWrappingIdentity();
    const keyScope = { owner: scope.owner, agent: scope.agent, checkpointId: id };
    const wrapped = await wrapCystRecoveryKey(key, keyScope,
      { ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey });
    const supplied = { bundle: wrapped, ownerIdentity: owner, agentPublicKey: agent.publicKey };
    const saved = await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key, wrappedKey: supplied });
    expect(saved.wrappedKey).toEqual(wrapped);
    await store.close();
    store = new LargeCystPrivateStore(storageDir, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 });
    await store.initialize();
    const persisted = await store.manifest(id);
    expect(persisted?.wrappedKey).toEqual(wrapped);
    expect(verifyLargeCystManifestKey(persisted, key, { id, owner: scope.owner, agent: scope.agent }).wrappedKey)
      .toEqual(wrapped);
    expect(await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key, wrappedKey: supplied }))
      .toEqual(saved);
    key.fill(0);
    const ownerKey = await unwrapCystRecoveryKey(persisted?.wrappedKey, keyScope, 'owner', owner);
    const agentKey = await unwrapCystRecoveryKey(persisted?.wrappedKey, keyScope, 'agent', agent);
    try {
      await restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'owner-restore'), scope, recoveryKey: ownerKey });
      expect(await readFile(join(outputDir, 'owner-restore'), 'utf8')).toBe(sentinel);
      await restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'agent-restore'), scope, recoveryKey: agentKey });
      expect(await readFile(join(outputDir, 'agent-restore'), 'utf8')).toBe(sentinel);
    } finally { ownerKey.fill(0); agentKey.fill(0); }
    const agentStore = new LargeCystAgentManifestStore({ baseUrl: 'http://127.0.0.1:1234',
      agentId: '0x' + '33'.repeat(32), sessionToken: 'a'.repeat(64),
      fetchImpl: async (input, init) => {
        if (new Headers(init?.headers).get('cookie') !== 'telomere_session=' + 'a'.repeat(64)) {
          return new Response(null, { status: 403 });
        }
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/manifest')) return new Response(JSON.stringify(await store.manifest(id)), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
        if (path.endsWith('/parts/0')) {
          const part = await store.part(id, 0);
          if (!part) return new Response(null, { status: 404 });
          return new Response(Uint8Array.from(part), { headers: { 'content-type': 'application/octet-stream',
            'cache-control': 'no-store', 'content-length': String(part.length) } });
        }
        return new Response(null, { status: 404 });
      } });
    await restoreLargeCystFileWithWrappedKey({ store: agentStore, id,
      destinationPath: join(outputDir, 'agent-http-restore'), scope, recipient: 'agent', identity: agent });
    expect(await readFile(join(outputDir, 'agent-http-restore'), 'utf8')).toBe(sentinel);
    await expect(restoreLargeCystFileWithWrappedKey({ store: agentStore, id,
      destinationPath: join(outputDir, 'wrong-identity'), scope, recipient: 'agent', identity: owner }))
      .rejects.toThrow();
    expect((await readdir(outputDir)).includes('wrong-identity')).toBe(false);
    await expect(unwrapCystRecoveryKey(wrapped, keyScope, 'agent', owner)).rejects.toThrow();
  });

  it('rejects a wrap for another key or agent before beginning an upload', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    const owner = await generateCystWrappingIdentity(), agent = await generateCystWrappingIdentity();
    const keyScope = { owner: scope.owner, agent: scope.agent, checkpointId: id };
    const wrongKeyWrap = await wrapCystRecoveryKey(randomBytes(32), keyScope,
      { ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey });
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key,
      wrappedKey: { bundle: wrongKeyWrap, ownerIdentity: owner, agentPublicKey: agent.publicKey } }))
      .rejects.toMatchObject({ code: 'invalid_key' });
    const correctWrap = await wrapCystRecoveryKey(key, keyScope,
      { ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey });
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key,
      wrappedKey: { bundle: correctWrap, ownerIdentity: owner, agentPublicKey: '00'.repeat(32) } }))
      .rejects.toMatchObject({ code: 'invalid_key' });
    expect(await readdir(storageDir)).toEqual(['.writer.lock']);
  });

  it('rejects over-limit sparse input before reading gigabytes', async () => {
    const file = await open(sourcePath, 'w');
    try { await file.truncate(LARGE_CYST_MAX_PLAINTEXT_BYTES + 1); }
    finally { await file.close(); }
    await expect(saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'invalid_source' });
    expect(await readdir(storageDir)).toEqual(['.writer.lock']);
  });

  it('holds a single-writer directory lock and recovers only an explicitly identified dead lock', async () => {
    const second = new LargeCystPrivateStore(storageDir,
      { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 });
    await expect(second.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    const live = await second.lockStatus(); if (!live) throw new Error('Writer lock missing');
    await expect(second.recoverStaleLock(live.token)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await store.close();
    const token = randomBytes(32).toString('hex');
    await writeFile(join(storageDir, '.writer.lock'), JSON.stringify({ version: 1, token,
      pid: 2_147_483_647, platform: process.platform }), { mode: 0o600 });
    await expect(second.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(second.recoverStaleLock('0'.repeat(64))).rejects.toMatchObject({ code: 'storage_unavailable' });
    await second.recoverStaleLock(token);
    await second.initialize(); store = second;
  });

  it('serializes concurrent owner reservations so their physical ciphertext stays within the cap', async () => {
    const limitedDirectory = join(root, 'limited'); await mkdir(limitedDirectory, { mode: 0o700 });
    const limit = LARGE_CYST_CHUNK_BYTES + 40;
    const limited = new LargeCystPrivateStore(limitedDirectory, { globalMaxBytes: limit, ownerMaxBytes: limit });
    await limited.initialize();
    try {
      const firstPath = join(root, 'first.tar.zst'), secondPath = join(root, 'second.tar.zst');
      await writeFile(firstPath, randomBytes(2 * 1024 * 1024)); await writeFile(secondPath, randomBytes(2 * 1024 * 1024));
      const results = await Promise.allSettled([
        saveLargeCystFile({ store: limited, sourcePath: firstPath, id: generateLargeCystId(), scope, recoveryKey: randomBytes(32) }),
        saveLargeCystFile({ store: limited, sourcePath: secondPath, id: generateLargeCystId(), scope, recoveryKey: randomBytes(32) }),
      ]);
      expect(results.some(result => result.status === 'rejected')).toBe(true);
      let used = 0;
      for (const checkpoint of await readdir(limitedDirectory)) {
        if (checkpoint === '.writer.lock') continue;
        for (const name of await readdir(join(limitedDirectory, checkpoint))) used += (await lstat(join(limitedDirectory, checkpoint, name))).size;
      }
      expect(used).toBeLessThanOrEqual(limit);
    } finally { await limited.close(); }
  }, 90_000);

  it.skipIf(process.platform === 'win32')('rejects a symlinked source file', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    const linked = join(root, 'linked-source'); await symlink(sourcePath, linked);
    await expect(saveLargeCystFile({ store, sourcePath: linked, id, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'invalid_source' });
  });

  it.skipIf(process.platform === 'win32')('refuses a public or linked storage directory and linked ciphertext part', async () => {
    await chmod(storageDir, 0o755);
    await expect(new LargeCystPrivateStore(storageDir, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 }).initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await chmod(storageDir, 0o700);
    const linkedRoot = join(root, 'linked-root'); await symlink(storageDir, linkedRoot, 'dir');
    await expect(new LargeCystPrivateStore(linkedRoot, { globalMaxBytes: 64 * 1024 * 1024, ownerMaxBytes: 32 * 1024 * 1024 }).initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await writeFile(sourcePath, Buffer.from(sentinel));
    await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const part = join(storageDir, id.slice(2), 'part-000000.bin');
    await rm(part); await symlink(sourcePath, part);
    await expect(restoreLargeCystFile({ store, id, destinationPath: join(outputDir, 'bad'), scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
  });
});
