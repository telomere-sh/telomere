import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import type { SelectionDatasetRow } from '../src/selection/dataset.js';
import { selectionBlocks, selectionCursors, selectionEvents } from '../src/selection/schema.js';
import { SelectionExplorer, createSelectionExplorerRoutes, type SelectionExplorerCanonicalReader, type SelectionExplorerIndex } from '../src/updates/selection-explorer.js';
import { mountFossilRecord } from '../public/updates/fossils.js';

const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const key = 'a'.repeat(64), registry = '0x' + 'b'.repeat(40), base = BigInt(Date.parse('2030-01-07T00:00:00.000Z') / 1000);
const huge = '123456789012345678901234567890';
const indexer: SelectionExplorerIndex = { indexKey: key, profile: { reviewed: true, chainId: 8453, registryAddress: registry,
  startBlock: 1n, confirmations: 2, maxBlocksPerSync: 64, maxReorgDepth: 64, maxEvents: 1000, maxVaults: 1024 } };
function row(n: number, status: SelectionDatasetRow['status']): SelectionDatasetRow {
  return { agentId: hash(n), family: hash(n), parent: hash(0), generation: 0, status, frozen: false, bornAt: base.toString(),
    diedAt: status === 'dead' ? (base + 700n).toString() : null, lifespanSeconds: status === 'dead' ? '700' : null,
    deathCause: status === 'dead' ? hash(999) : null, offspring: 0, weeklyIncomeUnits: huge, weeklyIncomeFeeUnits: '11',
    weeklyNetIncomeUnits: (BigInt(huge) - 11n).toString(), weeklyBurnUnits: '31', weeklySubsidyUnits: '37',
    lifetimeIncomeUnits: huge, lifetimeIncomeFeeUnits: '11', lifetimeNetIncomeUnits: (BigInt(huge) - 11n).toString(), lifetimeBurnUnits: '31', lifetimeSubsidyUnits: '37' };
}
const canonical = () => ({ version: 1 as const, currency: 'registry-token-base-units' as const, periodTime: 'block-timestamp' as const,
  index: { indexKey: key, chainId: 8453, registryAddress: registry, confirmations: 2, indexedThrough: '7', blockHash: hash(107), revision: 3 },
  coverage: { weekStart: '2030-01-07', weekEndExclusive: '2030-01-14', asOfSeconds: (base + 700n).toString(), historyStartBlock: '1',
    historyStartSeconds: (base - 7n * 86400n).toString(), partialStart: false, partialEnd: true, currentWeek: true, deploymentHistoryVerified: false as const },
  pagination: { limit: 100, afterAgentId: null, returnedRows: 3, totalRowsInSnapshot: 3, firstPage: true },
  rows: [row(1, 'alive'), row(2, 'dormant'), row(3, 'dead')] });
const request = { from: '2030-01-07', to: '2030-01-07' };

describe('public Selection event explorer with an injected canonical snapshot reader', () => {
  let directory: string, store: Awaited<ReturnType<typeof openStore>>;
  const reader = (): SelectionExplorerCanonicalReader => ({ page: vi.fn(async () => canonical()) });
  const service = (source = reader(), now = Number(base + 710n) * 1000) => new SelectionExplorer(store.db, source, indexer, () => now);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'selection-explorer-')); store = await openStore({ DATA_DIR: directory });
    await store.db.insert(selectionCursors).values({ key, profileHash: 'c'.repeat(64), nextBlock: 8n, lastHash: hash(107), revision: 3 });
    const names = ['Birth', 'Income', 'Subsidy', 'Burn', 'Dormant', 'Revived', 'Death'];
    for (let offset = 0; offset < names.length; offset++) {
      const height = BigInt(offset + 1), name = names[offset]!, txHash = hash(200 + offset), blockHash = hash(101 + offset);
      await store.db.insert(selectionBlocks).values({ indexKey: key, height, hash: blockHash, parentHash: hash(100 + offset), timestamp: base + height * 100n });
      await store.db.insert(selectionEvents).values({ indexKey: key, id: txHash + ':0', height, blockHash, transactionHash: txHash, logIndex: 0,
        address: registry, name, args: { agentId: hash(name === 'Dormant' ? 2 : name === 'Death' ? 3 : 1), amount: name === 'Income' ? huge : name === 'Subsidy' ? '37' : '31', fee: '11',
          source: 'PRIVATE_SOURCE', paymentRef: 'PRIVATE_PAYMENT_REF', owner: 'PRIVATE_OWNER' } });
    }
    // Owner-facing vault history and a second deployment must remain outside this public feed.
    await store.db.insert(selectionEvents).values({ indexKey: key, id: hash(999) + ':1', height: 1n, blockHash: hash(101), transactionHash: hash(999), logIndex: 1,
      address: '0x' + 'd'.repeat(40), name: 'OwnerWithdrawn', args: { owner: 'PRIVATE_OWNER', amount: '888', agentId: hash(1) } });
  }, 30_000);
  afterAll(async () => { await store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('returns real persisted registry references, exact amounts and separate subsidy classification', async () => {
    const result = await service().page(request);
    expect(result.events.map(event => event.event)).toEqual(['Birth', 'Income', 'Subsidy', 'Burn', 'Dormant', 'Revived', 'Death']);
    expect(result.events.find(event => event.event === 'Income')).toMatchObject({ amountUnits: huge, feeUnits: '11' });
    expect(result.events.find(event => event.event === 'Subsidy')).toMatchObject({ amountUnits: '37', feeUnits: null });
    expect(result.agents.map(agent => agent.status)).toEqual(['alive', 'dormant', 'dead']);
    expect(result.agents[0]).toMatchObject({ registryIncomeUnits: huge, registrySubsidyUnits: '37', actualIncomeUnits: null });
    expect(result.agents[0]!.eventRefs.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|OwnerWithdrawn|paymentRef|ownerWithdrawals/);
  });
  it('paginates without overlap, pins filters and rejects changed canonical revisions', async () => {
    const explorer = service(), first = await explorer.page({ ...request, limit: 2 });
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await explorer.page({ ...request, limit: 2, cursor: first.nextCursor! });
    expect(second.events.map(event => event.event)).toEqual(['Subsidy', 'Burn']);
    await expect(explorer.page({ ...request, status: 'dead', cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    const source = reader(); vi.mocked(source.page).mockResolvedValue({ ...canonical(), index: { ...canonical().index, revision: 4 } });
    await expect(service(source).page({ ...request, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });
  it('filters current lifecycle status and inclusive UTC block dates', async () => {
    const result = await service().page({ ...request, status: 'dead' });
    expect(result.events.map(event => event.event)).toEqual(['Death']);
    expect(result.period).toMatchObject({ statusTime: 'indexed-snapshot', endExclusive: '2030-01-08' });
    const empty = await service().page({ from: '2030-01-05', to: '2030-01-05' });
    expect(empty.state).toBe('no_data'); expect(empty.events).toEqual([]);
  });
  it('marks stale and partial coverage without inventing a zero actual income', async () => {
    const result = await service(reader(), Number(base + 5000n) * 1000).page(request);
    expect(result.state).toBe('stale'); expect(result.coverage).toMatchObject({ stale: true, partialEnd: true, deploymentHistoryVerified: false });
    expect(result.agents.every(agent => agent.actualIncomeUnits === null)).toBe(true);
  });
  it('rejects malformed cursors, impossible dates and excessive ranges before canonical reads', async () => {
    const source = reader(), explorer = service(source);
    for (const input of [{ ...request, cursor: '!' }, { ...request, cursor: Buffer.from('{}').toString('base64url') },
      { from: '2030-02-30', to: '2030-03-01' }, { from: '2028-01-01', to: '2030-01-01' }, { ...request, limit: 101 }]) {
      await expect(explorer.page(input)).rejects.toMatchObject({ status: 422 });
    }
    expect(source.page).not.toHaveBeenCalled();
  });
  it('fails closed on canonical reorg errors before and after the transaction', async () => {
    const source = reader(); vi.mocked(source.page).mockRejectedValueOnce(new Error('reorg'));
    await expect(service(source).page(request)).rejects.toMatchObject({ status: 503 });
    vi.mocked(source.page).mockResolvedValueOnce(canonical()).mockRejectedValueOnce(new Error('post-read reorg'));
    await expect(service(source).page(request)).rejects.toMatchObject({ status: 503 });
  });
  it('rejects index drift between guards and rejects an unrelated dataset profile', async () => {
    const source = reader(); vi.mocked(source.page).mockResolvedValueOnce(canonical()).mockResolvedValueOnce({ ...canonical(), index: { ...canonical().index, blockHash: hash(888) } });
    await expect(service(source).page(request)).rejects.toMatchObject({ status: 409 });
    vi.mocked(source.page).mockResolvedValue({ ...canonical(), index: { ...canonical().index, indexKey: 'e'.repeat(64) } });
    await expect(service(source).page(request)).rejects.toMatchObject({ status: 503 });
  });
  it('rejects a canonical timestamp dated beyond the permitted clock skew', async () => {
    await expect(service(reader(), Number(base) * 1000).page(request)).rejects.toMatchObject({ status: 503 });
  });
  it('exposes only the fixed read route, rejects duplicate params and reports missing Selection as 503', async () => {
    const app = new Hono(); app.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'error' }, error instanceof Problem ? error.status : 503));
    app.route('/api/public/selection', createSelectionExplorerRoutes(service()));
    expect((await app.request('/api/public/selection/explorer?from=2030-01-07&to=2030-01-07')).status).toBe(200);
    for (const suffix of ['&from=2030-01-07', '&url=https://example.com', '&limit=01']) {
      expect((await app.request('/api/public/selection/explorer?from=2030-01-07&to=2030-01-07' + suffix)).status).toBe(422);
    }
    const missing = new Hono(); missing.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'error' }, 503));
    missing.route('/api/public/selection', createSelectionExplorerRoutes());
    const response = await missing.request('/api/public/selection/explorer?from=2030-01-07&to=2030-01-07');
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'selection_explorer_not_configured' });
  });
});

describe('Fossil Record lifecycle in cached SPA views', () => {
  // EventTarget/observer fixture exercises lifecycle and async suppression without a browser renderer.
  class Control extends EventTarget {
    value = ''; hidden = false; disabled = false; textContent = ''; dataset: Record<string, string> = {};
    setAttribute(): void {} removeAttribute(): void {}
  }
  function fixture() {
    vi.useFakeTimers();
    const form = new Control(), from = new Control(), to = new Control(), status = new Control(), next = new Control(), apply = new Control(), error = new Control(), progress = new Control(), results = new Control();
    status.value = 'all'; results.hidden = true; error.hidden = true;
    const nodes: Record<string, Control> = { '#fossil-form': form, '#fossil-from': from, '#fossil-to': to, '#fossil-status': status,
      '#fossil-next': next, '#fossil-error': error, '#fossil-progress': progress, '.fossil-results': results };
    Object.assign(form, { querySelector: () => apply });
    const doc = Object.assign(new EventTarget(), { hidden: false, documentElement: {}, defaultView: new EventTarget() });
    const main = { id: 'page-content', innerHTML: '', isConnected: true, hidden: false, inert: false, ancestorHidden: false, hasForm: true,
      ownerDocument: doc, querySelector: (selector: string) => nodes[selector], contains: () => main.hasForm,
      closest: () => main.hidden || main.inert || main.ancestorHidden ? main : null };
    const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn(); disconnect = vi.fn(); constructor(callback: () => void) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
    });
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(resolve => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const cleanup = mountFossilRecord(main as unknown as HTMLElement, '');
    return { main, doc, form, error, progress, results, fetcher, cleanup, observers,
      submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      mutate: () => observers.forEach(observer => observer.callback()), resolve: (response: Response) => resolveResponse(response) };
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(['hidden', 'inert', 'ancestorHidden'] as const)('blocks requests and aborts in-flight work when a cached view becomes %s', async property => {
    const item = fixture();
    try {
      expect(item.fetcher).not.toHaveBeenCalled();
      item.submit(); expect(item.fetcher).toHaveBeenCalledTimes(1);
      const signal = item.fetcher.mock.calls[0]![1].signal!;
      item.main[property] = true; item.mutate();
      expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
      item.submit(); expect(item.fetcher).toHaveBeenCalledTimes(1);
      item.resolve(new Response('{}', { status: 503 })); await vi.advanceTimersByTimeAsync(0);
      expect(item.error.hidden).toBe(true); expect(item.results.hidden).toBe(true);
      item.main[property] = false; item.mutate(); item.submit(); expect(item.fetcher).toHaveBeenCalledTimes(2);
    } finally { item.cleanup(); }
  });
  it('blocks hidden-document requests and suppresses late completions even before observer delivery', async () => {
    const item = fixture();
    try {
      item.doc.hidden = true; item.submit(); expect(item.fetcher).not.toHaveBeenCalled();
      item.doc.hidden = false; item.submit(); expect(item.fetcher).toHaveBeenCalledTimes(1);
      item.main.hidden = true; item.resolve(new Response('{}', { status: 503 })); await vi.advanceTimersByTimeAsync(0);
      expect(item.error.hidden).toBe(true); expect(item.results.hidden).toBe(true);
      item.main.hidden = false; item.submit();
      const signal = item.fetcher.mock.calls[1]![1].signal!;
      item.doc.hidden = true; item.doc.dispatchEvent(new Event('visibilitychange'));
      expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
      item.doc.hidden = false; item.doc.dispatchEvent(new Event('visibilitychange'));
      expect(item.fetcher).toHaveBeenCalledTimes(2);
    } finally { item.cleanup(); }
  });
  it('returns an idempotent root cleanup that removes handlers and clears pending work', async () => {
    const item = fixture(); item.submit();
    const signal = item.fetcher.mock.calls[0]![1].signal!;
    item.cleanup(); item.cleanup();
    expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(item.observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    item.submit(); expect(item.fetcher).toHaveBeenCalledTimes(1);
    item.resolve(new Response('{}', { status: 503 })); await vi.advanceTimersByTimeAsync(0);
    expect(item.error.hidden).toBe(true); expect(item.results.hidden).toBe(true);
  });
  it.each(['id', 'isConnected', 'hasForm'] as const)('disposes on cached navigation or removal through %s', property => {
    const item = fixture();
    try {
      item.submit(); const signal = item.fetcher.mock.calls[0]![1].signal!;
      if (property === 'id') item.main.id = 'cached-page'; else item.main[property] = false;
      item.mutate(); expect(signal.aborted).toBe(true); expect(item.observers[0]!.disconnect).toHaveBeenCalledTimes(1);
      item.main.id = 'page-content'; item.main.isConnected = true; item.main.hasForm = true; item.submit();
      expect(item.fetcher).toHaveBeenCalledTimes(1);
    } finally { item.cleanup(); }
  });
});
