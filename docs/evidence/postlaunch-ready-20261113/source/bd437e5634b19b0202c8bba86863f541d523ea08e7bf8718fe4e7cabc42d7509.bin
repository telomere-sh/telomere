import type { SelectionExplorerResponse, SelectionExplorerEvent, SelectionExplorerAgent } from '../../src/updates/selection-explorer.js';

const hash = /^0x[0-9a-f]{64}$/;
const integer = /^(0|[1-9][0-9]{0,77})$/;
const dates = /^\d{4}-\d{2}-\d{2}$/;
const events = ['Birth', 'Dormant', 'Revived', 'Death', 'Income', 'Burn', 'Subsidy'];
const statuses = ['alive', 'dormant', 'dead'];
const eventLabels: Record<SelectionExplorerEvent['event'], string> = {
  Birth: 'Birth', Dormant: 'Dormancy', Revived: 'Revival', Death: 'Death', Income: 'Income', Burn: 'Burn', Subsidy: 'Subsidy',
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unit = (value: unknown): value is string => typeof value === 'string' && integer.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && hash.test(value);
const epoch = (value: unknown): value is string => unit(value) && BigInt(value) <= 253_402_300_799n;
const nullableEpoch = (value: unknown) => value === null || epoch(value);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && dates.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;

/** Validate all remotely rendered fields; never use server-supplied link URLs. */
function readReport(value: unknown): SelectionExplorerResponse {
  const bad = () => new Error('The explorer returned an unexpected record. Apply filters again to retry.');
  if (!object(value) || value.version !== 1 || value.source !== 'canonical-persisted-selection-events'
    || value.currency !== 'registry-token-base-units' || value.periodTime !== 'block-timestamp'
    || !['ready', 'partial', 'stale', 'no_data'].includes(String(value.state)) || !epoch(value.asOfSeconds)
    || !object(value.index) || !/^[0-9a-f]{64}$/.test(String(value.index.indexKey)) || !whole(value.index.revision)
    || !whole(value.index.chainId) || !whole(value.index.confirmations) || !unit(value.index.indexedThrough)
    || !id(value.index.blockHash) || typeof value.index.registryAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(value.index.registryAddress)
    || !object(value.period) || !date(value.period.from) || !date(value.period.to) || !date(value.period.endExclusive)
    || !['all', ...statuses].includes(String(value.period.status)) || value.period.statusTime !== 'indexed-snapshot'
    || !object(value.coverage) || !unit(value.coverage.historyStartBlock) || !epoch(value.coverage.historyStartSeconds)
    || typeof value.coverage.partialStart !== 'boolean' || typeof value.coverage.partialEnd !== 'boolean' || typeof value.coverage.stale !== 'boolean'
    || value.coverage.deploymentHistoryVerified !== false || !whole(value.coverage.staleAfterSeconds)
    || !object(value.pagination) || !whole(value.pagination.limit) || value.pagination.limit < 1 || value.pagination.limit > 100
    || !whole(value.pagination.returnedEvents) || typeof value.pagination.firstPage !== 'boolean'
    || !Array.isArray(value.events) || value.events.length > value.pagination.limit || value.pagination.returnedEvents !== value.events.length
    || !Array.isArray(value.agents) || value.agents.length > 100
    || (value.nextCursor !== undefined && (typeof value.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor)))) throw bad();
  for (const event of value.events) {
    if (!object(event) || !events.includes(String(event.event)) || !id(event.agentId) || !epoch(event.timestampSeconds)
      || !unit(event.blockNumber) || !id(event.blockHash) || !id(event.transactionHash) || !whole(event.logIndex)
      || !(event.amountUnits === null || unit(event.amountUnits)) || !(event.feeUnits === null || unit(event.feeUnits))
      || (['Income', 'Burn', 'Subsidy'].includes(String(event.event)) ? event.amountUnits === null : event.amountUnits !== null)
      || (event.event === 'Income' ? event.feeUnits === null : event.feeUnits !== null)) throw bad();
  }
  const seen = new Set<string>();
  for (const agent of value.agents) {
    if (!object(agent) || !id(agent.agentId) || seen.has(agent.agentId) || !statuses.includes(String(agent.status)) || !id(agent.family) || !id(agent.parent)
      || !whole(agent.generation) || !epoch(agent.bornAt) || !nullableEpoch(agent.diedAt)
      || !(agent.lifespanSeconds === null || unit(agent.lifespanSeconds)) || !(agent.deathCause === null || id(agent.deathCause))
      || !['registryIncomeUnits', 'registryIncomeFeeUnits', 'registryBurnUnits', 'registrySubsidyUnits'].every(key => unit(agent[key]))
      || agent.actualIncomeUnits !== null || !Array.isArray(agent.eventRefs) || agent.eventRefs.length > 100
      || !agent.eventRefs.every(ref => object(ref) && id(ref.transactionHash) && whole(ref.logIndex))) throw bad();
    seen.add(agent.agentId);
  }
  if (value.events.some(event => !seen.has(event.agentId))) throw bad();
  return value as unknown as SelectionExplorerResponse;
}
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag); node.textContent = content; if (className) node.className = className; return node;
}
function timestamp(doc: Document, value: string): HTMLTimeElement {
  const iso = new Date(Number(BigInt(value)) * 1000).toISOString(), node = text(doc, 'time', iso.replace('T', ' ').replace('.000Z', ' UTC'));
  node.dateTime = iso; return node;
}
function explorerLink(doc: Document, chainId: number, type: 'tx' | 'block', value: string): HTMLElement {
  const origin = chainId === 8453 ? 'https://basescan.org' : chainId === 84532 ? 'https://sepolia.basescan.org' : undefined;
  if (!origin) return text(doc, 'span', value, 'mono');
  const anchor = text(doc, 'a', value, 'mono'); anchor.href = origin + '/' + type + '/' + value; anchor.rel = 'noopener noreferrer'; return anchor;
}
function agentLink(doc: Document, agentId: string): HTMLAnchorElement {
  const link = text(doc, 'a', agentId, 'mono'); link.href = '/agents/' + agentId; return link;
}
function amount(value: string | null): string { return value === null ? 'Not applicable' : BigInt(value).toString() + ' base units'; }
function details(doc: Document, agent: SelectionExplorerAgent): HTMLElement {
  const item = doc.createElement('li'), heading = text(doc, 'h4', ''); heading.append(agentLink(doc, agent.agentId)); item.append(heading);
  const dl = doc.createElement('dl'); dl.className = 'fossil-details';
  const rows: [string, string | HTMLElement][] = [
    ['Status at indexed snapshot', agent.status], ['Family', agent.family], ['Parent', agent.parent], ['Generation', String(agent.generation)],
    ['Born', timestamp(doc, agent.bornAt)], ['Died', agent.diedAt === null ? 'Not recorded' : timestamp(doc, agent.diedAt)],
    ['Completed lifespan', agent.lifespanSeconds === null ? 'Not recorded' : agent.lifespanSeconds + ' seconds'], ['Death cause', agent.deathCause ?? 'Not recorded'],
    ['Lifetime registry income', amount(agent.registryIncomeUnits)], ['Lifetime registry income fees', amount(agent.registryIncomeFeeUnits)],
    ['Lifetime registry burn', amount(agent.registryBurnUnits)], ['Lifetime registry subsidy', amount(agent.registrySubsidyUnits)],
    ['Actual income', 'Unknown — complete deployment history has not been verified.'],
  ];
  for (const [label, value] of rows) { const row = doc.createElement('div'), dd = doc.createElement('dd'); dd.append(value); row.append(text(doc, 'dt', label), dd); dl.append(row); }
  item.append(dl); return item;
}
function render(results: HTMLElement, report: SelectionExplorerResponse): void {
  const doc = results.ownerDocument; results.replaceChildren(); results.dataset['state'] = report.state;
  results.append(text(doc, 'h3', 'Indexed lifecycle events'));
  const copy = report.state === 'stale' ? 'Stale snapshot. Refresh after the index catches up; records below reflect the stated as-of time.'
    : report.state === 'partial' ? 'Partial period coverage. Indexed history starts late or ends before the requested period is complete.'
      : report.state === 'no_data' ? 'No matching events in the indexed period.' : 'Ready. Matching indexed events are listed below.';
  results.append(text(doc, 'p', copy));
  const metadata = doc.createElement('dl'); metadata.className = 'fossil-details';
  const rows: [string, string | HTMLElement][] = [['Source', report.source], ['Period (UTC, inclusive)', report.period.from + ' through ' + report.period.to],
    ['Status filter (at snapshot)', report.period.status], ['As of', timestamp(doc, report.asOfSeconds)],
    ['Coverage starts', timestamp(doc, report.coverage.historyStartSeconds)], ['History start block', report.coverage.historyStartBlock],
    ['Coverage', `Start ${report.coverage.partialStart ? 'partial' : 'covered'}; end ${report.coverage.partialEnd ? 'partial' : 'covered'}; deployment history unverified`],
    ['Chain / registry', String(report.index.chainId) + ' / ' + report.index.registryAddress], ['Index revision', String(report.index.revision)],
    ['Index key', report.index.indexKey], ['Indexed through', explorerLink(doc, report.index.chainId, 'block', report.index.indexedThrough)],
    ['Snapshot block hash', report.index.blockHash]];
  for (const [label, value] of rows) { const row = doc.createElement('div'), dd = doc.createElement('dd'); dd.append(value); row.append(text(doc, 'dt', label), dd); metadata.append(row); }
  results.append(metadata);
  if (!report.events.length) results.append(text(doc, 'p', 'No matching events were found in this snapshot. Adjust the dates or lifecycle status and apply filters again.'));
  else {
    const wrapper = doc.createElement('div'); wrapper.className = 'fossil-table-wrap'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Lifecycle events; scroll horizontally if needed');
    const table = doc.createElement('table'), caption = text(doc, 'caption', 'Events ordered by block and log index. Amounts are exact registry token base units.'); table.append(caption);
    const head = doc.createElement('thead'), hr = doc.createElement('tr');
    for (const label of ['Event / time (UTC)', 'Agent / snapshot status', 'Amount / fee', 'Transaction / block']) { const th = text(doc, 'th', label); th.scope = 'col'; hr.append(th); } head.append(hr); table.append(head);
    const body = doc.createElement('tbody'), agents = new Map(report.agents.map(agent => [agent.agentId, agent]));
    for (const event of report.events) {
      const row = doc.createElement('tr'), kind = doc.createElement('td'), agent = doc.createElement('td'), money = doc.createElement('td'), refs = doc.createElement('td');
      kind.append(text(doc, 'span', eventLabels[event.event]), timestamp(doc, event.timestampSeconds));
      agent.append(agentLink(doc, event.agentId), text(doc, 'span', agents.get(event.agentId)!.status));
      money.append(text(doc, 'span', amount(event.amountUnits)), text(doc, 'span', 'Fee: ' + amount(event.feeUnits)));
      refs.append(explorerLink(doc, report.index.chainId, 'tx', event.transactionHash), explorerLink(doc, report.index.chainId, 'block', event.blockNumber), text(doc, 'span', 'Log ' + event.logIndex));
      row.append(kind, agent, money, refs); body.append(row);
    }
    table.append(body); wrapper.append(table); results.append(wrapper);
    results.append(text(doc, 'h3', 'Agents on this page'));
    const list = doc.createElement('ul'); list.className = 'fossil-agents'; for (const agent of report.agents) list.append(details(doc, agent)); results.append(list);
  }
  results.hidden = false;
}

/** Public read-only explorer. Retain the returned cleanup for cached SPA navigation.
 * Requests are explicit; there is no background polling. */
export function mountFossilRecord(main: HTMLElement, heroHtml: string): () => void {
  main.innerHTML = heroHtml + `<section class="section fossil-record" aria-labelledby="fossil-title">
    <div class="section-top"><div><div class="eyebrow">Selection / Fossil Record</div><h2 id="fossil-title">Follow the lifecycle.</h2></div><p>Explore indexed births, dormancy, revivals, deaths, income, burn and subsidy. Every record stays tied to its canonical snapshot.</p></div>
    <form class="inline-form" id="fossil-form">
      <p class="fossil-help" id="fossil-help">Dates are inclusive UTC block dates, up to 366 days. Status describes each agent at the indexed snapshot. No wallet is needed.</p>
      <label class="field"><span>From (UTC)</span><input id="fossil-from" type="date" required aria-describedby="fossil-help fossil-error"></label>
      <label class="field"><span>Through (UTC)</span><input id="fossil-to" type="date" required aria-describedby="fossil-help fossil-error"></label>
      <label class="field"><span>Lifecycle status</span><select id="fossil-status"><option value="all">All statuses</option><option value="alive">Alive</option><option value="dormant">Dormant</option><option value="dead">Dead</option></select></label>
      <p class="fossil-help">Amounts use exact registry token base units. Subsidy is reported separately from income. Complete deployment history is unverified, so actual income remains unknown.</p>
      <p id="fossil-error" class="fossil-error" role="alert" hidden></p>
      <div class="fossil-actions"><button class="pill primary" type="submit">Apply filters</button><button class="pill" id="fossil-next" type="button" hidden>Next page</button></div>
      <p id="fossil-progress" class="fossil-help" role="status" aria-live="polite">Choose dates and apply filters to read the index.</p>
    </form><section class="fossil-results" aria-label="Fossil Record results" hidden></section>
  </section>`;
  const doc = main.ownerDocument, form = main.querySelector<HTMLFormElement>('#fossil-form')!, from = main.querySelector<HTMLInputElement>('#fossil-from')!, to = main.querySelector<HTMLInputElement>('#fossil-to')!;
  const status = main.querySelector<HTMLSelectElement>('#fossil-status')!, next = main.querySelector<HTMLButtonElement>('#fossil-next')!, apply = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const error = main.querySelector<HTMLElement>('#fossil-error')!, progress = main.querySelector<HTMLElement>('#fossil-progress')!, results = main.querySelector<HTMLElement>('.fossil-results')!;
  const today = new Date(), earlier = new Date(today); earlier.setUTCDate(earlier.getUTCDate() - 29); from.value = earlier.toISOString().slice(0, 10); to.value = today.toISOString().slice(0, 10);
  const lifecycle = new AbortController(); let pending: AbortController | undefined, timeout: ReturnType<typeof setTimeout> | undefined, cursor: string | undefined, generation = 0, disposed = false;
  const active = (): boolean => !disposed && !doc.hidden && main.isConnected && !main.hidden && !main.inert
    && main.id === 'page-content' && !main.closest('[hidden], [inert]') && main.contains(form);
  const stop = (): void => { generation++; pending?.abort(); pending = undefined; if (timeout !== undefined) clearTimeout(timeout); timeout = undefined; apply.disabled = false; next.disabled = false; form.removeAttribute('aria-busy'); };
  const invalidate = (): void => { stop(); cursor = undefined; next.hidden = true; results.hidden = true; error.hidden = true; progress.textContent = 'Filters changed. Apply filters to read the index.'; };
  const load = async (pageCursor?: string): Promise<void> => {
    if (pending || !active()) return;
    const days = (Date.parse(to.value) - Date.parse(from.value)) / 86_400_000;
    if (!date(from.value) || !date(to.value) || !Number.isInteger(days) || days < 0 || days >= 366) {
      error.textContent = 'Choose valid UTC dates spanning at most 366 days.'; error.hidden = false; return;
    }
    const requestId = ++generation, controller = new AbortController(); pending = controller; error.hidden = true; results.hidden = true; apply.disabled = true; next.disabled = true; form.setAttribute('aria-busy', 'true'); progress.textContent = 'Loading canonical indexed lifecycle events…';
    timeout = setTimeout(() => controller.abort(), 40_000);
    const params = new URLSearchParams({ from: from.value, to: to.value, status: status.value, limit: '25' }); if (pageCursor) params.set('cursor', pageCursor);
    try {
      const response = await fetch('/api/public/selection/explorer?' + params.toString(), { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (requestId !== generation || !active()) return;
      if (!response.ok) {
        let code = ''; try { const problem: unknown = await response.json(); if (object(problem)) code = String(problem.code ?? problem.title ?? ''); } catch { /* Status remains sufficient. */ }
        if (requestId !== generation || !active()) return;
        if (response.status === 409) { cursor = undefined; next.hidden = true; throw new Error('The index changed. Apply filters again to start from the first page.'); }
        if (response.status === 404 || response.status === 503 && code.includes('not_configured')) { results.dataset['state'] = 'not_configured'; throw new Error('Selection is not configured or this explorer is not enabled. No indexed population is available.'); }
        throw new Error(response.status === 422 ? 'The index rejected these filters. Check the dates and apply filters again.' : 'The canonical index is unavailable. Your filters are retained; apply filters again to retry.');
      }
      const value: unknown = await response.json(); if (requestId !== generation || !active()) return;
      const report = readReport(value);
      if (report.period.from !== from.value || report.period.to !== to.value || report.period.status !== status.value) throw new Error('The explorer returned a different period. Apply filters again.');
      render(results, report); cursor = report.nextCursor; next.hidden = cursor === undefined;
      progress.textContent = `${report.state.replace('_', ' ')} — ${report.events.length} events on this page.${cursor ? ' Another page is available.' : ' End of matching indexed events.'}`;
    } catch (failure) {
      if (requestId !== generation || !active()) return;
      error.textContent = controller.signal.aborted ? 'The request timed out. Apply filters again to retry.' : failure instanceof Error ? failure.message : 'The explorer is unavailable. Apply filters again to retry.';
      error.hidden = false; progress.textContent = ''; if (results.dataset['state'] !== 'not_configured') results.dataset['state'] = 'unavailable';
    } finally { if (requestId === generation) stop(); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); if (!active() || pending) return; cursor = undefined; next.hidden = true; void load(); }, { signal: lifecycle.signal });
  next.addEventListener('click', () => { if (cursor) void load(cursor); }, { signal: lifecycle.signal });
  for (const control of [from, to, status]) control.addEventListener('input', invalidate, { signal: lifecycle.signal });
  const cleanup = (): void => { if (disposed) return; disposed = true; stop(); lifecycle.abort(); observer.disconnect(); };
  const syncVisibility = (): void => {
    if (!main.isConnected || !main.contains(form) || main.id !== 'page-content') { cleanup(); return; }
    if (!active()) {
      stop();
      const paused = 'Paused while this page is hidden. Apply filters to refresh.';
      if (progress.textContent !== paused) progress.textContent = paused;
    }
  };
  doc.addEventListener('visibilitychange', syncVisibility, { signal: lifecycle.signal });
  const observer = new MutationObserver(syncVisibility);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'id'] });
  doc.defaultView?.addEventListener('pagehide', cleanup, { signal: lifecycle.signal });
  syncVisibility();
  return cleanup;
}
