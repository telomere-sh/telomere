import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson } from '../common.js';
import { golemNodeIdSchema } from './golem-stats.js';

export const golemFinanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const golemFinanceUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,35})$/);
const positiveUnits = golemFinanceUnitsSchema.refine(value => BigInt(value) > 0n);
const timestamp = z.number().int().nonnegative().safe();
const nonzeroAddress = addressSchema.refine(value => !/^0x0{40}$/i.test(value), 'A reviewed nonzero address is required');
const nonzeroNode = golemNodeIdSchema.refine(value => !/^0x0{40}$/.test(value), 'A reviewed nonzero node is required');
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
export function golemAmountToBaseUnits(value: unknown): bigint {
  const [whole, fraction = ''] = decimal.parse(value).split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
export function golemBaseUnitsToAmount(value: string): string {
  const units = BigInt(golemFinanceUnitsSchema.parse(value));
  const fraction = (units % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return (units / 10n ** 18n).toString() + (fraction ? '.' + fraction : '');
}
export const golemFinancePolicySchema = z.object({ version: z.literal(1), policyId: bytes32Schema,
  runAuthorityId: bytes32Schema, treasuryAuthorityId: bytes32Schema, finalityAuthorityId: bytes32Schema,
  requestorId: nonzeroNode, payerAddr: nonzeroAddress,
  paymentPlatform: z.literal('erc20-polygon-glm'), tokenDecimals: z.literal(18),
  expiresAtMs: timestamp, maxLifetimeGlmBaseUnits: positiveUnits,
  maxLifetimeUsdcMicros: positiveUnits.refine(value => BigInt(value) <= 2_500_000_000n),
  minimumConfirmations: z.number().int().min(1).max(1024),
}).strict();
export type GolemFinancePolicy = z.infer<typeof golemFinancePolicySchema>;
export const golemOriginalRunSchema = z.object({ authorityId: bytes32Schema, owner: nonzeroAddress,
  runId: bytes32Schema, authorizationHash: bytes32Schema, active: z.boolean(), asOfMs: timestamp,
  requestorId: nonzeroNode, providerId: nonzeroNode,
  payerAddr: nonzeroAddress, payeeAddr: nonzeroAddress, paymentPlatform: golemFinancePolicySchema.shape.paymentPlatform,
  allocationId: golemFinanceIdSchema, agreementId: golemFinanceIdSchema, activityId: golemFinanceIdSchema,
  imageDigest: bytes32Schema, spendUntilMs: timestamp,
  maxGlmBaseUnits: positiveUnits, maxUsdcMicros: positiveUnits.refine(value => BigInt(value) <= 250_000_000n),
}).strict();
export type GolemOriginalRun = z.infer<typeof golemOriginalRunSchema>;
export function golemOriginalBinding(value: GolemOriginalRun) {
  const { active: _active, asOfMs: _asOfMs, ...binding } = value;
  return binding;
}
export type GolemFinanceBinding = ReturnType<typeof golemOriginalBinding>;
export const golemTreasuryEvidenceSchema = z.object({ authorityId: bytes32Schema, policyId: bytes32Schema,
  requestorId: golemNodeIdSchema, payerAddr: addressSchema,
  paymentPlatform: golemFinancePolicySchema.shape.paymentPlatform,
  availableGlmBaseUnits: golemFinanceUnitsSchema, availableUsdcMicros: golemFinanceUnitsSchema,
  evidenceHash: bytes32Schema, asOfMs: timestamp }).strict();
export type GolemTreasuryEvidence = z.infer<typeof golemTreasuryEvidenceSchema>;
const parties = { issuerId: golemNodeIdSchema, recipientId: golemNodeIdSchema,
  payerAddr: addressSchema, payeeAddr: addressSchema, paymentPlatform: golemFinancePolicySchema.shape.paymentPlatform,
  agreementId: golemFinanceIdSchema, timestamp: z.string().datetime({ offset: true }),
  status: z.enum(['ISSUED', 'RECEIVED', 'ACCEPTED', 'REJECTED', 'FAILED', 'SETTLED', 'CANCELLED']) };
export const golemDebitNoteSchema = z.object({ ...parties, debitNoteId: golemFinanceIdSchema,
  activityId: golemFinanceIdSchema, previousDebitNoteId: golemFinanceIdSchema.nullable(),
  totalAmountDue: decimal, paymentDueDate: z.string().datetime({ offset: true }).nullable() }).strict();
export const golemInvoiceSchema = z.object({ ...parties, invoiceId: golemFinanceIdSchema,
  activityIds: z.array(golemFinanceIdSchema).length(1), amount: decimal,
  paymentDueDate: z.string().datetime({ offset: true }) }).strict();
export type GolemFinanceDocument = z.infer<typeof golemDebitNoteSchema> | z.infer<typeof golemInvoiceSchema>;
export type GolemFinanceDocumentKind = 'debit' | 'invoice';
export function golemDocumentSummary(kind: GolemFinanceDocumentKind, raw: unknown) {
  const value = kind === 'debit' ? golemDebitNoteSchema.parse(raw) : golemInvoiceSchema.parse(raw);
  const { status, ...economic } = value;
  const units = golemAmountToBaseUnits('totalAmountDue' in value ? value.totalAmountDue : value.amount).toString();
  return { value, kind, id: 'debitNoteId' in value ? value.debitNoteId : value.invoiceId, status,
    totalBaseUnits: units, hash: hashJson({ ...economic,
      ...('totalAmountDue' in value ? { totalAmountDue: units } : { amount: units }) }) };
}
const share = z.object({ amount: decimal, allocationId: golemFinanceIdSchema }).strict();
export const golemPaymentSchema = z.object({ paymentId: golemFinanceIdSchema,
  payerId: golemNodeIdSchema, payeeId: golemNodeIdSchema, payerAddr: addressSchema, payeeAddr: addressSchema,
  paymentPlatform: golemFinancePolicySchema.shape.paymentPlatform, amount: decimal,
  timestamp: z.string().datetime({ offset: true }), details: z.string().max(16_384),
  agreementPayments: z.array(share.extend({ agreementId: golemFinanceIdSchema }).strict()).max(32),
  activityPayments: z.array(share.extend({ activityId: golemFinanceIdSchema }).strict()).max(32),
}).strict();
export type GolemFinancePayment = z.infer<typeof golemPaymentSchema>;
const evidence = { authorityId: bytes32Schema, bindingHash: bytes32Schema, asOfMs: timestamp };
export const golemStopEvidenceSchema = z.discriminatedUnion('confirmed', [
  z.object({ ...evidence, confirmed: z.literal(false) }).strict(),
  z.object({ ...evidence, confirmed: z.literal(true), proofHash: bytes32Schema,
    activityId: golemFinanceIdSchema, agreementId: golemFinanceIdSchema,
    activityStoppedAtMs: timestamp, agreementTerminatedAtMs: timestamp }).strict(),
]);
export const golemPaymentFinalitySchema = z.discriminatedUnion('confirmed', [
  z.object({ ...evidence, confirmed: z.literal(false), paymentId: golemFinanceIdSchema,
    paymentHash: bytes32Schema }).strict(),
  z.object({ ...evidence, confirmed: z.literal(true), paymentId: golemFinanceIdSchema,
    paymentHash: bytes32Schema, proofHash: bytes32Schema, settlementReference: bytes32Schema,
    confirmations: z.number().int().min(1).max(1_000_000) }).strict(),
]);
export const golemReleaseEvidenceSchema = z.discriminatedUnion('confirmed', [
  z.object({ ...evidence, confirmed: z.literal(false) }).strict(),
  z.object({ ...evidence, confirmed: z.literal(true), proofHash: bytes32Schema,
    allocationId: golemFinanceIdSchema }).strict(),
]);
export type GolemFinanceAction = 'accept_debit' | 'accept_invoice' | 'destroy_activity' | 'terminate_agreement' | 'release_allocation';
export function golemFinanceIntentId(bindingHash: string, action: GolemFinanceAction, resourceId: string) {
  return hashJson({ domain: 'telomere.golem.financial-intent.v1', bindingHash, action, resourceId });
}

/** Explicit trusted protocol seam. The opt-in HTTP implementation is unmounted;
 * accept operations can initiate real payment and require a durable original intent. */
export interface GolemFinanceProtocol {
  document(kind: GolemFinanceDocumentKind, id: string, signal: AbortSignal): Promise<unknown>;
  payment(id: string, signal: AbortSignal): Promise<unknown>;
  mutate(action: GolemFinanceAction, binding: GolemFinanceBinding,
    resourceId: string, totalAmountAccepted: string | undefined, signal: AbortSignal): Promise<void>;
}
/** Independent trusted reader/verifier ports, never supplied by a public body.
 * Yagna document status and HTTP acknowledgement alone establish no finality. */
export interface GolemFinanceAuthorities {
  originalRun(owner: string, runId: string, signal: AbortSignal): Promise<unknown>;
  treasury(signal: AbortSignal): Promise<unknown>;
  stop(binding: GolemFinanceBinding, signal: AbortSignal): Promise<unknown>;
  payment(binding: GolemFinanceBinding, payment: GolemFinancePayment, signal: AbortSignal): Promise<unknown>;
  release(binding: GolemFinanceBinding, signal: AbortSignal): Promise<unknown>;
}
