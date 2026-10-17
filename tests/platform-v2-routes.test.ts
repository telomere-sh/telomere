import { describe, expect, it, vi } from 'vitest';
import { platformV2EvidenceCoreSchema } from '../src/receipts/platform-v2.js';
import { createPlatformV2Routes } from '../src/receipts/platform-v2-routes.js';
import type { verifyPlatformV2CombinedEvidence, verifyPlatformV2PublishedEvidence } from '../src/receipts/platform-v2-combined.js';
import type { PlatformV2PublishedEvidenceReader } from '../src/receipts/platform-v2-publication.js';

const id = (digit: string) => `0x${digit.repeat(64)}`;
const owner = '0x1111111111111111111111111111111111111111';
const escrow = '0x2222222222222222222222222222222222222222';
const registry = '0x3333333333333333333333333333333333333333';
const signature = `0x${'a'.repeat(130)}`;
const hostSignature = Buffer.alloc(64).toString('base64');
const bridge = {} as Parameters<typeof verifyPlatformV2CombinedEvidence>[0]; // Fixture verifier never reads the bridge.

function core() {
  const quote = { runId: id('1'), leashId: id('2'), hostId: id('3'), payer: owner,
    hwClass: 0, regionHash: id('4'), imageHash: id('5'), workloadHash: id('6'),
    maxSeconds: 30, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: 1_700_000_020 };
  const hostKey = id('7'), controllerKey = id('8'), leaseHash = id('9');
  return platformV2EvidenceCoreSchema.parse({
    protocol: 'telomere-platform-evidence-core-v2', quote, quoteSignature: signature,
    delegation: { body: { version: 2, chainId: 31337, escrow, hostRegistry: registry,
      runId: quote.runId, hostId: quote.hostId, hostKey, controllerKey, quoteHash: id('a'),
      signedLeaseHash: id('b'), meterLeaseHash: leaseHash,
      leaseIssuedAtMs: 1_700_000_000_000, leaseExpiresAtMs: 1_700_000_030_000,
      maxSeconds: 30, nonce: id('c') }, signature },
    ticks: [{ body: { version: 1, hostKey, runId: quote.runId, owner, leaseHash,
      sequence: 0, timestamp: 1_700_000_005_000, elapsedMs: 5_000, cpuMs: 1_000,
      state: 'EXITED', previousHash: null, heartbeat: null,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }, signature: hostSignature }],
    acknowledgments: [{ body: { version: 1, hostKey, runId: quote.runId, leaseHash,
      sequence: 0, tickHash: id('d'), acceptedAt: 1_700_000_005_000,
      billableSeconds: 0, billableDelta: 0, fault: false }, signature: hostSignature }],
    hostEvidenceRoot: id('e'), hostPairCount: 1, endedAt: 1_700_000_005,
    billableSeconds: 0, inferenceCharge: '0', status: 'completed', outputCommitment: id('f'),
  });
}

type CombinedResult = Awaited<ReturnType<typeof verifyPlatformV2CombinedEvidence>>;
const result = {
  verification: 'caller-presented-v2-core-with-canonical-financial-commitment',
  opening: { transactionHash: id('1'), blockHash: id('2'), blockNumber: 15n,
    logIndex: 0, confirmations: 6n },
  financial: { kind: 'settlement', confirmations: '3' },
  independentlyPublished: false, historicalDelegationIssuanceTimeProven: false,
  committedTickAckSequenceVerified: true,
} as CombinedResult; // The injected verifier is a route boundary fixture, not a financial proof fixture.
const envelope = () => ({ openTransactionHash: id('1'), settlementTransactionHash: id('2'), core: core() });
const post = (routes: ReturnType<typeof createPlatformV2Routes>, value: unknown = envelope()) =>
  routes.request('http://localhost/verify', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

describe('bounded public Platform v2 combined verification route', () => {
  it('requires configured retrieval and rejects request-selected sources before any GET verification', async () => {
    const routes = createPlatformV2Routes(bridge, 1);
    const url = `http://localhost/runs/${id('1')}?settlementTransactionHash=${id('2')}`;
    expect((await routes.request(url)).status).toBe(503);
    expect((await routes.request(url + '&endpoint=https://caller.example')).status).toBe(422);
    expect((await routes.request('http://localhost/runs/wrong?settlementTransactionHash=' + id('2'))).status).toBe(422);
  });
  it('holds GET slots after timeout, sharing the bound with POST until underlying verification completes', async () => {
    vi.useFakeTimers();
    try {
      type Published = Awaited<ReturnType<typeof verifyPlatformV2PublishedEvidence>>;
      let finish!: (value: Published) => void;
      const pending = new Promise<Published>(resolve => { finish = resolve; });
      const publishedVerifier = vi.fn(() => pending);
      const reader = { retrieve: vi.fn() } as Pick<PlatformV2PublishedEvidenceReader, 'retrieve'>;
      const routes = createPlatformV2Routes(bridge, 1, async () => result, reader, publishedVerifier);
      const url = `http://localhost/runs/${id('1')}?settlementTransactionHash=${id('2')}`;
      const requests = Array.from({ length: 4 }, () => routes.request(url));
      await vi.advanceTimersByTimeAsync(1);
      expect(publishedVerifier).toHaveBeenCalledTimes(4);
      expect((await post(routes)).status).toBe(429);
      await vi.advanceTimersByTimeAsync(30_000);
      for (const response of await Promise.all(requests)) expect(response.status).toBe(503);
      expect((await routes.request(url)).status).toBe(429);
      finish({ verification: result, core: core(), publication: {} } as Published); // HTTP boundary fixture only.
      await vi.advanceTimersByTimeAsync(1);
      expect((await post(routes)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
  it('returns the complete verdict with only opening bigints converted to decimal strings', async () => {
    const verify = vi.fn(async () => result);
    const routes = createPlatformV2Routes(bridge, 2, verify);
    const response = await post(routes);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.json()).toMatchObject({ opening: { blockNumber: '15', confirmations: '6' },
      financial: { confirmations: '3' }, independentlyPublished: false,
      historicalDelegationIssuanceTimeProven: false, committedTickAckSequenceVerified: true });
    expect(verify).toHaveBeenCalledWith(bridge, id('1'), id('2'), envelope().core, 2);
  });

  it('rejects invalid schemas, request-selected parameters and non-JSON media before verification', async () => {
    const verify = vi.fn(async () => result);
    const routes = createPlatformV2Routes(bridge, 1, verify);
    expect((await post(routes, { ...envelope(), pins: {} })).status).toBe(422);
    expect((await post(routes, { ...envelope(), minConfirmations: 0 })).status).toBe(422);
    expect((await post(routes, { ...envelope(), core: { ...core(), hostPairCount: 0 } })).status).toBe(422);
    expect((await routes.request('http://localhost/verify?minConfirmations=0', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope()) })).status).toBe(422);
    expect((await routes.request('http://localhost/verify', { method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(envelope()) })).status).toBe(415);
    expect((await routes.request('http://localhost/verify', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(() => createPlatformV2Routes(bridge, 0)).toThrow('confirmation depth');
    expect(() => createPlatformV2Routes(bridge, 129)).toThrow('confirmation depth');
  });

  it('returns a generic unavailable response for both verifier rejection and uncertainty', async () => {
    const routes = createPlatformV2Routes(bridge, 1, async () => {
      throw new Error('private RPC token and verifier internal state');
    });
    const response = await post(routes);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('verification_unavailable');
    expect(body).not.toContain('private RPC token');
  });

  it('counts actual body bytes even when a declared length understates them', async () => {
    const verify = vi.fn(async () => result);
    const routes = createPlatformV2Routes(bridge, 1, verify);
    const response = await routes.request('http://localhost/verify', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
      body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }) });
    expect(response.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('retains body-read slots until timed-out sources acknowledge cancellation', async () => {
    vi.useFakeTimers();
    try {
      const verify = vi.fn(async () => result);
      const routes = createPlatformV2Routes(bridge, 1, verify);
      const finishCancellation: Array<() => void> = [];
      const slowRequest = () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
          cancel() { return new Promise<void>(resolve => { finishCancellation.push(resolve); }); },
        });
        return routes.request('http://localhost/verify', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
          body, duplex: 'half' } as RequestInit); // Node's streaming Request option is absent from DOM RequestInit.
      };
      const responses = Array.from({ length: 4 }, slowRequest);
      await vi.advanceTimersByTimeAsync(5_001);
      for (const response of await Promise.all(responses)) expect(response.status).toBe(408);
      expect((await post(routes)).status).toBe(429);
      expect(finishCancellation).toHaveLength(4);
      for (const finish of finishCancellation) finish();
      await vi.advanceTimersByTimeAsync(1);
      expect((await post(routes)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it('holds verification slots after response timeout until the underlying work settles', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: CombinedResult) => void;
      const pending = new Promise<CombinedResult>(resolve => { finish = resolve; });
      const verify = vi.fn(() => pending);
      const routes = createPlatformV2Routes(bridge, 1, verify);
      const requests = Array.from({ length: 4 }, () => post(routes));
      await vi.advanceTimersByTimeAsync(1);
      expect(verify).toHaveBeenCalledTimes(4);
      expect((await post(routes)).status).toBe(429);
      await vi.advanceTimersByTimeAsync(30_000);
      for (const response of await Promise.all(requests)) expect(response.status).toBe(503);
      expect((await post(routes)).status).toBe(429);
      finish(result);
      await vi.advanceTimersByTimeAsync(1);
      expect((await post(routes)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
