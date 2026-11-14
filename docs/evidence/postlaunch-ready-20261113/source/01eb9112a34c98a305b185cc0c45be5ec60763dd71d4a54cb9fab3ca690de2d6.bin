import { selectionPublicHealthSchema, selectionPublicJson, selectionPublicOrigin } from '../selection/public-http.js';
import type { StatusProbe } from './service-status.js';

/** Probe the actual public source without enabling financial Selection in the CPU controller. */
export function selectionPublicStatusProbe(origin: string, chainId: number, options: { fetch?: typeof fetch; now?: () => number } = {}): StatusProbe {
  const base = selectionPublicOrigin.parse(origin), now = options.now ?? Date.now;
  return async () => {
    try {
      const report = selectionPublicHealthSchema.parse(await selectionPublicJson(base, '/health/selection', { ...options, timeoutMs: 3000, limit: 16384 }));
      if (report.chainId !== chainId || report.state === 'unavailable' || report.asOfSeconds === null || report.indexedThrough === null) return { state: 'unavailable' };
      const age = BigInt(Math.floor(now() / 1000)) - BigInt(report.asOfSeconds);
      if (age < -300n) return { state: 'unavailable' };
      return { state: report.state === 'ready' && !report.stale && age <= 900n ? 'ready' : 'degraded' };
    } catch { return { state: 'unavailable' }; }
  };
}
