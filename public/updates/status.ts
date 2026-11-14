const ENDPOINT = '/api/public/status';
const POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const COMPONENTS = ['website', 'chain', 'controller', 'receipts', 'explorer', 'pricing'] as const;
const STATES = ['ready', 'degraded', 'unavailable', 'not_configured', 'unknown'] as const;
const CODES = ['ok', 'degraded', 'unavailable', 'not_configured', 'unknown', 'probe_failed', 'timeout', 'pending', 'invalid_result', 'stale'] as const;
type State = typeof STATES[number];
type Component = typeof COMPONENTS[number];
type Row = { id: Component; state: State; code: typeof CODES[number]; checkedAt: string; asOf: string | null;
  source: 'local_server_probe'; latencyMs: number | null; stale: boolean };
type Report = { state: State; checkedAt: string; asOf: string | null; stale: boolean; components: Row[] };
const NAMES: Record<Component, string> = { website: 'Website entry', chain: 'Configured chain connection', controller: 'Controller worker',
  receipts: 'Receipt service', explorer: 'Explorer source', pricing: 'Pricing source' };
const LABELS: Record<State, string> = { ready: 'Ready', degraded: 'Degraded', unavailable: 'Unavailable', not_configured: 'Not configured', unknown: 'Unknown' };
const CODE_COPY: Record<typeof CODES[number], string> = { ok: 'Check passed', degraded: 'Check reports degraded service',
  unavailable: 'Check reports unavailable service', not_configured: 'No check configured', unknown: 'Check state unknown',
  probe_failed: 'Check failed', timeout: 'Check deadline exceeded', pending: 'Earlier check is still pending', invalid_result: 'Unexpected check result', stale: 'Evidence is stale' };
const mounted = new WeakMap<HTMLElement, () => void>();
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function time(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function readReport(value: unknown): Report {
  const bad = (): never => { throw new Error('The status source returned an unexpected report. Refresh to retry.'); };
  if (!object(value) || !STATES.includes(value['state'] as State) || !time(value['checkedAt'])
    || !(value['asOf'] === null || time(value['asOf'])) || typeof value['stale'] !== 'boolean'
    || value['source'] !== 'local_server_probes' || value['refreshAfterMs'] !== POLL_MS
    || !Array.isArray(value['components']) || value['components'].length !== COMPONENTS.length) return bad();
  const components = value['components'].map((row: unknown, index: number): Row => {
    if (!object(row) || row['id'] !== COMPONENTS[index] || !STATES.includes(row['state'] as State)
      || !CODES.includes(row['code'] as typeof CODES[number]) || !time(row['checkedAt'])
      || !(row['asOf'] === null || time(row['asOf'])) || row['source'] !== 'local_server_probe'
      || typeof row['stale'] !== 'boolean' || !(row['latencyMs'] === null || typeof row['latencyMs'] === 'number'
        && Number.isSafeInteger(row['latencyMs']) && row['latencyMs'] >= 0 && row['latencyMs'] <= 5_000)
      || row['state'] === 'ready' && (row['stale'] || row['asOf'] === null || row['code'] !== 'ok')) return bad();
    return { id: COMPONENTS[index]!, state: row['state'] as State, code: row['code'] as typeof CODES[number],
      checkedAt: row['checkedAt'], asOf: row['asOf'], source: 'local_server_probe', stale: row['stale'], latencyMs: row['latencyMs'] };
  });
  const configured = components.filter(row => row.state !== 'not_configured');
  const expected: State = configured.length === 0 ? 'not_configured'
    : configured.every(row => row.state === 'ready' && !row.stale) ? 'ready'
    : configured.every(row => row.state === 'unavailable') ? 'unavailable'
    : configured.every(row => row.state === 'unknown') ? 'unknown' : 'degraded';
  if (value['state'] !== expected || value['stale'] !== components.some(row => row.stale)) return bad();
  return { state: value['state'] as State, checkedAt: value['checkedAt'], asOf: value['asOf'], stale: value['stale'], components };
}
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = value; if (className) element.className = className; return element;
}
function stamp(doc: Document, value: string | null): HTMLElement {
  if (value === null) return text(doc, 'span', 'No evidence');
  const element = text(doc, 'time', new Date(value).toISOString()); element.dateTime = value; return element;
}
function freshness(report: Report, now = Date.now()) {
  const expiresAt = Date.parse(report.checkedAt) + POLL_MS;
  const expired = now >= expiresAt || Date.parse(report.checkedAt) > now + 5_000;
  const evidenceStale = (row: Row): boolean => row.stale || expired || row.asOf !== null
    && (now - Date.parse(row.asOf) >= POLL_MS || Date.parse(row.asOf) > now + 5_000);
  const staleEvidence = report.components.some(row => row.state !== 'not_configured' && evidenceStale(row));
  const state: State = staleEvidence && report.state === 'ready' ? 'unknown' : report.state;
  const readyDeadlines = report.components.filter(row => row.state === 'ready' && !evidenceStale(row))
    .map(row => Math.min(expiresAt, Date.parse(row.asOf!) + POLL_MS));
  // Cached evidence may have only a few seconds left. Expire that display at its
  // actual deadline rather than granting a new lifetime from response arrival.
  const nextRefreshMs = Math.max(1, Math.min(POLL_MS, ...readyDeadlines.map(deadline => deadline - now)));
  return { expired, evidenceStale, staleEvidence, state, nextRefreshMs };
}
function render(target: HTMLElement, report: Report): State {
  const doc = target.ownerDocument;
  const { expired, evidenceStale, staleEvidence, state } = freshness(report);
  target.replaceChildren(); target.dataset['state'] = state;
  target.append(text(doc, 'h3', `Local checks: ${LABELS[state]}`), text(doc, 'p', expired || report.stale || staleEvidence
    ? 'Some evidence is stale or pending. This report does not establish current readiness.'
    : 'Readiness applies only to the configured checks in this server process.'));
  const meta = doc.createElement('dl'); meta.className = 'service-status-meta';
  for (const [label, value] of [['Last report check (UTC)', report.checkedAt], ['Oldest evidence (UTC)', report.asOf]]) {
    const line = doc.createElement('div'), detail = doc.createElement('dd'); detail.append(stamp(doc, value ?? null));
    line.append(text(doc, 'dt', label!), detail); meta.append(line);
  }
  const source = doc.createElement('div'); source.append(text(doc, 'dt', 'Source'), text(doc, 'dd', 'Fixed local server probes')); meta.append(source); target.append(meta);
  const wrap = doc.createElement('div'); wrap.className = 'service-status-table'; wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Component checks; scroll horizontally for more columns');
  const table = doc.createElement('table'); table.className = 'spec-table'; table.append(text(doc, 'caption', 'Configured component checks'));
  const head = doc.createElement('thead'), labels = doc.createElement('tr');
  for (const label of ['Component', 'Status', 'Evidence', 'Last check / evidence (UTC)', 'Latency', 'Source']) {
    const cell = text(doc, 'th', label); cell.scope = 'col'; labels.append(cell);
  }
  head.append(labels); table.append(head); const body = doc.createElement('tbody');
  for (const row of report.components) {
    const stale = row.state !== 'not_configured' && evidenceStale(row), line = doc.createElement('tr'), name = text(doc, 'th', NAMES[row.id]); name.scope = 'row';
    const displayState = stale && row.state === 'ready' ? 'unknown' : row.state;
    line.append(name, text(doc, 'td', LABELS[displayState] + (stale ? ' — stale' : '')), text(doc, 'td', CODE_COPY[row.code]));
    const times = doc.createElement('td'); times.append(stamp(doc, row.checkedAt), doc.createElement('br'), stamp(doc, row.asOf));
    line.append(times, text(doc, 'td', row.latencyMs === null ? 'Not measured' : `${row.latencyMs} ms`), text(doc, 'td', 'Local server probe')); body.append(line);
  }
  table.append(body); wrap.append(table); target.append(wrap);
  return state;
}

/** Caller retains cleanup for SPA navigation, including hidden cached page roots. */
export function mountStatus(main: HTMLElement, heroHtml: string): () => void {
  mounted.get(main)?.();
  main.innerHTML = heroHtml + `<section class="section service-status" aria-labelledby="service-status-title"><div class="section-top"><div><div class="eyebrow">Service status</div><h2 id="service-status-title">Check current readiness.</h2></div><p>Fixed checks from this site's server process. These observations do not measure global uptime, every route, or every user's connection.</p></div><form class="inline-form"><button class="pill primary" type="submit">Refresh status <span aria-hidden="true">↗</span></button><p id="service-status-error" role="alert" hidden></p><p id="service-status-progress" role="status" aria-live="polite"></p></form><div class="service-status-results"></div><p>Checks are shared and cached for up to 60 seconds. Refreshing reads that cache. A ready component means its configured check passed; unconfigured and unknown components have no readiness evidence.</p></section>`;
  const doc = main.ownerDocument, section = main.querySelector<HTMLElement>('.service-status')!;
  const form = section.querySelector<HTMLFormElement>('form')!, button = form.querySelector<HTMLButtonElement>('button')!;
  const error = section.querySelector<HTMLElement>('#service-status-error')!, progress = section.querySelector<HTMLElement>('#service-status-progress')!;
  const results = section.querySelector<HTMLElement>('.service-status-results')!;
  let disposed = false, terminal = false, inFlight: AbortController | null = null, poll: ReturnType<typeof setTimeout> | undefined;
  let latestReport: Report | null = null;
  const visible = (): boolean => {
    if (doc.hidden || !main.isConnected || !main.contains(section)) return false;
    for (let node: HTMLElement | null = main; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = doc.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  };
  let wasVisible = visible();
  const stop = (): void => { clearTimeout(poll); poll = undefined; inFlight?.abort(); };
  const showReport = (report: Report): void => {
    const state = render(results, report);
    progress.textContent = `${LABELS[state]}. Automatically refreshes within 60 seconds while this page is visible.`;
  };
  const schedule = (): void => {
    if (!disposed && !terminal && visible()) poll = setTimeout(() => {
      // Invalidate the old readiness evidence before beginning the next request.
      if (latestReport && visible()) showReport(latestReport);
      void load();
    }, latestReport ? freshness(latestReport).nextRefreshMs : POLL_MS);
  };
  const load = async (): Promise<void> => {
    if (disposed || terminal || !visible() || inFlight) return;
    clearTimeout(poll); poll = undefined;
    const controller = new AbortController(); inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    button.disabled = true; button.setAttribute('aria-busy', 'true'); error.hidden = true;
    results.replaceChildren(); results.dataset['state'] = 'loading'; progress.textContent = 'Loading local readiness checks…';
    let failureState = 'unavailable', failureMessage = 'Status checks are unavailable. Refresh to retry.';
    try {
      const response = await fetch(ENDPOINT, { credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal });
      if (disposed || !visible() || controller.signal.aborted) return;
      if (response.status === 404) {
        terminal = true; failureState = 'not_enabled'; failureMessage = 'Status is not enabled. Automatic refresh is paused. Use Refresh status to retry.';
        throw new Error('not_enabled');
      }
      failureMessage = 'The status source returned an unexpected report. Refresh to retry.';
      const value: unknown = await response.json();
      if (disposed || !visible() || controller.signal.aborted) return;
      const code = object(value) && object(value['error']) ? value['error']['code'] : undefined;
      if (object(value) && [value['state'], value['code'], value['error'], code].includes('not_configured')) {
        terminal = true; failureState = 'not_configured';
        failureMessage = 'Status checks are not configured. Automatic refresh is paused. Use Refresh status to retry.';
        throw new Error('not_configured');
      }
      if (object(value) && [value['state'], value['code'], value['error'], code].includes('not_enabled')) {
        terminal = true; failureState = 'not_enabled'; failureMessage = 'Status is not enabled. Automatic refresh is paused. Use Refresh status to retry.';
        throw new Error('not_enabled');
      }
      if (!response.ok) { failureMessage = 'Status checks are unavailable. Refresh to retry.'; throw new Error('unavailable'); }
      latestReport = readReport(value); showReport(latestReport);
    } catch {
      if (!disposed && visible()) {
        latestReport = null;
        results.replaceChildren(); results.dataset['state'] = failureState;
        error.textContent = controller.signal.aborted ? 'The status request timed out. Refresh to retry.' : failureMessage;
        error.hidden = false; progress.textContent = terminal ? 'Automatic refresh paused.' : 'Current readiness evidence is unavailable.';
      }
    } finally {
      clearTimeout(timeout); inFlight = null; button.disabled = false; button.removeAttribute('aria-busy'); schedule();
    }
  };
  const submit = (event: Event): void => { event.preventDefault(); terminal = false; void load(); };
  const lifecycle = (): void => {
    if (!main.isConnected || !main.contains(section)) { cleanup(); return; }
    const active = visible();
    if (!active) stop(); else if (!wasVisible) void load();
    wasVisible = active;
  };
  const observer = new MutationObserver(lifecycle);
  const cleanup = (): void => {
    if (disposed) return; disposed = true; stop(); observer.disconnect();
    form.removeEventListener('submit', submit); doc.removeEventListener('visibilitychange', lifecycle); mounted.delete(main);
  };
  form.addEventListener('submit', submit); doc.addEventListener('visibilitychange', lifecycle);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'] });
  mounted.set(main, cleanup); void load(); return cleanup;
}
