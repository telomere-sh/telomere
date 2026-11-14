const ENDPOINT = '/api/public/changelog';
const REQUEST_TIMEOUT_MS = 12_000;
const TARGETS = [
  [null, '/verify/'], ['refunds', '/refunds/'], ['prices', '/prices/'], ['receipt-links', '/verify/'],
  ['leash-presets', '/dashboard/'], ['runway', '/runway/'], ['accounting', '/accounting/'],
  ['fossils', '/fossils/'], ['agent-economics', '/fossils/'], ['copy-examples', '/developers/examples/'],
  ['host-calculator', '/hosts/calculator/'], ['status-changelog', '/status/'],
] as const;
type Entry = { id: number; feature: string | null; title: string; description: string; introducedOn: string; href: string };
type Report = { schemaVersion: 1; state: 'ready' | 'partial' | 'no_data'; asOf: string; source: 'curated_public_catalog';
  sourceCommit: string | null; sourceDirty: boolean | null; dateMeaning: 'introduced_on_not_deployment_time'; entries: Entry[] };
const mounted = new WeakMap<HTMLElement, () => void>();
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function plain(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[<>\u0000-\u001f\u007f]/u.test(value);
}
/** Validate independently in the browser before creating any link or rendering content. */
export function readChangelogReport(value: unknown): Report {
  const bad = (): never => { throw new Error('The changelog source returned an unexpected report. Refresh to retry.'); };
  if (!object(value) || !keys(value, ['schemaVersion', 'state', 'asOf', 'source', 'sourceCommit', 'sourceDirty', 'dateMeaning', 'entries'])
    || value['schemaVersion'] !== 1 || !['ready', 'partial', 'no_data'].includes(value['state'] as string)
    || typeof value['asOf'] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value['asOf'])
    || !Number.isFinite(Date.parse(value['asOf'])) || value['source'] !== 'curated_public_catalog'
    || !(value['sourceCommit'] === null || typeof value['sourceCommit'] === 'string' && /^[a-f0-9]{40}$/.test(value['sourceCommit']))
    || !(value['sourceDirty'] === null || typeof value['sourceDirty'] === 'boolean')
    || value['dateMeaning'] !== 'introduced_on_not_deployment_time' || !Array.isArray(value['entries']) || value['entries'].length > 12) return bad();
  const seen = new Set<number>();
  const entries = value['entries'].map((entry: unknown): Entry => {
    if (!object(entry) || !keys(entry, ['id', 'feature', 'title', 'description', 'introducedOn', 'href'])
      || typeof entry['id'] !== 'number' || !Number.isInteger(entry['id']) || entry['id'] < 1 || entry['id'] > 12
      || seen.has(entry['id']) || !plain(entry['title'], 100) || !plain(entry['description'], 500)
      || entry['introducedOn'] !== '2026-11-13') return bad();
    const target = TARGETS[entry['id'] - 1];
    if (!target || entry['feature'] !== target[0] || entry['href'] !== target[1]) return bad();
    seen.add(entry['id']);
    return { id: entry['id'], feature: target[0], href: target[1], title: entry['title'], description: entry['description'], introducedOn: entry['introducedOn'] };
  });
  const state = value['state'] as Report['state'];
  if (state === 'ready' && (value['sourceCommit'] === null || value['sourceDirty'] !== false)
    || state === 'no_data' && entries.length !== 0 || state !== 'no_data' && entries.length === 0) return bad();
  return { schemaVersion: 1, state, asOf: value['asOf'], source: 'curated_public_catalog', sourceCommit: value['sourceCommit'],
    sourceDirty: value['sourceDirty'], dateMeaning: 'introduced_on_not_deployment_time', entries };
}
function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.textContent = value; if (className) element.className = className; return element;
}
function stamp(doc: Document, value: string): HTMLTimeElement {
  const element = text(doc, 'time', new Date(value).toISOString()); element.dateTime = value; return element;
}
export function renderChangelog(target: HTMLElement, report: Report): void {
  const doc = target.ownerDocument;
  target.replaceChildren(); target.dataset['state'] = report.state;
  target.append(text(doc, 'h3', 'Available in this deployment'));
  const meta = doc.createElement('dl'); meta.className = 'changelog-meta';
  for (const [label, value] of [
    ['Source', 'Curated public catalog, filtered by enabled features'],
    ['Source commit', report.sourceCommit ?? 'Not recorded in this build'],
    ['Source working tree', report.sourceDirty === null ? 'Not recorded in this build' : report.sourceDirty ? 'Includes uncommitted changes' : 'Clean at build time'],
  ]) {
    const row = doc.createElement('div'); row.append(text(doc, 'dt', label!), text(doc, 'dd', value!)); meta.append(row);
  }
  const asOf = doc.createElement('div'), detail = doc.createElement('dd'); detail.append(stamp(doc, report.asOf));
  asOf.append(text(doc, 'dt', 'Catalog checked at (UTC)'), detail); meta.append(asOf); target.append(meta);
  if (report.state === 'partial') target.append(text(doc, 'p', 'Partial source metadata: the source commit is missing or this build includes uncommitted or unrecorded changes. The list reflects currently enabled features.'));
  if (report.state === 'no_data') { target.append(text(doc, 'p', 'No curated updates are available in this response.')); return; }
  const entries = doc.createElement('ol'); entries.className = 'changelog-entries';
  for (const entry of report.entries) {
    const item = doc.createElement('li'); item.value = entry.id;
    const intro = text(doc, 'p', 'Introduced / prepared on '), date = text(doc, 'time', `${entry.introducedOn} (UTC)`);
    date.dateTime = entry.introducedOn; intro.append(date);
    const link = text(doc, 'a', `Open ${entry.title}`, 'pill'); link.href = entry.href;
    item.append(intro, text(doc, 'h4', entry.title), text(doc, 'p', entry.description), link); entries.append(item);
  }
  target.append(entries);
}

/** One initial read and explicit refreshes; the SPA owns the returned disposer. */
export function mountChangelog(main: HTMLElement, heroHtml: string): () => void {
  mounted.get(main)?.();
  // heroHtml is the trusted pageHero supplied by the application router.
  main.innerHTML = heroHtml;
  const doc = main.ownerDocument, section = doc.createElement('section');
  section.className = 'section public-changelog'; section.setAttribute('aria-labelledby', 'changelog-title');
  const top = doc.createElement('div'); top.className = 'section-top';
  const heading = doc.createElement('div'), title = text(doc, 'h2', 'Updates with a visible source.'); title.id = 'changelog-title';
  heading.append(text(doc, 'div', 'Public changelog', 'eyebrow'), title);
  top.append(heading, text(doc, 'p', 'A curated account of the public tools enabled here. Introduction dates describe when each update was prepared; they are not deployment timestamps.'));
  const form = doc.createElement('form'); form.className = 'inline-form';
  const button = text(doc, 'button', 'Refresh changelog ↗', 'pill primary'); button.type = 'submit';
  const error = text(doc, 'p', ''); error.id = 'changelog-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const progress = text(doc, 'p', ''); progress.id = 'changelog-progress'; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const results = doc.createElement('div'); results.className = 'changelog-results'; results.hidden = true;
  form.append(button, error, progress); section.append(top, form, results); main.append(section);
  let disposed = false, terminal = false, request: AbortController | undefined, generation = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const load = async (): Promise<void> => {
    if (disposed || terminal || request || doc.hidden || !main.isConnected || main.hidden || main.inert) return;
    const current = ++generation, controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); deadline = timeout;
    button.disabled = true; error.hidden = true; progress.textContent = 'Loading the curated changelog…';
    section.dataset['state'] = 'loading'; results.hidden = true;
    try {
      const response = await fetch(ENDPOINT, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (disposed || current !== generation) return;
      if (response.status === 404) {
        terminal = true; section.dataset['state'] = 'not_enabled'; progress.textContent = 'This update is not enabled in this deployment.';
        return;
      }
      if (!response.ok) throw new Error('The changelog source is unavailable. Refresh to retry.');
      const report = readChangelogReport(await response.json());
      if (disposed || current !== generation) return;
      renderChangelog(results, report); results.hidden = false; section.dataset['state'] = report.state;
      progress.textContent = report.state === 'ready' ? 'Changelog loaded.' : report.state === 'partial' ? 'Changelog loaded with partial source metadata.' : 'No curated updates found.';
    } catch {
      if (disposed || current !== generation) return;
      section.dataset['state'] = 'unavailable'; progress.textContent = '';
      error.textContent = 'The changelog source is unavailable or returned an unexpected report. Refresh to retry.'; error.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (deadline === timeout) deadline = undefined;
      if (current === generation) { request = undefined; button.disabled = false; }
    }
  };
  const submit = (event: SubmitEvent): void => { event.preventDefault(); terminal = false; void load(); };
  const visibility = (): void => {
    if (!doc.hidden || !request) return;
    clearTimeout(deadline); deadline = undefined;
    ++generation; request.abort(); request = undefined; button.disabled = false;
    section.dataset['state'] = 'partial'; progress.textContent = 'Read paused while the page is hidden. Refresh when you return.';
  };
  const cleanup = (): void => {
    if (disposed) return;
    clearTimeout(deadline); deadline = undefined;
    disposed = true; ++generation; request?.abort(); request = undefined;
    form.removeEventListener('submit', submit); doc.removeEventListener('visibilitychange', visibility); mounted.delete(main);
  };
  form.addEventListener('submit', submit); doc.addEventListener('visibilitychange', visibility);
  mounted.set(main, cleanup); void load(); return cleanup;
}
