import { z } from 'zod';
import { bytes32Schema, hashJson, moneySchema, Problem } from '../common.js';
import { capacityIdentity, capacitySchema, placementSchema, selectCapacity,
  type Capacity, type CapacitySelectionOptions } from './planner.js';

const cpuPlacementSchema = placementSchema.refine(value => value.hardwareClasses.every(kind => kind === 'cpu'),
  'CPU replacement planning admits CPU capacity only');
export const cpuReplacementInputSchema = z.object({
  jobId: bytes32Schema,
  original: cpuPlacementSchema,
  source: z.object({ runId: bytes32Schema, hostId: bytes32Schema, quoteHash: bytes32Schema, ceiling: moneySchema }).strict(),
  now: z.number().int().safe().nonnegative(),
  remainingSeconds: z.number().int().min(1).max(86400),
  /** Restore time occupies and may bill the new CPU reservation. */
  restoreSeconds: z.number().int().min(0).max(600),
  checkpointHash: bytes32Schema.nullable(),
  sourceCleanupConfirmed: z.boolean(),
  /** Only a canonical confirmed receipt can release the source reservation. */
  sourceSettlement: z.object({ receiptHash: bytes32Schema, charged: moneySchema, refund: moneySchema,
    confirmed: z.literal(true) }).strict().nullable(),
  priorCharged: moneySchema,
  /** Still funded reservations count at their full ceiling until settled/refunded. */
  outstandingLiability: moneySchema,
}).strict();
export type CpuReplacementInput = z.infer<typeof cpuReplacementInputSchema>;

const cpuReplacementProposalBodySchema = z.object({
  domain: z.literal('telomere.cpu-replacement.v1'), jobId: bytes32Schema, originalIntentHash: bytes32Schema,
  sourceRunId: bytes32Schema, sourceHostId: bytes32Schema, sourceQuoteHash: bytes32Schema, sourceReceiptHash: bytes32Schema,
  checkpointHash: bytes32Schema, assessedAt: z.number().int().safe().nonnegative(),
  originalDeadline: z.number().int().safe().positive(), originalMaxSpend: moneySchema,
  charged: moneySchema, outstandingLiability: moneySchema, remainingBudget: moneySchema,
  remainingSeconds: z.number().int().min(1).max(86400), restoreSeconds: z.number().int().min(0).max(600),
  reservationSeconds: z.number().int().min(1).max(86400),
  target: capacitySchema.refine(value => value.hardwareClass === 'cpu', 'A replacement must use CPU capacity'),
  capacityId: bytes32Schema, ceiling: moneySchema, liabilityCeiling: moneySchema,
  plannedStart: z.number().int().safe().nonnegative(), plannedFinish: z.number().int().safe().positive(),
  candidates: z.number().int().min(1).max(1000),
}).strict();
export const cpuReplacementProposalSchema = cpuReplacementProposalBodySchema.extend({
  decisionHash: bytes32Schema, requiresSeparateOwnerApproval: z.literal(true), fundsReserved: z.literal(false),
}).strict();
export type CpuReplacementProposal = z.infer<typeof cpuReplacementProposalSchema>;

/**
 * Replans only controller-confirmed facts over the reviewed finite catalogue.
 * Producing a proposal never changes an existing quote, reserves funds or resumes a Cell.
 */
export function planCpuReplacement(raw: CpuReplacementInput, supplied: Capacity[], options: CapacitySelectionOptions = {}) {
  const input = cpuReplacementInputSchema.parse(raw);
  if (supplied.length > 1000) throw new Problem(422, 'capacity_limit', 'The capacity catalogue exceeds its supported bound.');
  if (input.now < input.original.now || input.remainingSeconds > input.original.seconds
    || BigInt(input.source.ceiling) > BigInt(input.original.maxSpend)) {
    throw new Problem(422, 'replacement_scope_invalid', 'Replacement work must remain inside the original deadline intent.');
  }
  const originalIntentHash = hashJson({ domain: 'telomere.cpu-deadline-intent.v1', jobId: input.jobId,
    request: input.original, source: input.source });
  const identity = { jobId: input.jobId, originalIntentHash, sourceRunId: input.source.runId,
    sourceQuoteHash: input.source.quoteHash, fundsReserved: false as const };
  const settlement = input.sourceSettlement;
  if (settlement && BigInt(settlement.charged) + BigInt(settlement.refund) !== BigInt(input.source.ceiling)) {
    throw new Problem(409, 'replacement_settlement_invalid', 'The source receipt must conserve its original reservation.');
  }
  const reservationSeconds = input.remainingSeconds + input.restoreSeconds;
  if (reservationSeconds > 86400 || BigInt(input.now) + BigInt(reservationSeconds) > BigInt(input.original.deadline)) {
    // A missed deadline is final even while cleanup or source settlement is pending.
    // Keep the complete source ceiling at risk until its receipt is confirmed.
    const knownCharged = BigInt(input.priorCharged) + BigInt(settlement?.charged ?? '0');
    const stillReserved = BigInt(input.outstandingLiability) + (settlement ? 0n : BigInt(input.source.ceiling));
    const available = BigInt(input.original.maxSpend) - knownCharged - stillReserved;
    return { ...identity, action: 'cancel' as const, reason: 'deadline_infeasible' as const,
      charged: knownCharged.toString(), outstandingLiability: stillReserved.toString(),
      remainingBudget: (available < 0n ? 0n : available).toString(), confirmedSourceRefund: settlement?.refund ?? null,
      sourceSettlementConfirmed: settlement !== null, sourceCleanupConfirmed: input.sourceCleanupConfirmed,
      outstandingRefundConfirmed: stillReserved === 0n, stopAndRefundRequired: true as const };
  }
  if (!input.sourceCleanupConfirmed || !settlement || !input.checkpointHash) {
    return { ...identity, action: 'wait' as const,
      reason: !input.sourceCleanupConfirmed ? 'source_cleanup' as const : !settlement ? 'source_settlement' as const : 'checkpoint' as const,
      sourceReservationReleased: settlement !== null, sourceCleanupConfirmed: input.sourceCleanupConfirmed };
  }
  const charged = BigInt(input.priorCharged) + BigInt(settlement.charged);
  const budget = BigInt(input.original.maxSpend) - charged - BigInt(input.outstandingLiability);
  const cancel = (reason: 'budget_exhausted' | 'deadline_infeasible' | 'capacity_infeasible') => ({
    ...identity, action: 'cancel' as const, reason, charged: charged.toString(),
    outstandingLiability: input.outstandingLiability, remainingBudget: (budget < 0n ? 0n : budget).toString(),
    confirmedSourceRefund: settlement.refund, outstandingRefundConfirmed: BigInt(input.outstandingLiability) === 0n,
    stopAndRefundRequired: true as const,
  });
  if (budget <= 0n) return cancel('budget_exhausted');
  // Exclude the physical source in every lane: cleanup does not assert that it is
  // healthy after preemption. A separately approved future intent may admit it again.
  const targets = supplied.filter(row => bytes32Schema.parse(row.hostId) !== input.source.hostId);
  try {
    const placement = selectCapacity({ ...input.original, hardwareClasses: ['cpu'], seconds: reservationSeconds,
      maxSpend: budget.toString(), now: input.now }, targets, options);
    const body = cpuReplacementProposalBodySchema.parse({ domain: 'telomere.cpu-replacement.v1',
      jobId: input.jobId, originalIntentHash, sourceRunId: input.source.runId, sourceHostId: input.source.hostId,
      sourceQuoteHash: input.source.quoteHash,
      sourceReceiptHash: settlement.receiptHash,
      checkpointHash: input.checkpointHash, assessedAt: input.now,
      originalDeadline: input.original.deadline, originalMaxSpend: input.original.maxSpend,
      charged: charged.toString(), outstandingLiability: input.outstandingLiability, remainingBudget: budget.toString(),
      remainingSeconds: input.remainingSeconds, restoreSeconds: input.restoreSeconds, reservationSeconds,
      target: placement.host, capacityId: placement.capacityId, ceiling: placement.ceiling, liabilityCeiling: placement.liabilityCeiling,
      plannedStart: placement.plannedStart, plannedFinish: placement.plannedFinish, candidates: placement.candidates });
    return { action: 'proposal' as const, proposal: cpuReplacementProposalSchema.parse({ ...body,
      decisionHash: hashJson(body), requiresSeparateOwnerApproval: true, fundsReserved: false }) };
  } catch (error) {
    if (error instanceof Problem && error.code === 'deadline_infeasible') return cancel('capacity_infeasible');
    throw error;
  }
}

/** Check the original owner-approved decision and exact refreshed target terms before preparing a new quote. */
export function assertCpuReplacementApproval(raw: CpuReplacementProposal, approvedDecisionHash: string,
  currentCapacity: Capacity, currentLiabilityCeiling: string, expectedOriginalIntentHash: string, nowValue: number): CpuReplacementProposal {
  const proposal = cpuReplacementProposalSchema.parse(raw), approved = bytes32Schema.parse(approvedDecisionHash);
  const now = z.number().int().safe().nonnegative().parse(nowValue);
  const { decisionHash, requiresSeparateOwnerApproval: _approval, fundsReserved: _reserved, ...body } = proposal;
  if (hashJson(body) !== decisionHash || approved !== decisionHash
    || proposal.originalIntentHash !== bytes32Schema.parse(expectedOriginalIntentHash)) {
    throw new Problem(409, 'replacement_approval_changed', 'Keep the exact original owner-approved replacement decision.');
  }
  const fresh = capacitySchema.parse(currentCapacity), liability = moneySchema.parse(currentLiabilityCeiling);
  if (capacityIdentity(fresh) !== proposal.capacityId || hashJson(fresh) !== hashJson(proposal.target)
    || liability !== proposal.liabilityCeiling) {
    throw new Problem(409, 'replacement_terms_changed', 'The approved target capacity or complete charge ceiling changed.');
  }
  if (capacityIdentity(proposal.target) !== proposal.capacityId
    || proposal.target.hostId === proposal.sourceHostId
    || BigInt(proposal.target.pricePerSecond) * BigInt(proposal.reservationSeconds) !== BigInt(proposal.ceiling)
    || BigInt(proposal.liabilityCeiling) < BigInt(proposal.ceiling)
    || BigInt(proposal.liabilityCeiling) > BigInt(proposal.remainingBudget)
    || BigInt(proposal.charged) + BigInt(proposal.outstandingLiability) + BigInt(proposal.remainingBudget) !== BigInt(proposal.originalMaxSpend)
    || proposal.reservationSeconds !== proposal.remainingSeconds + proposal.restoreSeconds
    || now < proposal.assessedAt || BigInt(Math.max(now, fresh.availableAt)) + BigInt(proposal.reservationSeconds) > BigInt(proposal.originalDeadline)
    || proposal.plannedStart < proposal.assessedAt || proposal.plannedStart < proposal.target.availableAt
    || BigInt(proposal.plannedStart) + BigInt(proposal.reservationSeconds) !== BigInt(proposal.plannedFinish)
    || proposal.plannedFinish > proposal.originalDeadline) {
    throw new Problem(409, 'replacement_proposal_invalid', 'The approved proposal exceeds its original financial or deadline scope.');
  }
  return proposal;
}
