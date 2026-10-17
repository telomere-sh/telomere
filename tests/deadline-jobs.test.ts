import pino from 'pino';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, http, type Hex } from 'viem';
import { deployLocalContracts, startLocalChain } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/index.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge, type WalletTransaction } from '../src/bridge.js';
import { Service, signedReceiptSchema } from '../src/service.js';
import { jobs, openStore } from '../src/store.js';
import { randomId } from '../src/common.js';
import { Worker } from '../src/worker.js';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { createDemoCpuExecutor, type CpuExecutor, type MeterTick } from '../src/runtime/index.js';
import { outputHash } from '../src/runtime/meter.js';
import { DeadlineService } from '../src/scheduling/service.js';
import { priceQuantiles, selectCapacity, type Capacity } from '../src/scheduling/planner.js';

describe('deadline jobs through actual escrow, owner API and durable worker', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge, service: Service, deadlines: DeadlineService;
  let wallet: ReturnType<typeof createWalletClient>, snapshot: Hex, leashId: Hex, session: string;
  let app: ReturnType<typeof createApp>;
  const origin = 'http://127.0.0.1:3284', logger = pino({ enabled: false });
  beforeAll(async () => {
    local = await startLocalChain(); deployed = await deployLocalContracts(local);
    wallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain, transport: http(local.rpcUrl, { retryCount: 0 }) });
    snapshot = await deployed.testClient.snapshot();
  });
  async function confirmed(hash: Promise<Hex>) {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash });
    expect(receipt.status).toBe('success'); return receipt;
  }
  const send = (transaction: WalletTransaction) => confirmed(wallet.sendTransaction({ account: deployed.accounts.owner,
    chain: localChain, to: transaction.to, data: transaction.data, value: 0n }));
  beforeEach(async () => {
    await deployed.testClient.revert({ id: snapshot }); snapshot = await deployed.testClient.snapshot();
    const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: origin,
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress });
    store = await openStore(config); bridge = new ChainBridge(config); service = new Service(store.db, bridge, config, false);
    deadlines = new DeadlineService(service); const auth = new Auth(store.db, config);
    session = await auth.session(deployed.accounts.owner.address); app = createApp(service, auth, logger);
    const mockToken = deployed.artifacts.MockToken;
    if (!mockToken) throw new Error('Missing disposable token artifact');
    await confirmed(wallet.writeContract({ account: deployed.accounts.owner, chain: localChain,
      address: deployed.tokenAddress, abi: mockToken.abi, functionName: 'faucet', args: [deployed.accounts.owner.address, 10000000n] }));
    for (const transaction of bridge.depositTransactions(1000000n)) await send(transaction);
    const prepared = await service.createLeash(deployed.accounts.owner.address, deployed.accounts.owner.address, 1000000n, 1000000n,
      BigInt(Math.floor(Date.now() / 1000) + 86400)); leashId = prepared.leashId; await send(prepared.transaction);
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });
  afterAll(async () => { await local.close(); });
  function request(overrides: Record<string, unknown> = {}) {
    return { leashId, task: { kind: 'sha256', text: 'deadline acceptance' }, maxSeconds: 5,
      maxSpend: '5000', deadline: Math.floor(Date.now() / 1000) + 60, ...overrides };
  }
  async function reserve(input = request(), key = 'deadline_request_001') {
    const prepared = await deadlines.prepare(deployed.accounts.owner.address, input, key);
    const receipt = await send(prepared.transaction);
    await service.admit(deployed.accounts.owner.address, prepared.quote.runId, receipt.transactionHash);
    return prepared;
  }
  function api(path: string, body?: unknown, token = session) {
    return app.request('/api/jobs' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: `telomere_session=${token}`, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'deadline_http_001',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it('prepares one immutable quote under concurrent original retries and rejects changed terms', async () => {
    const input = request(); const responses = await Promise.all([1, 2, 3].map(() => deadlines.prepare(deployed.accounts.owner.address, input, 'same_request_001')));
    expect(new Set(responses.map(row => row.quote.runId)).size).toBe(1);
    expect(responses[0]?.quote.quoteExpiry).toBe(input.deadline - input.maxSeconds);
    expect(await store.db.select().from(jobs)).toHaveLength(1);
    await expect(deadlines.prepare(deployed.accounts.owner.address, { ...input, deadline: input.deadline + 1 }, 'same_request_001')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rejects infeasible spend, tight/remote deadlines and inference fields before any quote', async () => {
    await expect(deadlines.prepare(deployed.accounts.owner.address, request({ maxSpend: '1' }), 'too_cheap_001')).rejects.toMatchObject({ code: 'deadline_infeasible' });
    await expect(deadlines.prepare(deployed.accounts.owner.address, request({ deadline: Math.floor(Date.now() / 1000) + 5 }), 'too_short_001')).rejects.toMatchObject({ code: 'invalid_deadline' });
    await expect(deadlines.prepare(deployed.accounts.owner.address, request({ deadline: Math.floor(Date.now() / 1000) + 8 * 86400 }), 'too_distant_001')).rejects.toMatchObject({ code: 'invalid_deadline' });
    await expect(deadlines.prepare(deployed.accounts.owner.address, request({ nearPrompt: 'not a deadline GPU lease' }), 'unexpected_001')).rejects.toBeDefined();
    expect(await store.db.select().from(jobs)).toHaveLength(0);
  });
  it('authenticates API and hides another owner job', async () => {
    expect((await api('/deadline', request(), '')).status).toBe(401);
    const response = await api('/deadline', request()); expect(response.status).toBe(200);
    const prepared = await response.json();
    await expect(deadlines.get(deployed.accounts.outsider.address, prepared.deadlineJob.id)).rejects.toMatchObject({ code: 'deadline_not_found' });
    expect((await api('/deadline/' + prepared.deadlineJob.id)).status).toBe(200);
    expect((await api('/prices')).status).toBe(200);
  });
  it('executes a real application task and anchors the deadline in its signed settled receipt', async () => {
    const prepared = await reserve(); const worker = new Worker(store.db, bridge, createDemoCpuExecutor(), undefined, logger);
    await worker.drainOnce(); const job = await service.requireJob(deployed.accounts.owner.address, prepared.quote.runId);
    expect(job.status).toBe('completed'); expect(job.output).toContain(outputHash('deadline acceptance'));
    const receipt = signedReceiptSchema.parse(job.receipt);
    expect(receipt.body.deadline).toMatchObject({ missed: false, jobId: prepared.deadlineJob.id });
    expect(await service.verifyReceipt(receipt)).toMatchObject({ valid: true, anchored: true });
    expect((await bridge.run(prepared.quote.runId)).status).toBe(2);
  });
  it('returns the full actual escrow ceiling without CPU dispatch when queue delay makes the deadline infeasible', async () => {
    const input = request(); const prepared = await reserve(input);
    const run = vi.fn<CpuExecutor['run']>(); const worker = new Worker(store.db, bridge, { run }, undefined, logger);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 58000);
    await worker.drainOnce(); expect(run).not.toHaveBeenCalled();
    const job = await service.requireJob(deployed.accounts.owner.address, prepared.quote.runId);
    expect(job).toMatchObject({ status: 'timed_out', charged: '0', refund: prepared.ceiling, errorCode: 'DEADLINE_MISSED' });
    expect(await bridge.balance(deployed.accounts.owner.address)).toEqual({ available: '1000000' });
    expect(await service.verifyReceipt(job.receipt)).toMatchObject({ valid: true, anchored: true });
  });
  function observedCpu(timestamp: string): CpuExecutor {
    return { run: async (input, _signal, onTick) => {
      const output = 'controlled host result';
      const record = { runId: input.runId, sequence: 0, timestamp, elapsedMs: 2000, billableSeconds: 2,
        state: 'completed' as const, previousHash: null, outputHash: outputHash(output) };
      const tick: MeterTick = { ...record, hash: outputHash(JSON.stringify(record)) }; await onTick?.(tick);
      return { status: 'completed', output, exitCode: 0, billableSeconds: 2, ticks: [tick] };
    } };
  }
  it('keeps measured observations but waives billing when the terminal observation is late', async () => {
    const input = request(), prepared = await reserve(input);
    await new Worker(store.db, bridge, observedCpu(new Date(input.deadline * 1000 + 1).toISOString()), undefined, logger).drainOnce();
    const job = await service.requireJob(deployed.accounts.owner.address, prepared.quote.runId);
    expect(job).toMatchObject({ status: 'timed_out', charged: '0', refund: prepared.ceiling });
    expect(signedReceiptSchema.parse(job.receipt).body.cpu).toMatchObject({ measuredSeconds: 2, billableSeconds: 0 });
    expect(await service.verifyReceipt(job.receipt)).toMatchObject({ valid: true, anchored: true });
  });
  it('does not turn an on-time completion into a missed deadline when receipt signing retries later', async () => {
    const input = request(), prepared = await reserve(input);
    const sign = vi.spyOn(bridge, 'signSettlement').mockRejectedValueOnce(new Error('transient signer outage'));
    const worker = new Worker(store.db, bridge, observedCpu(new Date().toISOString()), undefined, logger);
    // Both execute's attempt and this drain's immediate retry fail, preserving receipt_pending.
    sign.mockRejectedValueOnce(new Error('transient signer outage'));
    await worker.drainOnce();
    expect((await service.requireJob(deployed.accounts.owner.address, prepared.quote.runId)).status).toBe('receipt_pending');
    await deployed.testClient.increaseTime({ seconds: 3 }); await deployed.testClient.mine({ blocks: 1 });
    vi.spyOn(Date, 'now').mockReturnValue((input.deadline + 30) * 1000);
    await worker.drainOnce(); const job = await service.requireJob(deployed.accounts.owner.address, prepared.quote.runId);
    expect(job.status).toBe('completed'); expect(BigInt(job.charged ?? '0')).toBeGreaterThan(0n);
    expect(signedReceiptSchema.parse(job.receipt).body.deadline).toMatchObject({ missed: false });
    expect(await service.verifyReceipt(job.receipt)).toMatchObject({ valid: true, anchored: true });
  });
  it('publishes only settled indexed price samples, excluding prepared and waived work', async () => {
    await reserve(); expect((await deadlines.prices()).windows[0]?.count).toBe(0);
    const rows = await store.db.select().from(jobs); const row = rows[0]!;
    await store.db.update(jobs).set({ status: 'completed', charged: '200', billableSeconds: 2, receipt: {}, settlementTxHash: randomId() }).where(eq(jobs.id, row.id));
    const prices = await deadlines.prices(); expect(prices.windows[0]).toMatchObject({ count: 1, median: row.quote.pricePerSecond });
    await store.db.update(jobs).set({ charged: '0' }).where(eq(jobs.id, row.id));
    expect((await deadlines.prices()).windows[0]?.count).toBe(0);
  });
});

describe('capacity placement exact arithmetic', () => {
  const digest = 'sha256:' + '11'.repeat(32);
  const host = (id: string, price = '100', overrides: Partial<Capacity> = {}): Capacity => ({ hostId: `0x${id.repeat(64)}`,
    hardwareClass: 'cpu', region: 'eu-private', imageDigest: digest, sealed: false, lane: 'standard',
    pricePerSecond: price, reliabilityBps: 10000, strikes: 0, stake: '0', availableAt: 100, ...overrides });
  const input = { hardwareClasses: ['cpu' as const], regions: ['eu-private'], images: [digest], sealedOnly: false,
    lanes: ['standard' as const], seconds: 10, maxSpend: '2000', deadline: 200, now: 100 };
  it('filters class/region/image/TEE/lane/availability/spend before price ranking', () => {
    const valid = host('1');
    expect(selectCapacity(input, [host('2', '1', { region: 'us-private' }), host('3', '1', { availableAt: 195 }), valid]).host.hostId).toBe(valid.hostId);
    expect(() => selectCapacity({ ...input, sealedOnly: true }, [valid])).toThrow(/No admitted capacity/);
  });
  it('ranks exact effective reliability/strikes and allows stake only inside the five-percent band', () => {
    expect(selectCapacity(input, [host('1', '100'), host('2', '104', { stake: '1000' }), host('3', '106', { stake: '99999' })]).host.hostId).toBe(host('2').hostId);
    expect(selectCapacity(input, [host('1', '90', { reliabilityBps: 5000 }), host('2', '100')]).host.hostId).toBe(host('2').hostId);
  });
  it('does not round large token integers through floating point and rejects ambiguous host entries', () => {
    const amount = '10000000000000000000000000';
    expect(selectCapacity({ ...input, maxSpend: '200000000000000000000000000' }, [host('1', amount)]).ceiling).toBe((BigInt(amount) * 10n).toString());
    expect(() => selectCapacity(input, [host('1'), host('1')])).toThrow(/ambiguous/);
    expect(priceQuantiles([10n, 3n, 2n, 1n, 5n])).toEqual({ count: 5, p10: '1', median: '3', p90: '5' });
  });
});
