import { describe, expect, it, vi } from 'vitest';
import type { FinancialFact, FinancialHistory, FinancialScan } from '../src/updates/financial-history.js';
import { createPriceBoardRoutes, settledPriceBoard } from '../src/updates/price-board.js';
import { formatSettledPrice, mountPrices } from '../public/updates/prices.js';

const END = '2026-11-13T12:00:00.000Z';
function fact(price: string, overrides: Partial<FinancialFact> = {}): FinancialFact {
  return { runId: 'fixture', payer: 'private-owner', transactionHash: 'private-transaction', blockNumber: '1',
    blockHash: 'private-block', openedAt: '2026-11-13T10:00:00.000Z', returnedAt: END, receiptHash: null,
    kind: 'settlement', outcome: 'completed', charged: '100', returned: '0', ceiling: '100', billableSeconds: 1,
    pricePerSecond: price, hardware: 'CPU', lane: null, ...overrides };
}
function history(facts: FinancialFact[], overrides: Partial<FinancialScan> = {}, fail = false) {
  const scan: FinancialScan = { generation: 'generation-1', startedAt: END, asOf: END, state: facts.length ? 'ready' : 'no_data',
    anchor: { height: '1', hash: 'confirmed' }, candidates: facts.length, visited: facts.length, verified: facts.length,
    excluded: 0, complete: true, notes: [], refunds: {} as FinancialScan['refunds'], ...overrides };
  // Structural fixture: the board needs no source scanning or database methods.
  const fixture = { source: { chainId: 8453, token: 'USDC-address', escrow: 'escrow-address' },
    snapshot: async () => structuredClone(scan),
    facts: async function* () { for (const row of facts) yield row; if (fail) throw new Error('reorg / iterator failure'); },
  } as unknown as FinancialHistory;
  return { fixture, scan };
}

describe('actual settled price board', () => {
  it.each([404, 503])('stops polling terminal endpoint status %s until explicit refresh', async status => {
    vi.useFakeTimers();
    const formEvents = new Map<string, (event: Event) => void>(), documentEvents = new Map<string, () => void>();
    const select = { value: '24h', addEventListener: (): void => {}, removeEventListener: (): void => {} };
    const button = { disabled: false, setAttribute: (): void => {}, removeAttribute: (): void => {} };
    const error = { hidden: true, textContent: '' }, progress = { textContent: '' };
    const results = { dataset: {} as Record<string, string>, replaceChildren: (): void => {} };
    const form = { querySelector: (selector: string): unknown => selector === 'select' ? select : selector === 'button' ? button
      : selector === '#price-board-error' ? error : progress,
      addEventListener: (name: string, callback: (event: Event) => void): void => { formEvents.set(name, callback); },
      removeEventListener: (name: string): void => { formEvents.delete(name); } };
    const section = { querySelector: (selector: string): unknown => selector === 'form' ? form : results };
    const doc = { hidden: false, addEventListener: (name: string, callback: () => void): void => { documentEvents.set(name, callback); },
      removeEventListener: (name: string): void => { documentEvents.delete(name); } };
    // Minimal DOM fixture exercises only endpoint-failure and retry lifecycle, without table rendering.
    const main = { innerHTML: '', ownerDocument: doc, querySelector: (): unknown => section, contains: (): boolean => true } as unknown as HTMLElement;
    vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ state: 'not_configured' }), { status }));
    vi.stubGlobal('fetch', fetcher);
    const cleanup = mountPrices(main, '');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(results.dataset['state']).toBe(status === 404 ? 'not_enabled' : 'not_configured');
      expect(progress.textContent).toContain('Automatic refresh paused');
      await vi.advanceTimersByTimeAsync(180000);
      doc.hidden = true; documentEvents.get('visibilitychange')?.();
      doc.hidden = false; documentEvents.get('visibilitychange')?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      formEvents.get('submit')?.(new Event('submit'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it('uses returnedAt inclusive window bounds, not openedAt, and excludes future samples', async () => {
    const rows = [fact('1', { returnedAt: '2026-11-13T11:00:00.000Z' }), fact('9'),
      fact('888', { returnedAt: '2026-11-13T10:59:59.999Z' }), fact('999', { returnedAt: '2026-11-13T12:00:00.001Z' })];
    const report = await settledPriceBoard(history(rows).fixture, '1h');
    expect(report.rows[0]).toMatchObject({ sampleCount: '2', p10Atomic: '1', p90Atomic: '9', medianAtomic: { numerator: '5', denominator: '1' } });
    expect(report.periodStartsAt).toBe('2026-11-13T11:00:00.000Z');
    expect((await settledPriceBoard(history(rows).fixture, '24h')).rows[0]?.sampleCount).toBe('3');
  });
  it('omits zero billable rows, refunds, unknown hardware and missing recorded prices without inference', async () => {
    const rows = [fact('0'), fact('999', { billableSeconds: 0 }), fact('999', { kind: 'timeout_refund' }),
      fact('999', { hardware: null }), fact('999', { pricePerSecond: null })];
    const report = await settledPriceBoard(history(rows).fixture, '24h');
    expect(report.rows[0]).toMatchObject({ sampleCount: '1', p10Atomic: '0', medianAtomic: { numerator: '0', denominator: '1' } });
    expect(report.coverage.exclusions).toEqual({ zeroBillable: '1', unknownHardware: '1', missingRecordedPrice: '1' });
    expect(JSON.stringify(report)).not.toContain('private-owner');
    expect(report.rows.every(row => row.lane === null)).toBe(true);
    expect(report.rows.slice(1).every(row => row.state === 'no_data' && row.medianAtomic === null && row.p10Atomic === null && row.p90Atomic === null)).toBe(true);
  });
  it('computes nearest ranks and preserves large odd-sum even medians without floating point', async () => {
    const base = 900719925474099312345678n;
    const report = await settledPriceBoard(history(Array.from({ length: 10 }, (_, i) => fact((base + BigInt(i)).toString()))).fixture, '7d');
    expect(report.rows[0]).toMatchObject({ sampleCount: '10', p10Atomic: base.toString(), p90Atomic: (base + 8n).toString(),
      medianAtomic: { numerator: (base * 2n + 9n).toString(), denominator: '2' } });
    expect(formatSettledPrice({ numerator: '1', denominator: '2' })).toBe('0.0000005');
    expect(formatSettledPrice({ numerator: (base * 2n + 9n).toString(), denominator: '2' })).toBe('900719925474099312.3456825');
  });
  it('represents a verified empty period as no_data with null prices', async () => {
    const report = await settledPriceBoard(history([]).fixture, '24h');
    expect(report.state).toBe('no_data'); expect(report.coverage.complete).toBe(true);
    expect(report.rows[0]).toMatchObject({ state: 'no_data', sampleCount: '0', medianAtomic: null });
  });
  it('supports more than 2,000 samples and repeated histogram levels exactly', async () => {
    const report = await settledPriceBoard(history(Array.from({ length: 5001 }, (_, i) => fact(i < 4000 ? '2' : '4'))).fixture, '24h');
    expect(report.rows[0]).toMatchObject({ sampleCount: '5001', medianAtomic: { numerator: '2', denominator: '1' }, p90Atomic: '4' });
  });
  it('marks excessive distinct quantile levels unavailable without truncation', async () => {
    const report = await settledPriceBoard(history(Array.from({ length: 10001 }, (_, i) => fact(String(i)))).fixture, '24h');
    expect(report.state).toBe('unavailable'); expect(report.rows[0]?.sampleCount).toBeNull();
    expect(report.reason).toContain('10,000'); expect(report.coverage.complete).toBe(false);
  });
  it('withholds prices and unknown sample count until a complete snapshot exists', async () => {
    const report = await settledPriceBoard(history([fact('7')], { state: 'partial', complete: false }).fixture, '24h');
    expect(report.state).toBe('partial'); expect(report.rows[0]).toMatchObject({ sampleCount: null, medianAtomic: null });
  });
  it('discards a partial iteration after source or canonicality failure', async () => {
    const report = await settledPriceBoard(history([fact('7')], {}, true).fixture, '24h');
    expect(report.state).toBe('unavailable'); expect(report.rows[0]?.medianAtomic).toBeNull();
  });
  it('discards snapshots which change generation or omit verified facts', async () => {
    const item = history([fact('3')]); let calls = 0;
    item.fixture.snapshot = async () => ({ ...item.scan, generation: ++calls > 1 ? 'new-generation' : 'generation-1' });
    expect((await settledPriceBoard(item.fixture, '24h')).state).toBe('unavailable');
    expect((await settledPriceBoard(history([fact('3')], { verified: 2 }).fixture, '24h')).state).toBe('unavailable');
  });
  it.each(['?period=all', '?period=1h&period=7d', '?period=', '?owner=private-owner', '?period=24h&limit=5000'])('rejects malformed or unbounded query %s', async query => {
    expect((await createPriceBoardRoutes(history([]).fixture).request(`/prices${query}`)).status).toBe(422);
  });
  it('defaults to 24h and gives a read-only non-cacheable aggregate', async () => {
    const response = await createPriceBoardRoutes(history([fact('7')]).fixture).request('/prices');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ period: '24h', state: 'ready' });
  });
});
