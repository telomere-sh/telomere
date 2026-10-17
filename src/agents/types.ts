import { z } from 'zod';
import { cystAddressSchema, cystIdSchema, cystIdempotencySchema } from '../cysts/types.js';

export type AgentMode = 'full' | 'lean' | 'torpor' | 'cyst';
export type IntentKind = 'migrate' | 'sleep' | 'wake' | 'profile' | 'kill' | 'rollover';
export type IntentPhase = 'checkpoint' | 'stop' | 'attach' | 'resume' | 'profile' | 'done';
export const agentModeSchema = z.enum(['full', 'lean', 'torpor', 'cyst']);
export const unitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) <= 2n ** 256n - 1n);
export const agentAddressSchema = cystAddressSchema;
export const runIdSchema = cystIdSchema;
export const intentIdSchema = z.string().uuid();
export const lifecycleIdempotencySchema = cystIdempotencySchema;
export const POLICY = Object.freeze({ trailingBurnSeconds: 86400, maximumLeaseSeconds: 86400,
  rollBeforeSeconds: 1800, maximumAgentsPerOwner: 64, applicationStateOnly: true });
export const PAID_AGENT_POLICY = Object.freeze({ ...POLICY, maximumLeaseSeconds: 120, rollBeforeSeconds: 30 });

export interface ReservedAgentRun {
  id: string; owner: string; agent: string; reserved: true; leaseUntil: Date;
  resourceProfile?: Exclude<AgentMode, 'cyst'>;
  /** Trusted canonical signed price only; never accepted from a lifecycle HTTP caller. */
  paidPrice?: { leaseSeconds: number; cpuPricePerSecond: string; fixedInferencePrice: string };
}
export interface LifelineEvaluation {
  mode: AgentMode; balance: string; trailing24hBurn: string; runwaySeconds: string | null;
}
/** Exact token-unit arithmetic; no floating point, integer rounding or fiat conversion at thresholds. */
export function evaluateMetabolism(balanceValue: string, burnValue: string): LifelineEvaluation {
  const balance = BigInt(unitsSchema.parse(balanceValue)), burn = BigInt(unitsSchema.parse(burnValue));
  const numerator = balance * 86400n;
  const mode: AgentMode = balance === 0n ? 'cyst' : burn === 0n || numerator > burn * 72n * 3600n ? 'full'
    : numerator >= burn * 24n * 3600n ? 'lean' : numerator >= burn * 2n * 3600n ? 'torpor' : 'cyst';
  return { mode, balance: balanceValue, trailing24hBurn: burnValue, runwaySeconds: burn === 0n ? null : (numerator / burn).toString() };
}
