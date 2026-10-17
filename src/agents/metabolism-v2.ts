import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import { evaluateMetabolism, unitsSchema, type AgentMode } from './types.js';

const profileSchema = z.enum(['full', 'lean', 'torpor']);
/** Cost of repeating the original bounded reservation, including its fixed inference once per lease.
 * This is a conservative planning rate, never a new charge or a claim about CPU actually consumed.
 */
export const paidMetabolismRateSchema = z.object({ runId: bytes32Schema, hostId: bytes32Schema,
  resourceProfile: profileSchema, leaseSeconds: z.number().int().min(1).max(120),
  cpuPricePerSecond: unitsSchema, fixedInferencePrice: unitsSchema,
  feeBps: z.number().int().min(0).max(1200), completeLeaseCost: unitsSchema, burnPerHour: unitsSchema }).strict()
  .superRefine((rate, context) => {
    const base = BigInt(rate.cpuPricePerSecond) * BigInt(rate.leaseSeconds) + BigInt(rate.fixedInferencePrice);
    const cost = base + (base * BigInt(rate.feeBps) + 9999n) / 10000n;
    if (cost === 0n || cost !== BigInt(rate.completeLeaseCost)
      || (cost * 3600n + BigInt(rate.leaseSeconds) - 1n) / BigInt(rate.leaseSeconds) !== BigInt(rate.burnPerHour)) {
      context.addIssue({ code: 'custom', message: 'Paid Metabolism rate does not conserve the original fee-inclusive lease cost' });
    }
  });
export type PaidMetabolismRate = z.infer<typeof paidMetabolismRateSchema>;
export const paidMetabolismSnapshotSchema = z.object({ version: z.literal(2),
  observedAt: z.number().int().positive().safe(), blockNumber: unitsSchema, blockHash: bytes32Schema, availableBalance: unitsSchema,
  contextRunId: bytes32Schema.nullable(), current: paidMetabolismRateSchema.nullable(),
  projections: z.array(paidMetabolismRateSchema).max(3) }).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.projections.map(rate => rate.resourceProfile)).size !== snapshot.projections.length
    || snapshot.current && snapshot.current.runId !== snapshot.contextRunId
    || snapshot.projections.some(rate => rate.runId !== snapshot.contextRunId)
    || snapshot.contextRunId === null && snapshot.projections.length !== 0) {
    context.addIssue({ code: 'custom', message: 'Paid Metabolism pricing context changed' });
  }
});
export type PaidMetabolismSnapshot = z.infer<typeof paidMetabolismSnapshotSchema>;

export function paidMetabolismRate(input: Omit<PaidMetabolismRate, 'completeLeaseCost' | 'burnPerHour'>): PaidMetabolismRate {
  const base = BigInt(input.cpuPricePerSecond) * BigInt(input.leaseSeconds) + BigInt(input.fixedInferencePrice);
  const cost = base + (base * BigInt(input.feeBps) + 9999n) / 10000n;
  return paidMetabolismRateSchema.parse({ ...input, completeLeaseCost: cost.toString(),
    burnPerHour: ((cost * 3600n + BigInt(input.leaseSeconds) - 1n) / BigInt(input.leaseSeconds)).toString() });
}

/** Display retains the original trailing-24h denominator. Decisions compare exact prospective
 * profile fractions, so a lower actual lean burn cannot by itself promote the agent back to full.
 */
export function evaluateMetabolismV2(balanceValue: string, trailingBurnValue: string, raw: PaidMetabolismSnapshot) {
  const balance = BigInt(unitsSchema.parse(balanceValue)), pricing = paidMetabolismSnapshotSchema.parse(raw);
  if (balance !== BigInt(pricing.availableBalance)) throw new Error('Metabolism balance differs from its canonical pricing snapshot');
  const display = evaluateMetabolism(balanceValue, trailingBurnValue);
  let mode: AgentMode = 'cyst', selected: PaidMetabolismRate | undefined;
  if (balance > 0n) for (const profile of ['full', 'lean', 'torpor'] as const) {
    const rate = pricing.projections.find(value => value.resourceProfile === profile);
    if (!rate) continue;
    const available = balance * BigInt(rate.leaseSeconds), threshold = BigInt(rate.completeLeaseCost)
      * (profile === 'full' ? 72n * 3600n : profile === 'lean' ? 24n * 3600n : 2n * 3600n);
    if (profile === 'full' ? available > threshold : available >= threshold) { mode = profile; selected = rate; break; }
  }
  const runway = (rate: PaidMetabolismRate | undefined | null) => rate
    ? (balance * BigInt(rate.leaseSeconds) / BigInt(rate.completeLeaseCost)).toString() : null;
  return { ...display, mode, metabolismVersion: 2 as const, currentBurnPerHour: pricing.current?.burnPerHour ?? null,
    currentRunwaySeconds: runway(pricing.current), decisionRunwaySeconds: runway(selected), pricing,
    decisionReason: balance === 0n ? 'zero_balance' as const : pricing.projections.length === 0
      ? 'no_pricing_context' as const : selected ? 'affordable_profile' as const : 'no_affordable_profile' as const };
}

export const metabolismV2EvaluationFields = { metabolismVersion: z.literal(2), currentBurnPerHour: unitsSchema.nullable(),
  currentRunwaySeconds: unitsSchema.nullable(), decisionRunwaySeconds: unitsSchema.nullable(),
  pricing: paidMetabolismSnapshotSchema, decisionReason: z.enum(['zero_balance', 'no_pricing_context', 'affordable_profile', 'no_affordable_profile']) };
