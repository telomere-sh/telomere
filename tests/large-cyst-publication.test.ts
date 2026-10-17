import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { openStore } from '../src/store.js';
import { LARGE_CYST_CHUNK_BYTES, parseLargeCystManifest,
  type LargeCystHeader, type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { LargeCystPublicationService } from '../src/cysts/large-publication-service.js';
import { cystRegistryPinsSchema, type CystRegistryReader } from '../src/cysts/registry-types.js';
import { createLargeCystPublicationRoutes } from '../src/cysts/large-publication-routes.js';
import { Problem } from '../src/common.js';

const hash = (value: string) => keccak256(toHex(value));
const owner = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const outsider = '0x3333333333333333333333333333333333333333';
const agentId = hash('large-publication-agent');
const checkpointId = hash('large-publication-checkpoint');
const pins = cystRegistryPinsSchema.parse({ chainId: 31337,
  registryAddress: '0x4444444444444444444444444444444444444444', registryCodeHash: hash('registry-code'),
  selectionRegistryAddress: '0x5555555555555555555555555555555555555555',
  selectionRegistryCodeHash: hash('selection-code'), confirmations: 0 });

function manifest(partBytes?: Buffer) {
  const header: LargeCystHeader = { version: 1, algorithm: 'xchacha20-poly1305-chunked',
    id: checkpointId, owner, agent, applicationSchema: 'overlay.tar.zst/v1', plaintextBytes: partBytes ? partBytes.length - 40 : 1,
    chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount: 1, sourceMac: 'a'.repeat(64), keyCommitment: 'b'.repeat(64) };
  return parseLargeCystManifest({ header, parts: [{ index: 0, bytes: partBytes?.length ?? 41,
    sha256: partBytes ? createHash('sha256').update(partBytes).digest('hex') : 'c'.repeat(64) }], mac: 'd'.repeat(64) });
}

type Gate = (signal?: AbortSignal) => Promise<boolean>;
async function fixture(gate?: Gate, deadlineMs?: number, partBytes?: Buffer, partReadTimeoutMs?: number) {
  const store = await openStore({ DATA_DIR: ':memory:' });
  const item = manifest(partBytes);
  let revision = '0', checks = 0, running = 0, maxRunning = 0;
  const storage = {
    begin: async (_header: LargeCystHeader) => undefined,
    header: async (id: string) => id === checkpointId ? item.header : undefined,
    putPart: async (_id: string, _index: number, _bytes: Uint8Array) => undefined,
    part: async (id: string, index: number, _signal?: AbortSignal) =>
      id === checkpointId && index === 0 ? partBytes : undefined,
    commit: async (_manifest: LargeCystManifest) => undefined,
    manifest: async (id: string) => id === checkpointId ? item : undefined,
    isDurable: async (_id: string, signal?: AbortSignal) => {
      running++; maxRunning = Math.max(maxRunning, running);
      try { signal?.throwIfAborted(); return gate ? await gate(signal) : true; }
      finally { running--; }
    },
  };
  const reader: CystRegistryReader = { pins,
    check: async () => { checks++; },
    snapshot: async id => ({
      binding: { agentId: id as typeof agentId, owner, agentWallet: agent,
        vault: '0x6666666666666666666666666666666666666666', status: 1 as const, frozen: false },
      current: { agentId: id as typeof agentId, cystHash: hash('empty'), sizeBytes: '0',
        storageRef: hash('empty-locator'), revision, committedAt: '0', retired: false,
        block: { number: '100', hash: hash('block') } },
    }),
  };
  const service = new LargeCystPublicationService(store.db, storage, reader,
    { ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(partReadTimeoutMs === undefined ? {} : { partReadTimeoutMs }) });
  await service.initialize();
  return { store, service, storage, reader, setRevision: (value: string) => { revision = value; },
    checks: () => checks, maxRunning: () => maxRunning };
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error('Publication test timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('bounded durable large Cyst publication', () => {
  const opened: Array<Awaited<ReturnType<typeof fixture>>> = [];
  afterEach(async () => {
    for (const value of opened.splice(0)) {
      await value.service.close();
      await value.store.close();
    }
  });

  it('admits only the original agent wallet, serializes audits, and keeps idempotent jobs private', async () => {
    const value = await fixture(async () => {
      await new Promise(resolve => setTimeout(resolve, 30)); return true;
    }); opened.push(value);
    await expect(value.service.submit(owner, agentId, checkpointId, 'publication-owner-1'))
      .rejects.toMatchObject({ code: 'cyst_agent_forbidden' });
    const first = await value.service.submit(agent, agentId, checkpointId, 'publication-agent-1');
    const replay = await value.service.submit(agent, agentId, checkpointId, 'publication-agent-1');
    expect(replay.id).toBe(first.id);
    await expect(value.service.submit(agent, agentId, checkpointId, 'publication-agent-2'))
      .rejects.toMatchObject({ code: 'cyst_publication_agent_busy' });
    const secondAgentId = hash('large-publication-second-agent');
    const second = await value.service.submit(agent, secondAgentId, checkpointId, 'publication-agent-2');
    await expect(value.service.get(outsider, first.id)).rejects.toMatchObject({ code: 'cyst_publication_not_found' });
    const complete = await until(() => value.service.get(agent, first.id), item => item.status === 'succeeded');
    await until(() => value.service.get(agent, second.id, secondAgentId), item => item.status === 'succeeded');
    expect(complete.plan?.transaction.from.toLowerCase()).toBe(agent);
    expect(complete.plan?.transaction.to.toLowerCase()).toBe(pins.registryAddress.toLowerCase());
    expect(value.maxRunning()).toBe(1);
    expect(value.checks()).toBeGreaterThan(1);
    await expect(value.service.submit(agent, agentId, hash('other-checkpoint'), 'publication-agent-1'))
      .rejects.toMatchObject({ code: 'cyst_publication_idempotency' });
  });

  it('aborts an active scan on cancellation and requeues a crash-left unsigned job on restart', async () => {
    let attempt = 0;
    const value = await fixture(signal => {
      attempt++;
      if (attempt > 2) return Promise.resolve(true);
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }); opened.push(value);
    const cancelled = await value.service.submit(agent, agentId, checkpointId, 'publication-cancel');
    await until(() => value.service.get(agent, cancelled.id), item => item.status === 'running');
    await value.service.cancel(agent, cancelled.id);
    const stopped = await until(() => value.service.get(agent, cancelled.id), item => item.status === 'cancelled');
    expect(stopped.plan).toBeUndefined();
    const interrupted = await value.service.submit(agent, agentId, checkpointId, 'publication-restart');
    await until(() => value.service.get(agent, interrupted.id), item => item.status === 'running');
    await value.service.close();
    const replacement = new LargeCystPublicationService(value.store.db, value.storage, value.reader);
    await replacement.initialize();
    value.service = replacement;
    const recovered = await until(() => replacement.get(agent, interrupted.id), item => item.status === 'succeeded');
    expect(recovered.plan?.transaction.from.toLowerCase()).toBe(agent);
    expect(value.maxRunning()).toBe(1);
  });

  it('drops completed calldata when the canonical registry revision changes', async () => {
    const value = await fixture(); opened.push(value);
    const task = await value.service.submit(agent, agentId, checkpointId, 'publication-stale');
    await until(() => value.service.get(agent, task.id), item => item.status === 'succeeded');
    value.setRevision('1');
    const stale = await value.service.get(agent, task.id);
    expect(stale.status).toBe('stale');
    expect(stale.plan).toBeUndefined();
  });

  it('bounds the durable queue and records a deadline without leaving the audit running', async () => {
    const value = await fixture(signal => new Promise((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 1000); opened.push(value);
    const tasks: Array<{ id: string }> = [];
    for (let index = 0; index < 8; index++) {
      tasks.push(await value.service.submit(agent, hash(`large-publication-queued-agent-${index}`), checkpointId, `publication-bound-${index}`));
    }
    await expect(value.service.submit(agent, hash('large-publication-overflow-agent'), checkpointId, 'publication-bound-overflow'))
      .rejects.toMatchObject({ code: 'cyst_publication_busy' });
    const first = await until(() => value.service.get(agent, tasks[0]!.id), item => item.status === 'failed');
    expect(first.errorCode).toBe('cyst_publication_deadline');
    for (const task of tasks.slice(1)) await value.service.cancel(agent, task.id);
  });

  it('bounds submissions waiting on authentication before they reach the durable queue', async () => {
    const value = await fixture(); opened.push(value);
    const originalSnapshot = value.reader.snapshot.bind(value.reader);
    let release: () => void = () => undefined;
    let arrived = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    value.reader.snapshot = async id => { arrived++; await hold; return originalSnapshot(id); };
    const submissions = Array.from({ length: 8 }, (_, index) => value.service.submit(agent,
      hash(`large-publication-admission-agent-${index}`), checkpointId, `publication-admission-${index}`));
    try {
      await until(async () => arrived, count => count === 8);
      await expect(value.service.submit(agent, hash('large-publication-admission-overflow'), checkpointId,
        'publication-admission-overflow')).rejects.toMatchObject({ code: 'cyst_publication_busy' });
      expect(arrived).toBe(8);
    } finally { release(); }
    expect(await Promise.all(submissions)).toHaveLength(8);
  });

  it('bounds concurrent agent manifest GETs before registry reads and releases slots on success or failure', async () => {
    const value = await fixture(); opened.push(value);
    const routes = createLargeCystPublicationRoutes(value.service, async () => agent);
    routes.onError((error, context) => error instanceof Problem
      ? context.json({ code: error.code }, error.status) : context.json({ code: 'internal' }, 500));
    const path = `/agents/${agentId}/checkpoints/${checkpointId}/manifest`;
    const originalSnapshot = value.reader.snapshot.bind(value.reader);
    let release: () => void = () => undefined;
    let arrived = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    value.reader.snapshot = async id => { arrived++; await hold; return originalSnapshot(id); };
    const pending = Array.from({ length: 8 }, () => routes.request(path));
    try {
      await until(async () => arrived, count => count === 8);
      const overflow = await routes.request(path);
      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toEqual({ code: 'cyst_manifest_busy' });
      expect(arrived).toBe(8);
    } finally { release(); }
    expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array(8).fill(200));

    const previousManifest = value.storage.manifest;
    value.storage.manifest = async () => { throw new Error('test storage unavailable'); };
    try { expect((await routes.request(path)).status).toBe(500); }
    finally { value.storage.manifest = previousManifest; }
    expect((await routes.request(path)).status).toBe(200);
  });

  it('serves only the original agent a digest-checked ciphertext part', async () => {
    const bytes = Buffer.alloc(41, 7);
    const value = await fixture(undefined, undefined, bytes); opened.push(value);
    const routes = createLargeCystPublicationRoutes(value.service,
      async context => context.req.header('x-test-principal') ?? outsider);
    routes.onError((error, context) => error instanceof Problem
      ? context.json({ code: error.code }, error.status) : context.json({ code: 'internal' }, 500));
    const path = `/agents/${agentId}/checkpoints/${checkpointId}/parts/0`;
    expect((await routes.request(path, { headers: { 'x-test-principal': owner } })).status).toBe(403);
    expect((await routes.request(path, { headers: { 'x-test-principal': outsider } })).status).toBe(403);
    const allowed = await routes.request(path, { headers: { 'x-test-principal': agent } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toBe('application/octet-stream');
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes);
    value.storage.part = async () => Buffer.alloc(41, 8);
    const corrupt = await routes.request(path, { headers: { 'x-test-principal': agent } });
    expect(corrupt.status).toBe(503);
    expect(await corrupt.json()).toEqual({ code: 'cyst_part_unavailable' });
  });

  it('holds at most four part transfers and rejects a changed canonical binding', async () => {
    const value = await fixture(undefined, undefined, Buffer.alloc(41, 7)); opened.push(value);
    const open = await Promise.all(Array.from({ length: 4 }, () =>
      value.service.part(agent, agentId, checkpointId, 0)));
    try {
      await expect(value.service.part(agent, agentId, checkpointId, 0))
        .rejects.toMatchObject({ code: 'cyst_part_busy' });
    } finally { for (const item of open) item.release(); }
    const originalSnapshot = value.reader.snapshot.bind(value.reader);
    let count = 0;
    value.reader.snapshot = async id => {
      const snapshot = await originalSnapshot(id);
      count++;
      return count === 2 ? { ...snapshot, binding: { ...snapshot.binding, owner: outsider } } : snapshot;
    };
    try {
      await expect(value.service.part(agent, agentId, checkpointId, 0))
        .rejects.toMatchObject({ code: 'cyst_revision_changed' });
    } finally { value.reader.snapshot = originalSnapshot; }
    const recovered = await value.service.part(agent, agentId, checkpointId, 0);
    expect(recovered.bytes).toEqual(Buffer.alloc(41, 7));
    recovered.release();
  });

  it('releases the part slot at the read deadline even when a store ignores abort', async () => {
    const bytes = Buffer.alloc(41, 7);
    const value = await fixture(undefined, undefined, bytes, 20); opened.push(value);
    let received: AbortSignal | undefined;
    const original = value.storage.part;
    value.storage.part = async (_id, _index, signal) => {
      received = signal;
      return new Promise<Buffer>(() => undefined);
    };
    await expect(value.service.part(agent, agentId, checkpointId, 0))
      .rejects.toMatchObject({ code: 'cyst_part_unavailable' });
    expect(received?.aborted).toBe(true);
    value.storage.part = original;
    const recovered = await value.service.part(agent, agentId, checkpointId, 0);
    expect(recovered.bytes).toEqual(bytes);
    recovered.release();
  });

  it('releases a large HTTP part transfer slot when the agent cancels the stream', async () => {
    const bytes = Buffer.alloc(LARGE_CYST_CHUNK_BYTES + 40, 7);
    const value = await fixture(undefined, undefined, bytes); opened.push(value);
    const routes = createLargeCystPublicationRoutes(value.service, async () => agent);
    routes.onError((error, context) => error instanceof Problem
      ? context.json({ code: error.code }, error.status) : context.json({ code: 'internal' }, 500));
    const path = `/agents/${agentId}/checkpoints/${checkpointId}/parts/0`;
    const open = await Promise.all(Array.from({ length: 4 }, () => routes.request(path)));
    try {
      expect(open.map(response => response.status)).toEqual([200, 200, 200, 200]);
      expect((await routes.request(path)).status).toBe(429);
      await open[0]!.body?.cancel();
      const resumed = await routes.request(path);
      expect(resumed.status).toBe(200);
      await resumed.body?.cancel();
    } finally { for (const response of open) await response.body?.cancel().catch(() => undefined); }
  });

  it('exposes a small authenticated asynchronous HTTP boundary', async () => {
    const value = await fixture(); opened.push(value);
    const routes = createLargeCystPublicationRoutes(value.service, async context => context.req.header('x-test-principal') ?? outsider);
    routes.onError((error, context) => error instanceof Problem
      ? context.json({ code: error.code }, error.status) : context.json({ code: 'internal' }, 500));
    const manifestPath = `/agents/${agentId}/checkpoints/${checkpointId}/manifest`;
    const ownerManifest = await routes.request(manifestPath, { headers: { 'x-test-principal': owner } });
    expect(ownerManifest.status).toBe(403);
    const outsiderManifest = await routes.request(manifestPath, { headers: { 'x-test-principal': outsider } });
    expect(outsiderManifest.status).toBe(403);
    const agentManifest = await routes.request(manifestPath, { headers: { 'x-test-principal': agent } });
    expect(agentManifest.status).toBe(200);
    expect(agentManifest.headers.get('cache-control')).toBe('no-store');
    expect(agentManifest.headers.get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(manifest()))));
    expect(await agentManifest.json()).toEqual(manifest());
    const previousManifest = value.storage.manifest;
    value.storage.manifest = async id => id === checkpointId
      ? parseLargeCystManifest({ ...manifest(), header: { ...manifest().header, owner: outsider } }) : undefined;
    try {
      const mismatched = await routes.request(manifestPath, { headers: { 'x-test-principal': agent } });
      expect(mismatched.status).toBe(404);
    } finally { value.storage.manifest = previousManifest; }
    const path = `/agents/${agentId}/jobs`;
    const ownerResponse = await routes.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'idempotency-key': 'publication-route-owner', 'x-test-principal': owner,
    }, body: JSON.stringify({ checkpointId }) });
    expect(ownerResponse.status).toBe(403);
    const response = await routes.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'idempotency-key': 'publication-route-agent', 'x-test-principal': agent,
    }, body: JSON.stringify({ checkpointId }) });
    expect(response.status).toBe(202);
    const created = await response.json() as { id: string };
    await until(() => value.service.get(agent, created.id), item => item.status === 'succeeded');
    const status = await routes.request(path + '/' + created.id, { headers: { 'x-test-principal': agent } });
    expect(status.status).toBe(200);
    expect((await status.json() as { status: string }).status).toBe('succeeded');
    const cancelPath = path + '/' + created.id + '/cancel';
    const oversized = await routes.request(cancelPath, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-test-principal': agent,
    }, body: JSON.stringify({ padding: 'x'.repeat(600) }) });
    expect(oversized.status).toBe(413);
    const alreadyComplete = await routes.request(cancelPath, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-test-principal': agent,
    }, body: '{}' });
    expect(alreadyComplete.status).toBe(200);
  });
});
