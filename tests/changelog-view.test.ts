import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import catalog from '../public/updates/changelog-catalog.json' with { type: 'json' };
import { changelogCatalogSchema, changelogReportSchema, createChangelogRoutes } from '../src/updates/changelog.js';
import { mountChangelog, readChangelogReport, renderChangelog } from '../public/updates/changelog.js';

const digest = 'a'.repeat(64);
const release = { schemaVersion: 1 as const, sourceCommit: 'b'.repeat(40), sourceDirty: false,
  packageLockSha256: digest, assets: { 'index.html': digest, 'dashboard.js': digest, 'workspace-client.js': digest, 'site.js': digest, 'agent-panels.js': digest } };
const unversioned = { schemaVersion: 1, sourceCommit: null, sourceDirty: null, packageLockSha256: null, assets: {} } as const;
const allFeatures = catalog.entries.flatMap(entry => entry.feature === null ? [] : [entry.feature]);
function report() {
  return { schemaVersion: 1, state: 'ready', asOf: '2026-11-13T12:00:00.000Z', source: 'curated_public_catalog',
    sourceCommit: release.sourceCommit, sourceDirty: false, dateMeaning: 'introduced_on_not_deployment_time', entries: catalog.entries };
}

// A small DOM fixture records element creation and text; it never interprets HTML.
class ElementFixture {
  children: ElementFixture[] = []; attributes = new Map<string, string>(); listeners = new Map<string, (event: unknown) => void>();
  dataset: Record<string, string> = {}; hidden = false; disabled = false; inert = false; isConnected = true;
  className = ''; id = ''; href = ''; dateTime = ''; value = 0; type = ''; textContent = ''; htmlWrites: string[] = [];
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) {}
  set innerHTML(value: string) { this.htmlWrites.push(value); this.children = []; }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, callback: (event: unknown) => void): void { this.listeners.set(name, callback); }
  removeEventListener(name: string): void { this.listeners.delete(name); }
  flat(): ElementFixture[] { return [this, ...this.children.flatMap(child => child.flat())]; }
}
class DocumentFixture {
  hidden = false; listeners = new Map<string, () => void>();
  createElement(tag: string): ElementFixture { return new ElementFixture(this, tag); }
  addEventListener(name: string, callback: () => void): void { this.listeners.set(name, callback); }
  removeEventListener(name: string): void { this.listeners.delete(name); }
}
const tick = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('curated public changelog schema and source boundary', () => {
  it('accepts exactly the public catalog and shares the response contract with the browser', () => {
    expect(changelogCatalogSchema.parse(catalog).entries.map(entry => entry.id)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(changelogReportSchema.parse(report())).toEqual(readChangelogReport(report()));
    expect(catalog.entries[3]?.href).toBe('/verify/');
    expect(catalog.entries[8]?.href).toBe('/fossils/');
  });
  it.each([
    { id: 13 }, { id: 0 }, { feature: 'future-feature' }, { href: '/private/' }, { href: '//evil.example/' },
    { href: '/verify/../private/' }, { href: '/%2e%2e/private' }, { href: 'javascript:alert(1)' },
    { title: '<img src=x onerror=alert(1)>' }, { description: 'bad\u0000value' }, { introducedOn: '2026-11-14' },
    { rawCommitMessage: 'PRIVATE_COMMIT' },
  ])('rejects unknown IDs, unsafe text and unlisted paths: %j', patch => {
    const entries = [{ ...catalog.entries[0], ...patch }];
    expect(changelogCatalogSchema.safeParse({ schemaVersion: 1, entries }).success).toBe(false);
    expect(() => readChangelogReport({ ...report(), entries })).toThrow();
  });
  it('rejects duplicates, unknown report fields and a falsely ready unversioned build', () => {
    const entries = [catalog.entries[0], catalog.entries[0]];
    expect(changelogCatalogSchema.safeParse({ schemaVersion: 1, entries }).success).toBe(false);
    expect(() => readChangelogReport({ ...report(), entries })).toThrow();
    expect(() => readChangelogReport({ ...report(), privateOperations: [] })).toThrow();
    expect(() => readChangelogReport({ ...report(), sourceCommit: null })).toThrow();
    expect(changelogReportSchema.safeParse({ ...report(), sourceDirty: true }).success).toBe(false);
  });
  it('reads a compile-time public catalog and never invokes repository or private filesystem readers', async () => {
    const source = await readFile(new URL('../src/updates/changelog.ts', import.meta.url), 'utf8');
    expect(source).toContain("../../public/updates/changelog-catalog.json");
    expect(source).not.toMatch(/node:(?:fs|child_process)|readFile|readdir|execSync|spawn\(|git log|\.\.\/.*(?:ops|store|operations)/);
    expect(JSON.stringify(catalog)).not.toMatch(/PRIVATE_COMMIT|rawCommit|ops\/|\.git|releasedAt/);
  });
});

describe('enabled deployment filtering', () => {
  it('returns only the verifier and currently enabled entries, without future or unknown IDs', async () => {
    let enabled = ['status-changelog', 'prices', 'future-feature'];
    const app = createChangelogRoutes(() => enabled, release);
    const first = await app.request('/');
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
    const firstReport = readChangelogReport(await first.json());
    expect(firstReport.state).toBe('ready'); expect(firstReport.entries.map(entry => entry.id)).toEqual([1, 3, 12]);
    expect(firstReport.sourceCommit).toBe(release.sourceCommit); expect(firstReport.asOf).toMatch(/Z$/);
    enabled = ['status-changelog', 'refunds'];
    expect(readChangelogReport(await (await app.request('/')).json()).entries.map(entry => entry.id)).toEqual([1, 2, 12]);
    enabled = allFeatures;
    expect(readChangelogReport(await (await app.request('/')).json()).entries).toHaveLength(12);
  });
  it('keeps missing and dirty source metadata honest and excludes raw release details', async () => {
    for (const metadata of [unversioned, { ...release, sourceDirty: true }]) {
      const result = await (await createChangelogRoutes(() => ['status-changelog'], metadata).request('/')).json();
      expect(readChangelogReport(result).state).toBe('partial');
      expect(changelogReportSchema.safeParse(result).success).toBe(true);
      expect(result.sourceCommit).toBe(metadata.sourceCommit);
      expect(result.sourceDirty).toBe(metadata.sourceDirty);
      expect(JSON.stringify(result)).not.toMatch(/packageLock|assets|releasedAt|PRIVATE_COMMIT/);
    }
  });
  it('returns a terminal disabled response and a bounded unavailable response', async () => {
    const disabled = await createChangelogRoutes(() => []).request('/');
    expect(disabled.status).toBe(404); expect(await disabled.json()).toEqual({ state: 'not_enabled', error: 'This update is not enabled.' });
    const unavailable = await createChangelogRoutes(() => { throw new Error('PRIVATE_ERROR'); }).request('/');
    expect(unavailable.status).toBe(503); expect(JSON.stringify(await unavailable.json())).not.toContain('PRIVATE_ERROR');
  });
});

describe('changelog rendering and lifecycle', () => {
  it('renders remote strings as text and UTC time elements with fixed links', () => {
    const doc = new DocumentFixture(), target = doc.createElement('div'), valid = readChangelogReport(report());
    // Even a caller bypassing validation gets text nodes rather than executable markup.
    valid.entries[0]!.title = '<img src=x onerror=alert(1)>';
    renderChangelog(target as unknown as HTMLElement, valid);
    const elements = target.flat();
    expect(elements.some(element => element.tagName === 'h4' && element.textContent.startsWith('<img'))).toBe(true);
    expect(elements.some(element => element.tagName === 'img')).toBe(false);
    expect(elements.flatMap(element => element.htmlWrites)).toEqual([]);
    expect(elements.filter(element => element.tagName === 'time').every(element => element.textContent.includes('UTC') || element.textContent.endsWith('Z'))).toBe(true);
    expect(elements.filter(element => element.tagName === 'a').every(element => catalog.entries.some(entry => entry.href === element.href))).toBe(true);
    expect(elements.some(element => element.textContent === 'Available in this deployment')).toBe(true);
  });
  it('shows no_data and partial source states explicitly', () => {
    const doc = new DocumentFixture(), target = doc.createElement('div');
    renderChangelog(target as unknown as HTMLElement, readChangelogReport({ ...report(), state: 'no_data', entries: [] }));
    expect(target.dataset['state']).toBe('no_data'); expect(target.flat().some(element => /No curated updates/.test(element.textContent))).toBe(true);
    renderChangelog(target as unknown as HTMLElement, readChangelogReport({ ...report(), state: 'partial', sourceCommit: null, sourceDirty: null }));
    expect(target.flat().some(element => /Partial source metadata/.test(element.textContent))).toBe(true);
    expect(target.flat().some(element => element.textContent === 'Not recorded in this build')).toBe(true);
  });
  it('performs one public read, supports refresh and disposes pending work', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(report()))); vi.stubGlobal('fetch', fetcher);
    const doc = new DocumentFixture(), main = doc.createElement('main');
    const cleanup = mountChangelog(main as unknown as HTMLElement, '<h1>Trusted hero</h1>');
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/public/changelog');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const form = main.flat().find(element => element.tagName === 'form')!;
    fetcher.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('Aborted')))));
    form.listeners.get('submit')?.({ preventDefault() {} }); await tick();
    const signal = fetcher.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false); cleanup(); expect(signal.aborted).toBe(true); await tick();
    expect(doc.listeners.size).toBe(0); expect(form.listeners.size).toBe(0);
  });
  it('stops at disabled 404 and leaves failures retryable', async () => {
    for (const status of [404, 503]) {
      const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status })); vi.stubGlobal('fetch', fetcher);
      const doc = new DocumentFixture(), main = doc.createElement('main'); const cleanup = mountChangelog(main as unknown as HTMLElement, '');
      await tick(); const section = main.children[0]!, button = main.flat().find(element => element.tagName === 'button')!;
      expect(section.dataset['state']).toBe(status === 404 ? 'not_enabled' : 'unavailable');
      expect(button.disabled).toBe(false); cleanup();
    }
  });
  it('keeps disabled responses idle and recovers on an explicit refresh', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(report())));
    vi.stubGlobal('fetch', fetcher);
    const doc = new DocumentFixture(), main = doc.createElement('main');
    const cleanup = mountChangelog(main as unknown as HTMLElement, '');
    await tick();
    const section = main.children[0]!, button = main.flat().find(element => element.tagName === 'button')!;
    const form = main.flat().find(element => element.tagName === 'form')!;
    expect(section.dataset['state']).toBe('not_enabled'); expect(button.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000); expect(fetcher).toHaveBeenCalledTimes(1);
    form.listeners.get('submit')?.({ preventDefault() {} }); await tick();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(section.dataset['state']).toBe('ready');
    expect(button.disabled).toBe(false); cleanup();
  });
  it('cancels hidden-page reads, clears the deadline and starts no background polling', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('Aborted')))));
    vi.stubGlobal('fetch', fetcher);
    const doc = new DocumentFixture(), main = doc.createElement('main');
    const cleanup = mountChangelog(main as unknown as HTMLElement, '');
    await tick(); expect(vi.getTimerCount()).toBe(1);
    doc.hidden = true; doc.listeners.get('visibilitychange')?.(); await tick();
    expect((fetcher.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    doc.hidden = false; doc.listeners.get('visibilitychange')?.();
    await vi.advanceTimersByTimeAsync(120_000); expect(fetcher).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
