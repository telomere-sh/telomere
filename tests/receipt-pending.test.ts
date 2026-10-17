import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { setTimeout as delay } from 'node:timers/promises';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainBridge } from '../src/bridge.js';
import { hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { AmbiguousProviderError, ProviderRequestRejectedError, type NearCompletionResult, type NearProvider } from '../src/providers/index.js';
import { nearReadinessSnapshot } from '../src/providers/readiness.js';
import { RunMeter } from '../src/runtime/meter.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import type { CpuExecutor, CpuRunResult } from '../src/runtime/types.js';
import { signedReceiptSchema } from '../src/service.js';
import { jobs, openStore, type Job } from '../src/store.js';
import { Worker } from '../src/worker.js';

const runId: Hex = `0x${'22'.repeat(32)}`, leashId: Hex = `0x${'33'.repeat(32)}`, txHash: Hex = `0x${'44'.repeat(32)}`, zero: Hex = `0x${'00'.repeat(32)}`;
const owner: Address = '0x1111111111111111111111111111111111111111';
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666', TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777',
  NEAR_ENDPOINT: 'https://cloud-api.near.ai/v1', NEAR_MODEL: 'operator/model', NEAR_API_KEY: 'fixture-only', NEAR_ALLOWED_MODELS: 'operator/model' });
const logger = pino({ enabled: false });
type ChainRun = Awaited<ReturnType<ChainBridge['run']>>;
async function completedCpu(id: string): Promise<CpuRunResult> {
  const meter = new RunMeter(id, 30); await meter.emit('completed', 5000, 'CPU result');
  return { status: 'completed', output: 'CPU result', exitCode: 0, billableSeconds: 5, ticks: meter.ticks };
}
function completion(): NearCompletionResult {
  return { output: 'provider output', model: 'operator/model', requestId: 'known-completion-1',
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 }, evidence: { verification: 'provider_tls',
      endpoint: 'https://cloud-api.near.ai/v1/chat/completions', receivedAt: new Date().toISOString(), requestHash: '11'.repeat(32), responseHash: '22'.repeat(32) } };
}

describe('known durable outcomes retry receipt construction without repeating work', () => {
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge, cpu: CpuExecutor, near: NearProvider;
  let states: Map<string, ChainRun>, blockedReceiptReads: Set<string>, providerRejected: boolean, clock: number, inserted: number;
  async function job(id = runId): Promise<Job> {
    const row = (await store.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    if (!row) throw new Error('Receipt-pending fixture job missing'); return row;
  }
  async function insert(id = runId, withNear = false, status: Job['status'] = 'queued') {
    const input = { leashId, task: { kind: 'sha256' as const, text: 'hello' }, maxSeconds: 30, ...(withNear ? { nearPrompt: 'Bounded prompt' } : {}) };
    const quote = { runId: id, leashId, payer: owner, workloadHash: hashJson(input), maxSeconds: 30, pricePerSecond: '100',
      inferencePrice: withNear ? '10000' : '0', quoteExpiry: Math.floor(clock / 1000) + 300 };
    const ceiling = withNear ? '13000' : '3000';
    await store.db.insert(jobs).values({ id, owner: owner.toLowerCase(), leashId, idemKey: `pending-${id}`, inputHash: hashJson(input), input, quote,
      signature: `0x${'ab'.repeat(65)}`, ceiling, status, txHash, createdAt: new Date(clock + inserted++ * 1000) });
    states.set(id, { payer: owner, leashId, workloadHash: quote.workloadHash, openedAt: BigInt(Math.floor(clock / 1000)) - 20n,
      acceptedExpiry: 10_000_000_000n, maxSeconds: 30n, pricePerSecond: 100n, inferencePrice: BigInt(quote.inferencePrice), ceiling: BigInt(ceiling),
      stopAt: 0n, status: 1, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero });
  }
  const worker = () => new Worker(store.db, bridge, cpu, near, logger);
  const allowRetry = () => { clock += 11001; blockedReceiptReads.clear(); };
  beforeEach(async () => {
    store = await openStore(config); bridge = new ChainBridge(config);
    states = new Map(); blockedReceiptReads = new Set(); providerRejected = false; clock = Date.now(); inserted = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(bridge, 'run').mockImplementation(async id => {
      const saved = await job(id);
      // Fault only receipt construction after the outcome was stored; pre-dispatch checks work.
      if (blockedReceiptReads.has(id) && saved.cpuResult != null && (!saved.input.nearPrompt || saved.nearResult != null || providerRejected)) {
        throw new Error('Temporary receipt RPC outage');
      }
      const state = states.get(id); if (!state) throw new Error('Fixture chain run missing'); return state;
    });
    vi.spyOn(bridge, 'leash').mockResolvedValue({ owner, agent: owner, maxPerHour: 100000n, maxPerDay: 200000n,
      expiry: 10_000_000_000n, killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n, spentHour: 0n, spentDay: 0n, pending: 13000n });
    vi.spyOn(bridge, 'settle').mockImplementation(async (_db, settlement) => {
      const prior = states.get(settlement.runId); if (!prior) throw new Error('Fixture settlement run missing');
      states.set(settlement.runId, { ...prior, status: 2, receiptHash: settlement.receiptHash,
        billableSeconds: settlement.billableSeconds, inferenceCharge: settlement.inferenceCharge }); return txHash;
    });
    cpu = { run: vi.fn<CpuExecutor['run']>().mockImplementation(async (input, _signal, onTick) => {
      const result = await completedCpu(input.runId); for (const tick of result.ticks) await onTick?.(tick); return result;
    }) };
    near = { complete: vi.fn<NearProvider['complete']>().mockResolvedValue(completion()) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });

  it('keeps completed CPU in receipt_pending after transient receipt RPC failure and retries on the same worker', async () => {
    await insert(); blockedReceiptReads.add(runId); const same = worker();
    await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed', billableSeconds: 5, receipt: null });
    expect(validateCpuResult((await job()).cpuResult, runId, 30)).toMatchObject({ status: 'completed', billableSeconds: 5 });
    expect(same.snapshot().state).not.toBe('quarantined'); expect(bridge.settle).not.toHaveBeenCalled();
    allowRetry(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '500', refund: '2500' });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('preserves the completed CPU target when its first outcome write fails but the pending write succeeds', async () => {
    await insert(); blockedReceiptReads.add(runId);
    // nextval survives transaction rollback, so only the first non-null outcome write is rejected.
    await store.db.execute(sql.raw('CREATE SEQUENCE acceptance_cpu_write_attempt'));
    await store.db.execute(sql.raw("ALTER TABLE jobs ADD CONSTRAINT acceptance_cpu_first_write_failure CHECK (cpu_result IS NULL OR nextval('acceptance_cpu_write_attempt') > 1)"));
    const same = worker(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed' });
    expect(validateCpuResult((await job()).cpuResult, runId, 30).status).toBe('completed');
    await store.db.execute(sql.raw('ALTER TABLE jobs DROP CONSTRAINT acceptance_cpu_first_write_failure'));
    allowRetry(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '500', refund: '2500' });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('retains an already known CPU outcome across recovery while receipt RPC is still unavailable', async () => {
    await insert(); blockedReceiptReads.add(runId); await worker().drainOnce();
    const original = (await job()).cpuResult, restarted = worker(); await restarted.recover(true);
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed', cpuResult: original });
    expect(restarted.snapshot().state).not.toBe('quarantined'); allowRetry(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '500', refund: '2500', cpuResult: original });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('retries a persisted successful provider result without another paid dispatch even after policy expires', async () => {
    await insert(runId, true); blockedReceiptReads.add(runId);
    near.readiness = vi.fn(async () => nearReadinessSnapshot('ready', 'CONFIGURATION_READY', 'provider_tls'));
    const same = worker(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed', nearResult: { requestId: 'known-completion-1', output: 'provider output' } });
    vi.mocked(near.readiness).mockResolvedValue(nearReadinessSnapshot('unavailable', 'POLICY_EXPIRED', 'enclave_verified'));
    allowRetry(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    const receipt = signedReceiptSchema.parse((await job()).receipt);
    expect(receipt.settlement.inferenceCharge).toBe('10000');
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1); expect(near.readiness).toHaveBeenCalledTimes(1);
  });

  it('does not mark a known provider outcome unknown when writing its signed receipt fails', async () => {
    await insert(runId, true);
    await store.db.execute(sql.raw('ALTER TABLE jobs ADD CONSTRAINT acceptance_receipt_disk_failure CHECK (receipt IS NULL)'));
    const same = worker(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed', receipt: null,
      nearResult: { requestId: 'known-completion-1', output: 'provider output' } });
    expect((await job()).errorCode).not.toBe('PROVIDER_OUTCOME_UNKNOWN'); expect(same.snapshot().state).not.toBe('quarantined');
    await store.db.execute(sql.raw('ALTER TABLE jobs DROP CONSTRAINT acceptance_receipt_disk_failure')); allowRetry(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('re-reads a provider result committed before a lost storage acknowledgement without repeating dispatch', async () => {
    await insert(runId, true); const same = worker();
    // REASON: a narrow private persistence boundary injects only an acknowledgement loss
    // after the real PostgreSQL update committed; execution, signing and recovery remain real.
    type PersistenceBoundary = { update(id: string, values: Partial<typeof jobs.$inferInsert>): Promise<void> };
    const boundary = same as unknown as PersistenceBoundary, actualUpdate = boundary.update.bind(boundary);
    let lostAcknowledgement = false;
    vi.spyOn(boundary, 'update').mockImplementation(async (id, values) => {
      await actualUpdate(id, values);
      if (values.nearResult != null && !lostAcknowledgement) { lostAcknowledgement = true; throw new Error('Committed provider result acknowledgement lost'); }
    });
    await same.drainOnce();
    expect(lostAcknowledgement).toBe(true);
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500', nearResult: { requestId: 'known-completion-1' } });
    expect((await job()).errorCode).not.toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('recovers a valid stored provider result left in unknown reconciliation by an older controller', async () => {
    await insert(runId, true, 'reconciliation'); const result = await completedCpu(runId);
    await store.db.update(jobs).set({ cpuResult: result, ticks: result.ticks, billableSeconds: 5, nearResult: completion(),
      targetStatus: 'completed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }).where(eq(jobs.id, runId));
    const restarted = worker(); await restarted.recover(true); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500', nearResult: { requestId: 'known-completion-1' } });
    expect((await job()).errorCode).not.toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('preserves valid completed CPU observations while a pre-dispatch provider rejection has a failed target', async () => {
    await insert(runId, true); blockedReceiptReads.add(runId);
    vi.mocked(near.complete).mockImplementation(async () => { providerRejected = true; throw new ProviderRequestRejectedError(); });
    const same = worker(); await same.drainOnce();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'failed', nearResult: null });
    const observed = validateCpuResult((await job()).cpuResult, runId, 30);
    expect(observed.status).toBe('completed'); expect(observed.ticks.at(-1)?.state).toBe('completed');
    const restarted = worker(); allowRetry(); await restarted.recover(true); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'failed', charged: '500', refund: '12500', cpuResult: observed });
    const receipt = signedReceiptSchema.parse((await job()).receipt);
    expect(receipt.body.status).toBe('failed'); expect(receipt.settlement.inferenceCharge).toBe('0');
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps ambiguous provider dispatch in reconciliation rather than inventing a known outcome', async () => {
    await insert(runId, true);
    vi.mocked(near.complete).mockRejectedValue(new AmbiguousProviderError(runId, 'timeout'));
    await worker().drainOnce();
    expect(await job()).toMatchObject({ status: 'reconciliation', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', nearResult: null, receipt: null });
    const restarted = worker(); await restarted.recover(true); await restarted.drainOnce();
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1); expect(bridge.settle).not.toHaveBeenCalled();
  });

  it.each(['inconsistent_target', 'tampered_ticks', 'inconsistent_counter', 'wrong_model', 'excessive_token_usage', 'missing_provider_result', 'failed_target_with_provider_result'] as const)
    ('holds malformed pending evidence (%s) without dispatching or charging', async variant => {
      const withNear = ['wrong_model', 'excessive_token_usage', 'missing_provider_result', 'failed_target_with_provider_result'].includes(variant);
      await insert(runId, withNear, 'receipt_pending'); const result = await completedCpu(runId);
      await store.db.update(jobs).set({ cpuResult: result, ticks: result.ticks, billableSeconds: 5,
        targetStatus: 'completed', ...(withNear ? { nearResult: completion() } : {}) }).where(eq(jobs.id, runId));
      switch (variant) {
        case 'inconsistent_target': await store.db.update(jobs).set({ targetStatus: 'timed_out' }).where(eq(jobs.id, runId)); break;
        case 'tampered_ticks': await store.db.update(jobs).set({ ticks: result.ticks.map(tick => ({ ...tick, hash: '00'.repeat(32) })) }).where(eq(jobs.id, runId)); break;
        case 'inconsistent_counter': await store.db.update(jobs).set({ billableSeconds: 6 }).where(eq(jobs.id, runId)); break;
        case 'wrong_model': await store.db.update(jobs).set({ nearResult: { ...completion(), model: 'different/model' } }).where(eq(jobs.id, runId)); break;
        case 'excessive_token_usage': await store.db.update(jobs).set({ nearResult: { ...completion(), usage: {
          promptTokens: 3, completionTokens: config.MAX_TOKENS + 1, totalTokens: config.MAX_TOKENS + 4 } } }).where(eq(jobs.id, runId)); break;
        case 'missing_provider_result': await store.db.update(jobs).set({ nearResult: null }).where(eq(jobs.id, runId)); break;
        case 'failed_target_with_provider_result': await store.db.update(jobs).set({ targetStatus: 'failed' }).where(eq(jobs.id, runId)); break;
      }
      await worker().drainOnce();
      expect(await job()).toMatchObject({ status: 'reconciliation', errorCode: 'RECEIPT_RECOVERY_REQUIRED', charged: null, receipt: null });
      expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).not.toHaveBeenCalled();
    });

  it('serializes concurrent manual drains of a known pending result before signing or settling', async () => {
    await insert(runId, false, 'receipt_pending'); const result = await completedCpu(runId);
    await store.db.update(jobs).set({ cpuResult: result, ticks: result.ticks, billableSeconds: 5, targetStatus: 'completed' }).where(eq(jobs.id, runId));
    const sign = vi.spyOn(bridge, 'signSettlement'), same = worker();
    await Promise.all([same.drainOnce(), same.drainOnce(), same.drainOnce()]);
    expect(await job()).toMatchObject({ status: 'completed', charged: '500', refund: '2500' });
    expect(sign).toHaveBeenCalledTimes(1); expect(bridge.settle).toHaveBeenCalledTimes(1);
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('waits for active manual cleanup and settlement on stop without starting a queued manual drain', async () => {
    const second: Hex = `0x${'77'.repeat(32)}`; await insert(); await insert(second);
    let enteredResolve: (() => void) | undefined, firstFinished = false;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    vi.mocked(cpu.run).mockImplementation(async (input, signal, onTick) => {
      enteredResolve?.();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      const meter = new RunMeter(input.runId, input.maxSeconds, onTick); await meter.emit('cancelled', 0, '');
      return { status: 'cancelled', output: '', billableSeconds: 0, ticks: meter.ticks, exitCode: -1 };
    });
    const same = worker();
    const firstDrain = same.drainOnce().then(() => { firstFinished = true; }), queuedDrain = same.drainOnce();
    await entered; await same.stop();
    expect(firstFinished).toBe(true); await Promise.all([firstDrain, queuedDrain]);
    expect(await job()).toMatchObject({ status: 'cancelled', charged: '0', refund: '3000' });
    expect((await job(second)).status).toBe('queued'); expect(cpu.run).toHaveBeenCalledTimes(1);
    expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).toHaveBeenCalledTimes(1);
    await expect(same.drainOnce()).rejects.toThrow();
  });

  it('does not let a throttled failing receipt starve other eligible pending receipts', async () => {
    const second: Hex = `0x${'55'.repeat(32)}`, third: Hex = `0x${'66'.repeat(32)}`;
    for (const id of [runId, second, third]) {
      await insert(id, false, 'receipt_pending'); const result = await completedCpu(id);
      await store.db.update(jobs).set({ cpuResult: result, ticks: result.ticks, billableSeconds: 5, targetStatus: 'completed' }).where(eq(jobs.id, id));
    }
    async function waitCompleted(ids: Hex[]) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await Promise.all(ids.map(id => job(id)));
        if (rows.every(row => row.status === 'completed')) return;
        await delay(100);
      }
      throw new Error('Pending receipt scheduling did not progress within five seconds');
    }
    blockedReceiptReads.add(runId); const same = worker(); same.start();
    try {
      await waitCompleted([second, third]);
      const blockedReads = vi.mocked(bridge.run).mock.calls.filter(([id]) => id === runId);
      expect(blockedReads).toHaveLength(1); expect((await job(runId)).status).toBe('receipt_pending');
      expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
      allowRetry(); await waitCompleted([runId]); expect(bridge.settle).toHaveBeenCalledTimes(3);
    } finally { await same.stop(); }
  }, 10000);
});
