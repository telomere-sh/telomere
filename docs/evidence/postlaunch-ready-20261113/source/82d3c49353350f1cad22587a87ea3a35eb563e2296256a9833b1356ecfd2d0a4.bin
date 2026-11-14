import { buildRequestExamples, RequestExampleError, requestExampleOrigin, type RequestExamples, type RequestExampleContext } from '../../src/updates/request-examples.js';

type Language = 'curl' | 'typescript' | 'python';
const LANGUAGES: Record<Language, string> = {curl: 'curl', typescript: 'TypeScript', python: 'Python'};

/** Offline authoring only. Optional context is supplied by reviewed runtime configuration. */
export function mountCopyExamples(main: HTMLElement, heroHtml: string, options: {serverOrigin?: string; runtimeMaxSeconds?: number} = {}): void {
  const doc = main.ownerDocument;
  const runtimeMaxSeconds = options.runtimeMaxSeconds ?? 120;
  const originInput = options.serverOrigin ?? doc.location.origin;
  main.innerHTML = heroHtml + `<section class="section copy-examples" aria-labelledby="copy-examples-title">
    <div class="section-top"><div><div class="eyebrow">Developer tools</div><h2 id="copy-examples-title">One request. Three languages.</h2></div><p>Build a Legacy CPU quote request locally, review its JSON, then copy a runnable example.</p></div>
    <p class="copy-help">Use an existing confirmed Leash that belongs to your signed-in wallet. Run the example only after your signed-wallet API login. It prepares a quote and an unsigned transaction; it does not broadcast a transaction, approve tokens or start a run.</p>
    <form class="inline-form" id="copy-examples-form" novalidate>
      <label class="field"><span>Server origin</span><input id="copy-origin" type="text" readonly aria-describedby="copy-origin-help"></label>
      <p class="copy-help" id="copy-origin-help">Pinned to this site's production origin, or a loopback origin for local testing. This tool sends no API requests.</p>
      <label class="field"><span>Existing confirmed Leash ID</span><input id="copy-leash" name="leashId" type="text" maxlength="66" spellcheck="false" autocomplete="off" placeholder="0x…" aria-describedby="copy-leash-help copy-error" required></label>
      <p class="copy-help" id="copy-leash-help">0x followed by 64 hexadecimal characters. The server verifies ownership when you run the snippet.</p>
      <label class="field"><span>SHA-256 task text</span><textarea id="copy-task" name="taskText" rows="5" maxlength="8192" spellcheck="false" autocomplete="off" aria-describedby="copy-task-help copy-error"></textarea></label>
      <p class="copy-help" id="copy-task-help">Up to 8,192 UTF-8 bytes. Task text appears in the code and clipboard; leave secrets out.</p>
      <label class="field"><span>Maximum CPU seconds</span><input id="copy-seconds" name="maxSeconds" type="number" min="1" step="1" value="10" required aria-describedby="copy-limit-help copy-error"></label>
      <p class="copy-help" id="copy-limit-help"></p>
      <label class="field"><span>Idempotency key</span><input id="copy-key" name="idempotencyKey" type="text" minlength="8" maxlength="128" spellcheck="false" autocomplete="off" required aria-describedby="copy-key-help copy-error"></label>
      <p class="copy-help" id="copy-key-help">Reuse this key only for retries of this exact request. Choose a fresh key for a different request.</p>
      <p id="copy-error" class="copy-error" role="alert" hidden></p>
      <button class="pill primary" type="submit">Prepare examples <span aria-hidden="true">↗</span></button>
    </form>
    <section class="copy-output" aria-labelledby="copy-review-title" hidden>
      <h3 id="copy-review-title">Review the request</h3>
      <dl class="copy-details"><div><dt>Method and endpoint</dt><dd id="copy-endpoint"></dd></div><div><dt>Authentication</dt><dd>Set TELOMERE_SESSION privately in your terminal from a prior signed-wallet API login. The script sends telomere_session as a Cookie header.</dd></div><div><dt>Browser session</dt><dd>The browser cookie is HttpOnly. This page does not read it, ask for a token or include a session secret in copied code.</dd></div></dl>
      <pre class="copy-code" tabindex="0" aria-label="Request JSON"><code id="copy-json"></code></pre>
      <h3>Choose a language</h3>
      <div class="copy-actions" role="group" aria-label="Example language">
        <button class="pill" type="button" data-language="curl" aria-pressed="true">curl</button>
        <button class="pill" type="button" data-language="typescript" aria-pressed="false">TypeScript</button>
        <button class="pill" type="button" data-language="python" aria-pressed="false">Python</button>
      </div>
      <p id="copy-runtime" class="copy-help"></p>
      <pre class="copy-code" tabindex="0" aria-labelledby="copy-code-label"><code id="copy-code"></code></pre>
      <div class="copy-actions"><span id="copy-code-label" class="sr-only">curl example</span><button class="pill primary" type="button" id="copy-button">Copy curl</button></div>
      <p class="copy-help">Keep the idempotency key with your request. Quotes expire; review the response before any separate wallet action. These raw HTTP examples leave response signature and deployment checks to your application.</p>
      <label class="field" id="copy-manual-field" hidden><span>Select and copy this example</span><textarea id="copy-manual" rows="10" readonly spellcheck="false" aria-describedby="copy-status"></textarea></label>
    </section>
    <p id="copy-status" class="copy-help" role="status" aria-live="polite"></p>
  </section>`;
  const get = <T extends Element>(selector: string): T => main.querySelector<T>(selector)!;
  const form = get<HTMLFormElement>('#copy-examples-form');
  const originField = get<HTMLInputElement>('#copy-origin');
  const leash = get<HTMLInputElement>('#copy-leash');
  const task = get<HTMLTextAreaElement>('#copy-task');
  const seconds = get<HTMLInputElement>('#copy-seconds');
  const key = get<HTMLInputElement>('#copy-key');
  const error = get<HTMLElement>('#copy-error');
  const status = get<HTMLElement>('#copy-status');
  const output = get<HTMLElement>('.copy-output');
  const copy = get<HTMLButtonElement>('#copy-button');
  const manualField = get<HTMLElement>('#copy-manual-field');
  const manual = get<HTMLTextAreaElement>('#copy-manual');
  let examples: RequestExamples | undefined;
  let language: Language = 'curl';
  let copyGeneration = 0;
  originField.value = originInput;
  key.value = 'quote_' + (doc.defaultView?.crypto?.randomUUID?.() ?? Date.now().toString(36));
  task.value = 'Hello, Telomere.';
  seconds.max = String(runtimeMaxSeconds);
  if (Number.isSafeInteger(runtimeMaxSeconds) && runtimeMaxSeconds >= 1 && runtimeMaxSeconds <= 120) seconds.value = String(Math.min(10, runtimeMaxSeconds));
  get<HTMLElement>('#copy-limit-help').textContent = `CPU quote requests support 1–${runtimeMaxSeconds} whole seconds (Legacy maximum: 120).`;
  try {
    originField.value = requestExampleOrigin(originInput);
    if (!Number.isSafeInteger(runtimeMaxSeconds) || runtimeMaxSeconds < 1 || runtimeMaxSeconds > 120) throw new Error('The runtime CPU limit is not configured correctly.');
    status.textContent = 'Enter your existing Leash ID to prepare examples. Nothing is sent or copied yet.';
  } catch (problem) {
    error.hidden = false;
    error.textContent = problem instanceof Error ? problem.message : 'Example configuration is unavailable.';
    get<HTMLButtonElement>('button[type="submit"]').disabled = true;
    status.textContent = 'Examples are not configured for this origin or runtime.';
  }
  const fields: Partial<Record<keyof RequestExampleContext, HTMLInputElement | HTMLTextAreaElement>> = {leashId: leash, taskText: task, maxSeconds: seconds, idempotencyKey: key};
  const renderLanguage = (): void => {
    if (!examples) return;
    copyGeneration++;
    manualField.hidden = true;
    manual.value = '';
    get<HTMLElement>('#copy-code').textContent = examples[language];
    get<HTMLElement>('#copy-code-label').textContent = LANGUAGES[language] + ' example';
    get<HTMLElement>('#copy-runtime').textContent = language === 'curl' ? 'Run in a POSIX shell with curl. This is not PowerShell syntax.' : language === 'typescript' ? 'Node.js 22+. Save as quote.mjs and run node quote.mjs; the example is also valid TypeScript.' : 'Python 3, using only the standard library. Save as quote.py and run python3 quote.py.';
    copy.textContent = 'Copy ' + LANGUAGES[language];
    for (const button of main.querySelectorAll<HTMLButtonElement>('[data-language]')) button.setAttribute('aria-pressed', String(button.dataset['language'] === language));
  };
  for (const button of main.querySelectorAll<HTMLButtonElement>('[data-language]')) button.addEventListener('click', () => {
    language = button.dataset['language'] as Language;
    renderLanguage();
    status.textContent = LANGUAGES[language] + ' example ready. Copying sends no request.';
  });
  form.addEventListener('input', () => {
    copyGeneration++;
    examples = undefined;
    output.hidden = true;
    error.hidden = true;
    for (const field of Object.values(fields)) field?.removeAttribute('aria-invalid');
    status.textContent = 'Request changed. Prepare examples again to review the updated body and idempotency key.';
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    error.hidden = true;
    for (const field of Object.values(fields)) field?.removeAttribute('aria-invalid');
    try {
      examples = buildRequestExamples({serverOrigin: originField.value, runtimeMaxSeconds, leashId: leash.value.trim(), taskText: task.value, maxSeconds: seconds.value.trim() ? Number(seconds.value) : NaN, idempotencyKey: key.value.trim()});
      get<HTMLElement>('#copy-endpoint').textContent = 'POST ' + examples.origin + '/api/quotes';
      get<HTMLElement>('#copy-json').textContent = JSON.stringify(examples.body, null, 2);
      renderLanguage();
      output.hidden = false;
      status.textContent = 'Examples ready. Review the body, then choose and copy a language. No API request has been sent.';
    } catch (problem) {
      output.hidden = true;
      examples = undefined;
      error.hidden = false;
      error.textContent = problem instanceof Error ? problem.message : 'Check the request fields and try again.';
      if (problem instanceof RequestExampleError) { fields[problem.field]?.setAttribute('aria-invalid', 'true'); fields[problem.field]?.focus(); }
      status.textContent = '';
    }
  });
  copy.addEventListener('click', async () => {
    if (!examples || copy.disabled) return;
    const content = examples[language];
    const label = LANGUAGES[language];
    const generation = copyGeneration;
    copy.disabled = true;
    try {
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error('Clipboard is unavailable.');
      await clipboard.writeText(content);
      if (generation === copyGeneration && main.contains(copy)) status.textContent = label + ' copied. Run it in your terminal only after setting your API session token.';
    } catch {
      if (generation === copyGeneration && main.contains(copy)) {
        manual.value = content;
        manualField.hidden = false;
        manual.focus();
        manual.select();
        status.textContent = 'Automatic copy did not finish. Select the example below and use your system Copy command.';
      }
    } finally { copy.disabled = false; }
  });
}
