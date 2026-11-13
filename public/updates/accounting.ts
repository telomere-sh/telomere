const TIMEOUT_MS = 60_000;
const ATOMIC = /^(0|[1-9][0-9]{0,119})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export const ACCOUNTING_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export function accountingMonthLabel(month: string): string {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) throw new Error('Choose a valid UTC month.');
  return `${ACCOUNTING_MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}
type Summary = {
  state: 'ready' | 'no_data'; month: string; owner: string; asOf: string; generation: string;
  anchor: { height: string; hash: string };
  coverage: { scope: string; source: string; complete: true; candidates: number; verified: number; excluded: number; notes: string[] };
  totals: { records: string; settlements: string; timeoutRefunds: string; billableSeconds: string;
    chargedAtomic: string; returnedAtomic: string; ceilingAtomic: string; timeoutReturnedAtomic: string;
    chargedUsdc: string; returnedUsdc: string; ceilingUsdc: string; timeoutReturnedUsdc: string };
};
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function decimal(atomic: string): string { const amount = BigInt(atomic); return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`; }
function summary(value: unknown, month: string, owner: string): Summary {
  const bad = (): never => { throw new Error('The accounting response is malformed. Refresh the month to retry.'); };
  if (!object(value) || !['ready', 'no_data'].includes(String(value['state'])) || value['month'] !== month
    || typeof value['owner'] !== 'string' || value['owner'].toLowerCase() !== owner.toLowerCase()
    || !text(value['generation']) || !text(value['asOf']) || !/^\d{4}-\d{2}-\d{2}T/.test(value['asOf']) || !Number.isFinite(Date.parse(value['asOf']))) return bad();
  const coverage = value['coverage'], totals = value['totals'], anchor = value['anchor'];
  if (!object(coverage) || coverage['complete'] !== true || !text(coverage['scope']) || !text(coverage['source'])
    || !['candidates', 'verified', 'excluded'].every(key => count(coverage[key]))
    || coverage['excluded'] !== 0 || coverage['candidates'] !== coverage['verified']
    || !Array.isArray(coverage['notes']) || coverage['notes'].length > 100 || !coverage['notes'].every(text)
    || !object(anchor) || !text(anchor['height']) || !text(anchor['hash']) || !object(totals)) return bad();
  for (const key of ['records', 'settlements', 'timeoutRefunds', 'billableSeconds', 'chargedAtomic', 'returnedAtomic', 'ceilingAtomic', 'timeoutReturnedAtomic']) {
    if (typeof totals[key] !== 'string' || !ATOMIC.test(totals[key])) return bad();
  }
  for (const [atomic, formatted] of [['chargedAtomic', 'chargedUsdc'], ['returnedAtomic', 'returnedUsdc'], ['ceilingAtomic', 'ceilingUsdc'], ['timeoutReturnedAtomic', 'timeoutReturnedUsdc']] as const) {
    if (totals[formatted] !== decimal(String(totals[atomic]))) return bad();
  }
  if (BigInt(String(totals['records'])) !== BigInt(String(totals['settlements'])) + BigInt(String(totals['timeoutRefunds']))
    || BigInt(String(totals['chargedAtomic'])) + BigInt(String(totals['returnedAtomic'])) !== BigInt(String(totals['ceilingAtomic']))
    || (value['state'] === 'no_data') !== (totals['records'] === '0')) return bad();
  // All properties consumed below have been checked at this boundary.
  return value as unknown as Summary;
}
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
}
function details(doc: Document, rows: [string, string][]): HTMLDListElement {
  const dl = doc.createElement('dl'); dl.className = 'accounting-details';
  for (const [label, value] of rows) { const row = doc.createElement('div'); row.append(node(doc, 'dt', label), node(doc, 'dd', value)); dl.append(row); }
  return dl;
}
function completionRow(generation: string, token: string): string {
  return ['', '', '', '', '', '', '', '', '', '', '', '', 'coverage_complete', 'controller-recorded confirmed history', generation, token]
    .map(cell => `"${cell.replace(/"/g, '""')}"`).join(',') + '\r\n';
}

/** Owner-only manual reader. The existing Workspace owns sign-in; mounting never connects a wallet. */
export function mountAccounting(main: HTMLElement, heroHtml: string): () => void {
  main.innerHTML = heroHtml + `<section class="section accounting-tool" aria-labelledby="accounting-form-title">
    <div class="section-top"><div><div class="eyebrow">Owner accounting</div><h2 id="accounting-form-title">Your month, precisely.</h2></div><p>Review confirmed charges and returns from your signed session. Export a CSV after the complete history has been checked.</p></div>
    <form class="inline-form accounting-controls">
      <label class="field" for="accounting-month"><span>Month (UTC)</span><select id="accounting-month" name="month" required>${ACCOUNTING_MONTHS.map((label, index) => `<option value="${String(index + 1).padStart(2, '0')}">${label}</option>`).join('')}</select></label>
      <label class="field" for="accounting-year"><span>Year (UTC)</span><input id="accounting-year" name="year" type="text" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required aria-describedby="accounting-year-help"></label>
      <button class="pill primary" type="submit">Review month <span aria-hidden="true">↗</span></button>
      <button class="pill accounting-export" type="button" disabled>Prepare CSV</button>
      <a class="pill" href="/dashboard/">Open Workspace</a>
      <p class="accounting-help" id="accounting-year-help">Choose any four-digit year from 0001 through 9999. Use your existing signed Workspace session. Months follow on-chain settlement or timeout-refund time in UTC. This page reads accounting evidence and sends no financial transactions.</p>
      <p class="accounting-error" role="alert" hidden></p><p class="accounting-progress" role="status" aria-live="polite">Choose a month and review it.</p>
    </form><section class="accounting-results" aria-labelledby="accounting-results-title" hidden></section>
    <div class="accounting-download" hidden></div>
  </section>`;
  const doc = main.ownerDocument;
  const form = main.querySelector<HTMLFormElement>('.accounting-controls')!;
  const monthInput = main.querySelector<HTMLSelectElement>('#accounting-month')!;
  const yearInput = main.querySelector<HTMLInputElement>('#accounting-year')!;
  const today = new Date().toISOString();
  monthInput.value = today.slice(5, 7); yearInput.value = today.slice(0, 4);
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const exportButton = form.querySelector<HTMLButtonElement>('.accounting-export')!;
  const error = form.querySelector<HTMLElement>('.accounting-error')!;
  const progress = form.querySelector<HTMLElement>('.accounting-progress')!;
  const results = main.querySelector<HTMLElement>('.accounting-results')!;
  const download = main.querySelector<HTMLElement>('.accounting-download')!;
  let report: Summary | undefined, knownOwner: string | undefined, controller: AbortController | undefined;
  let version = 0, disposed = false, objectUrl: string | undefined;
  const visible = (): boolean => !disposed && main.isConnected && form.isConnected && !main.hidden && !main.inert && !doc.hidden;
  function clearFile(): void {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined; download.replaceChildren(); download.hidden = true;
  }
  function clearPrivate(): void { clearFile(); report = undefined; knownOwner = undefined; results.replaceChildren(); results.hidden = true; exportButton.disabled = true; }
  function stop(): void {
    ++version; controller?.abort(); controller = undefined; clearPrivate();
    submit.disabled = false; submit.removeAttribute('aria-busy'); exportButton.removeAttribute('aria-busy'); progress.textContent = '';
  }
  const sessionChannel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('telomere-wallet-session-v1');
  if (sessionChannel) sessionChannel.onmessage = (event: MessageEvent<unknown>): void => {
    if (!object(event.data) || !(event.data['owner'] === null || typeof event.data['owner'] === 'string' && ADDRESS.test(event.data['owner']))) return;
    // Workspace broadcasts {owner: address.toLowerCase()} after sign-in and {owner: null} after logout.
    // Even a same-owner sign-in replaces the session: every valid session event requires a fresh review.
    stop(); error.hidden = true;
    progress.textContent = 'The signed session changed in another tab. Review the month again before preparing an export.';
  };
  async function request(path: string, signal: AbortSignal, owner?: string): Promise<Response> {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: path.includes('.csv?') ? 'text/csv' : 'application/json', ...(owner ? { 'X-Telomere-Owner': owner } : {}) } });
    if (response.status === 401 || response.status === 409) {
      clearPrivate();
      throw new Error('Your signed session changed or ended. Open Workspace to sign in, then review the month again.');
    }
    if (!response.ok) {
      if (response.status === 404) throw new Error('Accounting is not enabled on this deployment.');
      let value: unknown;
      try { value = await response.json() as unknown; } catch { value = undefined; }
      if (object(value) && (value['state'] === 'not_configured' || value['title'] === 'not_configured')) throw new Error('The accounting source is not configured.');
      if (object(value) && value['state'] === 'partial') throw new Error('Accounting coverage is partial. Retry when the confirmed history scan completes.');
      throw new Error('Accounting evidence is unavailable. Review the month again to retry.');
    }
    return response;
  }
  async function currentOwner(signal: AbortSignal, expected?: string): Promise<string> {
    const response = await request('/api/me', signal, expected);
    const value: unknown = await response.json();
    if (!object(value) || typeof value['address'] !== 'string' || !ADDRESS.test(value['address'])) throw new Error('The signed session returned an unreadable account. Open Workspace to sign in again.');
    const address = value['address'];
    if ((expected && expected.toLowerCase() !== address.toLowerCase()) || (knownOwner && knownOwner.toLowerCase() !== address.toLowerCase())) {
      clearPrivate(); throw new Error('The active account changed. Review the month again.');
    }
    return address;
  }
  function render(value: Summary): void {
    results.replaceChildren(); results.hidden = false;
    const top = doc.createElement('div'); top.className = 'section-top'; const holder = doc.createElement('div');
    const heading = node(doc, 'h2', value.state === 'no_data' ? 'No records this month' : 'Monthly accounting'); heading.id = 'accounting-results-title'; holder.append(heading);
    top.append(holder, node(doc, 'p', value.state === 'no_data' ? 'The complete verified source has no matching records for your account this month. The measured totals are zero.' : 'Exact amounts from complete confirmed controller-recorded history.'));
    results.append(top, details(doc, [['Month (UTC)', accountingMonthLabel(value.month)], ['Owner', value.owner], ['Source', value.coverage.source], ['Coverage', value.coverage.scope],
      ['Verified source records', `${value.coverage.verified} of ${value.coverage.candidates}; complete`], ['Generation', value.generation], ['Chain anchor', `${value.anchor.height} / ${value.anchor.hash}`]]));
    const asOf = node(doc, 'p', 'Snapshot as of ', 'accounting-help'); const time = node(doc, 'time', value.asOf); time.dateTime = value.asOf; asOf.append(time); results.append(asOf);
    results.append(node(doc, 'h3', 'Exact totals'), details(doc, [['Charged', `${value.totals.chargedUsdc} USDC`], ['Returned to escrow', `${value.totals.returnedUsdc} USDC`],
      ['Reservation ceilings', `${value.totals.ceilingUsdc} USDC`], ['Timeout refunds (included in returns)', `${value.totals.timeoutReturnedUsdc} USDC`],
      ['Settlement records', value.totals.settlements], ['Timeout refund records', value.totals.timeoutRefunds], ['Billable seconds', value.totals.billableSeconds]]));
    const notes = doc.createElement('ul');
    for (const note of value.coverage.notes) notes.append(node(doc, 'li', note));
    results.append(notes, node(doc, 'p', 'CSV execution start/stop, host and lane cells remain blank where the source has no verified value. Reservation and return timestamps have their own columns. A final coverage_complete record certifies a finished export.', 'accounting-help'));
  }
  async function run(kind: 'review' | 'export'): Promise<void> {
    if (!visible() || controller) return;
    const month = `${yearInput.value}-${monthInput.value}`;
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) { error.textContent = 'Choose a valid UTC month in YYYY-MM format.'; error.hidden = false; return; }
    const selectedReport = report;
    if (kind === 'export' && (!selectedReport || selectedReport.month !== month)) return;
    const ownVersion = ++version, activeController = new AbortController(); controller = activeController;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; activeController.abort(); }, TIMEOUT_MS);
    error.hidden = true; clearFile(); submit.disabled = true; exportButton.disabled = true;
    (kind === 'review' ? submit : exportButton).setAttribute('aria-busy', 'true');
    progress.textContent = kind === 'review' ? 'Checking your session and complete monthly accounting.' : 'Preparing and verifying the complete CSV. The download link appears when all checks pass.';
    if (kind === 'review') { report = undefined; results.replaceChildren(); results.hidden = true; }
    try {
      const owner = await currentOwner(activeController.signal, selectedReport?.owner);
      if (ownVersion !== version || !visible()) return;
      knownOwner = owner;
      const response = await request(`/api/insights/accounting${kind === 'export' ? '.csv' : ''}?month=${encodeURIComponent(month)}`, activeController.signal, owner);
      if (kind === 'review') {
        const next = summary(await response.json() as unknown, month, owner);
        await currentOwner(activeController.signal, owner);
        if (ownVersion !== version || !visible()) return;
        report = next; render(next); progress.textContent = next.state === 'no_data' ? 'Complete source checked. No matching records this month.' : 'Monthly accounting ready.';
      } else {
        const generation = response.headers.get('X-Telomere-Export-Generation'), token = response.headers.get('X-Telomere-Export-Completion');
        if (!response.headers.get('content-type')?.startsWith('text/csv') || !generation || generation !== selectedReport!.generation || !token || !/^[0-9a-f-]{36}$/i.test(token)) throw new Error('The export snapshot changed. Review the month before preparing another CSV.');
        const blob = await response.blob();
        const bom = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
        const expected = completionRow(generation, token);
        const ending = await blob.slice(Math.max(0, blob.size - new TextEncoder().encode(expected).length)).text();
        if (bom[0] !== 239 || bom[1] !== 187 || bom[2] !== 191 || ending !== expected) throw new Error('The CSV did not finish. Prepare a fresh export.');
        await currentOwner(activeController.signal, owner);
        if (ownVersion !== version || !visible()) return;
        objectUrl = URL.createObjectURL(blob);
        const link = node(doc, 'a', `Download ${accountingMonthLabel(month)} CSV`, 'pill primary'); link.href = objectUrl; link.download = `telomere-accounting-${month}.csv`;
        link.addEventListener('click', event => {
          event.preventDefault();
          if (!visible() || controller || !objectUrl) return;
          const href = objectUrl;
          const clickController = new AbortController(); controller = clickController;
          const clickVersion = version;
          const clickTimeout = setTimeout(() => clickController.abort(), TIMEOUT_MS);
          void currentOwner(clickController.signal, owner).then(() => {
            if (clickVersion !== version || !visible() || objectUrl !== href) return;
            const save = doc.createElement('a'); save.href = href; save.download = link.download; save.click();
          }).catch(() => { if (clickVersion === version) { clearPrivate(); error.textContent = 'Verify your signed session in Workspace, then prepare a new CSV.'; error.hidden = false; } })
            .finally(() => { clearTimeout(clickTimeout); if (controller === clickController) controller = undefined; });
        });
        download.append(link, node(doc, 'p', 'Complete CSV verified. Use the link to save it; the file includes a final coverage record.', 'accounting-help'));
        download.hidden = false; progress.textContent = 'CSV verified and ready to download.';
      }
    } catch (failure: unknown) {
      if (ownVersion !== version || !visible()) return;
      clearFile();
      if (kind === 'review') { report = undefined; results.hidden = true; }
      error.textContent = timedOut ? 'The accounting request timed out. Review the month again to retry.' : failure instanceof Error ? failure.message : 'Accounting is unavailable. Review the month to retry.';
      error.hidden = false; progress.textContent = 'No completed export is available.';
    } finally {
      clearTimeout(timeout);
      if (ownVersion === version) {
        controller = undefined; submit.disabled = false; exportButton.disabled = !report;
        submit.removeAttribute('aria-busy'); exportButton.removeAttribute('aria-busy');
      }
    }
  }
  const onSubmit = (event: SubmitEvent): void => { event.preventDefault(); void run('review'); };
  const onExport = (): void => { void run('export'); };
  const onMonth = (): void => { stop(); error.hidden = true; progress.textContent = 'Review this month to prepare an export.'; };
  const onVisibility = (): void => { if (!visible()) stop(); };
  form.addEventListener('submit', onSubmit); exportButton.addEventListener('click', onExport); monthInput.addEventListener('change', onMonth); yearInput.addEventListener('change', onMonth);
  doc.addEventListener('visibilitychange', onVisibility);
  const observer = new MutationObserver(() => { if (!main.isConnected || !form.isConnected) cleanup(); else onVisibility(); });
  observer.observe(main, { attributes: true, attributeFilter: ['hidden', 'inert'], childList: true });
  if (main.parentNode) observer.observe(main.parentNode, { childList: true });
  function cleanup(): void {
    if (disposed) return;
    disposed = true; stop(); observer.disconnect(); doc.removeEventListener('visibilitychange', onVisibility);
    if (sessionChannel) { sessionChannel.onmessage = null; sessionChannel.close(); }
    form.removeEventListener('submit', onSubmit); exportButton.removeEventListener('click', onExport); monthInput.removeEventListener('change', onMonth); yearInput.removeEventListener('change', onMonth);
  }
  return cleanup;
}
