import { z } from 'zod';
import { addressSchema, bytes32Schema } from '../../common.js';
import { hostKeySchema, imageDigestSchema } from '../protocol.js';

export const PAID_PREEMPTION_MIN_NOTICE_MS = 30_000;
export const PAID_PREEMPTION_MAX_NOTICE_MS = 120_000;
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const scope = {
  version: z.literal(1), hostKey: hostKeySchema,
  owner: addressSchema.transform(value => value.toLowerCase()),
  runId: bytes32Schema, leaseHash: bytes32Schema, image: imageDigestSchema,
};

/** A controller attestation that its authenticated Vault owner explicitly
 * opted this already-admitted, immutable paid lease into host preemption.
 */
export const paidPreemptionOptInSchema = z.object({ body: z.object({
  domain: z.literal('telomere-paid-preemption-optin/v1'), ...scope,
  nonce: bytes32Schema, issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
}).strict(), signature }).strict();
export type SignedPaidPreemptionOptIn = z.infer<typeof paidPreemptionOptInSchema>;

/** Controller-authenticated remote request. A local host scheduler may call
 * the service directly, but neither path can issue before opt-in.
 */
export const paidPreemptionRequestSchema = z.object({ body: z.object({
  domain: z.literal('telomere-paid-preemption-request/v1'), ...scope,
  nonce: bytes32Schema, issuedAt: z.number().int().nonnegative().safe(),
  noticeMilliseconds: z.number().int().min(PAID_PREEMPTION_MIN_NOTICE_MS).max(PAID_PREEMPTION_MAX_NOTICE_MS),
  reason: z.enum(['maintenance', 'capacity']),
}).strict(), signature }).strict();
export type SignedPaidPreemptionRequest = z.infer<typeof paidPreemptionRequestSchema>;

export const paidPreemptionNoticeSchema = z.object({ body: z.object({
  domain: z.literal('telomere-paid-preemption/v1'), ...scope,
  noticeId: bytes32Schema, optInHash: bytes32Schema,
  issuedAt: z.number().int().nonnegative().safe(),
  interruptAt: z.number().int().positive().safe(),
  reason: z.enum(['maintenance', 'capacity']),
}).strict(), signature }).strict();
export type SignedPaidPreemptionNotice = z.infer<typeof paidPreemptionNoticeSchema>;
