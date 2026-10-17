import { z } from 'zod';
import { bytes32Schema } from '../common.js';

/** Optional, versioned financial workload commitment. Omission is legacy standard. */
export const paidCpuSchedulingSchema = z.object({ version: z.literal(1),
  lane: z.enum(['standard', 'interruptible']),
  interruptibleConsent: z.object({ minimumNoticeSeconds: z.literal(30) }).strict().optional(),
  job: z.object({ jobId: bytes32Schema, intentHash: bytes32Schema,
    sourceRunId: bytes32Schema.optional(), sourceQuoteHash: bytes32Schema.optional(),
    decisionHash: bytes32Schema.optional(), targetHostId: bytes32Schema.optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.lane === 'interruptible') !== !!value.interruptibleConsent) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Interruptible CPU requires explicit thirty-second notice consent.' });
  }
  const job = value.job;
  if (job && ([job.sourceRunId, job.sourceQuoteHash, job.decisionHash].filter(Boolean).length
    !== (job.decisionHash ? 3 : 0) || job.decisionHash && !job.targetHostId)) context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'A replacement binds its exact source, decision and target together.' });
});
export type PaidCpuScheduling = z.infer<typeof paidCpuSchedulingSchema>;
/** Operator-reviewed support, never inferred from a low posted price. */
export const paidInterruptibleCapabilitySchema = z.object({ protocol: z.literal('telomere-paid-preemption/v1'),
  minimumNoticeSeconds: z.literal(30), hostOptInRequired: z.literal(true) }).strict();
