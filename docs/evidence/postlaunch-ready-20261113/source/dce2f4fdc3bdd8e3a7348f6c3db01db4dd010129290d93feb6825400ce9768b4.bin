const PERIODS = ['24h', '7d', 'all'] as const;
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 30_000;
type Period = typeof PERIODS[number];
type ReportState = 'ready' | 'no_data' | 'partial' | 'unavailable';
type Totals = {
  settledRuns: number; successfulRuns: number; failedRuns: number; timeoutRefunds: number;
  returnedAtomic: string; unusedSuccessAtomic: string; failedReturnedAtomic: string;
  timeoutReturnedAtomic: string; unclassifiedReturnedAtomic: string;
  failedWithReturn: number; meanReturnSeconds: string | null;
};
type Daily = {date: string; returnedAtomic: string; successfulUnusedAtomic: string; failedReturnedAtomic: string; timeoutReturnedAtomic: string};
type RefundReport = {
  state: ReportState; asOf: string; chainId: number; token: string; escrow: string;
  coverage: {scope: string; candidates: number; verified: number; excluded: number; complete: boolean; notes: string[]};
  totals: Totals; daily: Daily[]; period: Period; chartWindowDays: number;
};

const PERIOD_LABELS: Record<Period, string> = {'24h': 'Last 24 hours', '7d': 'Last 7 days', all: 'All available history'};
const STATE_COPY: Record<ReportState, [string, string]> = {
  ready: ['Snapshot ready', 'Verified returns for the selected period are shown below.'],
  no_data: ['No verified data', 'This source has no verified settled runs for the selected period. There is no measured return total to show.'],
  partial: ['Partial coverage', 'These figures cover only the verified subset. Review the coverage and exclusions before comparing totals.'],
  unavailable: ['Source unavailable', 'The source did not supply a usable snapshot. Refresh to try again.'],
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function atomic(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,99})$/.test(value);
}
function shortText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_000;
}
function readReport(value: unknown, period: Period): RefundReport {
  const invalid = (): never => { throw new Error('The source returned a malformed snapshot. Refresh to request a new snapshot.'); };
  if (!object(value) || !['ready', 'no_data', 'partial', 'unavailable'].includes(String(value['state']))
    || value['period'] !== period || !count(value['chartWindowDays']) || value['chartWindowDays'] < 1 || value['chartWindowDays'] > 366
    || typeof value['asOf'] !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T/.test(value['asOf']) || !Number.isFinite(Date.parse(value['asOf']))
    || !count(value['chainId']) || value['chainId'] === 0
    || !shortText(value['token']) || !shortText(value['escrow'])) return invalid();
  const coverage = value['coverage'];
  const totals = value['totals'];
  if (!object(coverage) || !shortText(coverage['scope'])
    || !['candidates', 'verified', 'excluded'].every(key => count(coverage[key]))
    || typeof coverage['complete'] !== 'boolean' || !Array.isArray(coverage['notes'])
    || coverage['notes'].length > 100 || !coverage['notes'].every(shortText)
    || !object(totals) || !['settledRuns', 'successfulRuns', 'failedRuns', 'timeoutRefunds', 'failedWithReturn'].every(key => count(totals[key]))
    || !['returnedAtomic', 'unusedSuccessAtomic', 'failedReturnedAtomic', 'timeoutReturnedAtomic', 'unclassifiedReturnedAtomic'].every(key => atomic(totals[key]))
    || !(totals['meanReturnSeconds'] === null || (typeof totals['meanReturnSeconds'] === 'string'
      && /^(0|[1-9]\d{0,99})(\.\d{1,18})?$/.test(totals['meanReturnSeconds'])))
    || !Array.isArray(value['daily']) || value['daily'].length > 100_000) return invalid();
  if ((coverage['verified'] as number) > (coverage['candidates'] as number)
    || (coverage['excluded'] as number) > (coverage['candidates'] as number)
    || (totals['failedWithReturn'] as number) > (totals['failedRuns'] as number)) return invalid();
  const days = new Set<string>();
  for (const day of value['daily']) {
    if (!object(day) || typeof day['date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day['date'])
      || !Number.isFinite(Date.parse(`${day['date']}T00:00:00Z`))
      || new Date(`${day['date']}T00:00:00Z`).toISOString().slice(0, 10) !== day['date'] || days.has(day['date'])
      || !['returnedAtomic', 'successfulUnusedAtomic', 'failedReturnedAtomic', 'timeoutReturnedAtomic'].every(key => atomic(day[key]))) return invalid();
    days.add(day['date']);
  }
  return value as unknown as RefundReport;
}

function amount(value: string): string {
  const whole = BigInt(value);
  const fraction = (whole % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole / 1_000_000n}${fraction ? `.${fraction}` : ''} USDC`;
}
function failedRatio(totals: Totals): string {
  if (totals.failedRuns === 0) return 'No failed runs in this snapshot';
  const hundredths = BigInt(totals.failedWithReturn) * 10_000n / BigInt(totals.failedRuns);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}% (${totals.failedWithReturn} of ${totals.failedRuns} failed runs; rounded down)`;
}
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function details(doc: Document, rows: [string, string][], className: string): HTMLDListElement {
  const list = doc.createElement('dl');
  list.className = className;
  for (const [label, value] of rows) {
    const row = doc.createElement('div');
    row.append(node(doc, 'dt', label), node(doc, 'dd', value));
    list.append(row);
  }
  return list;
}
function renderReport(results: HTMLElement, report: RefundReport, stale = false): void {
  const doc = results.ownerDocument;
  results.replaceChildren();
  const partial = report.state === 'ready' && !report.coverage.complete;
  const state = partial ? 'partial' : report.state;
  const [title, copy] = STATE_COPY[state];
  results.dataset['state'] = stale ? 'stale' : state;
  const heading = node(doc, 'h2', stale ? 'Stale snapshot' : title);
  heading.id = 'refund-results-title';
  const headingRegion = doc.createElement('div');
  headingRegion.className = 'section-top';
  const holder = doc.createElement('div');
  holder.append(heading);
  headingRegion.append(holder, node(doc, 'p', stale ? 'The latest refresh did not complete. The retained snapshot has the timestamp and coverage shown below.' : copy));
  results.append(headingRegion);
  const timestamp = node(doc, 'p', 'Snapshot as of ');
  const time = node(doc, 'time', `${new Date(report.asOf).toISOString()} (UTC)`);
  time.dateTime = new Date(report.asOf).toISOString();
  timestamp.append(time);
  results.append(timestamp);
  results.append(details(doc, [
    ['Period', PERIOD_LABELS[report.period]], ['Source scope', report.coverage.scope],
    ['Chain ID', String(report.chainId)], ['Token', report.token], ['Escrow', report.escrow],
    ['Coverage', report.coverage.complete ? 'Complete for the stated source scope' : 'Incomplete for the stated source scope'],
    ['Candidate records', String(report.coverage.candidates)], ['Verified records', String(report.coverage.verified)],
    ['Excluded records', String(report.coverage.excluded)],
  ], 'refund-details'));
  if (report.coverage.notes.length) {
    results.append(node(doc, 'h3', 'Coverage notes'));
    const notes = doc.createElement('ul');
    for (const note of report.coverage.notes) notes.append(node(doc, 'li', note));
    results.append(notes);
  }
  if (state === 'unavailable' || state === 'no_data') return;
  if (state === 'partial' && report.coverage.verified === 0) {
    results.append(node(doc, 'h3', 'Return figures pending'));
    results.append(node(doc, 'p', 'No records have been verified yet. Return amounts, run counts, ratios and durations remain unknown while the source scans its history.', 'refund-help'));
    return;
  }
  results.append(node(doc, 'h3', 'Verified returns to escrow'));
  results.append(details(doc, [
    ['Total returned to escrow', amount(report.totals.returnedAtomic)],
    ['Unused funds from successful runs', amount(report.totals.unusedSuccessAtomic)],
    ['Funds returned from failed runs', amount(report.totals.failedReturnedAtomic)],
    ['Timeout refunds', amount(report.totals.timeoutReturnedAtomic)],
    ['Unclassified returns', amount(report.totals.unclassifiedReturnedAtomic)],
  ], 'refund-details refund-metrics'));
  results.append(node(doc, 'h3', 'Runs and return timing'));
  results.append(details(doc, [
    ['Settled runs', String(report.totals.settledRuns)], ['Successful runs', String(report.totals.successfulRuns)],
    ['Failed runs', String(report.totals.failedRuns)], ['Timeout refund events', String(report.totals.timeoutRefunds)],
    ['Failed runs with a return / failed runs', failedRatio(report.totals)],
    ['Mean reservation-to-return duration', report.totals.meanReturnSeconds === null ? 'No measured duration available' : `${report.totals.meanReturnSeconds} seconds`],
  ], 'refund-details'));
  results.append(node(doc, 'p', 'Return duration is measured from on-chain reservation to on-chain return. It is not failure-processing latency.', 'refund-help'));
  results.append(node(doc, 'h3', 'Daily returns'));
  results.append(node(doc, 'p', `Daily rows cover the selected period within the most recent ${report.chartWindowDays}-day window. Summary totals above cover the full selected period.`, 'refund-help'));
  if (!report.daily.length) {
    results.append(node(doc, 'p', `No daily breakdown is available within this snapshot's ${report.chartWindowDays}-day window. Older returns may still be included in the summary totals.`, 'refund-help'));
    return;
  }
  const scroller = doc.createElement('div');
  scroller.className = 'refund-table-scroll';
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Daily returns table; scroll horizontally for all categories');
  const table = doc.createElement('table');
  table.append(node(doc, 'caption', `Daily on-chain returns to escrow, in USDC, within the ${report.chartWindowDays}-day window. Dates use UTC.`));
  const head = doc.createElement('thead');
  const headerRow = doc.createElement('tr');
  for (const label of ['Date (UTC)', 'Total returned', 'Successful unused', 'Failed returns', 'Timeout refunds']) {
    const cell = node(doc, 'th', label);
    cell.scope = 'col';
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head);
  const body = doc.createElement('tbody');
  for (const day of report.daily) {
    const row = doc.createElement('tr');
    const dateCell = doc.createElement('th');
    dateCell.scope = 'row';
    const time = node(doc, 'time', day.date);
    time.dateTime = day.date;
    dateCell.append(time);
    row.append(dateCell);
    for (const value of [day.returnedAtomic, day.successfulUnusedAtomic, day.failedReturnedAtomic, day.timeoutReturnedAtomic]) row.append(node(doc, 'td', amount(value)));
    body.append(row);
  }
  table.append(body);
  scroller.append(table);
  results.append(scroller, node(doc, 'p', 'The daily total may include unclassified returns; the named category columns may not sum to that total.', 'refund-help'));
}

/** Mount only for an enabled route. All reads are aggregate, same-origin and wallet-free. */
export function mountRefundDashboard(main: HTMLElement, heroHtml: string): void {
  main.innerHTML = heroHtml + `<section class="section refund-dashboard" aria-labelledby="refund-form-title">
    <div class="section-top"><div><div class="eyebrow">Public settlement insights</div><h2 id="refund-form-title">Follow the returns.</h2></div><p>Aggregate on-chain returns to escrow, with successful unused funds, failed-run returns and timeout refunds shown separately.</p></div>
    <form class="inline-form refund-controls">
      <label class="field"><span>Period</span><select name="period" id="refund-period"><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="all">All available history</option></select></label>
      <button class="pill primary" type="submit">Refresh <span aria-hidden="true">↗</span></button>
      <p class="refund-help">Read-only public aggregates. No wallet connection is needed. Returned funds are released back to escrow; this does not mean a wallet withdrawal. Refreshes every 60 seconds while this page is visible.</p>
      <p class="refund-error" role="alert" hidden></p>
      <p class="refund-progress" role="status" aria-live="polite"></p>
    </form>
    <section class="refund-results" aria-labelledby="refund-results-title" hidden></section>
  </section>`;
  const doc = main.ownerDocument;
  const form = main.querySelector<HTMLFormElement>('.refund-controls')!;
  const periodSelect = main.querySelector<HTMLSelectElement>('#refund-period')!;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const error = form.querySelector<HTMLElement>('.refund-error')!;
  const progress = form.querySelector<HTMLElement>('.refund-progress')!;
  const results = main.querySelector<HTMLElement>('.refund-results')!;
  let active = false;
  let endpointDisabled = false;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let lastReport: RefundReport | undefined;
  const isVisible = (): boolean => main.isConnected && !main.hidden && !main.inert && !doc.hidden
    && doc.defaultView?.location.pathname.replace(/\/$/, '') === '/refunds';
  const stopPolling = (): void => { if (polling !== undefined) clearInterval(polling); polling = undefined; };
  const abort = (): void => {
    generation++;
    controller?.abort();
    controller = undefined;
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    results.removeAttribute('aria-busy');
    progress.textContent = '';
  };
  const startPolling = (): void => {
    if (polling === undefined && !endpointDisabled && isVisible()) polling = setInterval(() => { void refresh(); }, REFRESH_MS);
  };
  const showEndpointState = (state: 'not_enabled' | 'not_configured'): void => {
    endpointDisabled = true;
    stopPolling();
    lastReport = undefined;
    results.replaceChildren();
    results.dataset['state'] = state;
    const title = node(doc, 'h2', state === 'not_enabled' ? 'Refund insights not enabled' : 'Refund source not configured');
    title.id = 'refund-results-title';
    const headingRegion = doc.createElement('div');
    headingRegion.className = 'section-top';
    const holder = doc.createElement('div');
    holder.append(title);
    headingRegion.append(holder, node(doc, 'p', state === 'not_enabled'
      ? 'This public feature is not enabled. No refund figures are available.'
      : 'The operator has not configured the public refund source. No refund figures are available.'));
    results.append(headingRegion);
    results.hidden = false;
  };
  async function refresh(): Promise<void> {
    if (!isVisible() || controller) return;
    const period = periodSelect.value as Period;
    if (!PERIODS.includes(period)) return;
    const requestGeneration = ++generation;
    const requestController = new AbortController();
    controller = requestController;
    let timedOut = false;
    timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, TIMEOUT_MS);
    error.hidden = true;
    error.textContent = '';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    results.setAttribute('aria-busy', 'true');
    progress.textContent = 'Loading the public refund snapshot. This may take up to 30 seconds.';
    try {
      const response = await fetch(`/api/public/insights/refunds?period=${period}`, {
        credentials: 'omit', cache: 'no-store', redirect: 'error', headers: {'Accept': 'application/json'}, signal: requestController.signal,
      });
      if (requestGeneration !== generation || !isVisible()) return;
      if (response.status === 404) { showEndpointState('not_enabled'); progress.textContent = 'Refund insights not enabled.'; return; }
      let value: unknown;
      try { value = await response.json() as unknown; }
      catch { throw new Error('The source returned an unreadable response. Refresh to try again.'); }
      if (requestGeneration !== generation || !isVisible()) return;
      if (object(value) && (value['state'] === 'not_configured' || value['code'] === 'not_configured' || value['error'] === 'not_configured')) {
        showEndpointState('not_configured'); progress.textContent = 'Refund source not configured.'; return;
      }
      if (!response.ok) throw new Error(response.status === 429
        ? 'The public source is receiving too many requests. Wait a minute, then refresh.'
        : `The public source returned HTTP ${response.status}. Refresh to try again.`);
      const report = readReport(value, period);
      lastReport = report;
      endpointDisabled = false;
      renderReport(results, report);
      results.hidden = false;
      progress.textContent = STATE_COPY[report.state === 'ready' && !report.coverage.complete ? 'partial' : report.state][0] + '.';
      startPolling();
    } catch (failure: unknown) {
      if (requestGeneration !== generation || !isVisible()) return;
      error.textContent = timedOut ? 'The snapshot request timed out after 30 seconds. Refresh to try again.'
        : failure instanceof TypeError ? 'The public source could not be reached. Check your connection, then refresh.'
          : failure instanceof Error ? failure.message : 'The snapshot request did not complete. Refresh to try again.';
      error.hidden = false;
      if (lastReport?.period === period) renderReport(results, lastReport, true);
      else {
        results.replaceChildren();
        results.dataset['state'] = 'unavailable';
        const title = node(doc, 'h2', 'Snapshot unavailable');
        title.id = 'refund-results-title';
        const headingRegion = doc.createElement('div');
        headingRegion.className = 'section-top';
        const holder = doc.createElement('div');
        holder.append(title);
        headingRegion.append(holder, node(doc, 'p', 'No verified figures are available from this request. The period selector and Refresh remain available.'));
        results.append(headingRegion);
      }
      results.hidden = false;
      progress.textContent = lastReport?.period === period ? 'Refresh failed. The previous snapshot is marked stale.' : 'Snapshot unavailable.';
    } finally {
      if (requestGeneration === generation) {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        controller = undefined;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        results.removeAttribute('aria-busy');
      }
    }
  }
  function syncVisibility(): void {
    const visible = isVisible();
    if (visible === active) return;
    active = visible;
    if (!visible) { stopPolling(); abort(); return; }
    if (!endpointDisabled) { startPolling(); void refresh(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    endpointDisabled = false;
    startPolling();
    void refresh();
  });
  periodSelect.addEventListener('change', () => {
    abort();
    lastReport = undefined;
    results.hidden = true;
    error.hidden = true;
    endpointDisabled = false;
    startPolling();
    void refresh();
  });
  const observer = new MutationObserver(syncVisibility);
  observer.observe(main, {attributes: true, attributeFilter: ['hidden', 'inert', 'id']});
  const removalObserver = new MutationObserver(() => {
    syncVisibility();
    if (!main.isConnected) {
      observer.disconnect();
      removalObserver.disconnect();
      doc.removeEventListener('visibilitychange', syncVisibility);
    }
  });
  if (main.parentNode) removalObserver.observe(main.parentNode, {childList: true});
  doc.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
}
