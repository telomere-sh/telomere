const REFRESH_MS = 60_000;
const TIMEOUT_MS = 30_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
type Report = {
  state: 'ready' | 'no_data' | 'partial' | 'unavailable'; owner: string; asOf: string;
  chainId: number; token: string; escrow: string; anchor: { height: string; hash: string } | null;
  budgetScope: string; periodStartsAt: string; periodEndsAt: string;
  coverage: { scope: string; complete: boolean; notes: string[] };
  estimate: null | { availableAtomic: string; trailing24hChargedAtomic: string; ownerFacts: number;
    settledRuns24h: number; mode: 'full' | 'lean' | 'torpor' | 'cyst'; runwaySeconds: string | null;
    runwayHours: { numerator: string; denominator: string } | null; zeroSpend: boolean };
};
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function atomic(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,99})$/.test(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4000; }
function date(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function readReport(value: unknown, owner: string): Report {
  const bad = (): never => { throw new Error('The reader returned an unexpected snapshot. Refresh to retry.'); };
  if (!object(value) || !['ready', 'no_data', 'partial', 'unavailable'].includes(String(value['state']))
    || typeof value['owner'] !== 'string' || value['owner'].toLowerCase() !== owner
    || !date(value['asOf']) || !date(value['periodStartsAt']) || !date(value['periodEndsAt'])
    || !count(value['chainId']) || value['chainId'] < 1 || !text(value['token']) || !text(value['escrow']) || !text(value['budgetScope'])) return bad();
  const coverage = value['coverage'], anchor = value['anchor'], estimate = value['estimate'];
  if (!object(coverage) || !text(coverage['scope']) || typeof coverage['complete'] !== 'boolean'
    || !Array.isArray(coverage['notes']) || coverage['notes'].length > 100 || !coverage['notes'].every(text)
    || !(anchor === null || object(anchor) && atomic(anchor['height']) && typeof anchor['hash'] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(anchor['hash']))) return bad();
  if (value['state'] !== 'ready') { if (estimate !== null) return bad(); }
  else {
    if (!coverage['complete'] || anchor === null || !object(estimate)
      || !atomic(estimate['availableAtomic']) || !atomic(estimate['trailing24hChargedAtomic'])
      || !count(estimate['ownerFacts']) || estimate['ownerFacts'] === 0 || !count(estimate['settledRuns24h'])
      || !['full', 'lean', 'torpor', 'cyst'].includes(String(estimate['mode'])) || typeof estimate['zeroSpend'] !== 'boolean'
      || !(estimate['runwaySeconds'] === null || atomic(estimate['runwaySeconds']))) return bad();
    const available = BigInt(estimate['availableAtomic']), burn = BigInt(estimate['trailing24hChargedAtomic']);
    const hours = estimate['runwayHours'];
    const mode = available === 0n ? 'cyst' : burn === 0n || available * 24n > burn * 72n ? 'full'
      : available * 24n >= burn * 24n ? 'lean' : available * 24n >= burn * 2n ? 'torpor' : 'cyst';
    const seconds = available === 0n ? '0' : burn === 0n ? null : (available * 86400n / burn).toString();
    if (estimate['mode'] !== mode || estimate['runwaySeconds'] !== seconds || estimate['zeroSpend'] !== (burn === 0n)) return bad();
    if (available > 0n && burn === 0n) { if (hours !== null) return bad(); }
    else if (!object(hours) || !atomic(hours['numerator']) || !atomic(hours['denominator'])
      || hours['numerator'] !== (available === 0n ? '0' : (available * 24n).toString())
      || hours['denominator'] !== (available === 0n ? '1' : burn.toString())) return bad();
  }
  return value as unknown as Report;
}
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = content; return element;
}
function amount(value: string): string {
  const n = BigInt(value); return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDC`;
}
/** Readable hours preserve decimal arithmetic; repeating fractions are explicitly rounded down. */
export function formatRunwayHours(value: { numerator: string; denominator: string }): string {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator), scale = 1_000_000n;
  const scaled = numerator * scale / denominator;
  const fraction = (scaled % scale).toString().padStart(6, '0').replace(/0+$/, '');
  return `${scaled / scale}${fraction ? `.${fraction}` : ''} hours${numerator * scale % denominator ? ' (rounded down to 6 decimals)' : ''}`;
}
function render(results: HTMLElement, report: Report): void {
  const doc = results.ownerDocument;
  const copy = { ready: ['Runway estimate', 'An estimate based on the previous 24 hours of confirmed charges. Future prices and usage may differ.'],
    no_data: ['No owner history', 'There is no confirmed owner history in this source. Runway and mode remain unknown.'],
    partial: ['History still refreshing', 'Coverage is incomplete. Balance, burn, runway and mode are withheld until verification completes.'],
    unavailable: ['Source unavailable', 'Balance or history verification did not complete. Refresh to retry.'] }[report.state];
  results.replaceChildren(); results.dataset['state'] = report.state;
  const top = doc.createElement('div'); top.className = 'section-top';
  const holder = doc.createElement('div'), heading = node(doc, 'h2', copy[0]!); heading.id = 'runway-results-title';
  holder.append(heading); top.append(holder, node(doc, 'p', copy[1]!)); results.append(top);
  const stamped = node(doc, 'p', 'Snapshot as of '), time = node(doc, 'time', `${new Date(report.asOf).toISOString()} (UTC)`);
  time.dateTime = report.asOf; stamped.append(time); results.append(stamped);
  const rows: [string, string][] = [['Owner', report.owner], ['Budget scope', report.budgetScope], ['History source', report.coverage.scope],
    ['Coverage', report.coverage.complete ? 'Complete for the stated controller source' : 'Incomplete'],
    ['Window (UTC)', `${report.periodStartsAt} through ${report.periodEndsAt}`], ['Chain ID', String(report.chainId)],
    ['Token', report.token], ['Escrow', report.escrow], ['Confirmed block', report.anchor ? `${report.anchor.height} · ${report.anchor.hash}` : 'Pending']];
  const e = report.estimate;
  if (e) {
    const hours = e.runwayHours;
    rows.unshift(['Available compute escrow', amount(e.availableAtomic)], ['Charged in trailing 24 hours', amount(e.trailing24hChargedAtomic)],
      ['Runway', hours ? formatRunwayHours(hours) : 'Infinite at the measured zero spend rate'],
      ['Estimate mode', e.mode.charAt(0).toUpperCase() + e.mode.slice(1)],
      ['Spend evidence', e.zeroSpend ? 'Known owner history; zero settlement charges in this 24-hour window' : `${e.settledRuns24h} confirmed settlements in this window`]);
  }
  const list = doc.createElement('dl'); list.className = 'runway-details';
  for (const [label, value] of rows) {
    const row = doc.createElement('div'), detail = node(doc, 'dd', value);
    if (label === 'Window (UTC)') {
      const start = node(doc, 'time', report.periodStartsAt), end = node(doc, 'time', report.periodEndsAt);
      start.dateTime = report.periodStartsAt; end.dateTime = report.periodEndsAt;
      detail.replaceChildren(start, doc.createTextNode(' through '), end);
    }
    row.append(node(doc, 'dt', label), detail); list.append(row);
  }
  results.append(list);
  if (e?.runwayHours) {
    const exact = doc.createElement('details'); exact.className = 'runway-calculation';
    exact.append(node(doc, 'summary', 'Exact runway calculation'),
      node(doc, 'p', `${e.runwayHours.numerator} ÷ ${e.runwayHours.denominator} hours; ${e.runwaySeconds} whole seconds (rounded down).`));
    results.append(exact);
  }
  results.append(node(doc, 'h3', 'Coverage notes'));
  const notes = doc.createElement('ul');
  for (const note of report.coverage.notes) notes.append(node(doc, 'li', note));
  results.append(notes); results.hidden = false;
}

/** Standalone owner reader. The shared router owns the hero and calls cleanup on navigation. */
export function mountRunway(main: HTMLElement, heroHtml: string): () => void {
  main.innerHTML = heroHtml + `<section class="section runway-reader" aria-labelledby="runway-title">
    <div class="section-top"><div><div class="eyebrow">Private compute budget</div><h2 id="runway-title">How long could it last?</h2></div><p>Compare available owner escrow with confirmed charges in the last 24 hours. This estimate does not choose hardware, change agent policy, or read SelectionVault balances.</p></div>
    <div class="inline-form"><p class="runway-help">Use your existing signed Workspace session. Refreshes run only while this page is visible, at most once per minute automatically.</p>
    <a class="pill" href="/dashboard/">Sign in to Workspace <span aria-hidden="true">↗</span></a>
    <button class="pill primary" type="button" id="runway-refresh">Refresh estimate <span aria-hidden="true">↗</span></button>
    <p id="runway-status" role="status" aria-live="polite"></p><p id="runway-error" class="runway-error" role="alert" hidden></p></div>
    <section class="runway-results" aria-labelledby="runway-results-title" hidden></section></section>`;
  const doc = main.ownerDocument, button = main.querySelector<HTMLButtonElement>('#runway-refresh')!,
    status = main.querySelector<HTMLElement>('#runway-status')!, error = main.querySelector<HTMLElement>('#runway-error')!,
    results = main.querySelector<HTMLElement>('.runway-results')!;
  let disposed = false, terminalEndpoint = false, sessionReviewRequired = false, owner = '', generation = 0,
    active: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('telomere-wallet-session-v1') : undefined;
  const clear = (): void => { results.replaceChildren(); results.hidden = true; };
  const stop = (): void => { ++generation; active?.abort(); active = undefined; clearTimeout(timer); button.disabled = false; button.removeAttribute('aria-busy'); };
  const refresh = async (): Promise<void> => {
    if (disposed || terminalEndpoint || sessionReviewRequired || doc.hidden || active) return;
    clearTimeout(timer); const controller = new AbortController(); active = controller; const ticket = ++generation;
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    button.disabled = true; button.setAttribute('aria-busy', 'true'); error.hidden = true; clear(); results.dataset['state'] = 'loading'; status.textContent = 'Checking your session and confirmed compute history…';
    let failureState: 'unavailable' | 'not_enabled' | 'not_configured' = 'unavailable';
    const request = (path: string, address?: string): Promise<Response> => fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(address ? { 'X-Telomere-Owner': address } : {}) } });
    try {
      const me = await request('/api/me');
      if (disposed || doc.hidden || ticket !== generation || controller.signal.aborted) return;
      if (me.status === 401 || me.status === 403) { owner = ''; throw new Error('Sign in to Workspace to view your private compute estimate.'); }
      if (!me.ok) throw new Error('Your session check did not complete. Refresh to retry.');
      const session: unknown = await me.json();
      if (disposed || doc.hidden || ticket !== generation || controller.signal.aborted) return;
      if (!object(session) || typeof session['address'] !== 'string' || !ADDRESS.test(session['address'])) throw new Error('Your session returned an unexpected owner. Sign in again.');
      const currentOwner = session['address'].toLowerCase();
      if (owner !== currentOwner) { clear(); owner = currentOwner; }
      const response = await request('/api/insights/runway', currentOwner);
      if (disposed || doc.hidden || ticket !== generation || controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403 || response.status === 409) { owner = ''; clear(); throw new Error('Your signed session changed. Sign in to Workspace and refresh.'); }
      if (response.status === 404) {
        terminalEndpoint = true; failureState = 'not_enabled';
        throw new Error('Runway reader is not enabled. Automatic refresh is paused. Refresh estimate after the feature is enabled.');
      }
      if (response.status === 503) {
        const problem: unknown = await response.json().catch(() => null);
        if (disposed || doc.hidden || ticket !== generation || controller.signal.aborted) return;
        if (object(problem) && [problem['state'], problem['code'], problem['title'], problem['error'],
          object(problem['error']) ? problem['error']['code'] : undefined].includes('not_configured')) {
          terminalEndpoint = true; failureState = 'not_configured';
          throw new Error('Runway source is not configured. Automatic refresh is paused. Refresh estimate after configuration is restored.');
        }
      }
      if (!response.ok) throw new Error(`The reader returned HTTP ${response.status}. Refresh to retry.`);
      const report = readReport(await response.json() as unknown, currentOwner);
      if (disposed || doc.hidden || ticket !== generation || owner !== currentOwner) return;
      render(results, report); status.textContent = 'Snapshot checked. Review the source, timestamp and coverage below.';
    } catch (failure: unknown) {
      if (disposed || doc.hidden || ticket !== generation) return;
      clear(); results.dataset['state'] = failureState;
      status.textContent = failureState === 'not_enabled' ? 'Runway reader not enabled. Automatic refresh paused.'
        : failureState === 'not_configured' ? 'Runway source not configured. Automatic refresh paused.' : '';
      error.textContent = controller.signal.aborted ? 'The request timed out. Refresh to retry.'
        : failure instanceof Error ? failure.message : 'The request did not complete. Refresh to retry.'; error.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (ticket === generation) { active = undefined; button.disabled = false; button.removeAttribute('aria-busy');
        if (!disposed && !terminalEndpoint && !sessionReviewRequired && !doc.hidden) timer = setTimeout(() => { void refresh(); }, REFRESH_MS); }
    }
  };
  const visibility = (): void => { if (doc.hidden) { stop(); clear(); if (!terminalEndpoint && !sessionReviewRequired) status.textContent = 'Refresh paused while this page is hidden.'; } else void refresh(); };
  const click = (): void => { terminalEndpoint = false; sessionReviewRequired = false; void refresh(); };
  if (channel) channel.onmessage = (event: MessageEvent<unknown>): void => {
    const nextOwner = object(event.data) ? event.data['owner'] : undefined;
    if (disposed || !(nextOwner === null || typeof nextOwner === 'string' && ADDRESS.test(nextOwner))) return;
    if (owner && typeof nextOwner === 'string' && nextOwner.toLowerCase() === owner) return;
    stop(); owner = ''; sessionReviewRequired = true; clear(); results.dataset['state'] = 'session_changed'; error.hidden = true;
    status.textContent = 'Wallet session changed in another tab. Private figures cleared. Sign in to Workspace, then refresh to review the current account.';
  };
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true; stop(); owner = ''; clear();
    if (channel) { channel.onmessage = null; channel.close(); }
    doc.removeEventListener('visibilitychange', visibility); button.removeEventListener('click', click); doc.defaultView?.removeEventListener('pagehide', cleanup);
  };
  button.addEventListener('click', click); doc.addEventListener('visibilitychange', visibility); doc.defaultView?.addEventListener('pagehide', cleanup);
  void refresh(); return cleanup;
}
