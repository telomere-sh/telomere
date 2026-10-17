import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { inspectLargeCystRemoteTopology } from '../cysts/large-checkpoints.js';
import { readReviewedLargeCystReplication } from '../cysts/large-configured.js';

type DestinationState = 'ready' | 'unavailable' | 'unchecked';
export type LargeCystStorageObservation = { status: 'not_configured' } | {
  status: 'ready' | 'read_only' | 'destination_unavailable' | 'unobserved';
  destinations: readonly [DestinationState, DestinationState];
  reason?: 'configuration_untrusted' | 'topology_untrusted' | 'controller_untrusted';
};

const controllerSchema = z.object({
  mode: z.enum(['demo', 'testnet', 'mainnet']),
  chain: z.object({ id: z.number().int().positive() }).passthrough(),
  token: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).passthrough(),
  escrowAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  largeCystsAvailable: z.boolean(), largeCystsReplicated: z.boolean(), largeCystsWritable: z.boolean(),
}).passthrough();

async function controllerWritable(config: Config, origin: URL, request: typeof fetch): Promise<boolean | null> {
  try {
    const response = await request(new URL('/api/config', origin), {
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => undefined); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let count = 0, completed = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) { completed = true; break; }
        count += part.value.byteLength;
        if (count > 16_384) return null;
        chunks.push(part.value);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const parsed = controllerSchema.parse(JSON.parse(Buffer.concat(chunks.map(item => Buffer.from(item))).toString('utf8')));
    if (parsed.mode !== config.MODE || parsed.chain.id !== config.CHAIN_ID
      || parsed.token.address.toLowerCase() !== config.TOKEN_ADDRESS.toLowerCase()
      || parsed.escrowAddress.toLowerCase() !== config.ESCROW_ADDRESS.toLowerCase()
      || !parsed.largeCystsAvailable || !parsed.largeCystsReplicated) return null;
    return parsed.largeCystsWritable;
  } catch { return null; }
}

/** Observes the configured pair without opening the writer or issuing PUT/HEAD.
 * The signed canary GETs attest current reads; the controller flag reflects
 * the startup decision to serve a bound topology read-only after an outage.
 */
export async function observeLargeCystStorage(config: Config, controllerOrigin: URL,
  request: typeof fetch = fetch): Promise<LargeCystStorageObservation> {
  if (!config.CYSTS_LARGE_REPLICATION_CONFIG) return { status: 'not_configured' };
  const directory = config.CYSTS_LARGE_DIR;
  if (!directory) return { status: 'unobserved', destinations: ['unchecked', 'unchecked'],
    reason: 'configuration_untrusted' };
  let reviewed;
  try {
    reviewed = await readReviewedLargeCystReplication(config, resolve(directory));
  } catch { return { status: 'unobserved', destinations: ['unchecked', 'unchecked'],
    reason: 'configuration_untrusted' }; }
  try {
    if (!await inspectLargeCystRemoteTopology(directory, reviewed.topologySha256)) {
      return { status: 'unobserved', destinations: ['unchecked', 'unchecked'], reason: 'topology_untrusted' };
    }
  } catch { return { status: 'unobserved', destinations: ['unchecked', 'unchecked'],
    reason: 'topology_untrusted' }; }
  const [first, second, writable] = await Promise.all([
    reviewed.destinations[0].probeCanary().then(() => 'ready' as const).catch(() => 'unavailable' as const),
    reviewed.destinations[1].probeCanary().then(() => 'ready' as const).catch(() => 'unavailable' as const),
    controllerWritable(config, controllerOrigin, request),
  ]);
  const destinations: readonly [DestinationState, DestinationState] = [first, second];
  if (writable === null) return { status: 'unobserved', destinations, reason: 'controller_untrusted' };
  if (!writable) return { status: 'read_only', destinations };
  if (destinations.includes('unavailable')) return { status: 'destination_unavailable', destinations };
  return { status: 'ready', destinations };
}
