import { describe, expect, it, vi } from 'vitest';
import { FinancialHistory, refundSnapshot, type FinancialFact, type FinancialHistorySource } from '../src/updates/financial-history.js';
import { createRefundInsightRoutes } from '../src/updates/refund-routes.js';
import { loadConfig } from '../src/config.js';
import { featureEnabled, publicFeatures } from '../src/updates/features.js';

const now = Date.parse('2026-11-13T12:00:00Z');
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0');
function fact(n: number, extra: Partial<FinancialFact> = {}): FinancialFact {
  return { runId: id(n), payer: '0x' + '11'.repeat(20), transactionHash: id(n + 10000), blockNumber: '10', blockHash: id(999),
    openedAt: '2026-11-13T11:59:00.000Z', returnedAt: '2026-11-13T12:00:00.000Z', receiptHash: id(n + 20000),
    kind: 'settlement', outcome: 'completed', charged: '200', returned: '5800', ceiling: '6000',
    billableSeconds: 2, pricePerSecond: '100', hardware: 'CPU', lane: null, ...extra };
}
function source(input: FinancialFact[]): FinancialHistorySource {
  const rows = [...input].sort((a, b) => a.runId.localeCompare(b.runId));
  const saved = new Map<string, { value: FinancialFact; generation: string }>();
  return { scope: 'fixed-scope', chainId: 8453, token: '0x' + '22'.repeat(20), escrow: '0x' + '33'.repeat(20),
    anchor: vi.fn(async () => ({ height: '100', hash: id(999) })), canonical: vi.fn(async () => true),
    count: async () => rows.length,
    page: async (_cutoff, after) => rows.filter(row => !after || row.runId > after).slice(0, 25)
      .map(row => ({ id: row.runId, receipt: null, settlementTxHash: row.transactionHash })),
    verify: vi.fn(async candidate => rows.find(row => row.runId === candidate.id) ?? null),
    save: async (value, generation) => { saved.set(value.runId, { value, generation }); },
    facts: async (generation, after, owner) => [...saved.values()].filter(row => row.generation === generation
      && (!after || row.value.runId > after) && (!owner || row.value.payer === owner)).map(row => row.value)
      .sort((a, b) => a.runId.localeCompare(b.runId)).slice(0, 25),
  };
}
describe('verified refund history, exact accounting and bounded progress', () => {
  it('keeps success remainder, failed returns, timeout and unknown outcomes separate', async () => {
    const s = source([fact(1), fact(2, { outcome: 'failed', returned: '6000', charged: '0' }),
      fact(3, { kind: 'timeout_refund', outcome: 'timed_out', returned: '6000', charged: '0' }),
      fact(4, { outcome: 'unknown', returned: '5', charged: '5995' })]);
    const h = new FinancialHistory(s, () => now), result = refundSnapshot(await h.settled(), s, 'all');
    expect(result.state).toBe('ready'); expect(result.coverage.complete).toBe(true);
    expect(result.totals).toMatchObject({ settledRuns: 3, successfulRuns: 1, failedRuns: 1, timeoutRefunds: 1,
      returnedAtomic: '17805', unusedSuccessAtomic: '5800', failedReturnedAtomic: '6000', timeoutReturnedAtomic: '6000',
      unclassifiedReturnedAtomic: '5', failedWithReturn: 1, meanReturnSeconds: '60' });
    expect(JSON.stringify(result)).not.toMatch(/"payer":|"receipt":|"transactionHash":/);
  });
  it('has no 2000-row truncation and retains bounded aggregate memory', async () => {
    const s = source(Array.from({ length: 2027 }, (_, i) => fact(i + 1)));
    const h = new FinancialHistory(s, () => now), scan = await h.settled(), result = refundSnapshot(scan, s, 'all');
    expect(result.totals.settledRuns).toBe(2027); expect(result.totals.returnedAtomic).toBe((2027n * 5800n).toString());
    expect(result.coverage.verified).toBe(2027); expect(Object.keys(scan.refunds.all.daily)).toHaveLength(1);
    expect('facts' in scan).toBe(false); expect(JSON.stringify(scan).length).toBeLessThan(10000);
    const ownerRows: FinancialFact[] = []; for await (const row of h.facts('0x' + '11'.repeat(20))) ownerRows.push(row);
    expect(ownerRows).toHaveLength(2027);
    const otherRows: FinancialFact[] = []; for await (const row of h.facts('0x' + '99'.repeat(20))) otherRows.push(row);
    expect(otherRows).toHaveLength(0);
  });
  it('does not turn missing evidence, RPC errors or reorgs into verified totals', async () => {
    const s = source([fact(1)]); s.verify = async () => null;
    const h = new FinancialHistory(s, () => now), partial = await h.settled();
    expect(partial).toMatchObject({ state: 'partial', verified: 0, excluded: 1, complete: false });
    s.verify = async () => { throw new Error('PRIVATE_RPC_URL'); };
    const unavailable = await new FinancialHistory(s, () => now).settled();
    expect(unavailable.state).toBe('unavailable'); expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');
    s.verify = async () => fact(1); s.canonical = async () => false;
    expect((await new FinancialHistory(s, () => now).settled()).state).toBe('unavailable');
  });
  it('keeps stale cached data unavailable when its anchor cannot be checked', async () => {
    const s = source([fact(1)]), h = new FinancialHistory(s, () => now); await h.settled();
    s.canonical = async () => { throw new Error('offline'); };
    expect(await h.snapshot()).toMatchObject({ state: 'unavailable', complete: false });
  });
  it('never reports complete coverage if recorded history changes while scanning', async () => {
    const s = source([fact(1)]); let counted = 0; s.count = async () => ++counted === 1 ? 1 : 2;
    expect(await new FinancialHistory(s, () => now).settled()).toMatchObject({ state: 'partial', complete: false });
  });
  it('keeps huge USDC amounts exact and handles no positive returns without fabricated latency', async () => {
    const n = '1234567890123456789012345678';
    const s = source([fact(1, { returned: n, ceiling: n, charged: '0' }), fact(2, { returned: '0' })]);
    const result = refundSnapshot(await new FinancialHistory(s, () => now).settled(), s, 'all');
    expect(result.totals.returnedAtomic).toBe(n); expect(result.totals.meanReturnSeconds).toBe('60');
    const zero = source([fact(1, { returned: '0' })]);
    expect(refundSnapshot(await new FinancialHistory(zero, () => now).settled(), zero, 'all').totals.meanReturnSeconds).toBeNull();
  });
  it('retains all-history totals while disclosing a bounded 90-day chart', async () => {
    const s = source([fact(1, { openedAt: '2026-01-01T00:00:00Z', returnedAt: '2026-01-01T00:01:00Z' }), fact(2)]);
    const scan = await new FinancialHistory(s, () => now).settled();
    expect(refundSnapshot(scan, s, 'all')).toMatchObject({ chartWindowDays: 90, totals: { settledRuns: 2 } });
    expect(refundSnapshot(scan, s, 'all').daily).toHaveLength(1);
    expect(refundSnapshot(scan, s, '24h').totals.settledRuns).toBe(1);
  });
  it('has an explicit no-data state for empty history and null duration', async () => {
    const s = source([]), r = refundSnapshot(await new FinancialHistory(s, () => now).settled(), s, 'all');
    expect(r.state).toBe('no_data'); expect(r.coverage.complete).toBe(true); expect(r.totals.meanReturnSeconds).toBeNull();
  });
  it('rejects malformed/duplicate periods and makes no financial write', async () => {
    const s = source([]), h = new FinancialHistory(s, () => now); await h.settled();
    const routes = createRefundInsightRoutes(h);
    for (const path of ['/refunds?period=bad', '/refunds?period=all&period=7d', '/refunds?period=all&owner=other']) {
      expect((await routes.request(path)).status).toBeGreaterThanOrEqual(400);
    }
    const response = await routes.request('/refunds?period=all'); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('requires an explicit known feature flag and defaults all staged features OFF', () => {
    const base = { DEMO_PRIVATE_KEY: '0x' + '12'.repeat(32), SIGNER_PRIVATE_KEY: '0x' + '13'.repeat(32),
      ESCROW_ADDRESS: '0x' + '11'.repeat(20), TOKEN_ADDRESS: '0x' + '22'.repeat(20), DATA_DIR: ':memory:' };
    expect(publicFeatures(loadConfig(base))).toEqual([]);
    expect(featureEnabled(loadConfig({ ...base, POSTLAUNCH_FEATURES: 'refunds' }), 'refunds')).toBe(true);
    expect(() => loadConfig({ ...base, POSTLAUNCH_FEATURES: 'refunds,refunds' })).toThrow();
    expect(() => loadConfig({ ...base, POSTLAUNCH_FEATURES: 'secret' })).toThrow();
  });
});
