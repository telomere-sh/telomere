const ENDPOINT = '/api/public/insights/prices';
const POLL_MS = 60_000;
const TIMEOUT_MS = 30_000;
const HARDWARE = ['CPU', 'RTX', 'A100', 'H100', 'H200', 'B200'] as const;
const STATES = ['ready', 'no_data', 'partial', 'unavailable'] as const;
type State = typeof STATES[number];
type Rational = { numerator: string; denominator: '1' | '2' };
type Row = { hardware: string; profile: 'operator-signed-cpu' | null; lane: null; state: State;
  sampleCount: string | null; p10Atomic: string | null; medianAtomic: Rational | null; p90Atomic: string | null };
type Report = { state: State; reason: string; period: string; asOf: string | null; periodStartsAt: string | null;
  periodEndsAt: string | null; source: { scope: string; chainId: number; token: string; escrow: string };
  coverage: { complete: boolean; candidates: number | null; verified: number | null; excluded: number | null;
    scope: string; notes: string[] }; rows: Row[] };
const mounted = new WeakMap<HTMLElement, () => void>();
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function atomic(value: unknown): value is string { return typeof value === 'string' && /^\d{1,101}$/.test(value); }
function state(value: unknown): value is State { return STATES.some(item => item === value); }
function time(value: unknown): value is string | null { return value === null || typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function count(value: unknown): value is number | null { return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function short(value: unknown): value is string { return typeof value === 'string' && value.length <= 2000; }

function readReport(value: unknown, period: string): Report {
  const bad = (): never => { throw new Error('The price board returned an unexpected report. Refresh to retry.'); };
  if (!object(value) || !state(value['state']) || !short(value['reason']) || value['period'] !== period
    || !time(value['asOf']) || !time(value['periodStartsAt']) || !time(value['periodEndsAt'])
    || value['tokenDecimals'] !== 6 || value['unit'] !== 'USDC per billable second') return bad();
  const source = value['source'], coverage = value['coverage'];
  if (!object(source) || !short(source['scope']) || typeof source['chainId'] !== 'number'
    || !Number.isSafeInteger(source['chainId']) || source['chainId'] <= 0 || !short(source['token']) || !short(source['escrow'])
    || !object(coverage) || typeof coverage['complete'] !== 'boolean' || !short(coverage['scope'])
    || !count(coverage['candidates']) || !count(coverage['verified']) || !count(coverage['excluded'])
    || !Array.isArray(coverage['notes']) || coverage['notes'].length > 100 || !coverage['notes'].every(short)
    || !Array.isArray(value['rows']) || value['rows'].length !== HARDWARE.length) return bad();
  const rows: Row[] = value['rows'].map((row: unknown, index: number) => {
    if (!object(row) || row['hardware'] !== HARDWARE[index] || row['lane'] !== null || !state(row['state'])
      || row['profile'] !== (index === 0 ? 'operator-signed-cpu' : null)
      || !(row['sampleCount'] === null || atomic(row['sampleCount']))) return bad();
    const p10 = row['p10Atomic'], p90 = row['p90Atomic'], median = row['medianAtomic'];
    let exact: Rational | null = null;
    if (row['state'] === 'ready') {
      if (!atomic(row['sampleCount']) || BigInt(row['sampleCount']) <= 0n || !atomic(p10) || !atomic(p90)
        || !object(median) || !atomic(median['numerator']) || !['1', '2'].includes(String(median['denominator']))) return bad();
      const denominator = median['denominator'];
      if (denominator !== '1' && denominator !== '2') return bad();
      exact = { numerator: median['numerator'], denominator };
      if (BigInt(p10) * BigInt(denominator) > BigInt(exact.numerator)
        || BigInt(exact.numerator) > BigInt(p90) * BigInt(denominator)) return bad();
    } else if (p10 !== null || p90 !== null || median !== null) return bad();
    if (index > 0 && (row['state'] !== 'no_data' || row['sampleCount'] !== '0')) return bad();
    if (row['state'] === 'no_data' && row['sampleCount'] !== '0') return bad();
    if (['partial', 'unavailable'].includes(row['state']) && row['sampleCount'] !== null) return bad();
    return { hardware: HARDWARE[index]!, profile: index === 0 ? 'operator-signed-cpu' : null, lane: null,
      state: row['state'], sampleCount: row['sampleCount'], p10Atomic: atomic(p10) ? p10 : null,
      medianAtomic: exact, p90Atomic: atomic(p90) ? p90 : null };
  });
  if (rows[0]?.state !== value['state'] || ['ready', 'no_data'].includes(value['state'])
    && (!coverage['complete'] || value['asOf'] === null || value['periodStartsAt'] === null || value['periodEndsAt'] === null)) return bad();
  // The checked fields form the public display contract; unused metadata is never rendered.
  return { state: value['state'], reason: value['reason'], period, asOf: value['asOf'],
    periodStartsAt: value['periodStartsAt'], periodEndsAt: value['periodEndsAt'],
    source: { scope: source['scope'], chainId: source['chainId'], token: source['token'], escrow: source['escrow'] },
    coverage: { complete: coverage['complete'], candidates: coverage['candidates'],
      verified: coverage['verified'], excluded: coverage['excluded'],
      scope: coverage['scope'], notes: coverage['notes'] }, rows };
}

/** Six token decimals plus one exact half-atomic median digit. */
export function formatSettledPrice(value: Rational): string {
  const scaled = BigInt(value.numerator) * (value.denominator === '2' ? 5n : 10n);
  const fraction = (scaled % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return `${scaled / 10_000_000n}${fraction ? `.${fraction}` : ''}`;
}
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = content; if (className) element.className = className; return element;
}
const LABELS: Record<State, string> = { ready: 'Ready', no_data: 'No data', partial: 'Partial — history refreshing', unavailable: 'Unavailable' };
function render(target: HTMLElement, report: Report): void {
  const doc = target.ownerDocument; target.replaceChildren(); target.dataset['state'] = report.state;
  target.append(text(doc, 'h3', LABELS[report.state]), text(doc, 'p', report.reason));
  const meta = doc.createElement('dl'); meta.className = 'price-board-meta';
  for (const [label, value] of [ ['Source', report.source.scope], ['Actual scope', report.coverage.scope],
    ['Coverage', `${report.coverage.complete ? 'Complete' : 'Incomplete'}; ${report.coverage.verified ?? 'unknown'} verified / ${report.coverage.candidates ?? 'unknown'} candidates; ${report.coverage.excluded ?? 'unknown'} excluded`],
    ['Chain ID', String(report.source.chainId)], ['Token', report.source.token], ['Escrow', report.source.escrow] ]) {
    const item = doc.createElement('div'); item.append(text(doc, 'dt', label!), text(doc, 'dd', value!)); meta.append(item);
  }
  for (const [label, value] of [['As of (UTC)', report.asOf], ['Period starts (UTC)', report.periodStartsAt], ['Period ends (UTC)', report.periodEndsAt]]) {
    const item = doc.createElement('div'), detail = doc.createElement('dd');
    if (value) { const stamp = text(doc, 'time', new Date(value).toISOString()); stamp.dateTime = value; detail.append(stamp); }
    else detail.textContent = 'Unavailable'; item.append(text(doc, 'dt', label!), detail); meta.append(item);
  }
  target.append(meta);
  const wrap = doc.createElement('div'); wrap.className = 'price-board-table'; wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Settled price table; scroll horizontally for more columns');
  const table = doc.createElement('table'); table.className = 'spec-table'; table.append(text(doc, 'caption', 'Recorded USDC per billable second'));
  const head = doc.createElement('thead'), header = doc.createElement('tr');
  for (const label of ['Hardware / profile', 'Recorded lane', 'Status', 'Settled samples', 'P10', 'Median', 'P90']) {
    const cell = text(doc, 'th', label); cell.scope = 'col'; header.append(cell);
  }
  head.append(header); table.append(head); const body = doc.createElement('tbody');
  for (const row of report.rows) {
    const line = doc.createElement('tr'), name = text(doc, 'th', row.hardware + (row.profile ? ` / ${row.profile}` : ''));
    name.scope = 'row'; line.append(name);
    const formatted = (amount: string | null): string => amount === null ? 'No data' : formatSettledPrice({ numerator: amount, denominator: '1' });
    for (const value of ['Unknown', LABELS[row.state], row.sampleCount ?? 'Unknown', formatted(row.p10Atomic),
      row.medianAtomic ? formatSettledPrice(row.medianAtomic) : 'No data', formatted(row.p90Atomic)]) line.append(text(doc, 'td', value));
    body.append(line);
  }
  table.append(body); wrap.append(table); target.append(wrap);
  target.append(text(doc, 'p', 'Method: one sample per verified settlement with positive billable seconds and an actual recorded CPU price. P10 and P90 use nearest rank. Median is the exact middle value or mean of the two middle values. Period bounds include both endpoints, using settlement returned time. Prices are not inferred from charged totals; fixed-price inference and current offers are excluded.'));
  for (const note of report.coverage.notes) target.append(text(doc, 'p', note));
}

/** The caller should retain the cleanup callback for SPA navigation, including cached pages. */
export function mountPrices(main: HTMLElement, heroHtml: string): () => void {
  mounted.get(main)?.();
  main.innerHTML = heroHtml + `<section class="section price-board" aria-labelledby="price-board-title"><div class="section-top"><div><div class="eyebrow">Actual settled prices</div><h2 id="price-board-title">Read the recorded price.</h2></div><p>Historical settlement samples from confirmed operator records. GPU prices and current offers are not supplied by this source.</p></div><form class="inline-form"><label class="field"><span>Settlement period</span><select name="period" aria-describedby="price-board-progress"><option value="1h">Last hour</option><option value="24h" selected>Last 24 hours</option><option value="7d">Last 7 days</option></select></label><button type="submit" class="pill primary">Refresh prices <span aria-hidden="true">↗</span></button><p id="price-board-error" role="alert" hidden></p><p id="price-board-progress" role="status" aria-live="polite"></p></form><div class="price-board-results"></div></section>`;
  const section = main.querySelector<HTMLElement>('.price-board')!, form = section.querySelector<HTMLFormElement>('form')!;
  const select = form.querySelector<HTMLSelectElement>('select')!, button = form.querySelector<HTMLButtonElement>('button')!;
  const error = form.querySelector<HTMLElement>('#price-board-error')!, progress = form.querySelector<HTMLElement>('#price-board-progress')!;
  const results = section.querySelector<HTMLElement>('.price-board-results')!, doc = main.ownerDocument;
  let disposed = false, terminalEndpoint = false, inFlight: AbortController | null = null, poll: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => { clearTimeout(poll); poll = undefined; inFlight?.abort(); };
  const schedule = (): void => { if (!disposed && !terminalEndpoint && !doc.hidden) poll = setTimeout(() => { void load(); }, POLL_MS); };
  const load = async (): Promise<void> => {
    if (disposed || terminalEndpoint || doc.hidden || inFlight) return;
    clearTimeout(poll); poll = undefined;
    const controller = new AbortController(); inFlight = controller; const period = select.value;
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    error.hidden = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
    progress.textContent = 'Loading confirmed settlement prices…'; results.replaceChildren(); results.dataset['state'] = 'loading';
    let failureState: 'unavailable' | 'not_enabled' | 'not_configured' = 'unavailable';
    try {
      const response = await fetch(`${ENDPOINT}?period=${encodeURIComponent(period)}`, { credentials: 'omit', cache: 'no-store',
        redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (disposed || doc.hidden || controller.signal.aborted || select.value !== period) return;
      // OFF is terminal for automatic polling, including hidden/visible transitions.
      if (response.status === 404) {
        terminalEndpoint = true; failureState = 'not_enabled';
        throw new Error('The price board is not enabled. Automatic refresh is paused. Refresh prices after the feature is enabled.');
      }
      const value: unknown = await response.json();
      if (disposed || doc.hidden || controller.signal.aborted || select.value !== period) return;
      if (object(value)) {
        const code = object(value['error']) ? value['error']['code'] : value['error'];
        if ([value['state'], value['code'], code].includes('not_configured')) {
          terminalEndpoint = true; failureState = 'not_configured';
          throw new Error('The settled price source is not configured. Automatic refresh is paused. Refresh prices after configuration is restored.');
        }
        if ([value['state'], value['code'], code].includes('not_enabled')) {
          terminalEndpoint = true; failureState = 'not_enabled';
          throw new Error('The price board is not enabled. Automatic refresh is paused. Refresh prices after the feature is enabled.');
        }
      }
      if (!response.ok) throw new Error(`Prices returned HTTP ${response.status}. Refresh to retry.`);
      const report = readReport(value, period);
      render(results, report); progress.textContent = `${LABELS[report.state]}. Refreshes every 60 seconds while this page is visible.`;
    } catch (failure: unknown) {
      if (!disposed && !doc.hidden && select.value === period) {
        error.textContent = controller.signal.aborted ? 'The price request timed out. Refresh to retry.'
          : failure instanceof Error ? failure.message : 'Prices are unavailable. Refresh to retry.';
        error.hidden = false; results.dataset['state'] = failureState;
        progress.textContent = failureState === 'not_configured' ? 'Price source not configured. Automatic refresh paused.'
          : failureState === 'not_enabled' ? 'Price board not enabled. Automatic refresh paused.' : 'Price evidence unavailable.';
      }
    } finally {
      clearTimeout(timeout); inFlight = null; button.disabled = false; button.removeAttribute('aria-busy'); schedule();
    }
  };
  const submit = (event: Event): void => { event.preventDefault(); terminalEndpoint = false; void load(); };
  const change = (): void => { stop(); terminalEndpoint = false; results.replaceChildren(); error.hidden = true; progress.textContent = 'Period changed. Refresh prices to load this period.'; };
  const visibility = (): void => { if (doc.hidden) stop(); else void load(); };
  form.addEventListener('submit', submit); select.addEventListener('change', change); doc.addEventListener('visibilitychange', visibility);
  const observer = new MutationObserver(() => { if (!main.contains(section)) cleanup(); });
  const cleanup = (): void => {
    if (disposed) return; disposed = true; stop(); observer.disconnect();
    form.removeEventListener('submit', submit); select.removeEventListener('change', change); doc.removeEventListener('visibilitychange', visibility);
    mounted.delete(main);
  };
  observer.observe(main, { childList: true }); mounted.set(main, cleanup); void load(); return cleanup;
}
