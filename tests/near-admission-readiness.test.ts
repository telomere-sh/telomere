import { eq } from 'drizzle-orm';
import pino from 'pino';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainBridge } from '../src/bridge.js';
import { hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import type { NearCompletionResult, NearProvider } from '../src/providers/index.js';
import { nearReadinessSnapshot, type NearProviderReadiness } from '../src/providers/readiness.js';
import { RunMeter } from '../src/runtime/meter.js';
import type { CpuExecutor } from '../src/runtime/types.js';
import { Service } from '../src/service.js';
import { jobs, openStore } from '../src/store.js';
import { Worker } from '../src/worker.js';

const owner: Address = '0x1111111111111111111111111111111111111111';
const leashId: Hex = `0x${'33'.repeat(32)}`, txHash: Hex = `0x${'44'.repeat(32)}`, zero: Hex = `0x${'00'.repeat(32)}`;
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666', TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777',
  NEAR_ENDPOINT: 'https://cloud-api.near.ai/v1', NEAR_MODEL: 'operator/model', NEAR_API_KEY: 'fixture-secret', NEAR_ALLOWED_MODELS: 'operator/model' });
const logger = pino({ enabled: false });
const cpuInput = { leashId, task: { kind: 'sha256' as const, text: 'hello' }, maxSeconds: 30 };
const nearInput = { ...cpuInput, nearPrompt: 'One bounded inference' };
function completion(): NearCompletionResult {
  return { output: 'model output', model: 'operator/model', requestId: 'completion-1', evidence: { verification: 'provider_tls',
    endpoint: 'https://cloud-api.near.ai/v1/chat/completions', receivedAt: new Date().toISOString(), requestHash: '11'.repeat(32), responseHash: '22'.repeat(32) } };
}

describe('NEAR admission readiness does not create or charge unavailable work', () => {
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge, service: Service;
  let snapshot: NearProviderReadiness, probe: ReturnType<typeof vi.fn<() => Promise<NearProviderReadiness>>>;
  let runState: Awaited<ReturnType<ChainBridge['run']>>;
  let cpu: CpuExecutor, near: NearProvider;
  beforeEach(async () => {
    store = await openStore(config); bridge = new ChainBridge(config);
    snapshot = nearReadinessSnapshot('ready', 'CONFIGURATION_READY', 'provider_tls');
    probe = vi.fn(async () => snapshot);
    service = new Service(store.db, bridge, config, true, probe);
    runState = { payer: owner, leashId, workloadHash: zero, openedAt: BigInt(Math.floor(Date.now() / 1000)) - 10n,
      acceptedExpiry: 10_000_000_000n, maxSeconds: 30n, pricePerSecond: 100n, inferencePrice: 10000n, ceiling: 13000n,
      stopAt: 0n, status: 1, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero };
    vi.spyOn(bridge, 'leash').mockResolvedValue({ owner, agent: owner, maxPerHour: 100000n, maxPerDay: 200000n,
      expiry: 10_000_000_000n, killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n, spentHour: 0n, spentDay: 0n, pending: 13000n });
    vi.spyOn(bridge, 'run').mockImplementation(async () => runState);
    vi.spyOn(bridge, 'verifyOpened').mockResolvedValue();
    vi.spyOn(bridge, 'settle').mockImplementation(async (_db, settlement) => {
      runState = { ...runState, status: 2, billableSeconds: settlement.billableSeconds, inferenceCharge: settlement.inferenceCharge, receiptHash: settlement.receiptHash };
      return txHash;
    });
    cpu = { run: vi.fn(async (input, _signal, onTick) => {
      const meter = new RunMeter(input.runId, input.maxSeconds, onTick);
      await meter.emit('completed', 5000, 'CPU result');
      return { status: 'completed' as const, output: 'CPU result', exitCode: 0, billableSeconds: 5, ticks: meter.ticks };
    }) };
    near = { readiness: probe, complete: vi.fn(async () => completion()) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await store?.close(); });
  async function reserved() {
    const quote = await service.quote(owner, nearInput, 'confirmed-near-reservation');
    runState = { ...runState, workloadHash: quote.quote.workloadHash, ceiling: BigInt(quote.ceiling) };
    return quote;
  }
  async function record(id: string) { return (await store.db.select().from(jobs).where(eq(jobs.id, id)))[0]; }

  it('exposes a local readiness snapshot and preserves the legacy fixture constructor', async () => {
    expect(await service.nearReadiness()).toEqual(snapshot);
    const configured = await new Service(store.db, bridge, config, true).nearReadiness();
    expect(configured).toMatchObject({ state: 'ready', scope: 'local_configuration', liveAttestationChecked: false });
    expect(Number.isFinite(Date.parse(configured.checkedAt))).toBe(true);
    expect(await new Service(store.db, bridge, config, false).nearReadiness()).toMatchObject({ state: 'disabled', reasonCode: 'NOT_CONFIGURED',
      scope: 'local_configuration', liveAttestationChecked: false });
    expect(JSON.stringify(await service.nearReadiness())).not.toContain('fixture-secret');
    expect(near.complete).not.toHaveBeenCalled();
  });

  it('rejects a fresh unavailable NEAR quote before signing or writing a reservation', async () => {
    snapshot = nearReadinessSnapshot('unavailable', 'POLICY_EXPIRED', 'enclave_verified', '2026-10-08T14:29:11Z');
    const sign = vi.spyOn(bridge, 'signQuote'), insert = vi.spyOn(store.db, 'insert');
    await expect(service.quote(owner, nearInput, 'expired-policy-new')).rejects.toMatchObject({ status: 503, code: 'near_unavailable' });
    expect(sign).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(await store.db.select().from(jobs)).toEqual([]);
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('rechecks a reused prepared NEAR quote after readiness becomes unavailable', async () => {
    const first = await service.quote(owner, nearInput, 'expired-policy-repeat');
    const sign = vi.spyOn(bridge, 'signQuote');
    snapshot = nearReadinessSnapshot('unavailable', 'POLICY_CHANGED', 'enclave_verified');
    await expect(service.quote(owner, nearInput, 'expired-policy-repeat')).rejects.toMatchObject({ status: 503, code: 'near_unavailable' });
    expect(sign).not.toHaveBeenCalled();
    const rows = await store.db.select().from(jobs);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: first.quote.runId, status: 'prepared', signature: first.signature });
    expect(near.complete).not.toHaveBeenCalled();
  });

  it('continues accepting CPU-only work while the NEAR policy is unavailable', async () => {
    snapshot = nearReadinessSnapshot('unavailable', 'POLICY_EXPIRED', 'enclave_verified');
    const quote = await service.quote(owner, cpuInput, 'cpu-only-independent');
    expect(quote.quote.inferencePrice).toBe('0'); expect(quote.ceiling).toBe('3000');
    expect(await record(quote.quote.runId)).toMatchObject({ status: 'prepared', inputHash: hashJson(cpuInput) });
    expect(probe).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('expires an inference quote no later than its reviewed provider policy', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 45;
    snapshot = nearReadinessSnapshot('ready', 'CONFIGURATION_READY', 'enclave_verified', new Date(expiry * 1000).toISOString());
    const quote = await service.quote(owner, nearInput, 'bounded-policy-expiry');
    expect(quote.quote.quoteExpiry).toBe(expiry);
    const cpuOnly = await service.quote(owner, cpuInput, 'independent-cpu-expiry');
    expect(cpuOnly.quote.quoteExpiry).toBeGreaterThan(expiry);
  });

  it('refuses signing if the ready snapshot policy expired while checking the leash', async () => {
    snapshot = nearReadinessSnapshot('ready', 'CONFIGURATION_READY', 'enclave_verified', new Date((Math.floor(Date.now() / 1000) - 1) * 1000).toISOString());
    const sign = vi.spyOn(bridge, 'signQuote'), insert = vi.spyOn(store.db, 'insert');
    await expect(service.quote(owner, nearInput, 'expiry-race')).rejects.toMatchObject({ status: 503, code: 'near_unavailable' });
    expect(sign).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

  it('admits an existing confirmed reservation, then refunds it without CPU or NEAR dispatch', async () => {
    const quote = await reserved();
    snapshot = nearReadinessSnapshot('unavailable', 'POLICY_EXPIRED', 'enclave_verified');
    expect(await service.admit(owner, quote.quote.runId, txHash)).toMatchObject({ status: 'queued' });
    const worker = new Worker(store.db, bridge, cpu, near, logger); await worker.drainOnce();
    expect(await record(quote.quote.runId)).toMatchObject({ status: 'failed', errorCode: 'NEAR_NOT_READY', billableSeconds: 0,
      charged: '0', refund: quote.ceiling, settlementTxHash: txHash });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
    expect(bridge.settle).toHaveBeenCalledTimes(1);
    expect(bridge.settle).toHaveBeenCalledWith(store.db, expect.objectContaining({ billableSeconds: 0n, inferenceCharge: 0n }), expect.any(String));
    expect(await service.verifyReceipt((await record(quote.quote.runId))?.receipt)).toMatchObject({ valid: true, anchored: true });
  });

  it('fails closed when the local readiness probe throws, without exposing raw errors', async () => {
    const quote = await reserved(); await service.admit(owner, quote.quote.runId, txHash);
    probe.mockRejectedValue(new Error('private-policy-path-and-provider-secret'));
    expect(await service.nearReadiness()).toMatchObject({ state: 'unavailable', reasonCode: 'READINESS_CHECK_FAILED' });
    expect(JSON.stringify(await service.nearReadiness())).not.toContain('private-policy');
    await new Worker(store.db, bridge, cpu, near, logger).drainOnce();
    expect(await record(quote.quote.runId)).toMatchObject({ status: 'failed', errorCode: 'NEAR_NOT_READY', charged: '0', refund: quote.ceiling });
    expect(JSON.stringify(await record(quote.quote.runId))).not.toContain('private-policy');
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('executes and charges once when a configured readiness hook reports ready', async () => {
    const quote = await reserved(); await service.admit(owner, quote.quote.runId, txHash); probe.mockClear();
    await new Worker(store.db, bridge, cpu, near, logger).drainOnce();
    expect(await record(quote.quote.runId)).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    expect(probe).toHaveBeenCalledTimes(1); expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1);
  });

  it('retains legacy provider fixtures without a readiness hook', async () => {
    const quote = await reserved(); await service.admit(owner, quote.quote.runId, txHash);
    const legacy: NearProvider = { complete: near.complete };
    await new Worker(store.db, bridge, cpu, legacy, logger).drainOnce();
    expect(await record(quote.quote.runId)).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(near.complete).toHaveBeenCalledTimes(1);
  });
});
