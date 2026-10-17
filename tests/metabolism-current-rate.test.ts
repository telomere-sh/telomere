import { describe, expect, it } from 'vitest';
import { evaluateMetabolismV2, paidMetabolismRate, paidMetabolismRateSchema,
  type PaidMetabolismSnapshot } from '../src/agents/metabolism-v2.js';
import { evaluateMetabolism } from '../src/agents/types.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { PAID_AGENT_POLICY } from '../src/agents/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { CystService } from '../src/cysts/service.js';
import { AgentLifecycleService } from '../src/agents/service.js';

const runId = `0x${'a'.repeat(64)}` as const, hostId = `0x${'b'.repeat(64)}` as const;
function snapshot(balance: string, profile: 'full' | 'lean' | 'torpor' = 'full'): PaidMetabolismSnapshot {
  const projections = (['full', 'lean', 'torpor'] as const).map(resourceProfile => paidMetabolismRate({ runId, hostId,
    resourceProfile, leaseSeconds: 100, cpuPricePerSecond: resourceProfile === 'full' ? '100' : resourceProfile === 'lean' ? '50' : '25',
    fixedInferencePrice: '0', feeBps: 900 }));
  return { version: 2, observedAt: 1791972000, blockNumber: '10', blockHash: `0x${'c'.repeat(64)}`,
    availableBalance: balance, contextRunId: runId, current: projections.find(rate => rate.resourceProfile === profile)!, projections };
}
describe('Metabolism policy v2 separates current paid burn, prospective profiles and trailing display', () => {
  it.each([
    ['28252801', 'full'], ['28252800', 'lean'], ['4708800', 'lean'], ['4708799', 'torpor'],
    ['196200', 'torpor'], ['196199', 'cyst'], ['0', 'cyst'],
  ] as const)('applies exact non-rounded profile threshold for %s units → %s', (balance, mode) => {
    const result = evaluateMetabolismV2(balance, '1000', snapshot(balance));
    expect(result.mode).toBe(mode); expect(result.runwaySeconds).toBe(evaluateMetabolism(balance, '1000').runwaySeconds);
  });
  it('keeps zero trailing display undefined while reporting a real paid current burn and stable lean choice', () => {
    const full = evaluateMetabolismV2('12000000', '0', snapshot('12000000'));
    const lean = evaluateMetabolismV2('12000000', '0', snapshot('12000000', 'lean'));
    expect(full).toMatchObject({ mode: 'lean', runwaySeconds: null, currentBurnPerHour: '392400' });
    expect(lean).toMatchObject({ mode: 'lean', runwaySeconds: null, currentBurnPerHour: '196200' });
    expect(full.decisionRunwaySeconds).toBe(lean.decisionRunwaySeconds);
  });
  it('includes a fixed inference price once per original lease, with exact fee ceil and no new billing', () => {
    const rate = paidMetabolismRate({ runId, hostId, resourceProfile: 'full', leaseSeconds: 120,
      cpuPricePerSecond: '1', fixedInferencePrice: '1001', feeBps: 800 });
    expect(rate).toMatchObject({ completeLeaseCost: '1211', burnPerHour: '36330' });
    expect(paidMetabolismRateSchema.safeParse({ ...rate, completeLeaseCost: '1210' }).success).toBe(false);
  });
  it('never interprets idle, unavailable profile prices or a zero rate as free full compute', () => {
    const asleep = snapshot('500000'); asleep.current = null;
    expect(evaluateMetabolismV2('500000', '10', asleep)).toMatchObject({ mode: 'torpor', currentBurnPerHour: null,
      currentRunwaySeconds: null });
    asleep.projections = []; asleep.contextRunId = null;
    expect(evaluateMetabolismV2('500000', '0', asleep)).toMatchObject({ mode: 'cyst', decisionReason: 'no_pricing_context' });
    expect(() => paidMetabolismRate({ runId, hostId, resourceProfile: 'full', leaseSeconds: 100,
      cpuPricePerSecond: '0', fixedInferencePrice: '0', feeBps: 900 })).toThrow();
    expect(() => evaluateMetabolismV2('500001', '0', snapshot('500000'))).toThrow('canonical pricing snapshot');
  });
  it('requires explicit current-rate HTTP facts and independently rejects a changed profile decision', async () => {
    const owner = `0x${'1'.repeat(40)}`, agent = `0x${'2'.repeat(40)}`;
    const at = '2026-10-14T10:00:00.000Z';
    const current = { agent: { owner, agent, version: 0, mode: 'full', currentRunId: runId,
      checkpointId: null, leaseUntil: at, wakeAt: null, killedAt: null, createdAt: at, updatedAt: at },
    intent: null, policy: PAID_AGENT_POLICY };
    const economic = evaluateMetabolismV2('12000000', '1000', snapshot('12000000'));
    const flags = { rollDue: false, scheduledWakeDue: false, killed: false };
    let response: unknown = { ...evaluateMetabolism('12000000', '1000'), ...flags };
    const paths: string[] = [];
    const control = new HttpAgentLifecycleControl(new ApiTransport('http://127.0.0.1:3281', { fetch: async url => {
      paths.push(String(url));
      return Response.json(String(url).includes('/evaluation') ? response : current);
    } }), { metabolismVersion: 2 });
    await expect(control.evaluate(owner, agent)).rejects.toThrow('required version');
    response = { ...economic, ...flags, mode: 'full' };
    await expect(control.evaluate(owner, agent)).rejects.toThrow();
    response = { ...economic, ...flags };
    expect(await control.evaluate(owner, agent)).toMatchObject({ mode: 'lean', metabolismVersion: 2 });
    expect(paths.filter(path => path.includes('/evaluation')).every(path => path.endsWith('?metabolismVersion=2'))).toBe(true);
  });
  it('rejects an independently admitted target rate above the selected projection, and durably binds the accepted policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-metabolism-target-'));
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const owner = `0x${'1'.repeat(40)}`, agent = `0x${'2'.repeat(40)}`, targetId = `0x${'d'.repeat(64)}`;
      const pricing = snapshot('12000000'), now = new Date(pricing.observedAt * 1000);
      const cysts = new CystService(store.db, join(directory, 'cysts')); await cysts.initialize();
      let targetPrice = '60';
      const service = new AgentLifecycleService(store.db, { cysts, leasePolicy: 'paid_cpu', now: () => now,
        balance: async () => '12000000', metabolismPricing: async () => pricing,
        reservedRun: async (_owner, _agent, id) => ({ id, owner, agent, reserved: true,
          leaseUntil: new Date(now.getTime() + 100_000), resourceProfile: id === runId ? 'full' : 'lean',
          paidPrice: { leaseSeconds: 100, cpuPricePerSecond: id === runId ? '100' : targetPrice, fixedInferencePrice: '0' } }) });
      await service.register(owner, { agent, runId });
      const input = { action: 'evaluate', expectedVersion: 0, metabolismVersion: 2, targetRunId: targetId };
      await expect(service.plan(owner, agent, input, 'target-rate-bound')).rejects.toMatchObject({ code: 'agent_target_rate_exceeded' });
      expect((await service.get(owner, agent)).intent).toBeNull();
      targetPrice = '50';
      const planned = await service.plan(owner, agent, input, 'target-rate-bound');
      expect(planned.intent).toMatchObject({ targetMode: 'lean', metabolismVersion: 2,
        metabolismEvaluation: { mode: 'lean', balance: '12000000' } });
      expect((await service.get(owner, agent)).intent?.metabolismVersion).toBe(2);
      await expect(service.plan(owner, agent, { ...input, metabolismVersion: undefined }, 'target-rate-bound'))
        .rejects.toMatchObject({ code: 'agent_idempotency_conflict' });
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
