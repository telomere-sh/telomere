import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { LARGE_CYST_CHUNK_BYTES, LargeCystPrivateStore, parseLargeCystManifest,
  saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { largeCystRegistryDescriptor } from '../src/cysts/large-registry.js';
import { cystRegistryBindingSchema, cystRegistryPinsSchema, cystRegistryStateSchema,
  type CystRegistryReader } from '../src/cysts/registry-types.js';
import { LargeCystAgentManifestStore } from '../src/sdk/large-cyst-agent-manifest.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';

const agentId = keccak256(toHex('agent-manifest-test'));
const checkpointId = keccak256(toHex('agent-manifest-checkpoint'));
const sessionToken = 'a'.repeat(64);
const manifest = parseLargeCystManifest({ header: {
  version: 1, algorithm: 'xchacha20-poly1305-chunked', id: checkpointId,
  owner: '0x1111111111111111111111111111111111111111',
  agent: '0x2222222222222222222222222222222222222222',
  applicationSchema: 'overlay.tar.zst/v1', plaintextBytes: 1, chunkBytes: LARGE_CYST_CHUNK_BYTES,
  chunkCount: 1, sourceMac: 'a'.repeat(64), keyCommitment: 'b'.repeat(64),
}, parts: [{ index: 0, bytes: 41, sha256: 'c'.repeat(64) }], mac: 'd'.repeat(64) });

function client(response: Response) {
  return new LargeCystAgentManifestStore({ baseUrl: 'http://127.0.0.1:1234', agentId, sessionToken,
    fetchImpl: async () => response });
}
function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

describe('agent-side checked manifest fetch', () => {
  it('accepts only a bounded, scoped, valid manifest and treats only 404 as absent', async () => {
    expect(await client(json(manifest)).manifest(checkpointId)).toEqual(manifest);
    expect(await client(new Response(null, { status: 404 })).manifest(checkpointId)).toBeUndefined();
    await expect(client(new Response(null, { status: 403 })).manifest(checkpointId))
      .rejects.toThrow('HTTP 403');
    await expect(client(json(manifest, { 'content-length': '131073' })).manifest(checkpointId))
      .rejects.toThrow('byte limit');
    await expect(client(json(manifest, { 'cache-control': 'public' })).manifest(checkpointId))
      .rejects.toThrow('headers');
    await expect(client(json({ ...manifest, unexpected: true })).manifest(checkpointId)).rejects.toThrow();
    await expect(client(json({ ...manifest, header: { ...manifest.header,
      id: keccak256(toHex('different-checkpoint')) } })).manifest(checkpointId))
      .rejects.toThrow('ID changed');
  });

  it('checks exact ciphertext part length, digest and transport headers', async () => {
    const part = Buffer.alloc(41, 7);
    const item = parseLargeCystManifest({ ...manifest, parts: [{ index: 0, bytes: 41,
      sha256: createHash('sha256').update(part).digest('hex') }] });
    const fetchPart = (response: Response) => new LargeCystAgentManifestStore({
      baseUrl: 'http://127.0.0.1:1234', agentId, sessionToken,
      fetchImpl: async input => String(input).endsWith('/manifest') ? json(item) : response,
    });
    const binary = (bytes: Buffer, headers: Record<string, string> = {}) => new Response(Uint8Array.from(bytes), {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
        'content-length': '41', ...headers },
    });
    expect(await fetchPart(binary(part)).part(checkpointId, 0)).toEqual(part);
    await expect(fetchPart(binary(Buffer.alloc(41, 8))).part(checkpointId, 0)).rejects.toThrow('integrity');
    await expect(fetchPart(binary(part.subarray(0, 40))).part(checkpointId, 0)).rejects.toThrow('integrity');
    await expect(fetchPart(binary(Buffer.concat([part, Buffer.from([0])]))).part(checkpointId, 0))
      .rejects.toThrow('bound');
    await expect(fetchPart(binary(part, { 'cache-control': 'public' })).part(checkpointId, 0))
      .rejects.toThrow('headers');
    await expect(fetchPart(binary(part, { 'content-encoding': 'gzip' })).part(checkpointId, 0))
      .rejects.toThrow('headers');
  });

  it('bounds and independently checks the current locator against manifest and canonical registry', async () => {
    const descriptor = largeCystRegistryDescriptor(manifest);
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337,
      registryAddress: '0x4444444444444444444444444444444444444444', registryCodeHash: keccak256(toHex('registry')),
      selectionRegistryAddress: '0x5555555555555555555555555555555555555555',
      selectionRegistryCodeHash: keccak256(toHex('selection')), confirmations: 0 });
    const binding = cystRegistryBindingSchema.parse({ agentId, owner: manifest.header.owner, agentWallet: manifest.header.agent,
      vault: '0x6666666666666666666666666666666666666666', status: 1, frozen: false });
    const current = cystRegistryStateSchema.parse({ agentId, cystHash: descriptor.cystHash, sizeBytes: String(descriptor.sizeBytes),
      storageRef: descriptor.storageRef, revision: '1', committedAt: '10', retired: false,
      block: { number: '100', hash: keccak256(toHex('block')) } });
    const reader: CystRegistryReader = { pins, check: async () => undefined,
      snapshot: async () => ({ binding, current }) };
    const resolved = { checkpointId, checkpoint: descriptor, binding, current, pins, manifest };
    const currentResponse = (value: unknown, extra: Record<string, string> = {}) => {
      const bytes = Buffer.from(JSON.stringify(value));
      return new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'content-length': String(bytes.length), ...extra } });
    };
    expect((await client(currentResponse(resolved)).resolveCurrent(reader)).checkpointId).toBe(checkpointId);
    await expect(client(currentResponse(resolved, { 'content-length': '147457' })).resolveCurrent(reader))
      .rejects.toThrow('headers');
    await expect(client(currentResponse(resolved, { 'content-length': '1' })).resolveCurrent(reader))
      .rejects.toThrow('length changed');
    const overflowing = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(147_457)); controller.close();
    } }), { headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'content-length': '1' } });
    await expect(client(overflowing).resolveCurrent(reader)).rejects.toThrow('bound');
    await expect(client(currentResponse({ ...resolved, checkpoint: { ...descriptor,
      cystHash: keccak256(toHex('wrong')) } })).resolveCurrent(reader)).rejects.toThrow('descriptor');
    await expect(client(currentResponse({ ...resolved, pins: { ...pins,
      registryAddress: '0x7777777777777777777777777777777777777777' } })).resolveCurrent(reader))
      .rejects.toThrow('pins differ');
    await expect(client(currentResponse(resolved)).resolveCurrent({ ...reader,
      pins: { ...pins, confirmations: 1 } })).rejects.toThrow('pins differ');
  });

  it('publishes a restored current file only after a fresh canonical revision check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telomere-current-agent-restore-'));
    const storage = join(root, 'storage'), output = join(root, 'output'), source = join(root, 'source.bin');
    await mkdir(storage, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
    const privateStore = new LargeCystPrivateStore(storage, {
      globalMaxBytes: 8 * 1024 * 1024, ownerMaxBytes: 8 * 1024 * 1024 });
    await privateStore.initialize();
    const key = randomBytes(32);
    try {
      const scope = { owner: manifest.header.owner, agent: manifest.header.agent,
        applicationSchema: manifest.header.applicationSchema };
      const plaintext = Buffer.from('current agent checkpoint with authenticated state');
      await writeFile(source, plaintext);
      const ownerIdentity = await generateCystWrappingIdentity();
      const agentIdentity = await generateCystWrappingIdentity();
      const wrapped = await wrapCystRecoveryKey(key,
        { owner: scope.owner, agent: scope.agent, checkpointId },
        { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
      const saved = await saveLargeCystFile({ store: privateStore, sourcePath: source,
        id: checkpointId, scope, recoveryKey: key,
        wrappedKey: { bundle: wrapped, ownerIdentity, agentPublicKey: agentIdentity.publicKey } });
      const descriptor = largeCystRegistryDescriptor(saved);
      const pins = cystRegistryPinsSchema.parse({ chainId: 31337,
        registryAddress: '0x4444444444444444444444444444444444444444',
        registryCodeHash: keccak256(toHex('registry')),
        selectionRegistryAddress: '0x5555555555555555555555555555555555555555',
        selectionRegistryCodeHash: keccak256(toHex('selection')), confirmations: 1 });
      const binding = cystRegistryBindingSchema.parse({ agentId, owner: scope.owner, agentWallet: scope.agent,
        vault: '0x6666666666666666666666666666666666666666', status: 1, frozen: false });
      const first = cystRegistryStateSchema.parse({ agentId, cystHash: descriptor.cystHash,
        sizeBytes: String(descriptor.sizeBytes), storageRef: descriptor.storageRef,
        revision: '1', committedAt: '10', retired: false,
        block: { number: '100', hash: keccak256(toHex('block-100')) } });
      let current = first, change: 'none' | 'revision' | 'reorg' = 'none';
      const reader: CystRegistryReader = { pins, check: async () => undefined,
        snapshot: async () => ({ binding, current }) };
      const reply = (value: unknown, includeLength = false) => {
        const bytes = Buffer.from(JSON.stringify(value));
        return new Response(Uint8Array.from(bytes), { headers: {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          ...(includeLength ? { 'content-length': String(bytes.length) } : {}) } });
      };
      const store = new LargeCystAgentManifestStore({ baseUrl: 'http://127.0.0.1:1234',
        agentId, sessionToken, fetchImpl: async input => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith('/current')) {
            return reply({ checkpointId, checkpoint: descriptor, binding, current, pins, manifest: saved }, true);
          }
          if (path.endsWith('/manifest')) return reply(saved);
          if (path.endsWith('/parts/0')) {
            const part = await privateStore.part(checkpointId, 0);
            if (!part) throw new Error('Test checkpoint part missing');
            if (change === 'revision') current = cystRegistryStateSchema.parse({ ...first, revision: '2' });
            if (change === 'reorg') current = cystRegistryStateSchema.parse({ ...first,
              block: { ...first.block, hash: keccak256(toHex('alternate-block-100')) } });
            return new Response(Uint8Array.from(part), { headers: {
              'content-type': 'application/octet-stream', 'cache-control': 'no-store',
              'content-length': String(part.length) } });
          }
          return new Response(null, { status: 404 });
        } });
      change = 'revision';
      await expect(store.restoreCurrent({ reader, destinationPath: join(output, 'stale.bin'),
        scope, identity: agentIdentity })).rejects.toThrow('changed on the canonical registry');
      expect(await readdir(output)).toEqual([]);
      current = first; change = 'reorg';
      await expect(store.restoreCurrent({ reader, destinationPath: join(output, 'reorg.bin'),
        scope, identity: agentIdentity })).rejects.toThrow('changed on the canonical registry');
      expect(await readdir(output)).toEqual([]);
      current = first; change = 'none';
      await store.restoreCurrent({ reader, destinationPath: join(output, 'current.bin'),
        scope, identity: agentIdentity });
      expect(await readFile(join(output, 'current.bin'))).toEqual(plaintext);
      expect(await readdir(output)).toEqual(['current.bin']);
    } finally {
      key.fill(0); await privateStore.close(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
