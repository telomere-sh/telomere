import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainBridge } from '../src/bridge.js';
import { hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import type { NearProvider } from '../src/providers/index.js';
import type { CpuExecutor } from '../src/runtime/index.js';
import { RunMeter } from '../src/runtime/meter.js';
import { jobs, openStore, transactions } from '../src/store.js';
import { Worker } from '../src/worker.js';

const owner: Address = '0x1111111111111111111111111111111111111111';
const leashId: Hex = `0x${'33'.repeat(32)}`;
const zero: Hex = `0x${'00'.repeat(32)}`;
const createdAt = new Date('2026-10-08T12:00:00.000Z');
const runId = (index: number): Hex => `0x${index.toString(16).padStart(64, '0')}`;
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666',
  TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777' });
type ChainRun = Awaited<ReturnType<ChainBridge['run']>>;

describe('fair read-only reconciliation of external escrow refunds', () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: ChainBridge;
  let worker: Worker;
  let cpu: CpuExecutor;
  let near: NearProvider;
  let states: Map<Hex, ChainRun>;

  async function insertUnknown(index: number, chainStatus: number) {
    const id = runId(index);
    const input = { leashId, task: { kind: 'sha256' as const, text: 'uncertain work' }, maxSeconds: 30 };
    const quote = { runId: id, leashId, payer: owner, workloadHash: hashJson(input), maxSeconds: 30,
      pricePerSecond: '100', inferencePrice: '0', quoteExpiry: 2_000_000_000 };
    await store.db.insert(jobs).values({ id, owner, leashId, idemKey: `refund-fixture-${index}`, inputHash: hashJson(input),
      input, quote, signature: `0x${'ab'.repeat(65)}`, ceiling: '3000', status: 'reconciliation', createdAt,
      charged: '500', refund: '2500', billableSeconds: 5, errorCode: 'PROVIDER_OUTCOME_UNKNOWN' });
    states.set(id, { payer: owner, leashId, workloadHash: quote.workloadHash, openedAt: 1n, acceptedExpiry: 2_000_000_000n,
      maxSeconds: 30n, pricePerSecond: 100n, inferencePrice: 0n, ceiling: 3000n, stopAt: 0n, status: chainStatus,
      billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero });
  }

  async function waitForRefunds(ids: Hex[]) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const rows = await store.db.select({ id: jobs.id, status: jobs.status }).from(jobs);
      if (ids.every(id => rows.some(row => row.id === id && row.status === 'refunded'))) return;
      await delay(50);
    }
    throw new Error('Canonical external refunds were not reconciled within seven seconds');
  }

  async function expectNoExecutionOrTransactions() {
    expect(cpu.run).not.toHaveBeenCalled();
    expect(near.complete).not.toHaveBeenCalled();
    expect(bridge.leash).not.toHaveBeenCalled();
    expect(bridge.signSettlement).not.toHaveBeenCalled();
    expect(bridge.settle).not.toHaveBeenCalled();
    expect(await store.db.select().from(transactions)).toEqual([]);
  }

  beforeEach(async () => {
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new ChainBridge(config);
    states = new Map();
    vi.spyOn(bridge, 'run').mockImplementation(async id => {
      const state = states.get(id);
      if (!state) throw new Error('Unknown fixture escrow run');
      return state;
    });
    vi.spyOn(bridge, 'leash');
    vi.spyOn(bridge, 'signSettlement');
    vi.spyOn(bridge, 'settle');
    cpu = { run: vi.fn<CpuExecutor['run']>() };
    near = { complete: vi.fn<NearProvider['complete']>() };
    worker = new Worker(store.db, bridge, cpu, near, pino({ enabled: false }));
  });

  afterEach(async () => {
    await worker.stop();
    vi.restoreAllMocks();
    await store.close();
  });

  it('reaches refunds beyond twenty unresolved jobs when every creation time is tied', async () => {
    // Reverse insertion inside the first batch prevents insertion order from standing in for the cursor's ID ordering.
    for (let index = 20; index >= 1; index--) await insertUnknown(index, 1);
    for (let index = 21; index <= 25; index++) await insertUnknown(index, 3);
    // PostgreSQL retains microseconds that JavaScript Date cannot represent. The cursor must retain this exact value.
    await store.db.update(jobs).set({ createdAt: sql`'2026-10-08T12:00:00.000456Z'::timestamptz` });
    expect((await store.db.select({ exactTime: sql<string>`${jobs.createdAt}::text` }).from(jobs).limit(1))[0]?.exactTime)
      .toContain('.000456');
    worker.start();
    await waitForRefunds([21, 22, 23, 24, 25].map(runId));
    const rows = await store.db.select().from(jobs);
    for (let index = 1; index <= 20; index++) {
      expect(rows.find(row => row.id === runId(index))).toMatchObject({ status: 'reconciliation', charged: '500',
        refund: '2500', billableSeconds: 5, errorCode: 'PROVIDER_OUTCOME_UNKNOWN', receipt: null, cpuResult: null, nearResult: null });
    }
    for (let index = 21; index <= 25; index++) {
      expect(rows.find(row => row.id === runId(index))).toMatchObject({ status: 'refunded', charged: '0', refund: '3000' });
    }
    expect(new Set(vi.mocked(bridge.run).mock.calls.map(([id]) => id)).size).toBe(25);
    // A second complete first page leaves the cursor past all remaining rows. It must wrap again after the empty page.
    const repeatDeadline = Date.now() + 3000;
    while (vi.mocked(bridge.run).mock.calls.filter(([id]) => id === runId(1)).length < 2 && Date.now() < repeatDeadline) await delay(50);
    expect(vi.mocked(bridge.run).mock.calls.filter(([id]) => id === runId(1)).length).toBeGreaterThanOrEqual(2);
    const previous = states.get(runId(1));
    if (!previous) throw new Error('Fixture escrow run is missing');
    states.set(runId(1), { ...previous, status: 3 });
    await waitForRefunds([runId(1)]);
    expect((await store.db.select().from(jobs).where(eq(jobs.id, runId(1))))[0])
      .toMatchObject({ status: 'refunded', charged: '0', refund: '3000' });
    await expectNoExecutionOrTransactions();
  }, 12_000);

  it('continues canonical refund checks after another run RPC fails', async () => {
    await insertUnknown(1, 1);
    await insertUnknown(2, 3);
    await insertUnknown(3, 3);
    vi.mocked(bridge.run).mockImplementation(async id => {
      if (id === runId(1)) throw new Error('One escrow RPC is temporarily unavailable');
      const state = states.get(id);
      if (!state) throw new Error('Unknown fixture escrow run');
      return state;
    });
    worker.start();
    await waitForRefunds([runId(2), runId(3)]);
    const unresolved = (await store.db.select().from(jobs).where(eq(jobs.id, runId(1))))[0];
    expect(unresolved).toMatchObject({ status: 'reconciliation', charged: '500', refund: '2500',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN', receipt: null });
    expect(bridge.run).toHaveBeenCalledWith(runId(1));
    await expectNoExecutionOrTransactions();
  }, 12_000);

  it('recognizes an external refund while queued CPU work remains', async () => {
    await insertUnknown(1, 3);
    for (let index = 31; index <= 34; index++) {
      await insertUnknown(index, 1);
      await store.db.update(jobs).set({ status: 'queued', charged: null, refund: null, billableSeconds: 0, errorCode: null })
        .where(eq(jobs.id, runId(index)));
    }
    vi.mocked(bridge.leash).mockResolvedValue({ owner, agent: owner, maxPerHour: 100_000n, maxPerDay: 200_000n,
      expiry: 2_000_000_000n, killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n, spentHour: 0n, spentDay: 0n, pending: 12_000n });
    let notifyDispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { notifyDispatch = resolve; });
    vi.mocked(cpu.run).mockImplementation(async (input, signal, onTick) => {
      notifyDispatch();
      // Hold the first workload so the assertion observes a live queue rather than waiting for it to drain.
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const meter = new RunMeter(input.runId, input.maxSeconds);
      await meter.emit('cancelled', 0, '');
      await onTick?.(meter.ticks[0]!);
      return { status: 'cancelled', output: '', exitCode: -1, billableSeconds: 0, ticks: meter.ticks };
    });
    worker.start();
    await dispatched;
    const refunded = (await store.db.select().from(jobs).where(eq(jobs.id, runId(1))))[0];
    expect(refunded).toMatchObject({ status: 'refunded', charged: '0', refund: '3000' });
    expect(await store.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'queued'))).toHaveLength(3);
    expect(worker.snapshot().state).toBe('running');
    expect(cpu.run).toHaveBeenCalledTimes(1);
    expect(near.complete).not.toHaveBeenCalled();
    expect(bridge.settle).not.toHaveBeenCalled();
    expect(await store.db.select().from(transactions)).toEqual([]);
  }, 12_000);
});
