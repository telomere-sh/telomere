import { Hono } from 'hono';

export const STATUS_COMPONENTS = ['website', 'chain', 'controller', 'receipts', 'explorer', 'pricing'] as const;
export const STATUS_STATES = ['ready', 'degraded', 'unavailable', 'not_configured', 'unknown'] as const;
export const STATUS_CODES = ['ok', 'degraded', 'unavailable', 'not_configured', 'unknown', 'probe_failed', 'timeout', 'pending', 'invalid_result', 'stale'] as const;
export type StatusComponent = typeof STATUS_COMPONENTS[number];
export type StatusState = typeof STATUS_STATES[number];
export type StatusCode = typeof STATUS_CODES[number];
export type StatusProbeResult = { state: StatusState; code?: 'ok' | 'degraded' | 'unavailable' | 'not_configured' | 'unknown' };
export type StatusProbe = () => StatusProbeResult | Promise<StatusProbeResult>;
export type StatusProbes = Partial<Record<StatusComponent, StatusProbe | null>>;
export type ComponentStatus = { id: StatusComponent; state: StatusState; code: StatusCode; checkedAt: string;
  asOf: string | null; source: 'local_server_probe'; latencyMs: number | null; stale: boolean };
export type ServiceStatusSnapshot = { state: StatusState; code: StatusCode; checkedAt: string; asOf: string | null;
  source: 'local_server_probes'; stale: boolean; refreshAfterMs: number; components: ComponentStatus[] };

const DEFAULT_CODES: Record<StatusState, StatusCode> = { ready: 'ok', degraded: 'degraded', unavailable: 'unavailable',
  not_configured: 'not_configured', unknown: 'unknown' };
function validResult(value: unknown): value is StatusProbeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return STATUS_STATES.includes(result['state'] as StatusState)
    && (result['code'] === undefined || result['code'] === DEFAULT_CODES[result['state'] as StatusState]);
}
function overall(components: ComponentStatus[]): StatusState {
  const configured = components.filter(component => component.state !== 'not_configured');
  if (configured.length === 0) return 'not_configured';
  if (configured.every(component => component.state === 'ready' && !component.stale)) return 'ready';
  if (configured.every(component => component.state === 'unavailable')) return 'unavailable';
  if (configured.every(component => component.state === 'unknown')) return 'unknown';
  return 'degraded';
}

/** Fixed local probes only. Timed-out work owns its slot until it actually settles. */
export class ServiceStatusService {
  private cached: ServiceStatusSnapshot | undefined;
  private cachedAt = -Infinity;
  private refreshing: Promise<ServiceStatusSnapshot> | undefined;
  private readonly slots = new Map<StatusComponent, Promise<unknown>>();
  private readonly probes: StatusProbes;
  private readonly ttl: number;
  private readonly timeout: number;
  constructor(probes: StatusProbes, private readonly now: () => number = Date.now, ttlMs = 60_000, timeoutMs = 5_000) {
    this.probes = Object.fromEntries(STATUS_COMPONENTS.map(id => [id, typeof probes[id] === 'function' ? probes[id] : null]));
    this.ttl = Number.isFinite(ttlMs) ? Math.max(1, Math.min(60_000, ttlMs)) : 60_000;
    this.timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5_000, timeoutMs)) : 5_000;
  }
  async snapshot(): Promise<ServiceStatusSnapshot> {
    const age = this.now() - this.cachedAt;
    if (this.cached && age >= 0 && age < this.ttl) return structuredClone(this.cached);
    if (!this.refreshing) {
      this.refreshing = this.collect().then(report => {
        this.cached = report; this.cachedAt = this.now(); return report;
      }).finally(() => { this.refreshing = undefined; });
    }
    return structuredClone(await this.refreshing);
  }
  private async collect(): Promise<ServiceStatusSnapshot> {
    const components = await Promise.all(STATUS_COMPONENTS.map(id => this.check(id)));
    const state = overall(components), checkedAt = new Date(this.now()).toISOString();
    const evidence = components.map(component => component.asOf).filter((stamp): stamp is string => stamp !== null);
    return { state, code: DEFAULT_CODES[state], checkedAt, asOf: evidence.length ? evidence.sort()[0]! : null,
      source: 'local_server_probes', stale: components.some(component => component.stale), refreshAfterMs: this.ttl, components };
  }
  private async check(id: StatusComponent): Promise<ComponentStatus> {
    const started = this.now(), checkedAt = new Date(started).toISOString(), probe = this.probes[id];
    const previous = this.cached?.components.find(component => component.id === id);
    const row = (state: StatusState, code: StatusCode, stale: boolean, latencyMs: number | null,
      asOf: string | null = null): ComponentStatus => ({ id, state, code, checkedAt, asOf,
      source: 'local_server_probe', latencyMs, stale });
    if (!probe) return row('not_configured', 'not_configured', false, null);
    if (this.slots.has(id)) return row('unknown', 'pending', true, null, previous?.asOf ?? null);
    // Promise handlers consume both success and rejection, including settlement after the deadline.
    const task = Promise.resolve().then(probe);
    this.slots.set(id, task);
    void task.then(() => { if (this.slots.get(id) === task) this.slots.delete(id); },
      () => { if (this.slots.get(id) === task) this.slots.delete(id); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      task.then(value => ({ kind: 'result' as const, value }), () => ({ kind: 'failure' as const })),
      new Promise<{ kind: 'timeout' }>(resolve => { deadline = setTimeout(() => resolve({ kind: 'timeout' }), this.timeout); }),
    ]);
    clearTimeout(deadline);
    const latency = Math.max(0, Math.min(this.timeout, Math.round(this.now() - started)));
    if (result.kind === 'timeout') return row('unknown', 'timeout', true, latency, previous?.asOf ?? null);
    if (result.kind === 'failure') return row('unavailable', 'probe_failed', false, latency, new Date(this.now()).toISOString());
    if (!validResult(result.value)) return row('unknown', 'invalid_result', false, latency, new Date(this.now()).toISOString());
    return row(result.value.state, DEFAULT_CODES[result.value.state], false, latency, new Date(this.now()).toISOString());
  }
}

export function createServiceStatusRoutes(service: ServiceStatusService) {
  const routes = new Hono();
  routes.get('/', async context => {
    context.header('Cache-Control', 'no-store');
    if (new URL(context.req.url).searchParams.size) return context.json({ code: 'status_query', state: 'unavailable' }, 422);
    const report = await service.snapshot();
    return context.json(report, report.state === 'not_configured' ? 503 : 200);
  });
  return routes;
}
