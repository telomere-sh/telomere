import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Problem } from '../src/common.js';
import { FinancialHistory, type FinancialFact, type FinancialHistorySource, type FinancialScan } from '../src/updates/financial-history.js';
import { ACCOUNTING_COLUMNS, accountingCompletionRow, accountingCsvCell, createAccountingRoutes, type AccountingHistory } from '../src/updates/accounting.js';
import { ACCOUNTING_MONTHS, accountingMonthLabel, mountAccounting } from '../public/updates/accounting.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'a'.repeat(64);
function fact(index = 1, overrides: Partial<FinancialFact> = {}): FinancialFact {
  return { runId: '0x' + index.toString(16).padStart(64, '0'), payer: OWNER, transactionHash: HASH, blockNumber: '100', blockHash: HASH,
    openedAt: '2026-10-31T23:59:00.000Z', returnedAt: '2026-11-01T00:01:00.000Z', receiptHash: HASH,
    kind: 'settlement', outcome: 'completed', charged: '3', returned: '7', ceiling: '10', billableSeconds: 3,
    pricePerSecond: '1', hardware: 'CPU', lane: null, ...overrides };
}
function scan(verified = 1): FinancialScan {
  return { generation: 'generation-1', startedAt: '2026-11-13T00:00:00.000Z', asOf: '2026-11-13T00:00:00.000Z',
    state: verified ? 'ready' : 'no_data', anchor: { height: '100', hash: HASH }, candidates: verified, visited: verified,
    verified, excluded: 0, complete: true, notes: [], refunds: {} as FinancialScan['refunds'] };
}
function fakeHistory(rows: FinancialFact[]) {
  let current = scan(rows.length), canonical = true, read = 0, closed = false;
  const history: AccountingHistory = {
    source: { scope: 'fixture scope', chainId: 1, token: OWNER, escrow: OTHER,
      canonical: async () => canonical, anchor: async () => ({ height: '100', hash: HASH }),
      count: async () => rows.length, page: async () => [], verify: async () => null,
      save: async () => undefined, facts: async () => [] },
    snapshot: async () => structuredClone(current),
    async *facts() { try { for (const row of rows) { ++read; yield row; } } finally { closed = true; } },
  };
  return { history, setScan: (next: FinancialScan) => { current = next; }, reorg: () => { canonical = false; },
    get read() { return read; }, get closed() { return closed; } };
}
function app(history: AccountingHistory, owner = OWNER) {
  const server = new Hono();
  server.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : 422));
  server.route('/api/insights', createAccountingRoutes(history, async context => {
    if (context.req.header('cookie') !== 'session=valid') throw new Problem(401, 'authentication_required', 'Sign in.');
    const expected = context.req.header('X-Telomere-Owner');
    if (expected && expected.toLowerCase() !== owner.toLowerCase()) throw new Problem(409, 'session_owner_changed', 'Session changed.');
    return owner;
  }));
  return server;
}
const headers = { Cookie: 'session=valid', 'X-Telomere-Owner': OWNER };
function get(server: Hono, path = '/accounting?month=2026-11') { return server.request('/api/insights' + path, { headers }); }
async function csv(server: Hono) { return get(server, '/accounting.csv?month=2026-11'); }

describe('owner accounting monthly report', () => {
  it('requires signed session and rejects owner query parameters and session mismatch', async () => {
    const server = app(fakeHistory([fact()]).history);
    expect((await server.request('/api/insights/accounting?month=2026-11')).status).toBe(401);
    expect((await get(server, `/accounting?month=2026-11&owner=${OTHER}`)).status).toBe(422);
    expect((await server.request('/api/insights/accounting?month=2026-11', { headers: { ...headers, 'X-Telomere-Owner': OTHER } })).status).toBe(409);
  });
  it.each(['2026-00', '2026-13', '2026-1', '0000-01', '2026-11-01', '2026-11Z', '', '2026-11&month=2026-10'])('rejects invalid or ambiguous month %s', async month => {
    expect((await get(app(fakeHistory([]).history), '/accounting?month=' + month)).status).toBe(422);
  });
  it('uses UTC return timestamps, never reservation timestamps, for month attribution', async () => {
    const rows = [fact(1), fact(2, { returnedAt: '2026-12-01T00:00:00.000Z' }),
      fact(3, { openedAt: '2026-10-01T00:00:00.000Z', returnedAt: '2026-10-31T23:59:59.999Z' })];
    const response = await get(app(fakeHistory(rows).history));
    expect(await response.json()).toMatchObject({ state: 'ready', totals: { records: '1', chargedAtomic: '3' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('retains exact huge atomic values and separates timeout refunds', async () => {
    const charged = 900719925474099312345678901234n, returned = 123456789123456789n;
    const rows = [fact(1, { charged: charged.toString(), returned: returned.toString(), ceiling: (charged + returned).toString() }),
      fact(2, { kind: 'timeout_refund', outcome: 'timed_out', charged: '0', returned: '1000001', ceiling: '1000001', billableSeconds: 0 })];
    expect(await (await get(app(fakeHistory(rows).history))).json()).toMatchObject({ totals: {
      records: '2', settlements: '1', timeoutRefunds: '1', chargedAtomic: charged.toString(), chargedUsdc: '900719925474099312345678.901234',
      returnedAtomic: (returned + 1000001n).toString(), timeoutReturnedAtomic: '1000001', timeoutReturnedUsdc: '1.000001',
    } });
  });
  it('defends against another-owner records even when the source filter is faulty', async () => {
    const rows = [fact(), fact(2, { payer: OTHER, runId: 'PRIVATE_OTHER_OWNER_RUN', charged: 'secret' })];
    const server = app(fakeHistory(rows).history);
    expect(await (await get(server)).json()).toMatchObject({ totals: { records: '1', chargedAtomic: '3' } });
    const output = await (await csv(server)).text();
    expect(output).not.toContain('PRIVATE_OTHER_OWNER_RUN'); expect(output).not.toContain(OTHER); expect(output).not.toContain('secret');
  });
  it('distinguishes complete empty source from missing, partial and failed evidence', async () => {
    expect(await (await get(app(fakeHistory([]).history))).json()).toMatchObject({ state: 'no_data', coverage: { complete: true }, totals: { records: '0', chargedAtomic: '0' } });
    for (const state of ['partial', 'unavailable'] as const) {
      const fixture = fakeHistory([]); fixture.setScan({ ...scan(0), state, complete: false });
      const response = await get(app(fixture.history));
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ totals: null, coverage: { complete: false } });
      expect((await csv(app(fixture.history))).status).toBe(503);
    }
    const fixture = fakeHistory([fact()]); fixture.history.source.canonical = async () => { throw new Error('RPC unreachable'); };
    expect((await get(app(fixture.history))).status).toBe(503);
  });
  it('invalid facts do not become certified zero or partial totals', async () => {
    const server = app(fakeHistory([fact(1, { charged: 'NaN' })]).history);
    const response = await get(server);
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ totals: null });
    const exportResponse = await csv(server); await expect(exportResponse.text()).rejects.toThrow('did not complete');
  });
});

describe('complete streaming accounting CSV', () => {
  it('streams more than 2000 facts through real 25-record pages without a total cap', async () => {
    const rows = Array.from({ length: 2057 }, (_, index) => fact(index + 1));
    const pageSizes: number[] = [];
    const source: FinancialHistorySource = {
      scope: 'fixture', chainId: 1, token: OWNER, escrow: OTHER,
      anchor: async () => ({ height: '100', hash: HASH }), canonical: async () => true,
      count: async () => rows.length, page: async () => [], verify: async () => null, save: async () => undefined,
      async facts(_generation, after, owner) {
        expect(owner).toBe(OWNER);
        const page = rows.filter(row => !after || row.runId > after).slice(0, 25); pageSizes.push(page.length); return page;
      },
    };
    // Seed only the completed scan; the tested fact iterator is the production implementation.
    const history = new FinancialHistory(source, () => Date.parse('2026-11-13T00:00:00Z'), 1_000_000);
    Object.assign(history, { scan: scan(rows.length), checkedAt: Date.parse('2026-11-13T00:00:00Z') });
    const server = app(history);
    const response = await csv(server); const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191]);
    const output = new TextDecoder().decode(bytes);
    expect(output.split('\r\n')).toHaveLength(2060); // header + facts + coverage + trailing newline
    expect(output.replaceAll('\r\n', '')).not.toContain('\n');
    expect(output).toContain(`"${rows.at(-1)!.runId}"`);
    expect(output.endsWith(accountingCompletionRow(response.headers.get('X-Telomere-Export-Generation')!, response.headers.get('X-Telomere-Export-Completion')!))).toBe(true);
    expect(pageSizes.length).toBeGreaterThan(80); expect(Math.max(...pageSizes)).toBe(25);
    expect(await (await get(server)).json()).toMatchObject({ totals: { records: '2057', chargedAtomic: '6171' } });
  });
  it('quotes Unicode and formulas and leaves unknown execution fields blank', async () => {
    const response = await csv(app(fakeHistory([fact(1, { runId: '=SUM(1,2)"\n東京' })]).history));
    const output = await response.text();
    expect(output).toContain('"\'=SUM(1,2)""\n東京"');
    expect(output).toContain(',"","CPU","","","","3","0.000003","0.000007","completed","2026-10-31T23:59:00.000Z","2026-11-01T00:01:00.000Z","settlement",');
    expect(ACCOUNTING_COLUMNS.slice(0, 10)).toEqual(['run_id', 'host_id', 'hw_class', 'lane', 'started_at', 'stopped_at', 'billable_seconds', 'amount_usdc', 'refund_usdc', 'stop_reason']);
    for (const formula of ['=A1', '+A1', '-A1', '@A1', '  =A1', '\tA1', '\rA1', '\nA1']) expect(accountingCsvCell(formula).startsWith('"\'')).toBe(true);
  });
  it('refuses completion after generation changes or reorgs during streaming', async () => {
    for (const mutation of ['generation', 'reorg'] as const) {
      const fixture = fakeHistory([fact()]);
      const response = await csv(app(fixture.history)); const reader = response.body!.getReader();
      await reader.read(); await reader.read();
      if (mutation === 'generation') fixture.setScan({ ...scan(), generation: 'generation-2' }); else fixture.reorg();
      await expect(reader.read()).rejects.toThrow('did not complete');
    }
  });
  it('does not certify changed-generation monthly summaries', async () => {
    const fixture = fakeHistory([fact()]);
    const snapshot = vi.spyOn(fixture.history, 'snapshot');
    snapshot.mockResolvedValueOnce(scan()).mockResolvedValueOnce({ ...scan(), generation: 'generation-2' });
    const response = await get(app(fixture.history));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ totals: null });
  });
  it('cancels without draining the history or generating a completion record', async () => {
    const fixture = fakeHistory(Array.from({ length: 3000 }, (_, index) => fact(index + 1)));
    const response = await csv(app(fixture.history)), reader = response.body!.getReader();
    expect(fixture.read).toBe(0);
    await reader.read(); expect(fixture.read).toBe(0); // BOM/header alone
    await reader.read(); expect(fixture.read).toBe(1);
    await reader.cancel(); expect(fixture.closed).toBe(true); expect(fixture.read).toBe(1);
  });
  it('aborts a request before fetching any private facts', async () => {
    const fixture = fakeHistory([fact()]); const abort = new AbortController();
    const response = await app(fixture.history).request('/api/insights/accounting.csv?month=2026-11', { headers, signal: abort.signal });
    abort.abort(); await expect(response.text()).rejects.toThrow('did not complete'); expect(fixture.read).toBe(0);
  });
});

// Lifecycle fixture exercises the mounted reader without a browser dependency or parsing remote HTML.
class AccountingElement {
  children: AccountingElement[] = []; listeners = new Map<string, (event: unknown) => void>();
  attributes = new Map<string, string>(); hidden = false; disabled = false; inert = false; isConnected = true;
  className = ''; id = ''; href = ''; download = ''; dateTime = ''; value = ''; textContent = ''; html = '';
  parentNode = undefined;
  constructor(readonly ownerDocument: AccountingDocument, readonly tagName: string) {}
  set innerHTML(value: string) { this.html = value; }
  append(...children: AccountingElement[]): void { this.children.push(...children); }
  replaceChildren(...children: AccountingElement[]): void { this.children = children; }
  querySelector(selector: string): AccountingElement | undefined { return this.ownerDocument.elements.get(selector); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, callback: (event: unknown) => void): void { this.listeners.set(name, callback); }
  removeEventListener(name: string): void { this.listeners.delete(name); }
  flat(): AccountingElement[] { return [this, ...this.children.flatMap(child => child.flat())]; }
}
class AccountingDocument {
  hidden = false; elements = new Map<string, AccountingElement>(); listeners = new Map<string, () => void>();
  constructor() {
    for (const [selector, tag] of [['.accounting-controls', 'form'], ['#accounting-month', 'select'], ['#accounting-year', 'input'],
      ['button[type="submit"]', 'button'], ['.accounting-export', 'button'], ['.accounting-error', 'p'], ['.accounting-progress', 'p'],
      ['.accounting-results', 'section'], ['.accounting-download', 'div']]) this.elements.set(selector!, new AccountingElement(this, tag!));
  }
  createElement(tag: string): AccountingElement { return new AccountingElement(this, tag); }
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(name: string): void { this.listeners.delete(name); }
  get(selector: string): AccountingElement { return this.elements.get(selector)!; }
}
class AccountingChannel {
  static instances: AccountingChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null; closed = false;
  constructor(readonly name: string) { AccountingChannel.instances.push(this); }
  close(): void { this.closed = true; }
  deliver(data: unknown): void { this.onmessage?.({ data }); }
}
function mountedAccounting() {
  AccountingChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', AccountingChannel);
  vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
  const doc = new AccountingDocument(), main = new AccountingElement(doc, 'main');
  const cleanup = mountAccounting(main as unknown as HTMLElement, '<h1>Accounting</h1>');
  doc.get('#accounting-year').value = '2026'; doc.get('#accounting-month').value = '11';
  return { doc, main, cleanup, channel: AccountingChannel.instances[0]!,
    submit: () => doc.get('.accounting-controls').listeners.get('submit')?.({ preventDefault() {} }),
    export: () => doc.get('.accounting-export').listeners.get('click')?.({ preventDefault() {} }) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('accounting English month and session invalidation', () => {
  it('uses explicit English months and four-digit year entry without a fixed history cutoff', () => {
    const ui = mountedAccounting();
    expect(ACCOUNTING_MONTHS).toEqual(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
    expect(ui.main.html).toContain('<select id="accounting-month"'); expect(ui.main.html).toContain('<option value="11">November</option>');
    expect(ui.main.html).not.toContain('type="month"'); expect(ui.main.html).toContain('name="year" type="text"');
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('Locale formatting should not be used'); });
    expect(accountingMonthLabel('2026-11')).toBe('November 2026');
    expect(accountingMonthLabel('0001-01')).toBe('January 0001'); expect(accountingMonthLabel('9999-12')).toBe('December 9999');
    expect(() => accountingMonthLabel('0000-01')).toThrow(); ui.cleanup();
  });
  it.each([{ owner: OTHER }, { owner: null }, { owner: OWNER }])('clears rendered private totals and prepared CSV on Workspace event %j', async message => {
    const server = app(fakeHistory([fact()]).history);
    const fetcher = vi.fn(async (url: string) => url === '/api/me'
      ? new Response(JSON.stringify({ address: OWNER }), { headers: { 'Content-Type': 'application/json' } })
      : server.request(url, { headers }));
    vi.stubGlobal('fetch', fetcher);
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-accounting');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const ui = mountedAccounting(); ui.submit();
    await vi.waitFor(() => expect(ui.doc.get('.accounting-export').disabled).toBe(false));
    expect(ui.doc.get('.accounting-results').flat().some(element => element.textContent === 'November 2026')).toBe(true);
    ui.export(); await vi.waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
    expect(ui.doc.get('.accounting-download').children.length).toBeGreaterThan(0);
    ui.channel.deliver(message);
    expect(ui.doc.get('.accounting-results').children).toEqual([]); expect(ui.doc.get('.accounting-results').hidden).toBe(true);
    expect(ui.doc.get('.accounting-download').children).toEqual([]); expect(ui.doc.get('.accounting-download').hidden).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:private-accounting'); expect(ui.doc.get('.accounting-export').disabled).toBe(true);
    const calls = fetcher.mock.calls.length; ui.export(); await Promise.resolve(); expect(fetcher).toHaveBeenCalledTimes(calls);
    ui.cleanup(); expect(ui.channel.name).toBe('telomere-wallet-session-v1'); expect(ui.channel.closed).toBe(true); expect(ui.channel.onmessage).toBeNull();
  });
  it('aborts pending reads and prevents a late prior-session response from repopulating private DOM', async () => {
    let resolveMe: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(resolve => { resolveMe = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const ui = mountedAccounting(); ui.submit();
    expect(fetcher).toHaveBeenCalledOnce();
    const signal = fetcher.mock.calls[0]![1].signal!;
    expect(signal.aborted).toBe(false); ui.channel.deliver({ owner: null }); expect(signal.aborted).toBe(true);
    resolveMe!(new Response(JSON.stringify({ address: OWNER })));
    await vi.waitFor(() => expect(ui.doc.get('button[type="submit"]').disabled).toBe(false));
    await Promise.resolve(); await Promise.resolve();
    expect(fetcher).toHaveBeenCalledOnce(); expect(ui.doc.get('.accounting-results').children).toEqual([]);
    expect(ui.doc.get('.accounting-export').disabled).toBe(true); ui.cleanup();
  });
});
