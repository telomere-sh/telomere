import { z } from 'zod';
import { bytes32Schema } from '../common.js';

export const paidCpuReliabilitySchema = z.object({ protocol: z.literal('telomere-paid-cpu-reliability-v1'),
  scope: z.literal('verified-local-controller-history'), marketWide: z.literal(false),
  hardwareClass: z.literal('cpu'), lane: z.enum(['standard', 'interruptible']), hostId: bytes32Schema,
  from: z.number().int().safe().nonnegative(), until: z.number().int().safe().nonnegative(),
  eligible: z.number().int().nonnegative(), completed: z.number().int().nonnegative(),
  reliabilityBps: z.number().int().min(1).max(10000),
  noHistoryPrior: z.literal(10000), excludedUnverified: z.number().int().nonnegative(),
  attribution: z.literal('canonical-financial-settlement-and-retained-hostkit-cleanup'),
}).strict();
/** Completed means a clean retained terminal outcome; owner cancellation and
 * natural lease expiry are successful cleanup, while a host/controller fault
 * is a failed sample. Undispatched refunds and unverifiable history do not vote.
 * The documented neutral prior is explicit and never presented as observations. */
export function paidCpuReliability(hostId: string, lane: 'standard' | 'interruptible', now: number,
  records: { hostId: string; lane: 'standard' | 'interruptible'; endedAt: number; cleanOutcome: boolean }[], excludedUnverified = 0) {
  const from = Math.max(0, now - 30 * 86400);
  const eligible = records.filter(row => row.hostId === hostId && row.lane === lane && row.endedAt >= from && row.endedAt <= now);
  const completed = eligible.filter(row => row.cleanOutcome).length;
  return paidCpuReliabilitySchema.parse({ protocol: 'telomere-paid-cpu-reliability-v1',
    scope: 'verified-local-controller-history', marketWide: false, hardwareClass: 'cpu', hostId, lane,
    from, until: now, eligible: eligible.length, completed,
    reliabilityBps: eligible.length ? Math.max(1, Math.floor(completed * 10000 / eligible.length)) : 10000,
    noHistoryPrior: 10000, excludedUnverified,
    attribution: 'canonical-financial-settlement-and-retained-hostkit-cleanup' });
}
