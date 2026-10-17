import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainBridge } from '../src/bridge.js';
import { hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import type { NearProvider } from '../src/providers/index.js';
import { RunMeter } from '../src/runtime/meter.js';
import type { CpuExecutor } from '../src/runtime/index.js';
import { receiptSettlement, Service, signedReceiptSchema } from '../src/service.js';
import { jobs, openStore, transactions, type Job } from '../src/store.js';
import { Worker } from '../src/worker.js';

// Control only the worker's polling cadence; PostgreSQL, cryptography and the event loop remain real.
const polling = vi.hoisted(() => ({ mode: 'real' as 'real' | 'paused' | 'released', waits: [] as Array<() => void> }));
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: async (milliseconds = 1, value?: unknown) => {
    if (milliseconds !== 1000 || polling.mode === 'real') return actual.setTimeout(milliseconds, value);
    if (polling.mode === 'paused') await new Promise<void>(resolve => polling.waits.push(resolve));
    return value;
  } };
});

const owner: Address = '0x1111111111111111111111111111111111111111';
const leashId: Hex = `0x${'33'.repeat(32)}`, zero: Hex = `0x${'00'.repeat(32)}`, txHash: Hex = `0x${'44'.repeat(32)}`;
const idAt = (index: number): Hex => `0x${index.toString(16).padStart(64, '0')}`;
const readyId = idAt(13);
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666',
  TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777' });
type ChainRun = Awaited<ReturnType<ChainBridge['run']>>;

describe('financial retry scheduling advances beyond repeatedly eligible failures', () => {
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge, worker: Worker;
  let cpu: CpuExecutor, near: NearProvider, clock: number;
  let states: Map<Hex, ChainRun>;

  async function insert(index: number, status: 'receipt_pending' | 'settling') {
    const id = idAt(index), input = { leashId, task: { kind: 'sha256' as const, text: 'completed once' }, maxSeconds: 30 };
    const quote = { runId: id, leashId, payer: owner, workloadHash: hashJson(input), maxSeconds: 30,
      pricePerSecond: '100', inferencePrice: '0', quoteExpiry: Math.floor(clock / 1000) + 300 };
    const meter = new RunMeter(id, 30); await meter.emit('completed', 5000, 'durable CPU output');
    const result = { status: 'completed' as const, output: 'durable CPU output', exitCode: 0, billableSeconds: 5, ticks: meter.ticks };
    const body = { version: 1, runId: id, payer: owner, leashId, workloadHash: quote.workloadHash, status: 'completed',
      cpu: { billingUnit: 'running_seconds', mode: config.CPU_MODE, billableSeconds: 5, measuredSeconds: 5,
        pricePerSecond: '100', ticks: result.ticks, outputHash: hashJson(result.output) }, near: null,
      billing: { token: config.TOKEN_ADDRESS, ceiling: '3000', charged: '500', refund: '2500' }, issuedAt: new Date().toISOString() };
    const receiptHash = hashJson(body);
    const settlement = { runId: id, billableSeconds: 5n, inferenceCharge: 0n, receiptHash };
    const receipt = { body, receiptHash, settlement: { ...settlement, billableSeconds: '5', inferenceCharge: '0' },
      signature: await bridge.signSettlement(settlement), signer: bridge.account.address, domain: bridge.domain };
    await store.db.insert(jobs).values({ id, owner, leashId, idemKey: `retry-scheduling-${index}`, inputHash: hashJson(input),
      input, quote, signature: `0x${'ab'.repeat(65)}`, ceiling: '3000', status, targetStatus: 'completed',
      createdAt: new Date('2026-10-08T12:00:00.000Z'), cpuResult: result, ticks: result.ticks, billableSeconds: 5,
      output: result.output, ...(status === 'settling' ? { receipt, charged: '500', refund: '2500' } : {}) });
    states.set(id, { payer: owner, leashId, workloadHash: quote.workloadHash, openedAt: BigInt(Math.floor(clock / 1000)) - 20n,
      acceptedExpiry: 10_000_000_000n, maxSeconds: 30n, pricePerSecond: 100n, inferencePrice: 0n, ceiling: 3000n,
      stopAt: 0n, status: 1, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero });
  }

  async function readyJob(): Promise<Job> {
    const row = (await store.db.select().from(jobs).where(eq(jobs.id, readyId)))[0];
    if (!row) throw new Error('Newer ready fixture is missing'); return row;
  }

  async function progressToReady() {
    polling.mode = 'paused'; worker.start();
    // Twelve older failures cover more than one 10-second cooldown window. They stay unavailable throughout.
    for (let iteration = 0; iteration < 25; iteration++) {
      const deadline = performance.now() + 3000;
      while (!polling.waits.length && performance.now() < deadline) await yieldEventLoop();
      expect(polling.waits.length).toBe(1);
      if ((await readyJob()).status === 'completed') return;
      clock += 1001;
      polling.waits.shift()!();
    }
    throw new Error('A ready financial outcome was starved by older unavailable outcomes');
  }

  async function waitForBoundary(entered: () => boolean) {
    const deadline = performance.now() + 3000;
    while (!entered() && performance.now() < deadline) await yieldEventLoop();
    expect(entered()).toBe(true);
  }

  async function queueReadyJob() {
    await insert(13, 'receipt_pending');
    await store.db.update(jobs).set({ status: 'queued', cpuResult: null, ticks: [], billableSeconds: 0,
      output: null, targetStatus: null }).where(eq(jobs.id, readyId));
  }

  beforeEach(async () => {
    polling.mode = 'real'; polling.waits.length = 0;
    store = await openStore({ DATA_DIR: ':memory:' }); bridge = new ChainBridge(config); states = new Map(); clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(bridge, 'run').mockImplementation(async id => {
      if (id !== readyId) throw new Error('Older outcome RPC remains unavailable');
      const state = states.get(id); if (!state) throw new Error('Fixture chain run is missing'); return state;
    });
    vi.spyOn(bridge, 'leash').mockResolvedValue({ owner, agent: owner, maxPerHour: 100000n, maxPerDay: 200000n,
      expiry: 10_000_000_000n, killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n, spentHour: 0n, spentDay: 0n, pending: 3000n });
    vi.spyOn(bridge, 'settle').mockImplementation(async (_db, settlement) => {
      const previous = states.get(settlement.runId); if (!previous) throw new Error('Fixture chain run is missing');
      states.set(settlement.runId, { ...previous, status: 2, receiptHash: settlement.receiptHash,
        billableSeconds: settlement.billableSeconds, inferenceCharge: settlement.inferenceCharge }); return txHash;
    });
    cpu = { run: vi.fn<CpuExecutor['run']>() }; near = { complete: vi.fn<NearProvider['complete']>() };
    worker = new Worker(store.db, bridge, cpu, near, pino({ enabled: false }));
  });

  afterEach(async () => {
    const stopping = worker.stop(); polling.mode = 'released';
    for (const resume of polling.waits.splice(0)) resume();
    await stopping; vi.restoreAllMocks(); await store.close(); polling.mode = 'real';
  });

  it.each(['receipt_pending', 'settling'] as const)('reaches a newer %s outcome while twelve older outcomes remain unavailable', async status => {
    for (let index = 12; index >= 1; index--) await insert(index, status);
    await insert(13, status);
    // A cursor based on JavaScript Date alone loses the exact tie and repeats old rows indefinitely.
    await store.db.update(jobs).set({ createdAt: sql`'2026-10-08T12:00:00.000456Z'::timestamptz` });
    expect((await store.db.select({ exactTime: sql<string>`${jobs.createdAt}::text` }).from(jobs).limit(1))[0]?.exactTime).toContain('.000456');
    await progressToReady();
    const ready = await readyJob();
    expect(ready).toMatchObject({ status: 'completed', charged: '500', refund: '2500', billableSeconds: 5, settlementTxHash: txHash });
    const receipt = signedReceiptSchema.parse(ready.receipt);
    expect(receiptSettlement(receipt)).toMatchObject({ runId: readyId, billableSeconds: 5n, inferenceCharge: 0n });
    expect(states.get(readyId)).toMatchObject({ status: 2, receiptHash: receipt.receiptHash });
    expect(await new Service(store.db, bridge, config, false).verifyReceipt(receipt)).toMatchObject({ valid: true, anchored: true });
    const older = (await store.db.select().from(jobs)).filter(row => row.id !== readyId);
    expect(older).toHaveLength(12); expect(older.every(row => row.status === status)).toBe(true);
    expect(new Set(vi.mocked(bridge.run).mock.calls.map(([id]) => id)).size).toBe(13);
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
    expect(bridge.settle).toHaveBeenCalledTimes(1);
    expect(await store.db.select().from(transactions)).toEqual([]);
  }, 15_000);

  it('keeps queued work untouched when shutdown starts during a refund reconciliation RPC', async () => {
    await insert(1, 'receipt_pending');
    await store.db.update(jobs).set({ status: 'reconciliation', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }).where(eq(jobs.id, idAt(1)));
    await queueReadyJob();
    let entered = false, resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.mocked(bridge.run).mockImplementation(async id => {
      if (id === idAt(1)) { entered = true; await gate; }
      const state = states.get(id); if (!state) throw new Error('Fixture chain run is missing'); return state;
    });
    polling.mode = 'released'; worker.start();
    let stopping: Promise<void> | undefined;
    try {
      await waitForBoundary(() => entered);
      stopping = worker.stop(); resume(); await stopping;
      expect(await readyJob()).toMatchObject({ status: 'queued', cpuResult: null, receipt: null, charged: null, refund: null });
      expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
      expect(bridge.settle).not.toHaveBeenCalled();
    } finally { resume(); await stopping; }
  }, 10_000);

  it('aborts a durably claimed run before CPU dispatch when shutdown races with execution entry', async () => {
    await queueReadyJob();
    // Hold the handoff after the real SQL claim, before an execution AbortController exists.
    type ExecutionBoundary = { execute(job: Job): Promise<void> };
    const boundary = worker as unknown as ExecutionBoundary, actualExecute = boundary.execute.bind(boundary);
    let entered = false, resume!: () => void, dispatches = 0;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(boundary, 'execute').mockImplementation(async job => { entered = true; await gate; await actualExecute(job); });
    vi.mocked(cpu.run).mockImplementation(async (input, signal, onTick) => {
      if (!signal.aborted) dispatches++;
      const status = signal.aborted ? 'cancelled' as const : 'completed' as const;
      const meter = new RunMeter(input.runId, input.maxSeconds, onTick);
      await meter.emit(status, signal.aborted ? 0 : 5000, '');
      return { status, output: '', exitCode: signal.aborted ? -1 : 0,
        billableSeconds: meter.ticks.at(-1)!.billableSeconds, ticks: meter.ticks };
    });
    polling.mode = 'released'; worker.start();
    let stopping: Promise<void> | undefined;
    try {
      await waitForBoundary(() => entered);
      expect((await readyJob()).status).toBe('running');
      stopping = worker.stop(); resume(); await stopping;
      expect(dispatches).toBe(0); expect(cpu.run).toHaveBeenCalledTimes(1);
      expect(vi.mocked(cpu.run).mock.calls[0]![1].aborted).toBe(true);
      expect(near.complete).not.toHaveBeenCalled();
      expect(await readyJob()).toMatchObject({ status: 'settling', targetStatus: 'cancelled', billableSeconds: 0, charged: '0', refund: '3000' });
      expect(bridge.settle).not.toHaveBeenCalled();
      // Shutdown preserves the signed outcome; a restarted controller settles it without running CPU again.
      const restarted = new Worker(store.db, bridge, cpu, near, pino({ enabled: false }));
      try { await restarted.drainOnce(); } finally { await restarted.stop(); }
      const cancelled = await readyJob();
      expect(cancelled).toMatchObject({ status: 'cancelled', billableSeconds: 0, charged: '0', refund: '3000' });
      expect(await new Service(store.db, bridge, config, false).verifyReceipt(signedReceiptSchema.parse(cancelled.receipt)))
        .toMatchObject({ valid: true, anchored: true });
      expect(dispatches).toBe(0); expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).not.toHaveBeenCalled();
      expect(bridge.settle).toHaveBeenCalledTimes(1);
    } finally { resume(); await stopping; }
  }, 10_000);
});
