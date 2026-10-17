import { z } from 'zod';

/** Yagna node identity, never a request-supplied URL or a payment address. */
export const golemNodeIdSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
export const golemRuntimeSchema = z.enum(['vm', 'vm-nvidia']);
export type GolemRuntime = z.infer<typeof golemRuntimeSchema>;

const propertiesSchema = z.object({
    id: golemNodeIdSchema,
    'golem.runtime.name': z.string().min(1).max(64),
    'golem.inf.cpu.cores': z.number().int().positive().safe(),
    'golem.inf.cpu.threads': z.number().int().positive().safe(),
    'golem.inf.mem.gib': z.number().finite().positive(),
    'golem.inf.storage.gib': z.number().finite().positive(),
    'golem.!exp.gap-35.v1.inf.gpu.model': z.string().min(1).max(256).optional(),
  }).passthrough();
const runtimeSchema = z.object({ properties: propertiesSchema.nullable() }).passthrough();
const providerSchema = z.object({
  node_id: golemNodeIdSchema,
  runtimes: z.record(z.unknown()),
  online: z.boolean(),
  updated_at: z.string().datetime({ offset: true }),
}).passthrough();

export type GolemProviderObservation = {
  nodeId: string;
  runtime: GolemRuntime;
  cpuCores: number;
  cpuThreads: number;
  memoryGiB: number;
  storageGiB: number;
  gpuModel?: string;
  onlineReported: boolean;
  observedAt: string;
  recentlyObserved: boolean;
};

/** Indexed statistics only: this does not discover a live offer or prove lease availability. */
export class GolemStatsReader {
  private readonly origin = 'https://api.stats.golem.network';
  constructor(private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  private async get(id: string): Promise<unknown> {
    const response = await this.fetchImpl(this.origin + '/v2/provider/node/' + id, {
      method: 'GET', redirect: 'error', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Golem Stats GET failed (${response.status})`);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json'))
      throw new Error('Golem Stats response is not JSON');
    if (!response.body) throw new Error('Golem Stats response is empty');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 1_048_576) throw new Error('Golem Stats response exceeds size limit');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown;
  }

  async provider(nodeId: string, runtime: GolemRuntime = 'vm'): Promise<GolemProviderObservation> {
    const id = golemNodeIdSchema.parse(nodeId);
    const selectedRuntime = golemRuntimeSchema.parse(runtime);
    const providers = z.array(providerSchema).min(1).max(1).parse(await this.get(id));
    const item = providers[0]!;
    if (item.node_id !== id) throw new Error('Golem node identity mismatch');
    const selected = item.runtimes[selectedRuntime];
    if (selected === undefined) throw new Error('Golem runtime has no current inventory');
    const properties = runtimeSchema.parse(selected).properties;
    if (!properties) throw new Error('Golem runtime has no current inventory');
    if (properties.id !== id || properties['golem.runtime.name'] !== selectedRuntime)
      throw new Error('Golem runtime identity mismatch');
    const gpuModel = selectedRuntime === 'vm-nvidia'
      ? properties['golem.!exp.gap-35.v1.inf.gpu.model'] : undefined;
    if (selectedRuntime === 'vm-nvidia' && !gpuModel) throw new Error('Golem GPU model is unavailable');
    const observedAtMs = Date.parse(item.updated_at);
    const ageMs = this.now() - observedAtMs;
    return {
      nodeId: id, runtime: selectedRuntime,
      cpuCores: properties['golem.inf.cpu.cores'],
      cpuThreads: properties['golem.inf.cpu.threads'],
      memoryGiB: properties['golem.inf.mem.gib'],
      storageGiB: properties['golem.inf.storage.gib'],
      ...(gpuModel ? { gpuModel } : {}),
      onlineReported: item.online, observedAt: item.updated_at,
      recentlyObserved: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60_000,
    };
  }

  /** Only caller-approved identities are queried. Four concurrent GETs maximum. */
  async providers(nodeIds: string[], runtime: GolemRuntime = 'vm'): Promise<GolemProviderObservation[]> {
    const ids = z.array(golemNodeIdSchema).min(1).max(64).parse(nodeIds);
    const selectedRuntime = golemRuntimeSchema.parse(runtime);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate Golem node identity');
    const results: GolemProviderObservation[] = [];
    for (let offset = 0; offset < ids.length; offset += 4)
      results.push(...await Promise.all(ids.slice(offset, offset + 4).map(id => this.provider(id, selectedRuntime))));
    return results;
  }
}

export interface GolemStatsReadClient {
  provider(nodeId: string, runtime?: GolemRuntime): Promise<GolemProviderObservation>;
  providers(nodeIds: string[], runtime?: GolemRuntime): Promise<GolemProviderObservation[]>;
}
