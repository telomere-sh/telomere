const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const AMOUNT = /^(0|[1-9][0-9]{0,27})$/;
const SOURCE = 'Operator-signed receipt and canonical escrow settlement';
type Summary = { runId: string; receiptHash: string; charged: string; refund: string; ceiling: string;
  billableSeconds: number; chainId: number; escrow: string; token: string; settlementTxHash: string };
type Shared = { state: 'ready'; summary: Summary; asOf: string; publishedAt: string; source: string };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function read(value: unknown, runId: string): Shared {
  if (!object(value) || value['state'] !== 'ready' || value['source'] !== SOURCE
    || typeof value['asOf'] !== 'string' || !Number.isFinite(Date.parse(value['asOf']))
    || typeof value['publishedAt'] !== 'string' || !Number.isFinite(Date.parse(value['publishedAt'])) || !object(value['summary'])) throw new Error('The public receipt response is incomplete. Retry shortly.');
  const s = value['summary'];
  if (!['runId', 'receiptHash', 'settlementTxHash'].every(k => typeof s[k] === 'string' && HASH.test(s[k]))
    || s['runId'] !== runId || !['escrow', 'token'].every(k => typeof s[k] === 'string' && ADDRESS.test(s[k]))
    || !['charged', 'refund', 'ceiling'].every(k => typeof s[k] === 'string' && AMOUNT.test(s[k]))
    || typeof s['billableSeconds'] !== 'number' || !Number.isSafeInteger(s['billableSeconds']) || s['billableSeconds'] < 0 || s['billableSeconds'] > 120
    || typeof s['chainId'] !== 'number' || !Number.isSafeInteger(s['chainId']) || s['chainId'] <= 0
    || BigInt(s['charged'] as string) + BigInt(s['refund'] as string) !== BigInt(s['ceiling'] as string)) throw new Error('The public receipt response is incomplete. Retry shortly.');
  return { state: 'ready', source: SOURCE, asOf: value['asOf'], publishedAt: value['publishedAt'], summary: s as Summary };
}
function usdc(value: string): string { const n = BigInt(value); return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDC`; }
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = value; if (className) element.className = className; return element;
}
function scan(chainId: number): string | undefined { return chainId === 8453 ? 'https://basescan.org' : chainId === 84532 ? 'https://sepolia.basescan.org' : undefined; }

/** Owner opted-in summary only; no wallet, receipt upload or private run endpoint. */
export function mountSharedReceipt(main: HTMLElement, heroHtml: string, id: string): () => void {
  const runId = id.toLowerCase();
  main.innerHTML = heroHtml + `<section class="section shared-receipt" aria-labelledby="shared-receipt-title">
    <div class="section-top"><div><div class="eyebrow">Public receipt</div><h2 id="shared-receipt-title">A shared settlement record.</h2></div><p>The owner chose to publish this summary. Each view checks the signed record and current canonical settlement.</p></div>
    <p class="shared-receipt-progress" role="status" aria-live="polite"></p>
    <p class="shared-receipt-error" role="alert" hidden></p>
    <div class="shared-receipt-result" hidden></div>
    <button class="pill" type="button" hidden>Retry receipt check <span aria-hidden="true">↗</span></button>
    <div class="shared-receipt-scope"><h3>What this record establishes</h3><p>Operator-signed metering and canonical escrow settlement. This summary does not prove mathematical output, sealed execution or hardware attestation. It contains no input, output, owner identity or raw receipt.</p><p>The owner can revoke this page. External preview caches may retain a summary that was already public.</p></div>
  </section>`;
  const doc = main.ownerDocument, section = main.querySelector<HTMLElement>('.shared-receipt')!;
  const progress = section.querySelector<HTMLElement>('.shared-receipt-progress')!;
  const error = section.querySelector<HTMLElement>('.shared-receipt-error')!;
  const result = section.querySelector<HTMLElement>('.shared-receipt-result')!;
  const retry = section.querySelector<HTMLButtonElement>('button')!;
  let pending: AbortController | undefined, stopped = false;
  const active = (): boolean => !stopped && !doc.hidden && !main.hidden && !main.inert
    && main.id === 'page-content' && main.contains(section);
  const render = (receipt: Shared): void => {
    const s = receipt.summary, details = doc.createElement('dl'); details.className = 'shared-receipt-details';
    const rows: [string, string][] = [['Run ID', s.runId], ['Receipt hash', s.receiptHash], ['Charged', usdc(s.charged)],
      ['Refund to escrow', usdc(s.refund)], ['Ceiling', usdc(s.ceiling)], ['Billable seconds', String(s.billableSeconds)],
      ['Chain ID', String(s.chainId)], ['Escrow', s.escrow], ['Token', s.token], ['Settlement transaction', s.settlementTxHash]];
    const base = scan(s.chainId);
    for (const [label, value] of rows) {
      const row = doc.createElement('div'), dd = text(doc, 'dd', value);
      if (base && ['Escrow', 'Token', 'Settlement transaction'].includes(label)) {
        const link = text(doc, 'a', value);
        link.href = `${base}/${label === 'Settlement transaction' ? 'tx' : 'address'}/${value}`;
        link.rel = 'noopener noreferrer'; dd.replaceChildren(link);
      }
      row.append(text(doc, 'dt', label), dd); details.append(row);
    }
    const heading = text(doc, 'h3', 'Current settlement verified');
    const source = text(doc, 'p', `Source: ${receipt.source}. Coverage: this run only; USDC amounts use six decimal places.`);
    const checked = text(doc, 'p', 'Checked at '), checkedTime = text(doc, 'time', new Date(receipt.asOf).toISOString());
    checkedTime.dateTime = receipt.asOf; checked.append(checkedTime);
    const published = text(doc, 'p', 'Published at '), publishedTime = text(doc, 'time', new Date(receipt.publishedAt).toISOString());
    publishedTime.dateTime = receipt.publishedAt; published.append(publishedTime);
    result.replaceChildren(heading, source, checked, published, details); result.hidden = false;
  };
  const load = async (): Promise<void> => {
    if (pending || !active()) return;
    result.hidden = true; result.replaceChildren(); error.hidden = true; error.textContent = ''; retry.hidden = true;
    if (!HASH.test(runId)) { section.dataset['state'] = 'no_data'; progress.textContent = 'This receipt is not publicly available.'; return; }
    const controller = new AbortController(); pending = controller;
    section.dataset['state'] = 'loading'; progress.textContent = 'Checking current receipt and settlement evidence…';
    retry.disabled = true;
    const timeout = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(`/api/public/receipt-links/${encodeURIComponent(runId)}`, { credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!active()) return;
      if (response.status === 404) { section.dataset['state'] = 'no_data'; progress.textContent = 'This receipt is not publicly available. It may be unpublished, revoked or awaiting matching settlement evidence.'; return; }
      if (!response.ok) throw new Error(response.status === 429 ? 'Receipt verification is busy. Retry shortly.' : 'Current receipt evidence is unavailable. Retry shortly; no cached verification is shown.');
      const receipt = read(await response.json() as unknown, runId);
      if (!active()) return;
      render(receipt); section.dataset['state'] = 'ready'; progress.textContent = 'Current receipt and canonical settlement verified.';
    } catch (failure) {
      if (!active()) return;
      section.dataset['state'] = 'unavailable'; progress.textContent = '';
      error.textContent = controller.signal.aborted ? 'The current receipt check timed out. Retry shortly.' : failure instanceof Error ? failure.message : 'Current receipt evidence is unavailable. Retry shortly.';
      error.hidden = false;
    } finally {
      clearTimeout(timeout); pending = undefined; retry.disabled = false;
      if (active()) retry.hidden = false;
    }
  };
  const retryClick = (): void => { void load(); };
  retry.addEventListener('click', retryClick);
  const hide = (): void => {
    pending?.abort(); result.hidden = true; result.replaceChildren();
    section.dataset['state'] = 'partial'; progress.textContent = 'Recheck this receipt for current settlement evidence.';
  };
  const visibility = (): void => { if (doc.hidden) hide(); else if (active()) { if (pending) retry.hidden = false; else void load(); } };
  const dispose = (): void => {
    stopped = true; pending?.abort(); observer.disconnect(); retry.removeEventListener('click', retryClick);
    doc.removeEventListener('visibilitychange', visibility); doc.defaultView?.removeEventListener('pagehide', dispose);
  };
  const observer = new MutationObserver(() => {
    if (!main.contains(section) || main.hidden || main.inert || main.id !== 'page-content') dispose();
  });
  observer.observe(main, { childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'id'] });
  doc.addEventListener('visibilitychange', visibility); doc.defaultView?.addEventListener('pagehide', dispose, { once: true });
  void load();
  return dispose;
}
