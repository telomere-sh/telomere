import { describe, expect, it, vi } from 'vitest';
import { Problem } from '../src/common.js';
import { FinancialHistory, type FinancialFact, type FinancialHistorySource } from '../src/updates/financial-history.js';
import { createRunwayRoutes, RunwayReader, type RunwayReport } from '../src/updates/runway.js';
import { formatRunwayHours, mountRunway } from '../public/updates/runway.js';

const now = Date.parse('2026-11-13T12:00:00Z'), owner = '0x' + '11'.repeat(20), other = '0x' + '22'.repeat(20);
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const anchor = { height: '100', hash: id(999) };
function fact(n: number, extra: Partial<FinancialFact> = {}): FinancialFact {
  return { runId: id(n), payer: owner, transactionHash: id(n + 100), blockNumber: '90', blockHash: id(998),
    openedAt: '2026-11-13T11:59:00Z', returnedAt: '2026-11-13T12:00:00Z', receiptHash: id(n + 200),
    kind: 'settlement', outcome: 'completed', charged: '24', returned: '0', ceiling: '24',
    billableSeconds: 1, pricePerSecond: '24', hardware: 'CPU', lane: null, ...extra };
}
async function fixture(rows: FinancialFact[], balance = '72') {
  const saved = new Map<string, { fact: FinancialFact; generation: string }>();
  const source: FinancialHistorySource = { scope: 'controller-recorded confirmed history', chainId: 8453,
    token: '0x' + '33'.repeat(20), escrow: '0x' + '44'.repeat(20),
    anchor: vi.fn(async () => anchor), canonical: vi.fn(async () => true), count: async () => rows.length,
    page: async (_cutoff, after) => rows.filter(r => !after || r.runId > after).slice(0, 25)
      .map(r => ({ id: r.runId, receipt: null, settlementTxHash: r.transactionHash })),
    verify: async candidate => rows.find(r => r.runId === candidate.id) ?? null,
    save: async (r, generation) => { saved.set(r.runId, { fact: r, generation }); },
    facts: vi.fn(async (generation, after, address) => [...saved.values()].filter(r => r.generation === generation
      && (!after || r.fact.runId > after) && (!address || r.fact.payer === address)).map(r => r.fact).slice(0, 25)),
  };
  const history = new FinancialHistory(source, () => now); await history.settled();
  const readBalance = vi.fn(async (_owner: string, _anchor: typeof anchor) => balance);
  return { source, history, readBalance, reader: new RunwayReader(history, readBalance) };
}
function privateClientFixture(fetcher: (path: string, options?: RequestInit) => Promise<Response>) {
  class Element {
    private value = '';
    children: Element[] = [];
    get textContent(): string { return this.value + this.children.map(child => child.textContent).join(' '); }
    set textContent(value: string) { this.value = value; this.children = []; }
    append(...children: Element[]): void { this.children.push(...children); }
    replaceChildren(...children: Element[]): void { this.value = ''; this.children = children; }
  }
  const buttonEvents = new Map<string, () => void>(), documentEvents = new Map<string, () => void>();
  const button = { disabled: false, setAttribute: (): void => {}, removeAttribute: (): void => {},
    addEventListener: (name: string, callback: () => void): void => { buttonEvents.set(name, callback); },
    removeEventListener: (name: string): void => { buttonEvents.delete(name); } };
  const doc = { hidden: false, createElement: (): Element => new Element(),
    createTextNode: (value: string): Element => { const result = new Element(); result.textContent = value; return result; },
    addEventListener: (name: string, callback: () => void): void => { documentEvents.set(name, callback); },
    removeEventListener: (name: string): void => { documentEvents.delete(name); } };
  const status = { textContent: '' }, error = { textContent: '', hidden: true };
  const results = Object.assign(new Element(), { ownerDocument: doc, dataset: {} as Record<string, string>, hidden: true });
  const main = { innerHTML: '', ownerDocument: doc, querySelector: (selector: string): unknown => selector === '#runway-refresh' ? button
    : selector === '#runway-status' ? status : selector === '#runway-error' ? error : results } as unknown as HTMLElement;
  const channels: Channel[] = [];
  class Channel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    close = vi.fn();
    constructor(readonly name: string) { channels.push(this); }
  }
  vi.stubGlobal('window', {}); vi.stubGlobal('BroadcastChannel', Channel); vi.stubGlobal('fetch', fetcher);
  return { buttonEvents, documentEvents, results, status, doc, channels, main };
}
describe('private owner compute runway', () => {
  it('formats readable decimal hours while retaining explicit rounding for repeating fractions', () => {
    expect(formatRunwayHours({ numerator: '23995200', denominator: '200' })).toBe('119976 hours');
    expect(formatRunwayHours({ numerator: '3', denominator: '2' })).toBe('1.5 hours');
    expect(formatRunwayHours({ numerator: '0', denominator: '1' })).toBe('0 hours');
    expect(formatRunwayHours({ numerator: '1', denominator: '3' })).toBe('0.333333 hours (rounded down to 6 decimals)');
    expect(formatRunwayHours({ numerator: '123456789012345678901', denominator: '10' })).toBe('12345678901234567890.1 hours');
  });
  it.each([null, other])('clears private figures on wallet broadcast %s and waits for explicit session review', async nextOwner => {
    const report = await (await fixture([fact(1)], '23995200')).reader.read(owner);
    vi.useFakeTimers(); let currentOwner: string | null = owner;
    const fetcher = vi.fn(async (path: string) => path === '/api/me'
      ? new Response(JSON.stringify(currentOwner ? { address: currentOwner } : {}), { status: currentOwner ? 200 : 401 })
      : currentOwner === owner ? new Response(JSON.stringify(report)) : new Response('{}', { status: 404 }));
    const client = privateClientFixture(fetcher), cleanup = mountRunway(client.main, '');
    try {
      await vi.advanceTimersByTimeAsync(0);
      const channel = client.channels[0]!;
      expect(channel.name).toBe('telomere-wallet-session-v1');
      expect(client.results.hidden).toBe(false); expect(client.results.textContent).toContain('23.995200 USDC');
      expect(client.results.textContent).toContain('Exact runway calculation');
      channel.onmessage?.({ data: { owner } } as MessageEvent<unknown>);
      expect(client.results.hidden).toBe(false);
      currentOwner = nextOwner;
      channel.onmessage?.({ data: { owner: nextOwner } } as MessageEvent<unknown>);
      expect(client.results.textContent).toBe(''); expect(client.results.hidden).toBe(true);
      expect(client.results.dataset['state']).toBe('session_changed'); expect(client.status.textContent).toContain('Private figures cleared');
      expect(vi.getTimerCount()).toBe(0);
      client.doc.hidden = true; client.documentEvents.get('visibilitychange')?.();
      client.doc.hidden = false; client.documentEvents.get('visibilitychange')?.();
      await vi.advanceTimersByTimeAsync(180000); expect(fetcher).toHaveBeenCalledTimes(2);
      client.buttonEvents.get('click')?.(); await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(nextOwner ? 4 : 3);
      expect(client.results.textContent).not.toContain('23.995200 USDC');
      cleanup(); expect(channel.onmessage).toBeNull(); expect(channel.close).toHaveBeenCalledTimes(1);
    } finally { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it('aborts pending owner data and rejects a late response after another window switches accounts', async () => {
    const report = await (await fixture([fact(1)])).reader.read(owner);
    vi.useFakeTimers(); let pendingSignal: AbortSignal | null | undefined, resolveLate: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/me') return new Response(JSON.stringify({ address: owner }));
      pendingSignal = options?.signal;
      return new Promise<Response>(resolve => { resolveLate = resolve; });
    });
    const client = privateClientFixture(fetcher), cleanup = mountRunway(client.main, '');
    try {
      await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledTimes(2);
      client.channels[0]!.onmessage?.({ data: { owner: other } } as MessageEvent<unknown>);
      expect(pendingSignal?.aborted).toBe(true); expect(client.results.hidden).toBe(true);
      resolveLate?.(new Response(JSON.stringify(report))); await vi.advanceTimersByTimeAsync(0);
      expect(client.results.textContent).toBe(''); expect(client.results.dataset['state']).toBe('session_changed');
      await vi.advanceTimersByTimeAsync(180000); expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it.each([
    { status: 404, problem: { title: 'not_enabled' }, state: 'not_enabled', terminal: true },
    { status: 503, problem: { code: 'not_configured' }, state: 'not_configured', terminal: true },
    { status: 503, problem: { title: 'not_configured' }, state: 'not_configured', terminal: true },
    { status: 503, problem: { title: 'service_unavailable' }, state: 'unavailable', terminal: false },
    { status: 403, problem: { title: 'not_configured' }, state: 'unavailable', terminal: false },
  ])('keeps endpoint $status/$state lifecycle distinct until manual retry', async testCase => {
    vi.useFakeTimers();
    const buttonEvents = new Map<string, () => void>(), documentEvents = new Map<string, () => void>();
    const button = { disabled: false, setAttribute: (): void => {}, removeAttribute: (): void => {},
      addEventListener: (name: string, callback: () => void): void => { buttonEvents.set(name, callback); },
      removeEventListener: (name: string): void => { buttonEvents.delete(name); } };
    const status = { textContent: '' }, error = { textContent: '', hidden: true };
    const results = { dataset: {} as Record<string, string>, hidden: true, replaceChildren: (): void => {} };
    const doc = { hidden: false, addEventListener: (name: string, callback: () => void): void => { documentEvents.set(name, callback); },
      removeEventListener: (name: string): void => { documentEvents.delete(name); } };
    // Endpoint failure lifecycle needs no layout engine or report rendering.
    const main = { innerHTML: '', ownerDocument: doc, querySelector: (selector: string): unknown => selector === '#runway-refresh' ? button
      : selector === '#runway-status' ? status : selector === '#runway-error' ? error : results } as unknown as HTMLElement;
    const fetcher = vi.fn(async (path: string) => path === '/api/me' ? new Response(JSON.stringify({ address: owner }))
      : new Response(JSON.stringify(testCase.problem), { status: testCase.status }));
    vi.stubGlobal('fetch', fetcher);
    const cleanup = mountRunway(main, '');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2); expect(results.dataset['state']).toBe(testCase.state);
      if (testCase.terminal) {
        expect(status.textContent).toContain('Automatic refresh paused');
        await vi.advanceTimersByTimeAsync(180000);
        doc.hidden = true; documentEvents.get('visibilitychange')?.();
        doc.hidden = false; documentEvents.get('visibilitychange')?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
        buttonEvents.get('click')?.(); await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(4); expect(results.dataset['state']).toBe(testCase.state);
      } else {
        expect(status.textContent).not.toContain('Automatic refresh paused');
        await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledTimes(4);
      }
      expect(results.hidden).toBe(true);
    } finally { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it('pins balance to the history anchor and never includes another owner or refunds in burn', async () => {
    const f = await fixture([fact(1), fact(2, { payer: other, charged: '999999' }),
      fact(3, { kind: 'timeout_refund', charged: '999', returned: '999' })]);
    const report = await f.reader.read(owner);
    expect(f.readBalance).toHaveBeenCalledWith(owner, anchor);
    expect(f.source.facts).toHaveBeenCalledWith(expect.any(String), undefined, owner);
    expect(report).toMatchObject({ state: 'ready', owner, anchor,
      estimate: { availableAtomic: '72', trailing24hChargedAtomic: '24', ownerFacts: 2, settledRuns24h: 1,
        mode: 'lean', runwaySeconds: '259200', runwayHours: { numerator: '1728', denominator: '24' } } });
    expect(JSON.stringify(report)).not.toContain(other);
  });
  it.each([['73', 'full'], ['72', 'lean'], ['24', 'lean'], ['23', 'torpor'], ['2', 'torpor'], ['1', 'cyst'], ['0', 'cyst']])
    ('uses exact policy thresholds at balance %s', async (balance, mode) => {
      expect((await (await fixture([fact(1)], balance)).reader.read(owner)).estimate?.mode).toBe(mode);
    });
  it('distinguishes zero available balance, known zero spend, and absent owner history', async () => {
    const old = fact(1, { returnedAt: '2026-11-01T12:00:00Z' });
    expect((await (await fixture([old], '0')).reader.read(owner)).estimate).toMatchObject({ mode: 'cyst', zeroSpend: true,
      runwaySeconds: '0', runwayHours: { numerator: '0', denominator: '1' } });
    expect((await (await fixture([old])).reader.read(owner)).estimate).toMatchObject({ mode: 'full', zeroSpend: true,
      runwaySeconds: null, runwayHours: null });
    expect(await (await fixture([fact(1, { payer: other })])).reader.read(owner)).toMatchObject({ state: 'no_data', estimate: null });
    expect(await (await fixture([])).reader.read(owner)).toMatchObject({ state: 'no_data', estimate: null });
  });
  it('includes both window boundaries and excludes earlier or later settlement times', async () => {
    const f = await fixture([fact(1, { returnedAt: '2026-11-12T12:00:00Z' }), fact(2),
      fact(3, { returnedAt: '2026-11-12T11:59:59.999Z', charged: '100000' }),
      fact(4, { returnedAt: '2026-11-13T12:00:00.001Z', charged: '100000' })]);
    expect((await f.reader.read(owner)).estimate).toMatchObject({ trailing24hChargedAtomic: '48', settledRuns24h: 2 });
  });
  it('preserves atomic precision beyond Number and exposes rational hours', async () => {
    const balance = '123456789012345678901234567890';
    const f = await fixture([fact(1, { charged: '7' })], balance), report = await f.reader.read(owner);
    expect(report.estimate).toMatchObject({ availableAtomic: balance, trailing24hChargedAtomic: '7',
      runwaySeconds: (BigInt(balance) * 86400n / 7n).toString(), runwayHours: { numerator: (BigInt(balance) * 24n).toString(), denominator: '7' } });
  });
  it('withholds private amounts for partial history, unavailable balance, malformed balance and reorg', async () => {
    const f = await fixture([fact(1)]), original = await f.history.snapshot();
    vi.spyOn(f.history, 'snapshot').mockResolvedValue({ ...original, state: 'partial', complete: false });
    expect(await f.reader.read(owner)).toMatchObject({ state: 'partial', estimate: null });
    expect(f.readBalance).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    for (const read of [async () => { throw new Error('PRIVATE_RPC'); }, async () => '1.5']) {
      const reader = new RunwayReader(f.history, read), report = await reader.read(owner);
      expect(report).toMatchObject({ state: 'unavailable', estimate: null }); expect(JSON.stringify(report)).not.toContain('PRIVATE_RPC');
    }
    f.readBalance.mockImplementation(async () => { f.source.canonical = async () => false; return '72'; });
    expect(await f.reader.read(owner)).toMatchObject({ estimate: null });
  });
  it('withholds estimate if a new scan generation replaces the original while reading balance', async () => {
    const f = await fixture([fact(1)]), original = await f.history.snapshot();
    f.readBalance.mockImplementation(async () => { vi.spyOn(f.history, 'snapshot').mockResolvedValue({ ...original, generation: 'changed' }); return '72'; });
    expect(await f.reader.read(owner)).toMatchObject({ state: 'unavailable', estimate: null });
  });
  it('requires a signed owner, rejects owner queries and a mismatched guard, and clears session races', async () => {
    const f = await fixture([fact(1)]), resolve = vi.fn(async () => owner), routes = createRunwayRoutes(f.history, f.readBalance, resolve);
    routes.onError((error, c) => c.json({ detail: error.message }, error instanceof Problem ? error.status : 500));
    const request = (path: string, address = owner) => routes.request(path, { headers: { 'X-Telomere-Owner': address } });
    expect((await routes.request('/runway')).status).toBe(409);
    expect((await request('/runway', other)).status).toBe(409);
    expect((await request('/runway?owner=' + other)).status).toBe(422);
    const response = await request('/runway');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json() as RunwayReport).owner).toBe(owner);
    resolve.mockResolvedValueOnce(owner).mockResolvedValueOnce(other);
    const changed = await request('/runway'); expect(changed.status).toBe(409); expect(await changed.text()).not.toContain('availableAtomic');
    resolve.mockRejectedValue(new Problem(401, 'auth', 'Sign in.'));
    expect((await request('/runway')).status).toBe(401);
  });
});
