import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createServiceStatusRoutes, ServiceStatusService, type StatusProbeResult } from '../src/updates/service-status.js';
import { mountStatus } from '../public/updates/status.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const start = (): void => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z')); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('fixed local service status', () => {
  it('shares one bounded refresh, reuses the cache for 60 seconds and protects cached objects', async () => {
    start();
    const website = vi.fn(() => ({ state: 'ready' as const }));
    const service = new ServiceStatusService({ website });
    const reports = await Promise.all(Array.from({ length: 40 }, () => service.snapshot()));
    expect(website).toHaveBeenCalledTimes(1);
    expect(reports[0]?.state).toBe('ready');
    expect(reports[0]?.components).toHaveLength(6);
    reports[0]!.components[0]!.state = 'unavailable';
    expect((await service.snapshot()).components[0]?.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(59_999); await service.snapshot(); expect(website).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await service.snapshot(); expect(website).toHaveBeenCalledTimes(2);
  });

  it('bounds deadlines and keeps an uncancellable timed-out probe slot until it settles', async () => {
    start();
    const hung = deferred<StatusProbeResult>();
    const website = vi.fn(() => hung.promise);
    const service = new ServiceStatusService({ website, chain: () => ({ state: 'ready' }) });
    const first = service.snapshot();
    await vi.advanceTimersByTimeAsync(4_999); expect(website).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const timedOut = await first;
    expect(timedOut.state).toBe('degraded');
    expect(timedOut.components[0]).toMatchObject({ state: 'unknown', code: 'timeout', stale: true, asOf: null, latencyMs: 5_000 });
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const reports = await Promise.all(Array.from({ length: 20 }, () => service.snapshot()));
      expect(reports[0]?.components[0]).toMatchObject({ state: 'unknown', code: 'pending', stale: true });
      expect(website).toHaveBeenCalledTimes(1);
    }
    hung.resolve({ state: 'ready' }); await vi.advanceTimersByTimeAsync(0);
    website.mockImplementation(() => Promise.resolve({ state: 'ready' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await service.snapshot()).components[0]).toMatchObject({ state: 'ready', stale: false, code: 'ok' });
    expect(website).toHaveBeenCalledTimes(2);
  });

  it('retains old evidence dates without reporting old success as fresh after timeout', async () => {
    start();
    const website = vi.fn<() => Promise<StatusProbeResult>>(async () => ({ state: 'ready' }));
    const service = new ServiceStatusService({ website });
    const initial = await service.snapshot(), firstEvidence = initial.components[0]!.asOf;
    const hung = deferred<StatusProbeResult>(); website.mockImplementation(() => hung.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    const next = service.snapshot(); await vi.advanceTimersByTimeAsync(5_000);
    const report = await next;
    expect(report.state).toBe('unknown'); expect(report.stale).toBe(true);
    expect(report.components[0]).toMatchObject({ state: 'unknown', code: 'timeout', asOf: firstEvidence, stale: true });
    expect(report.components[0]?.checkedAt).not.toBe(firstEvidence);
    hung.reject(new Error('SECRET_RPC_URL PRIVATE_TOKEN INTERNAL_HOST')); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(await service.snapshot())).not.toMatch(/SECRET|PRIVATE|INTERNAL/);
    website.mockImplementation(async () => ({ state: 'ready' })); await vi.advanceTimersByTimeAsync(60_000);
    const recovered = await service.snapshot(); expect(recovered.state).toBe('ready'); expect(recovered.stale).toBe(false);
    expect(recovered.components[0]?.asOf).not.toBe(firstEvidence);
  });

  it('returns only public whitelisted fields and fixed failure codes', async () => {
    start();
    const service = new ServiceStatusService({
      website: () => { throw new Error('postgres://TOKEN@PRIVATE_HOST:5432/db'); },
      chain: async () => ({ state: 'ready', url: 'https://PRIVATE_RPC', version: 'SECRET_VERSION', ip: '10.0.0.3' }),
      controller: () => ({ state: 'degraded', code: 'degraded' }),
    });
    const report = await service.snapshot();
    expect(report.state).toBe('degraded');
    expect(report.components[0]).toMatchObject({ state: 'unavailable', code: 'probe_failed' });
    expect(report.components[1]).toMatchObject({ state: 'ready', code: 'ok', source: 'local_server_probe' });
    expect(JSON.stringify(report)).not.toMatch(/postgres|TOKEN|PRIVATE|SECRET|10\.0\.0\.3|version|url/);
    expect(Object.keys(report.components[1]!).sort()).toEqual(['id', 'state', 'code', 'checkedAt', 'asOf', 'source', 'latencyMs', 'stale'].sort());
  });

  it('rejects malformed probe reports without echoing their data and can recover', async () => {
    start();
    const probe = vi.fn(() => ({ state: 'ready', code: 'SECRET_DIAGNOSTIC' } as unknown as StatusProbeResult));
    const service = new ServiceStatusService({ website: probe });
    const report = await service.snapshot();
    expect(report.components[0]).toMatchObject({ state: 'unknown', code: 'invalid_result' });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    probe.mockImplementation(() => ({ state: 'ready' })); await vi.advanceTimersByTimeAsync(60_000);
    expect((await service.snapshot()).state).toBe('ready');
  });

  it('uses the fixed allowlist and reports empty configuration with no readiness evidence', async () => {
    start();
    const surprise = vi.fn(() => ({ state: 'ready' as const }));
    const service = new ServiceStatusService({ arbitrary_internal_name: surprise } as never);
    const report = await service.snapshot();
    expect(report).toMatchObject({ state: 'not_configured', code: 'not_configured', asOf: null, stale: false });
    expect(report.components.every(row => row.state === 'not_configured' && row.asOf === null && row.latencyMs === null)).toBe(true);
    expect(surprise).not.toHaveBeenCalled(); expect(JSON.stringify(report)).not.toContain('arbitrary');
  });

  it('recovers unavailable checks and never keeps cached success when the clock goes backwards', async () => {
    start();
    const probe = vi.fn<() => StatusProbeResult>(() => ({ state: 'unavailable' }));
    const service = new ServiceStatusService({ website: probe });
    expect((await service.snapshot()).state).toBe('unavailable');
    probe.mockImplementation(() => ({ state: 'ready' })); await vi.advanceTimersByTimeAsync(60_000);
    expect((await service.snapshot()).state).toBe('ready');
    probe.mockImplementation(() => ({ state: 'degraded' })); vi.setSystemTime(new Date('2026-11-13T11:00:00Z'));
    expect((await service.snapshot()).state).toBe('degraded'); expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('public status routes', () => {
  it('mounts GET /, rejects client query input before probing, and uses no-store', async () => {
    const probe = vi.fn(() => ({ state: 'ready' as const }));
    const app = new Hono().route('/api/public/status', createServiceStatusRoutes(new ServiceStatusService({ website: probe })));
    const rejected = await app.request('/api/public/status?url=https://PRIVATE_HOST');
    expect(rejected.status).toBe(422); expect(probe).not.toHaveBeenCalled();
    const response = await app.request('/api/public/status');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ state: 'ready', source: 'local_server_probes', refreshAfterMs: 60_000 });
  });
  it('returns terminal not_configured status when no checks exist', async () => {
    const routes = createServiceStatusRoutes(new ServiceStatusService({}));
    const response = await routes.request('/');
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ state: 'not_configured', code: 'not_configured' });
  });
});

// A small DOM adapter keeps the real mount, render, fetch and timer behavior in
// this regression test. Static controls are prebuilt; rendered nodes stay real
// objects with their text and attributes, without needing a browser dependency.
class StatusElement {
  children: StatusElement[] = [];
  queries = new Map<string, StatusElement>();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  parentElement: StatusElement | null = null;
  hidden = false;
  isConnected = true;
  innerHTML = '';
  private ownText = '';
  constructor(readonly ownerDocument: StatusDocument) {}
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children: StatusElement[]): void { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(): void { this.children = []; this.ownText = ''; }
  contains(child: StatusElement): boolean { return this === child || this.children.some(node => node.contains(child)); }
  querySelector(selector: string): StatusElement | null { return this.queries.get(selector) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(): void {}
  removeEventListener(): void {}
}
class StatusDocument {
  hidden = false;
  documentElement = new StatusElement(this);
  defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  createElement(): StatusElement { return new StatusElement(this); }
  addEventListener(): void {}
  removeEventListener(): void {}
}
function statusPage() {
  const doc = new StatusDocument(), main = new StatusElement(doc), section = new StatusElement(doc), form = new StatusElement(doc);
  const button = new StatusElement(doc), error = new StatusElement(doc), progress = new StatusElement(doc), results = new StatusElement(doc);
  doc.documentElement.append(main); main.append(section); section.append(form, results); form.append(button, error, progress);
  main.queries.set('.service-status', section); section.queries.set('form', form); form.queries.set('button', button);
  section.queries.set('#service-status-error', error); section.queries.set('#service-status-progress', progress);
  section.queries.set('.service-status-results', results);
  vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
  return { main: main as unknown as HTMLElement, progress, results };
}

describe('status evidence expiry in the mounted page', () => {
  it('refreshes a 55-second-old cached ready report after its remaining five seconds', async () => {
    start();
    const cached = await new ServiceStatusService({ website: () => ({ state: 'ready' }) }, () => Date.now() - 55_000).snapshot();
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(cached)))
      .mockImplementationOnce(() => pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const page = statusPage(), cleanup = mountStatus(page.main, '');
    await vi.advanceTimersByTimeAsync(0);
    expect(page.results.dataset['state']).toBe('ready'); expect(page.progress.textContent).toMatch(/^Ready\./);
    await vi.advanceTimersByTimeAsync(4_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(page.results.dataset['state']).toBe('loading'); expect(page.progress.textContent).not.toMatch(/^Ready\./);
    pending.resolve(new Response(JSON.stringify(cached))); await vi.advanceTimersByTimeAsync(0);
    expect(page.results.dataset['state']).toBe('unknown'); expect(page.results.textContent).toContain('Unknown — stale');
    expect(page.progress.textContent).toMatch(/^Unknown\./);
    await vi.advanceTimersByTimeAsync(59_999); expect(fetcher).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('uses the earliest component evidence expiry and never announces stale success as Ready', async () => {
    start();
    const report = await new ServiceStatusService({ website: () => ({ state: 'ready' }), chain: () => ({ state: 'ready' }) }).snapshot();
    report.components[0]!.asOf = new Date(Date.now() - 59_000).toISOString();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetcher);
    const page = statusPage(), cleanup = mountStatus(page.main, ''); await vi.advanceTimersByTimeAsync(0);
    expect(page.results.dataset['state']).toBe('ready');
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(page.results.dataset['state']).toBe('unknown'); expect(page.progress.textContent).toMatch(/^Unknown\./);
    cleanup();
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
