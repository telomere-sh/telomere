const MAX_RECEIPT_LENGTH = 131_072;
const REQUEST_TIMEOUT_MS = 40_000;
const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const OUTCOMES = ['verified', 'invalid', 'incomplete', 'unavailable'] as const;
const STEP_STATUSES = ['passed', 'failed', 'not_applicable', 'not_checked', 'unavailable'] as const;
type Outcome = typeof OUTCOMES[number];
type StepStatus = typeof STEP_STATUSES[number];
type VerificationStep = {id: string; label: string; status: StepStatus; detail: string};
type VerificationSummary = {
  runId: string; receiptHash: string; billableSeconds: number;
  charged: string; refund: string; ceiling: string; token: string; escrow: string;
  chainId: number; settlementTxHash?: string;
};
type VerificationReport = {
  outcome: Outcome; checkedAt: string; steps: VerificationStep[]; summary?: VerificationSummary;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readReport(value: unknown): VerificationReport {
  const badResponse = () => new Error('The verifier returned an unexpected report. Try again; if this continues, contact the operator.');
  if (!object(value) || !OUTCOMES.includes(value['outcome'] as Outcome)
    || typeof value['checkedAt'] !== 'string' || !Number.isFinite(Date.parse(value['checkedAt']))
    || !Array.isArray(value['steps']) || value['steps'].length > 100) throw badResponse();
  const steps: VerificationStep[] = value['steps'].map((step: unknown) => {
    if (!object(step) || typeof step['id'] !== 'string' || typeof step['label'] !== 'string'
      || typeof step['detail'] !== 'string' || !STEP_STATUSES.includes(step['status'] as StepStatus)) throw badResponse();
    return {id: step['id'], label: step['label'], status: step['status'] as StepStatus, detail: step['detail']};
  });
  const report: VerificationReport = {outcome: value['outcome'] as Outcome, checkedAt: value['checkedAt'], steps};
  const summary = value['summary'];
  if (summary !== undefined) {
    if (!object(summary)
      || !['runId', 'receiptHash', 'token', 'escrow'].every(key => typeof summary[key] === 'string')
      || !['charged', 'refund', 'ceiling'].every(key => typeof summary[key] === 'string' && /^\d{1,100}$/.test(summary[key]))
      || typeof summary['billableSeconds'] !== 'number' || !Number.isSafeInteger(summary['billableSeconds']) || summary['billableSeconds'] < 0
      || typeof summary['chainId'] !== 'number' || !Number.isSafeInteger(summary['chainId'])
      || (summary['settlementTxHash'] !== undefined && typeof summary['settlementTxHash'] !== 'string')) throw badResponse();
    report.summary = summary as VerificationSummary;
  }
  return report;
}

function formatUsdc(atomic: string): string {
  const amount = BigInt(atomic);
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ''} USDC`;
}

function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

const OUTCOME_COPY: Record<Outcome, [string, string]> = {
  verified: ['Receipt verified', 'The required metering and settlement checks passed. Review each step for checks that do not apply.'],
  invalid: ['Receipt invalid', 'At least one check failed. Review the failed steps before relying on this record.'],
  incomplete: ['Verification incomplete', 'Some evidence is missing or has not been checked. This report does not confirm the complete record.'],
  unavailable: ['Verification unavailable', 'A required service or source of evidence is unavailable. Try again when it is available.'],
};
const STATUS_LABELS: Record<StepStatus, string> = {
  passed: 'Passed', failed: 'Failed', not_applicable: 'Not applicable', not_checked: 'Not checked', unavailable: 'Unavailable',
};

function renderReport(results: HTMLElement, report: VerificationReport): void {
  const doc = results.ownerDocument;
  const [heading, description] = OUTCOME_COPY[report.outcome];
  results.replaceChildren();
  results.dataset['outcome'] = report.outcome;
  const title = text(doc, 'h2', heading);
  title.id = 'receipt-result-title';
  const headingRegion = doc.createElement('div');
  headingRegion.className = 'section-top';
  const headingHolder = doc.createElement('div');
  headingHolder.append(title);
  headingRegion.append(headingHolder, text(doc, 'p', description));
  results.append(headingRegion);
  const checked = text(doc, 'p', 'Checked at ');
  const time = text(doc, 'time', new Date(report.checkedAt).toISOString());
  time.dateTime = report.checkedAt;
  checked.append(time);
  results.append(checked);
  if (report.summary) {
    const summary = report.summary;
    const details = doc.createElement('dl');
    details.className = 'receipt-summary';
    const rows: [string, string][] = [
      ['Run ID', summary.runId], ['Receipt hash', summary.receiptHash],
      ['Billable seconds', String(summary.billableSeconds)], ['Charged', formatUsdc(summary.charged)],
      ['Refund to escrow', formatUsdc(summary.refund)], ['Ceiling', formatUsdc(summary.ceiling)],
      ['Token', summary.token], ['Escrow', summary.escrow], ['Chain ID', String(summary.chainId)],
    ];
    if (summary.settlementTxHash) rows.push(['Settlement transaction', summary.settlementTxHash]);
    for (const [label, value] of rows) {
      const row = doc.createElement('div');
      row.append(text(doc, 'dt', label), text(doc, 'dd', value));
      details.append(row);
    }
    results.append(details);
  }
  results.append(text(doc, 'h3', 'Verification steps'));
  const steps = doc.createElement('ol');
  steps.className = 'receipt-steps';
  for (const step of report.steps) {
    const item = doc.createElement('li');
    item.dataset['status'] = step.status;
    item.append(text(doc, 'h4', step.label), text(doc, 'span', STATUS_LABELS[step.status], 'mono'), text(doc, 'p', step.detail));
    steps.append(item);
  }
  results.append(steps);
  results.hidden = false;
}

function httpError(status: number): string {
  if (status === 400 || status === 422) return 'The verifier rejected this input. Check the receipt JSON or run ID, then submit again.';
  if (status === 404) return 'No public receipt was found for this run. Paste the signed receipt JSON, or check the run ID and try again.';
  if (status === 413) return 'This receipt exceeds the verifier request limit. Submit a smaller receipt document.';
  if (status === 429) return 'The verifier is receiving too many requests. Wait a minute, then try again.';
  if (status === 401 || status === 403) return 'Public verification access is unavailable. Try again later or contact the operator; no wallet sign-in is required.';
  return `The verifier returned HTTP ${status}. Try again shortly; if this continues, contact the operator.`;
}

/** Public, read-only verification; submission is the only network trigger. */
export function mountReceiptVerifier(main: HTMLElement, heroHtml: string): void {
  main.innerHTML = heroHtml + `<section class="section receipt-verifier" aria-labelledby="receipt-form-title">
    <div class="section-top"><div><div class="eyebrow">Public verification</div><h2 id="receipt-form-title">Check the record.</h2></div><p>Verify operator-signed metering and on-chain settlement for a run paid in USDC on Base.</p></div>
    <form class="inline-form" id="receipt-verifier-form" novalidate>
      <p class="receipt-help" id="receipt-privacy">No wallet, signature, payment or public publishing is needed. Your JSON goes only to this site's verifier. It is not stored or echoed in responses. Never include private keys or secrets.</p>
      <label class="field"><span>Verify using</span><select id="receipt-source" name="source"><option value="receipt">Receipt JSON</option><option value="runId">Run ID</option></select></label>
      <label class="field" id="receipt-json-field"><span>Receipt JSON</span><textarea id="receipt-json" name="receipt" rows="10" maxlength="131072" spellcheck="false" autocomplete="off" aria-describedby="receipt-json-help receipt-error"></textarea></label>
      <p class="receipt-help" id="receipt-json-help">Paste a signed receipt, a full execution record, or an hourly proof containing a receipt. Maximum 131,072 characters.</p>
      <label class="field" id="receipt-run-field" hidden><span>Run ID</span><input id="receipt-run-id" name="runId" type="text" maxlength="66" spellcheck="false" autocomplete="off" placeholder="0x…" aria-describedby="receipt-run-help receipt-error"></label>
      <p class="receipt-help" id="receipt-run-help" hidden>Enter 0x followed by 64 hexadecimal characters. Public lookup returns only the receipt verification report.</p>
      <label class="field"><span>Settlement transaction hash (optional)</span><input id="receipt-tx-hash" name="settlementTxHash" type="text" maxlength="66" spellcheck="false" autocomplete="off" placeholder="0x…" aria-describedby="receipt-tx-help receipt-error"></label>
      <p class="receipt-help" id="receipt-tx-help">Supply a known settlement transaction to check against the receipt. Otherwise the verifier uses available settlement evidence.</p>
      <p class="receipt-error" id="receipt-error" role="alert" hidden></p>
      <button class="pill primary" type="submit">Verify receipt <span aria-hidden="true">↗</span></button>
      <p class="receipt-help" id="receipt-progress" role="status" aria-live="polite"></p>
    </form>
    <div class="receipt-scope"><h3>What verification establishes</h3><p>These checks cover the operator-signed usage record and canonical escrow settlement. They do not prove the mathematical output or sealed execution. Meter-chain integrity is distinct from independent host signatures. Hourly-root checks apply only when the configured profile and supplied evidence support them; otherwise they are marked not applicable.</p></div>
    <section class="receipt-results" aria-labelledby="receipt-result-title" hidden></section>
  </section>`;
  const form = main.querySelector<HTMLFormElement>('#receipt-verifier-form')!;
  const source = main.querySelector<HTMLSelectElement>('#receipt-source')!;
  const receipt = main.querySelector<HTMLTextAreaElement>('#receipt-json')!;
  const runId = main.querySelector<HTMLInputElement>('#receipt-run-id')!;
  const transaction = main.querySelector<HTMLInputElement>('#receipt-tx-hash')!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const error = main.querySelector<HTMLElement>('#receipt-error')!;
  const progress = main.querySelector<HTMLElement>('#receipt-progress')!;
  const results = main.querySelector<HTMLElement>('.receipt-results')!;
  const clearError = (): void => {
    error.hidden = true;
    error.textContent = '';
    for (const field of [receipt, runId, transaction]) field.removeAttribute('aria-invalid');
  };
  source.addEventListener('change', () => {
    const useReceipt = source.value === 'receipt';
    main.querySelector<HTMLElement>('#receipt-json-field')!.hidden = !useReceipt;
    main.querySelector<HTMLElement>('#receipt-json-help')!.hidden = !useReceipt;
    main.querySelector<HTMLElement>('#receipt-run-field')!.hidden = useReceipt;
    main.querySelector<HTMLElement>('#receipt-run-help')!.hidden = useReceipt;
    clearError();
  });
  const invalid = (field: HTMLInputElement | HTMLTextAreaElement, message: string): void => {
    field.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    field.focus();
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    clearError();
    results.hidden = true;
    progress.textContent = '';
    const payload: {receipt?: unknown; runId?: string; settlementTxHash?: string} = {};
    if (source.value === 'receipt') {
      if (!receipt.value.trim()) { invalid(receipt, 'Paste a receipt JSON document to verify.'); return; }
      if (receipt.value.length > MAX_RECEIPT_LENGTH) { invalid(receipt, 'Receipt JSON must contain at most 131,072 characters.'); return; }
      try { payload.receipt = JSON.parse(receipt.value) as unknown; }
      catch { invalid(receipt, 'Receipt JSON is not valid. Check its quotes, commas and brackets, then submit again.'); return; }
      if (!object(payload.receipt)) { invalid(receipt, 'Paste a JSON object containing a signed receipt or execution record.'); return; }
    } else {
      const id = runId.value.trim();
      if (!ID_PATTERN.test(id)) { invalid(runId, 'Run ID must be 0x followed by 64 hexadecimal characters.'); return; }
      payload.runId = id;
    }
    const txHash = transaction.value.trim();
    if (txHash && !ID_PATTERN.test(txHash)) { invalid(transaction, 'Settlement transaction hash must be 0x followed by 64 hexadecimal characters.'); return; }
    if (txHash) payload.settlementTxHash = txHash;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    progress.textContent = 'Checking the signature, metering evidence and settlement. This may take up to 40 seconds.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch('/api/public/receipts/verify', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) throw new Error(httpError(response.status));
      let value: unknown;
      try { value = await response.json() as unknown; }
      catch { throw new Error('The verifier returned an unreadable report. Try again shortly.'); }
      const report = readReport(value);
      renderReport(results, report);
      progress.textContent = `${OUTCOME_COPY[report.outcome][0]}. Review the report below.`;
    } catch (failure: unknown) {
      error.textContent = controller.signal.aborted
        ? 'Verification timed out after 40 seconds. Your input is retained; try again shortly.'
        : failure instanceof TypeError
          ? 'The verifier could not be reached. Check your connection, then try again.'
          : failure instanceof Error ? failure.message : 'Verification did not complete. Try again shortly.';
      error.hidden = false;
      progress.textContent = '';
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
}
