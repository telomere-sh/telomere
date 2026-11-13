import type { AgentEconomicsResponse } from '../../src/updates/agent-economics.js';

const HASH = /^0x[0-9a-f]{64}$/;
const UNITS = /^(0|[1-9][0-9]{0,77})$/;
const TIMEOUT_MS = 40_000;
const RESPONSE_LIMIT = 2_097_152;
const CHART_WIDTH = 800, CHART_HEIGHT = 200, CHART_INSET = 16, CHART_RATIO = 10_000n;
const SERIES = [['incomeUnits', 'Registry income (gross)'], ['feeUnits', 'Income fee'], ['netIncomeUnits', 'Registry income (net)'],
  ['burnUnits', 'Settled burn'], ['subsidyUnits', 'Subsidy']] as const;
type Amounts = AgentEconomicsResponse['totals'];
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const atomic = (value: unknown): value is string => typeof value === 'string' && UNITS.test(value);
const nullableAtomic = (value: unknown) => value === null || atomic(value);
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00.000Z'); return Number.isFinite(time) && time >= 0 && new Date(time).toISOString().slice(0, 10) === value;
}
function amounts(value: unknown): value is Amounts {
  return object(value) && SERIES.every(([key]) => atomic(value[key])) && BigInt(value['feeUnits'] as string) <= BigInt(value['incomeUnits'] as string)
    && BigInt(value['netIncomeUnits'] as string) === BigInt(value['incomeUnits'] as string) - BigInt(value['feeUnits'] as string);
}
function readResponse(value: unknown, id: string, from: string, to: string): AgentEconomicsResponse {
  const invalid = () => new Error('The agent source returned an unexpected report. Apply the dates again.');
  if (!object(value) || value['version'] !== 1 || !['ready', 'partial', 'stale', 'no_data'].includes(value['state'] as string)
    || value['source'] !== 'canonical-persisted-selection-events' || value['currency'] !== 'registry-token-base-units' || value['periodTime'] !== 'block-timestamp'
    || !atomic(value['asOfSeconds']) || BigInt(value['asOfSeconds']) > 253_402_300_799n || !amounts(value['totals'])) throw invalid();
  const period = value['period'], index = value['index'], coverage = value['coverage'];
  if (!object(period) || period['from'] !== from || period['to'] !== to || !validDate(period['endExclusive'])
    || Date.parse(period['endExclusive']) !== Date.parse(to) + 86_400_000 || !object(index) || !atomic(index['indexedThrough'])
    || typeof index['blockHash'] !== 'string' || !HASH.test(index['blockHash']) || typeof index['indexKey'] !== 'string' || !/^[0-9a-f]{64}$/.test(index['indexKey'])
    || typeof index['registryAddress'] !== 'string' || !/^0x[0-9a-f]{40}$/.test(index['registryAddress'])
    || !Number.isSafeInteger(index['chainId']) || !Number.isSafeInteger(index['revision']) || (index['revision'] as number) < 0
    || !object(coverage) || !atomic(coverage['historyStartBlock']) || !atomic(coverage['historyStartSeconds']) || coverage['deploymentHistoryVerified'] !== false
    || coverage['verifiedEarnedUnits'] !== null || coverage['earningsProvenance'] !== 'registry-classification-only' || coverage['unclassifiedTransfers'] !== 'excluded'
    || coverage['staleAfterSeconds'] !== 900 || !['partialStart', 'partialEnd', 'stale', 'lifecycleTruncated'].every(key => typeof coverage[key] === 'boolean')) throw invalid();
  const daily = value['daily'], lifecycle = value['lifecycle'];
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (!Array.isArray(daily) || daily.length !== days || daily.length > 366 || !daily.every((row, offset) => object(row)
    && row['date'] === new Date(Date.parse(from) + offset * 86_400_000).toISOString().slice(0, 10) && amounts(row)) || !Array.isArray(lifecycle) || lifecycle.length > 1000
    || !lifecycle.every(row => object(row) && ['Birth', 'Dormant', 'Revived', 'Death'].includes(row['event'] as string)
      && atomic(row['timestampSeconds']) && BigInt(row['timestampSeconds']) <= BigInt(value['asOfSeconds'] as string)
      && typeof row['transactionHash'] === 'string' && HASH.test(row['transactionHash']) && Number.isSafeInteger(row['logIndex']) && (row['logIndex'] as number) >= 0)) throw invalid();
  for (const [key] of SERIES) if (daily.reduce((sum, row: unknown) => sum + BigInt((row as Amounts)[key]), 0n).toString() !== (value['totals'] as Amounts)[key]) throw invalid();
  const agent = value['agent'], metrics = value['metrics'];
  if (agent === null) { if (metrics !== null || value['state'] !== 'no_data') throw invalid(); }
  else {
    if (!object(agent) || agent['agentId'] !== id || typeof agent['parent'] !== 'string' || !HASH.test(agent['parent'])
      || typeof agent['family'] !== 'string' || !HASH.test(agent['family']) || !['alive', 'dormant', 'dead'].includes(agent['status'] as string)
      || !Number.isSafeInteger(agent['generation']) || (agent['generation'] as number) < 0 || typeof agent['frozen'] !== 'boolean'
      || !atomic(agent['bornAt']) || !['dormantAt', 'deathAt', 'diedAt'].every(key => nullableAtomic(agent[key]))
      || !(agent['deathCause'] === null || typeof agent['deathCause'] === 'string' && HASH.test(agent['deathCause']))
      || !Number.isSafeInteger(agent['livingChildren']) || (agent['livingChildren'] as number) < 0 || (agent['livingChildren'] as number) > 3
      || !Number.isSafeInteger(agent['lifetimeOffspring']) || (agent['lifetimeOffspring'] as number) < (agent['livingChildren'] as number)
      || !amounts(agent['lifetime']) || !object(metrics) || !atomic(metrics['spendableBalanceUnits']) || metrics['balanceAtBlock'] !== index['indexedThrough']
      || !atomic(metrics['trailing24hBurnUnits']) || typeof metrics['trailing24hComplete'] !== 'boolean'
      || !['estimated-from-settled-burn', 'no-observed-burn', 'incomplete-history', 'dead'].includes(metrics['runwayReason'] as string)) throw invalid();
    for (const key of ['metabolism', 'runway']) {
      const ratio = metrics[key]; if (ratio !== null && (!object(ratio) || !atomic(ratio['numerator']) || !atomic(ratio['denominator'])
        || ratio['denominator'] === '0' || ratio['unit'] !== (key === 'runway' ? 'seconds' : 'base-units-per-second'))) throw invalid();
    }
    if (metrics['metabolism'] !== null && (!object(metrics['metabolism']) || metrics['metabolism']['denominator'] !== '86400'
      || metrics['metabolism']['numerator'] !== metrics['trailing24hBurnUnits'])) throw invalid();
    if (metrics['runway'] !== null && (!object(metrics['runway']) || metrics['runwayReason'] !== 'estimated-from-settled-burn'
      || metrics['runway']['denominator'] !== metrics['trailing24hBurnUnits']
      || metrics['runway']['numerator'] !== (BigInt(metrics['spendableBalanceUnits']) * 86_400n).toString())) throw invalid();
  }
  return value as unknown as AgentEconomicsResponse;
}
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag); node.textContent = content; if (className) node.className = className; return node;
}
function time(doc: Document, seconds: string): HTMLTimeElement {
  const iso = new Date(Number(seconds) * 1000).toISOString(), node = text(doc, 'time', iso); node.dateTime = iso; return node;
}
function pair(doc: Document, list: HTMLElement, label: string, value: string | HTMLElement): void {
  const detail = doc.createElement('dd'); detail.append(value); list.append(text(doc, 'dt', label), detail);
}
function transactionLink(doc: Document, chainId: number, hash: string): HTMLElement {
  const origin = chainId === 8453 ? 'https://basescan.org' : chainId === 84532 ? 'https://sepolia.basescan.org' : null;
  if (!origin || !HASH.test(hash)) return text(doc, 'span', hash);
  const link = text(doc, 'a', hash); link.href = origin + '/tx/' + hash; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function chart(doc: Document, data: AgentEconomicsResponse): HTMLElement {
  const figure = doc.createElement('figure'), caption = text(doc, 'figcaption', 'Daily registry flows. Exact values appear in the table. All series share one base-unit scale.');
  figure.append(caption); const ns = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Five daily registry flow series; exact accessible table follows.');
  const observed = data.daily.filter(row => BigInt(Date.parse(row.date) / 1000) <= BigInt(data.asOfSeconds)
    && BigInt(Date.parse(row.date) / 1000) + 86_400n > BigInt(data.coverage.historyStartSeconds));
  const maximum = observed.reduce((max, row) => SERIES.reduce((value, [key]) => BigInt(row[key]) > value ? BigInt(row[key]) : value, max), 0n);
  for (const [index, [key]] of SERIES.entries()) {
    const line = doc.createElementNS(ns, 'polyline'); line.setAttribute('class', 'agent-series agent-series-' + index);
    line.setAttribute('points', observed.map((row, offset) => {
      const x = CHART_INSET + offset * (CHART_WIDTH - 2 * CHART_INSET) / Math.max(1, observed.length - 1);
      const ratio = maximum === 0n ? 0 : Number(BigInt(row[key]) * CHART_RATIO / maximum) / Number(CHART_RATIO);
      const y = CHART_HEIGHT - CHART_INSET - ratio * (CHART_HEIGHT - 2 * CHART_INSET); return x + ',' + y;
    }).join(' ')); svg.append(line);
  }
  figure.append(svg); const legend = text(doc, 'ul', '', 'agent-legend');
  SERIES.forEach(([, label], index) => legend.append(text(doc, 'li', label, 'agent-key agent-series-' + index))); figure.append(legend); return figure;
}
function render(results: HTMLElement, data: AgentEconomicsResponse): void {
  const doc = results.ownerDocument; results.replaceChildren(); results.dataset['state'] = data.state;
  const title = text(doc, 'h2', ({ ready: 'Agent economics', partial: 'Partial agent evidence', stale: 'Stale agent evidence', no_data: 'No events in this period' })[data.state]);
  title.id = 'agent-economics-result-title'; results.append(title);
  const source = text(doc, 'p', `Source: canonical persisted Selection registry events. UTC block timestamps. Indexed through block ${data.index.indexedThrough}, revision ${data.index.revision}. As of `);
  source.append(time(doc, data.asOfSeconds)); results.append(source, text(doc, 'p', `Period: ${data.period.from} through ${data.period.to}, inclusive (UTC).`));
  const coverage = data.coverage;
  results.append(text(doc, 'p', `Observed history starts at block ${coverage.historyStartBlock}. ${coverage.partialStart ? 'Start coverage is partial. ' : ''}${coverage.partialEnd ? 'End coverage is partial. ' : ''}${coverage.stale ? 'The indexed anchor is more than 15 minutes old. ' : ''}Deployment history is not verified.`));
  results.append(text(doc, 'p', 'Amounts are exact registry token base units. Token decimals and symbol are not verified. Registry Income records a classification, not independently verified earnings. Self funding, circular transfers and top ups are not established as earned revenue. Subsidy is separate; unclassified transfers are excluded. Verified earned revenue: unavailable.'));
  if (!data.agent || !data.metrics) { results.append(text(doc, 'p', 'No indexed agent was found for this ID. Check the ID and the source coverage.')); return; }
  const agent = data.agent, metrics = data.metrics, summary = text(doc, 'dl', '', 'agent-economics-summary');
  pair(doc, summary, 'Agent', agent.agentId); pair(doc, summary, 'Lifecycle', agent.status + (agent.frozen ? ' · frozen' : ''));
  pair(doc, summary, 'Born', time(doc, agent.bornAt)); pair(doc, summary, 'Family', agent.family); pair(doc, summary, 'Parent', agent.parent);
  pair(doc, summary, 'Generation', String(agent.generation)); pair(doc, summary, 'Living children (maximum 3)', String(agent.livingChildren));
  pair(doc, summary, 'Lifetime offspring', String(agent.lifetimeOffspring));
  if (agent.dormantAt !== null) pair(doc, summary, 'Dormant since', time(doc, agent.dormantAt));
  if (agent.deathAt !== null) pair(doc, summary, 'Indexed death deadline', time(doc, agent.deathAt));
  if (agent.diedAt !== null) pair(doc, summary, 'Died', time(doc, agent.diedAt));
  pair(doc, summary, 'Death reason (registry bytes32)', agent.deathCause ?? 'No death recorded');
  pair(doc, summary, `Spendable balance at block ${metrics.balanceAtBlock}`, metrics.spendableBalanceUnits + ' base units');
  pair(doc, summary, 'Settled burn in trailing 24 hours', metrics.trailing24hBurnUnits + ' base units' + (metrics.trailing24hComplete ? '' : ' · incomplete history'));
  pair(doc, summary, 'Observed metabolism', metrics.metabolism ? `${metrics.metabolism.numerator} / ${metrics.metabolism.denominator} base units per second` : 'Unavailable: incomplete history');
  const reason = { dead: 'No runway estimate for a dead agent', 'no-observed-burn': 'No estimate: no settled burn observed',
    'incomplete-history': 'No estimate: incomplete history', 'estimated-from-settled-burn': 'Estimated from the last 24 hours of settled burn' }[metrics.runwayReason];
  pair(doc, summary, 'Runway', metrics.runway ? `${metrics.runway.numerator} / ${metrics.runway.denominator} seconds · ${reason}` : reason);
  results.append(summary, text(doc, 'p', 'Metabolism describes observed settled burn, not a configured rate. Runway is an estimate at the pinned balance and assumes the same burn rate.'));
  results.append(text(doc, 'h3', 'Daily flows'), chart(doc, data));
  const holder = text(doc, 'div', '', 'agent-economics-table'), table = doc.createElement('table');
  holder.tabIndex = 0; holder.setAttribute('role', 'region'); holder.setAttribute('aria-label', 'Exact daily flows table; scroll horizontally for all columns');
  const caption = text(doc, 'caption', 'Exact observed amounts in registry token base units. Net income = gross registry income − fee. Burn and subsidy remain separate. Partial days show observed totals only; days without indexed coverage have no amount.'); table.append(caption);
  const head = doc.createElement('thead'), header = doc.createElement('tr');
  for (const label of ['UTC day', ...SERIES.map(([, label]) => label)]) { const th = text(doc, 'th', label); th.scope = 'col'; header.append(th); } head.append(header); table.append(head);
  const body = doc.createElement('tbody');
  for (const row of data.daily) {
    const start = BigInt(Date.parse(row.date) / 1000), end = start + 86_400n;
    const missing = start > BigInt(data.asOfSeconds) || end <= BigInt(coverage.historyStartSeconds);
    const partial = !missing && (start < BigInt(coverage.historyStartSeconds) || end - 1n > BigInt(data.asOfSeconds));
    const tr = doc.createElement('tr'), th = text(doc, 'th', row.date + (partial ? ' · partial' : '')); th.scope = 'row'; tr.append(th);
    for (const [key] of SERIES) tr.append(text(doc, 'td', missing ? 'No indexed coverage' : row[key])); body.append(tr);
  } table.append(body);
  const foot = doc.createElement('tfoot');
  for (const [label, amount] of [['Period total', data.totals], ['Lifetime at indexed anchor', agent.lifetime]] as const) {
    const row = doc.createElement('tr'), th = text(doc, 'th', label); th.scope = 'row'; row.append(th); SERIES.forEach(([key]) => row.append(text(doc, 'td', amount[key]))); foot.append(row);
  }
  table.append(foot); holder.append(table); results.append(holder, text(doc, 'h3', 'Lifecycle in this period'));
  if (coverage.lifecycleTruncated) results.append(text(doc, 'p', 'Showing the most recent 1,000 lifecycle events. Daily monetary totals cover the full selected period.'));
  const list = doc.createElement('ol');
  for (const event of data.lifecycle) { const item = text(doc, 'li', event.event + ' · '); item.append(time(doc, event.timestampSeconds), ' · ', transactionLink(doc, data.index.chainId, event.transactionHash), ` · log ${event.logIndex}`); list.append(item); }
  results.append(data.lifecycle.length ? list : text(doc, 'p', 'No Birth, Dormant, Revived or Death events in this period.'));
}

/** Manual refresh only. The caller supplies the shared, trusted pageHero markup. */
export function mountAgentEconomics(main: HTMLElement, heroHtml: string, agentId: string): () => void {
  main.innerHTML = heroHtml + `<section class="section agent-economics" aria-labelledby="agent-economics-form-title">
    <div class="section-top"><div><div class="eyebrow">Public agent record</div><h2 id="agent-economics-form-title">Follow the flows.</h2></div><p>Read canonical registry income, fees, burn and subsidy alongside the agent lifecycle.</p></div>
    <p class="agent-economics-id"></p><form class="inline-form" novalidate>
    <label class="field"><span>From (UTC)</span><input name="from" type="date" required aria-describedby="agent-economics-date-help agent-economics-error"></label>
    <label class="field"><span>Through (UTC)</span><input name="to" type="date" required aria-describedby="agent-economics-date-help agent-economics-error"></label>
    <p id="agent-economics-date-help">Choose up to 366 inclusive days. Refresh reads this source once; no wallet is needed.</p>
    <p id="agent-economics-error" role="alert" hidden></p><button class="pill primary" type="submit">Refresh agent record <span aria-hidden="true">↗</span></button>
    <p id="agent-economics-progress" role="status" aria-live="polite"></p></form>
    <section class="agent-economics-results" aria-labelledby="agent-economics-result-title" hidden></section></section>`;
  const doc = main.ownerDocument, section = main.querySelector<HTMLElement>('.agent-economics')!, form = section.querySelector<HTMLFormElement>('form')!;
  const from = form.elements.namedItem('from') as HTMLInputElement, to = form.elements.namedItem('to') as HTMLInputElement;
  const error = section.querySelector<HTMLElement>('#agent-economics-error')!, progress = section.querySelector<HTMLElement>('#agent-economics-progress')!;
  const results = section.querySelector<HTMLElement>('.agent-economics-results')!, button = form.querySelector<HTMLButtonElement>('button')!;
  const id = agentId.toLowerCase(); section.querySelector<HTMLElement>('.agent-economics-id')!.textContent = 'Agent: ' + id;
  const today = new Date(); to.value = today.toISOString().slice(0, 10); today.setUTCDate(today.getUTCDate() - 29); from.value = today.toISOString().slice(0, 10);
  let active: AbortController | undefined, generation = 0, destroyed = false;
  const abort = (): void => { generation++; active?.abort(); active = undefined; button.disabled = false; button.removeAttribute('aria-busy'); };
  const visibility = (): void => { if (doc.hidden) { abort(); progress.textContent = 'Paused while this page is hidden. Refresh to read again.'; } };
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault(); if (active || destroyed || doc.hidden) return;
    error.hidden = true; error.textContent = ''; from.removeAttribute('aria-invalid'); to.removeAttribute('aria-invalid');
    const fromValue = from.value, toValue = to.value;
    if (!HASH.test(id)) { error.textContent = 'The agent ID must contain 0x followed by 64 hexadecimal characters.'; error.hidden = false; return; }
    if (!validDate(fromValue) || !validDate(toValue) || Date.parse(toValue) < Date.parse(fromValue) || Date.parse(toValue) - Date.parse(fromValue) >= 366 * 86_400_000) {
      error.textContent = 'Choose valid UTC dates spanning at most 366 inclusive days.'; error.hidden = false; from.setAttribute('aria-invalid', 'true'); to.setAttribute('aria-invalid', 'true'); return;
    }
    const controller = new AbortController(), current = ++generation; active = controller; let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    results.hidden = true; button.disabled = true; button.setAttribute('aria-busy', 'true'); progress.textContent = 'Loading canonical agent evidence…';
    try {
      const query = new URLSearchParams({ from: fromValue, to: toValue });
      const response = await fetch('/api/public/selection/agents/' + encodeURIComponent(id) + '?' + query.toString(),
        { credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (Number(response.headers.get('content-length') ?? '0') > RESPONSE_LIMIT) throw new Error('The agent response exceeds its size limit.');
      const raw = await response.text(); if (raw.length > RESPONSE_LIMIT) throw new Error('The agent response exceeds its size limit.');
      let value: unknown; try { value = JSON.parse(raw) as unknown; } catch { throw new Error('The agent source returned an unreadable report. Refresh to retry.'); }
      if (!response.ok) {
        const code = object(value) ? value['title'] ?? value['code'] : undefined;
        section.dataset['state'] = code === 'agent_economics_not_configured' ? 'not_configured' : 'unavailable';
        throw new Error(code === 'agent_economics_not_configured' ? 'Selection is not configured. Indexed agent evidence is unavailable.'
          : response.status === 409 ? 'The indexed snapshot changed. Refresh the record again.' : response.status === 404 ? 'This agent feature is not enabled.'
          : 'Agent evidence is unavailable. Your dates are retained; refresh to retry.');
      }
      const data = readResponse(value, id, fromValue, toValue);
      if (destroyed || current !== generation || !section.isConnected || doc.hidden) return;
      render(results, data); results.hidden = false; section.dataset['state'] = data.state; progress.textContent = 'Agent evidence loaded. Manual refresh only.';
    } catch (failure) {
      if (destroyed || current !== generation || !section.isConnected || doc.hidden) return;
      error.textContent = timedOut ? 'The source timed out after 40 seconds. Your dates are retained; refresh to retry.'
        : failure instanceof Error ? failure.message : 'Agent evidence is unavailable. Refresh to retry.';
      error.hidden = false; progress.textContent = '';
    } finally { clearTimeout(timeout); if (current === generation) { active = undefined; button.disabled = false; button.removeAttribute('aria-busy'); } }
  };
  const cleanup = (): void => { if (destroyed) return; destroyed = true; abort(); observer.disconnect(); doc.removeEventListener('visibilitychange', visibility);
    doc.defaultView?.removeEventListener('pagehide', cleanup); form.removeEventListener('submit', submit); };
  const observer = new MutationObserver(() => { if (!section.isConnected) cleanup(); }); observer.observe(main, { childList: true });
  doc.addEventListener('visibilitychange', visibility); doc.defaultView?.addEventListener('pagehide', cleanup); form.addEventListener('submit', submit);
  return cleanup;
}
