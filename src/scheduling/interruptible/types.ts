import { z } from 'zod';
import { addressSchema, bytes32Schema, moneySchema } from '../../common.js';
import { capacitySchema, placementSchema } from '../planner.js';
import { hostKeySchema, signedLeaseSchema } from '../../host-kit/protocol.js';

export const PREEMPTION_MIN_NOTICE_MS = 30_000;
export const PREEMPTION_MAX_NOTICE_MS = 120_000;
export const MAX_INTERRUPTIBLE_TARGETS = 16;
export const interruptibleOwnerSchema = addressSchema.transform(value => value.toLowerCase());
export const interruptibleKeySchema = z.string().min(8).max(96).regex(/^[A-Za-z0-9_-]+$/);
export const interruptiblePlacementSchema = placementSchema.pick({ hardwareClasses: true, regions: true,
  images: true, sealedOnly: true, lanes: true }).refine(value => value.hardwareClasses.every(kind => kind === 'cpu'),
  'This implementation admits CPU capacity only');
export const interruptibleAdmissionSchema = z.object({ agent: interruptibleOwnerSchema, runId: bytes32Schema,
  optIn: z.literal(true), allowTerminalAgentKill: z.literal(true), resumeSeconds: z.number().int().min(1).max(120),
  maxSpend: moneySchema, deadline: z.number().int().safe().positive(), placement: interruptiblePlacementSchema }).strict();
export type InterruptibleAdmission = z.infer<typeof interruptibleAdmissionSchema>;

/** Authoritative existing reservations only. Producing this value must never create a payment or reservation. */
export const approvedInterruptibleRunSchema = z.object({ runId: bytes32Schema, owner: interruptibleOwnerSchema,
  agent: interruptibleOwnerSchema, reserved: z.literal(true), active: z.boolean(), hostKey: hostKeySchema,
  capacity: capacitySchema, maxSeconds: z.number().int().min(1).max(120), ceiling: moneySchema,
  leaseUntil: z.number().int().safe().positive(), sourceLease: signedLeaseSchema.optional() }).strict();
export type ApprovedInterruptibleRun = z.infer<typeof approvedInterruptibleRunSchema>;
export const preemptionNoticeBodySchema = z.object({ domain: z.literal('telomere-interruptible/v1'), version: z.literal(1),
  noticeId: bytes32Schema, hostKey: hostKeySchema, owner: interruptibleOwnerSchema, agent: interruptibleOwnerSchema,
  runId: bytes32Schema, leaseHash: bytes32Schema, issuedAt: z.number().int().safe().nonnegative(),
  interruptAt: z.number().int().safe().positive(), reason: z.enum(['maintenance', 'capacity']) }).strict();
export const signedPreemptionNoticeSchema = z.object({ body: preemptionNoticeBodySchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type SignedPreemptionNotice = z.infer<typeof signedPreemptionNoticeSchema>;
export const completedInterruptibleSettlementSchema = z.object({ runId: bytes32Schema, owner: interruptibleOwnerSchema,
  agent: interruptibleOwnerSchema, receiptId: bytes32Schema, billableSeconds: z.number().int().min(0).max(120),
  pricePerSecond: moneySchema, ceiling: moneySchema, charged: moneySchema, refund: moneySchema,
  confirmed: z.literal(true), cleanupConfirmed: z.literal(true) }).strict();
export type CompletedInterruptibleSettlement = z.infer<typeof completedInterruptibleSettlementSchema>;
export type InterruptibleState = 'admitted' | 'noticed' | 'checkpointing' | 'settling' | 'selecting' | 'waking'
  | 'cancelling' | 'resumed' | 'cancelled';
export const interruptiblePublicSchema = z.object({ id: bytes32Schema, owner: interruptibleOwnerSchema,
  agent: interruptibleOwnerSchema, runId: bytes32Schema,
  state: z.enum(['admitted', 'noticed', 'checkpointing', 'settling', 'selecting', 'waking', 'cancelling', 'resumed', 'cancelled']),
  version: z.number().int().nonnegative(), deadline: z.number().int().safe().positive(), resumeSeconds: z.number().int().min(1).max(120),
  maxSpend: moneySchema, spent: moneySchema, remainingBudget: moneySchema, confirmedSourceRefund: moneySchema.nullable(),
  confirmedTargetRefund: moneySchema.nullable(),
  refundConfirmed: z.boolean(), completedSeconds: z.number().int().min(0).max(120).nullable(), receiptId: bytes32Schema.nullable(),
  notice: signedPreemptionNoticeSchema.nullable(), checkpointId: bytes32Schema.nullable(), targetRunId: bytes32Schema.nullable(),
  approvedTargetRunIds: z.array(bytes32Schema).max(MAX_INTERRUPTIBLE_TARGETS), reason: z.string().max(96).nullable(),
  unconfirmedTargetReservations: z.array(z.object({ runId: bytes32Schema, ceiling: moneySchema,
    refundStatus: z.literal('unconfirmed') }).strict()).max(MAX_INTERRUPTIBLE_TARGETS),
  walletActionRequired: z.literal(false), sourceSettlementPending: z.boolean(), cancellationMayKillJobAgent: z.literal(true),
  applicationStateOnly: z.literal(true) }).strict();
