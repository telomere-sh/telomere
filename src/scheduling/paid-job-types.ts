import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema } from '../common.js';
import { paidSessionTaskSchema } from '../host-kit/sessions/paid-protocol.js';
import { platformPreparedSchema, type PlatformPins } from '../platform-runtime/types.js';
import type { PlatformVaultBinding } from '../platform-runtime/vault.js';
import { cpuReplacementProposalSchema } from './cpu-replacement.js';

export const paidCpuJobInputSchema = z.object({ protocol: z.literal('telomere-paid-cpu-job-v1'),
  leashId: bytes32Schema, task: paidSessionTaskSchema,
  workSeconds: z.number().int().min(10).max(120),
  deadline: z.number().int().positive().safe(), maxSpend: moneySchema,
  regions: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(32).default([]),
  lanes: z.array(z.enum(['standard', 'interruptible'])).min(1).max(2).default(['standard'])
    .refine(values => new Set(values).size === values.length),
  interruptibleConsent: z.object({ minimumNoticeSeconds: z.literal(30) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.lanes.includes('interruptible') !== !!value.interruptibleConsent
    || value.lanes.includes('interruptible') && value.workSeconds <= 30) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'Interruptible CPU requires explicit owner consent and time for thirty-second notice.' });
});
export type PaidCpuJobInput = z.infer<typeof paidCpuJobInputSchema>;
export const paidCpuJobReplanSchema = z.object({ checkpointHash: bytes32Schema,
  /** A retained owner-side preemption cycle must not replan a successor run. */
  expectedSourceRunId: bytes32Schema.optional(),
  remainingSeconds: z.number().int().min(1).max(120), restoreSeconds: z.number().int().min(0).max(120) }).strict()
  .refine(value => value.remainingSeconds + value.restoreSeconds >= 10 && value.remainingSeconds + value.restoreSeconds <= 120,
    'Each separately funded paid CPU reservation must fit its ten-to-120-second session window.');
export type PaidCpuJobReplan = z.infer<typeof paidCpuJobReplanSchema>;
export const paidCpuJobFinishSchema = z.object({
  /** A retained owner completion must never finish a later replacement. */
  expectedSourceRunId: bytes32Schema.optional(),
}).strict();
export const paidCpuJobApprovalSchema = z.object({ decisionHash: bytes32Schema }).strict();
export const paidCpuJobSchema = z.object({ protocol: z.literal('telomere-paid-cpu-job-v1'),
  id: bytes32Schema, owner: addressSchema, vault: addressSchema, intentHash: bytes32Schema,
  binding: z.object({ owner: addressSchema, vault: addressSchema, agentWallet: addressSchema,
    agentId: bytes32Schema, leashId: bytes32Schema }).strict(),
  input: paidCpuJobInputSchema, createdAt: z.number().int().safe().nonnegative(),
  phase: z.enum(['preparing', 'active', 'awaiting_owner', 'approved', 'cancelled', 'finished']),
  runIds: z.array(bytes32Schema).max(64), currentRunId: bytes32Schema.nullable(),
  proposal: cpuReplacementProposalSchema.nullable(), approvalHash: bytes32Schema.nullable(),
  charged: moneySchema, outstandingLiability: moneySchema,
  cancellationReason: z.enum(['deadline_infeasible', 'budget_exhausted', 'capacity_infeasible', 'owner_cancelled']).nullable(),
  prepared: platformPreparedSchema.nullable(), fundsReserved: z.literal(false),
  funding: z.literal('external-wallet-required'),
  stopAndRefundRequired: z.boolean(),
}).strict();
export type PaidCpuJob = z.infer<typeof paidCpuJobSchema>;
export function paidCpuJobIntentHash(id: string, binding: PlatformVaultBinding, input: PaidCpuJobInput, createdAt: number, pins: PlatformPins) {
  const normalize = (value: unknown): unknown => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase() : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)])) : value;
  return hashJson(normalize({ domain: 'telomere-paid-cpu-job-intent/v1', jobId: id, binding, input, createdAt, pins }));
}
export function paidCpuJobQuoteKey(id: string, decisionHash?: string) {
  return 'cpu-job:' + hashJson({ domain: 'telomere-paid-cpu-job-quote/v1', jobId: bytes32Schema.parse(id),
    decisionHash: decisionHash ? bytes32Schema.parse(decisionHash) : null });
}
