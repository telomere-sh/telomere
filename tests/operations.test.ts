import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { ChainBridge } from '../src/bridge.js';
import { hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { createOperations } from '../src/operations.js';
import { Service } from '../src/service.js';
import { jobs, openStore, type RunStatus } from '../src/store.js';
import { Worker, type WorkerSnapshot } from '../src/worker.js';
import type { CpuExecutor } from '../src/runtime/index.js';

const ownerKey: Hex = `0x${'55'.repeat(32)}`;
const outsiderKey: Hex = `0x${'99'.repeat(32)}`;
const owner = privateKeyToAccount(ownerKey).address;
const outsider = privateKeyToAccount(outsiderKey).address;
const ownerRun: Hex = `0x${'22'.repeat(32)}`;
const completedRun: Hex = `0x${'23'.repeat(32)}`;
const outsiderRun: Hex = `0x${'33'.repeat(32)}`;
const leashId: Hex = `0x${'44'.repeat(32)}`;
const zero: Hex = `0x${'00'.repeat(32)}`;
const txHash: Hex = `0x${'aa'.repeat(32)}`;
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: ownerKey, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666',
  TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777' });

describe('controller dispatch gate and tenant-scoped operational status', () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: ChainBridge;
  let service: Service;
  let app: ReturnType<typeof createApp>;
  let ownerSession: string;
  let outsiderSession: string;
  let snapshot: WorkerSnapshot = { state: 'idle' };
  const logger = pino({ enabled: false });

  async function insertJob(address: Address, id: Hex, status: RunStatus) {
    const input = { leashId, task: { kind: 'sha256' as const, text: 'operations fixture' }, maxSeconds: 30 };
    const quote = { runId: id, leashId, payer: address, workloadHash: hashJson(input), maxSeconds: 30,
      pricePerSecond: '100', inferencePrice: '0', quoteExpiry: Math.floor(Date.now() / 1000) + 300 };
    await store.db.insert(jobs).values({ id, owner: address.toLowerCase(), leashId, idemKey: `ops-${id}`,
      inputHash: hashJson(input), input, quote, signature: `0x${'ab'.repeat(65)}`, ceiling: '3000', status });
  }
  function request(path: string, body?: unknown, session = ownerSession) {
    return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: {
      cookie: `telomere_session=${session}`, origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'operations-test-key',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  beforeAll(async () => {
    store = await openStore(config);
    bridge = new ChainBridge(config);
    vi.spyOn(bridge, 'check').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'balance').mockResolvedValue({ available: '10000000' });
    vi.spyOn(bridge, 'run').mockResolvedValue({ payer: owner, leashId, workloadHash: zero,
      openedAt: BigInt(Math.floor(Date.now() / 1000)), acceptedExpiry: 10_000_000_000n, maxSeconds: 30n,
      pricePerSecond: 100n, inferencePrice: 0n, ceiling: 3000n, stopAt: 0n, status: 1,
      billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero });
    service = new Service(store.db, bridge, config, false);
    vi.spyOn(service, 'quote').mockRejectedValue(new Error('Dispatch must not reach the quote service'));
    vi.spyOn(service, 'admit').mockRejectedValue(new Error('Dispatch must not reach the admission service'));
    const auth = new Auth(store.db, config);
    ownerSession = await auth.session(owner); outsiderSession = await auth.session(outsider);
    const cpu: CpuExecutor = { run: vi.fn<CpuExecutor['run']>() };
    const worker = new Worker(store.db, bridge, cpu, undefined, logger);
    vi.spyOn(worker, 'snapshot').mockImplementation(() => ({ ...snapshot }));
    const operations = createOperations(store.db, worker, config, false);
    app = createApp(service, auth, logger, './dist/public', operations);
    await insertJob(owner, ownerRun, 'queued');
    await insertJob(owner, completedRun, 'completed');
    await insertJob(outsider, outsiderRun, 'running');
  }, 30000);
  beforeEach(() => {
    snapshot = { state: 'idle' };
    vi.mocked(service.quote).mockClear(); vi.mocked(service.admit).mockClear();
  });
  afterAll(async () => { vi.restoreAllMocks(); await store?.close(); });

  it.each(['stopped', 'quarantined', 'faulted'] as const)('blocks new work while %s and keeps existing funds and recovery intents available', async state => {
    snapshot = { state, ...(state === 'quarantined' ? { reason: 'CPU_RECOVERY_REQUIRED' } : {}) };
    const quote = await request('/api/quotes', { leashId, task: { kind: 'sha256', text: 'must not dispatch' }, maxSeconds: 10 });
    expect(quote.status).toBe(503);
    expect(await quote.json()).toMatchObject({ title: 'controller_unavailable', status: 503 });
    const admission = await request('/api/runs', { runId: ownerRun, txHash });
    expect(admission.status).toBe(503);
    expect(await admission.json()).toMatchObject({ title: 'controller_unavailable', status: 503 });
    expect(service.quote).not.toHaveBeenCalled(); expect(service.admit).not.toHaveBeenCalled();

    const balance = await request('/api/balance');
    expect(balance.status).toBe(200);
    expect(await balance.json()).toEqual({ available: '10000000', reserved: '3000' });
    const withdrawal = await request('/api/transactions/withdraw?amount=100');
    expect(withdrawal.status).toBe(200);
    expect(await withdrawal.json()).toMatchObject({ transaction: { to: config.ESCROW_ADDRESS, value: '0x0' } });
    expect((await request(`/api/runs/${ownerRun}/stop`, {})).status).toBe(200);
    expect((await request(`/api/runs/${ownerRun}/refund`, {})).status).toBe(200);
  });

  it.each(['stopped', 'quarantined', 'faulted'] as const)('reports readiness unavailable while %s without failing liveness', async state => {
    snapshot = { state };
    expect((await request('/health/live')).status).toBe(200);
    const readiness = await request('/health/ready');
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ status: 'unavailable', worker: state });
  });

  it('requires authentication for operations and returns only the requesting tenant counts and active run', async () => {
    snapshot = { state: 'running', activeRunId: outsiderRun };
    expect((await request('/api/operations', undefined, 'invalid')).status).toBe(401);
    const ownResponse = await request('/api/operations');
    expect(ownResponse.status).toBe(200);
    const ownPayload: unknown = await ownResponse.json();
    expect(ownPayload).toMatchObject({ worker: { state: 'running' }, counts: { queued: 1, completed: 1 },
      near: { configured: false, verification: 'disabled' }, cpu: { mode: 'demo' } });
    expect(JSON.stringify(ownPayload)).not.toContain(outsiderRun);
    expect(ownPayload).not.toHaveProperty('worker.activeRunId');
    expect(ownPayload).not.toHaveProperty('counts.running');
    const outsiderResponse = await request('/api/operations', undefined, outsiderSession);
    expect(await outsiderResponse.json()).toMatchObject({ worker: { state: 'running', activeRunId: outsiderRun }, counts: { running: 1 } });

    snapshot = { state: 'running', activeRunId: ownerRun };
    expect(await (await request('/api/operations')).json()).toHaveProperty('worker.activeRunId', ownerRun);
    expect(await (await request('/api/operations', undefined, outsiderSession)).json()).not.toHaveProperty('worker.activeRunId');
  });

  it('fails readiness when its database probe fails and leaves liveness available', async () => {
    vi.spyOn(store.db, 'execute').mockRejectedValueOnce(new Error('Database unavailable'));
    expect((await request('/health/ready')).status).toBe(503);
    expect((await request('/health/live')).status).toBe(200);
  });
});
