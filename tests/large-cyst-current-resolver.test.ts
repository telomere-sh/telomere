import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { keccak256, toHex } from 'viem';
import { LARGE_CYST_CHUNK_BYTES, parseLargeCystManifest,
  type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { largeCystPublicationCatalog as catalog } from '../src/cysts/large-publication-schema.js';
import { LargeCystPublicationService } from '../src/cysts/large-publication-service.js';
import { largeCystRegistryDescriptor, type DurableLargeCystStore } from '../src/cysts/large-registry.js';
import { cystRegistryBindingSchema, cystRegistryPinsSchema, cystRegistryStateSchema,
  type CystRegistryBinding, type CystRegistryReader, type CystRegistryState } from '../src/cysts/registry-types.js';
import { openStore } from '../src/store.js';

const hash = (value: string) => keccak256(toHex(value));
const agentId = hash('catalog-agent'), checkpointId = hash('catalog-checkpoint');
const owner = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const vault = '0x3333333333333333333333333333333333333333';
const pins = cystRegistryPinsSchema.parse({ chainId: 31337,
  registryAddress: '0x4444444444444444444444444444444444444444', registryCodeHash: hash('catalog-registry'),
  selectionRegistryAddress: '0x5555555555555555555555555555555555555555',
  selectionRegistryCodeHash: hash('catalog-selection'), confirmations: 0 });
const manifest = parseLargeCystManifest({ header: { version: 1, algorithm: 'xchacha20-poly1305-chunked',
  id: checkpointId, owner, agent, applicationSchema: 'overlay.tar.zst/v1', plaintextBytes: 1,
  chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount: 1, sourceMac: 'a'.repeat(64), keyCommitment: 'b'.repeat(64) },
parts: [{ index: 0, bytes: 41, sha256: 'c'.repeat(64) }], mac: 'd'.repeat(64) });
const descriptor = largeCystRegistryDescriptor(manifest);

async function fixture() {
  const database = await openStore({ DATA_DIR: ':memory:' });
  let now = Date.now();
  let latest: LargeCystManifest = manifest;
  let current: CystRegistryState = cystRegistryStateSchema.parse({ agentId, cystHash: hash('empty'), sizeBytes: '0', storageRef: hash('empty-ref'),
    revision: '0', committedAt: '0', retired: false,
    block: { number: '100', hash: hash('block-100') } });
  let binding: CystRegistryBinding = cystRegistryBindingSchema.parse({ agentId, owner, agentWallet: agent,
    vault, status: 1, frozen: false });
  let onManifest: (() => void) | undefined;
  const storage: DurableLargeCystStore = {
    begin: async () => undefined, header: async () => latest.header,
    putPart: async () => undefined, part: async () => undefined,
    commit: async () => undefined, manifest: async id => {
      onManifest?.();
      return id === checkpointId ? latest : undefined;
    }, isDurable: async () => true,
  };
  const reader: CystRegistryReader = { pins, check: async () => undefined,
    snapshot: async id => ({ binding: { ...binding, agentId: id as typeof agentId },
      current: { ...current, agentId: id as typeof agentId } }),
  };
  const service = new LargeCystPublicationService(database.db, storage, reader, { now: () => now });
  await service.initialize();
  const created = await service.submit(agent, agentId, checkpointId, 'catalog-audit');
  let completed;
  for (let index = 0; index < 200; index++) {
    completed = await service.get(agent, created.id, agentId);
    if (completed.status === 'succeeded') break;
    if (completed.status !== 'queued' && completed.status !== 'running') throw new Error('Catalog audit failed');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (completed?.status !== 'succeeded') throw new Error('Catalog audit did not finish');
  const publish = () => { current = { ...current, cystHash: descriptor.cystHash,
    sizeBytes: String(descriptor.sizeBytes), storageRef: descriptor.storageRef,
    revision: '1', committedAt: '10', block: { number: '101', hash: hash('block-101') } }; };
  return { database, service, created, publish, setNow: (value: number) => { now = value; },
    changeManifest: (value: LargeCystManifest) => { latest = value; },
    changeBinding: (value: typeof binding) => { binding = value; },
    changeCurrent: (value: typeof current) => { current = value; },
    current: () => current, onManifest: (value: (() => void) | undefined) => { onManifest = value; } };
}

describe('durable large Cyst current-checkpoint catalog', () => {
  const opened: Array<Awaited<ReturnType<typeof fixture>>> = [];
  afterEach(async () => {
    for (const value of opened.splice(0)) { await value.service.close(); await value.database.close(); }
  });

  it('resolves only after an onchain match and survives the short-lived job plan expiring', async () => {
    const value = await fixture(); opened.push(value);
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_current_missing' });
    value.publish();
    const resolved = await value.service.current(agent, agentId);
    expect(resolved.checkpointId).toBe(checkpointId);
    expect(resolved.checkpoint).toEqual(descriptor);
    expect(resolved.manifest).toEqual(manifest);
    value.setNow(Date.now() + 10 * 60_000);
    expect((await value.service.get(agent, value.created.id, agentId)).status).toBe('stale');
    expect((await value.service.current(agent, agentId)).checkpointId).toBe(checkpointId);
  });

  it('fails closed on missing, altered, or reorged catalog and manifest evidence', async () => {
    const value = await fixture(); opened.push(value); value.publish();
    await expect(value.service.current(owner, agentId)).rejects.toMatchObject({ code: 'cyst_agent_forbidden' });
    value.changeManifest({ ...manifest, mac: 'e'.repeat(64) });
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_catalog_corrupt' });
    value.changeManifest(manifest);
    value.changeBinding({ agentId, owner, agentWallet: agent,
      vault: '0x6666666666666666666666666666666666666666', status: 1, frozen: false });
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_catalog_corrupt' });
    value.changeBinding({ agentId, owner, agentWallet: agent, vault, status: 1, frozen: false });
    value.onManifest(() => value.changeCurrent({ ...value.current(),
      block: { ...value.current().block, hash: hash('reorged-block') } }));
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_current_changed' });
    value.onManifest(undefined);
    await value.database.db.update(catalog).set({ checkpointId: hash('wrong-id') })
      .where(eq(catalog.storageRef, descriptor.storageRef));
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_catalog_corrupt' });
    await value.database.db.delete(catalog).where(eq(catalog.storageRef, descriptor.storageRef));
    await expect(value.service.current(agent, agentId)).rejects.toMatchObject({ code: 'cyst_current_unresolved' });
  });
});
