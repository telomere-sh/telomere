import { createHash } from 'node:crypto';
import { parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema, signatureSchema } from '../common.js';
import { cpuTaskSchema } from '../runtime/types.js';
import { capacitySchema } from '../scheduling/planner.js';
import { baseUsdcForChainId } from '../chain/chains.js';
import { leaseSchema } from '../host-kit/protocol.js';
import { paidSessionTaskSchema } from '../host-kit/sessions/paid-protocol.js';
import { paidCpuSchedulingSchema, paidInterruptibleCapabilitySchema } from '../scheduling/paid-lanes.js';
import { SPEND_PERMISSION_MANAGER, spendPermissionFundingSchema, spendPermissionProfileSchema } from '../payments/spend-permission-types.js';
import { CPU_PERMIT2, CPU_UPTO_PROXY, x402CpuProfileSchema, x402ReservationSchema } from '../payments/cpu-reservation-types.js';
import { cystInputMaxBytesSchema } from '../host-kit/sessions/cyst-input-protocol.js';
import { cpuLaneOffersSchema, cpuSessionPricesSchema } from '../scheduling/cpu-offers.js';

/** A single command in a reviewed CPU image; this is not a persistent cell session. */
export const platformExecTaskSchema = z.object({ kind: z.literal('exec'),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  argv: leaseSchema.shape.argv.refine(values => values.every(value => Buffer.from(value, 'utf8').toString('utf8') === value), 'Command arguments must contain valid Unicode'),
  stdin: z.string().max(8192).refine(value => Buffer.byteLength(value, 'utf8') <= 8192 && !value.includes('\0')
    && Buffer.from(value, 'utf8').toString('utf8') === value).optional() }).strict();
/** Logical one-shot model request. No CPU image or arbitrary GPU code is executed. */
export const platformInferenceTaskSchema = z.object({ kind: z.literal('near_inference') }).strict();
const platformHostTaskSchema = z.union([cpuTaskSchema, platformExecTaskSchema, paidSessionTaskSchema]);
export const platformTaskSchema = z.union([platformHostTaskSchema, platformInferenceTaskSchema]);
export type PlatformTask = z.infer<typeof platformTaskSchema>;
export const platformNearConfigSchema = z.object({ model: z.string().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/),
  maxTokens: z.number().int().min(1).max(512), policySha256: bytes32Schema,
  inferencePrice: moneySchema.refine(value => BigInt(value) > 0n) }).strict();
export type PlatformNearConfig = z.infer<typeof platformNearConfigSchema>;
export const platformNearRequestSchema = platformNearConfigSchema.omit({ inferencePrice: true }).extend({
  prompt: z.string().min(1).max(8192).refine(value => Buffer.byteLength(value, 'utf8') <= 8192),
}).strict();
const sessionDuration = (value: { task: PlatformTask; maxSeconds: number; near?: z.infer<typeof platformNearRequestSchema> | undefined }, context: z.RefinementCtx) => {
  if (value.task.kind === 'session' && value.maxSeconds < 10) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['maxSeconds'], message: 'Paid CPU sessions require at least ten seconds for authenticated host admission.' });
  if (value.near && ['exec', 'session'].includes(value.task.kind)) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['near'], message: 'Verified NEAR inference is supported only after a bounded CPU task or as a one-shot inference request.' });
  if (value.task.kind === 'near_inference' && !value.near) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['near'], message: 'A one-shot inference request requires a reviewed NEAR model and bounded prompt.' });
};
export const platformRunInputSchema = z.object({ runId: bytes32Schema, task: platformHostTaskSchema,
  maxSeconds: z.number().int().min(1).max(120), cpuScheduling: paidCpuSchedulingSchema.optional() }).strict().superRefine(sessionDuration);
export type PlatformRunInput = z.infer<typeof platformRunInputSchema>;
export const platformQuoteInputSchema = z.object({ leashId: bytes32Schema, task: platformTaskSchema,
  maxSeconds: z.number().int().min(1).max(120), deadline: z.number().int().positive().safe(), maxSpend: moneySchema,
  regions: z.array(capacitySchema.shape.region).max(32).default([]),
  // Optional without a default: persisted pre-feature quote hashes and replay identities stay unchanged.
  excludedHostIds: z.array(bytes32Schema).max(16).refine(ids => new Set(ids).size === ids.length,
    'Excluded host IDs must be unique').optional(), near: platformNearRequestSchema.optional(),
  cpuScheduling: paidCpuSchedulingSchema.optional(), funding: spendPermissionFundingSchema.optional() }).strict();
export const validatedPlatformQuoteInputSchema = platformQuoteInputSchema.superRefine((value, context) => {
  sessionDuration(value, context);
  if (value.funding && (value.near || value.task.kind === 'near_inference')) context.addIssue({
    code: z.ZodIssueCode.custom, path: ['funding'], message: 'Spend permission funding supports bounded CPU work only.' });
  if (value.cpuScheduling && (value.task.kind !== 'session' || value.near
    || value.cpuScheduling.lane === 'interruptible' && value.maxSeconds <= 30)) context.addIssue({
    code: z.ZodIssueCode.custom, path: ['cpuScheduling'],
    message: 'CPU lanes require a paid session; interruptible sessions must leave thirty seconds for notice.' });
});
export type PlatformQuoteInput = z.infer<typeof validatedPlatformQuoteInputSchema>;
/** Existing CPU-only signatures retain their original hash; a paid NEAR request binds every provider policy field. */
export function platformWorkloadHash(input: Pick<PlatformQuoteInput, 'task' | 'near' | 'cpuScheduling'>): Hex {
  if (input.cpuScheduling) return hashJson({ protocol: 'telomere-platform-cpu-scheduling-v1', task: input.task,
    cpuScheduling: input.cpuScheduling });
  return input.near ? hashJson({ protocol: 'telomere-platform-near-v1', task: input.task, near: input.near })
    : hashJson({ task: input.task });
}
export function platformNearRequestUser(runId: string): string {
  return `enclave-platform-${bytes32Schema.parse(runId)}`;
}
/** Exact signed HTTP request body sent by the opt-in verified provider adapter. */
export function platformNearRequestHash(runId: string, raw: z.infer<typeof platformNearRequestSchema>): Hex {
  const near = platformNearRequestSchema.parse(raw);
  const body = JSON.stringify({ model: near.model, user: platformNearRequestUser(runId),
    messages: [{ role: 'user', content: near.prompt }], stream: false, temperature: 0,
    max_tokens: near.maxTokens, chat_template_kwargs: { enable_thinking: false } });
  return `0x${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}
export const platformQuoteSchema = z.object({ runId: bytes32Schema, leashId: bytes32Schema, hostId: bytes32Schema,
  payer: addressSchema, hwClass: z.literal(0), regionHash: bytes32Schema, imageHash: bytes32Schema, workloadHash: bytes32Schema,
  maxSeconds: z.number().int().min(1).max(120), pricePerSecond: moneySchema, inferencePrice: moneySchema,
  quoteExpiry: z.number().int().positive().safe() }).strict();
export type PlatformQuote = z.infer<typeof platformQuoteSchema>;
export const platformSettlementSchema = z.object({ runId: bytes32Schema, billableSeconds: z.number().int().min(0).max(120),
  endedAt: z.number().int().positive().safe(), inferenceCharge: moneySchema, receiptHash: bytes32Schema }).strict();
export type PlatformSettlement = z.infer<typeof platformSettlementSchema>;
export const platformPinsSchema = z.object({ chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]), escrowAddress: addressSchema,
  tokenAddress: addressSchema, quoteSigner: addressSchema, receiptRootAddress: addressSchema, hostRegistryAddress: addressSchema,
  feeRouterAddress: addressSchema, tokenCodeHash: bytes32Schema, reviewedTokenKind: z.enum(['immutable', 'eip1967', 'circle_proxy']),
  assetImplementation: z.object({ address: addressSchema, codeHash: bytes32Schema }).strict().optional(),
  assetFacet: z.object({ address: addressSchema, codeHash: bytes32Schema }).strict().optional(),
  escrowCodeHash: bytes32Schema, receiptRootCodeHash: bytes32Schema,
  hostRegistryCodeHash: bytes32Schema, feeRouterCodeHash: bytes32Schema,
  // Opt-in new deployment. Absent on every original v1 signed quote and journal.
  financialProfile: z.object({ kind: z.literal('tlmr_economics_v2'), stakingAddress: addressSchema,
    stakingCodeHash: bytes32Schema, utilityTokenAddress: addressSchema, utilityTokenCodeHash: bytes32Schema,
    discountVaultRegistry: z.object({ address: addressSchema, codeHash: bytes32Schema,
      implementationAddress: addressSchema, implementationCodeHash: bytes32Schema }).strict().optional(),
  }).strict().optional(),
  spendPermissionProfile: spendPermissionProfileSchema.optional(),
  x402CpuProfile: x402CpuProfileSchema.optional(),
}).strict().superRefine((value, context) => {
    const baseUsdc = baseUsdcForChainId(value.chainId);
    if (value.reviewedTokenKind !== 'immutable' && !value.assetImplementation
      || value.reviewedTokenKind === 'immutable' && (value.assetImplementation || value.assetFacet)
      || value.reviewedTokenKind === 'circle_proxy' && !!value.assetFacet
      || !!baseUsdc && (value.tokenAddress.toLowerCase() !== baseUsdc.toLowerCase()
        || value.reviewedTokenKind !== 'circle_proxy' || !value.assetImplementation || !!value.assetFacet)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Platform payment asset lacks its reviewed deployment pins' });
    }
    if (value.financialProfile && (value.financialProfile.stakingAddress.toLowerCase() === value.financialProfile.utilityTokenAddress.toLowerCase()
      || value.financialProfile.utilityTokenAddress.toLowerCase() === value.tokenAddress.toLowerCase())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Economics requires a separate reviewed utility token and staking contract' });
    }
    if (value.spendPermissionProfile && value.financialProfile) context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Spend permission domain3 cannot be combined with economics-v2 domain2.' });
    if (value.spendPermissionProfile && value.chainId !== 31337
      && value.spendPermissionProfile.managerAddress.toLowerCase() !== SPEND_PERMISSION_MANAGER.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Public Base spend permissions require the canonical Manager address.' });
    }
    if (value.x402CpuProfile && (value.financialProfile || value.spendPermissionProfile)) context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'X402 CPU domain4 cannot be combined with earlier economics or spend permission profiles.' });
    if (value.x402CpuProfile && value.chainId !== 31337 && (value.x402CpuProfile.permit2Address.toLowerCase() !== CPU_PERMIT2.toLowerCase()
      || value.x402CpuProfile.proxyAddress.toLowerCase() !== CPU_UPTO_PROXY.toLowerCase())) context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Public x402 CPU requires canonical Permit2 and x402 Upto Proxy addresses.' });
  });
export type PlatformPins = z.infer<typeof platformPinsSchema>;
export function platformQuoteDomainVersion(pins: PlatformPins): '1' | '2' | '3' | '4' {
  return pins.x402CpuProfile ? '4' : pins.spendPermissionProfile ? '3' : pins.financialProfile ? '2' : '1';
}
export const platformFeeDiscountBpsSchema = z.union([z.literal(0), z.literal(100), z.literal(200), z.literal(300)]);
/** Trusted controller journal observation, not independent execution or TEE proof. */
export const platformNoDispatchSchema = z.object({ state: z.literal('never_dispatched'), confirmed: z.literal(true),
  admissionTx: bytes32Schema }).strict();
export function platformRunFeeBps(pins: PlatformPins, run: { admissionTx: string | null; feeDiscountBps?: number | undefined }): number {
  const discount = platformFeeDiscountBpsSchema.parse(run.feeDiscountBps ?? 0);
  if (!pins.financialProfile && discount !== 0 || pins.financialProfile && run.admissionTx && run.feeDiscountBps === undefined
    || !run.admissionTx && discount !== 0) throw new Error('Run lacks its original reviewed locked discount');
  return 900 - discount;
}
export const platformSessionPricesSchema = cpuSessionPricesSchema;
export const platformHostSchema = capacitySchema.extend({ hardwareClass: z.literal('cpu'), sealed: z.literal(false),
  lane: z.enum(['standard', 'interruptible']), interruptible: paidInterruptibleCapabilitySchema.optional(),
  hostKey: bytes32Schema, image: z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/),
  execEnabled: z.boolean().optional(),
  sessionEnabled: z.boolean().optional(),
  cystInputMaxBytes: cystInputMaxBytesSchema.optional(),
  sessionPrices: platformSessionPricesSchema.optional(),
  laneOffers: cpuLaneOffersSchema.optional(),
  imageProof: z.array(bytes32Schema).max(64).default([]), regionProof: z.array(bytes32Schema).max(64).default([]) }).strict();
export type PlatformHost = z.infer<typeof platformHostSchema>;
export const platformAdmissionSchema = z.object({ runId: bytes32Schema, transactionHash: bytes32Schema }).strict();
export const platformPreparedSchema = z.object({ input: validatedPlatformQuoteInputSchema, quote: platformQuoteSchema,
  receiptVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  fundingReview: z.object({ kind: z.literal('base_spend_permission_v1'), fundingAccount: addressSchema,
    refundBeneficiary: addressSchema, reservationCeiling: moneySchema, permissionHash: bytes32Schema,
    managerAddress: addressSchema }).strict().optional(),
  signature: signatureSchema, ceiling: moneySchema, imageProof: z.array(bytes32Schema).max(64), regionProof: z.array(bytes32Schema).max(64),
  transaction: z.object({ chainId: z.number().int(), to: addressSchema, data: z.string().regex(/^0x[a-f0-9]+$/), value: z.literal('0') }).strict() }).strict();
export type PlatformPrepared = z.infer<typeof platformPreparedSchema>;
export const platformX402RequestSchema = z.object({ input: validatedPlatformQuoteInputSchema, scheme: z.enum(['exact', 'upto']),
  extension: z.literal('telomere-cpu-reservation-v1') }).strict();
export const platformX402ChallengeSchema = z.object({ input: validatedPlatformQuoteInputSchema, quote: platformQuoteSchema,
  signature: signatureSchema, ceiling: moneySchema, imageProof: z.array(bytes32Schema).max(64), regionProof: z.array(bytes32Schema).max(64),
  reservation: x402ReservationSchema,
  disclosure: z.object({ extension: z.literal('telomere-cpu-reservation-v1'), immediateDebit: moneySchema,
    refundBeneficiary: addressSchema, unusedFunds: z.literal('escrow_balance_withdrawable_by_original_eoa'),
    externalWalletGas: z.literal(true), receiptVersion: z.literal(1) }).strict(),
  paymentRequired: z.unknown() }).strict();
export type PlatformX402Challenge = z.infer<typeof platformX402ChallengeSchema>;
export const platformX402IntentSchema = z.object({ challenge: platformX402ChallengeSchema, paymentHash: bytes32Schema,
  state: z.enum(['external_wallet_required', 'retained_external_wallet_intent']), transaction: platformPreparedSchema.shape.transaction }).strict();
export type PlatformX402Intent = z.infer<typeof platformX402IntentSchema>;
export function typedPlatformQuote(value: PlatformQuote) {
  return { ...value, maxSeconds: BigInt(value.maxSeconds), pricePerSecond: BigInt(value.pricePerSecond),
    inferencePrice: BigInt(value.inferencePrice), quoteExpiry: BigInt(value.quoteExpiry) };
}
export function typedPlatformSettlement(value: PlatformSettlement) {
  return { ...value, billableSeconds: BigInt(value.billableSeconds), endedAt: BigInt(value.endedAt),
    inferenceCharge: BigInt(value.inferenceCharge) };
}
export const platformQuoteTypes = { PlatformQuote: [
  { name: 'runId', type: 'bytes32' }, { name: 'leashId', type: 'bytes32' }, { name: 'hostId', type: 'bytes32' },
  { name: 'payer', type: 'address' }, { name: 'hwClass', type: 'uint16' }, { name: 'regionHash', type: 'bytes32' },
  { name: 'imageHash', type: 'bytes32' }, { name: 'workloadHash', type: 'bytes32' }, { name: 'maxSeconds', type: 'uint64' },
  { name: 'pricePerSecond', type: 'uint96' }, { name: 'inferencePrice', type: 'uint96' }, { name: 'quoteExpiry', type: 'uint64' },
] } as const;
export const platformEscrowAbi = parseAbi([
  'function MAX_RUN_CEILING() view returns (uint96)',
  'function MAX_LEASH_DAY() view returns (uint96)',
  'function MAX_TOTAL_ESCROW() view returns (uint256)',
  'struct PlatformQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'struct PlatformSettlement { bytes32 runId; uint64 billableSeconds; uint64 endedAt; uint96 inferenceCharge; bytes32 receiptHash; }',
  'struct PlatformRun { address payer; address hostOperator; bytes32 leashId; bytes32 hostId; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; bool sealedHost; uint64 openedAt; uint64 acceptedExpiry; uint64 maxSeconds; uint64 stopAt; uint96 pricePerSecond; uint96 inferencePrice; uint96 ceiling; uint8 status; uint64 billableSeconds; uint96 inferenceCharge; bytes32 receiptHash; bool hostReleased; }',
  'struct PlatformLeash { address owner; address agent; uint96 maxPerHour; uint96 maxPerDay; uint64 classMask; bool sealedOnly; bytes32 imageAllowRoot; bytes32 regionAllowRoot; uint64 expiry; bool killed; uint64 killedAt; uint64 hourKey; uint64 dayKey; uint96 spentHour; uint96 spentDay; uint96 pending; }',
  'function token() view returns (address)', 'function quoteSigner() view returns (address)',
  'function receiptRoot() view returns (address)', 'function hostRegistry() view returns (address)', 'function feeRouter() view returns (address)',
  'function availableBalance(address payer) view returns (uint256)', 'function opensPaused() view returns (bool)',
  'function getRun(bytes32 runId) view returns (PlatformRun)', 'function getLeash(bytes32 leashId) view returns (PlatformLeash)',
  'function quoteCeiling(PlatformQuote quote,bool sealedHost) view returns (uint96)',
  'function openRun(PlatformQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof)',
  'function settleRun(PlatformSettlement settlement,uint64 hour,bytes32[] proof)',
  'function receiptLeaf(PlatformSettlement settlement) view returns (bytes32)',
  'function requestStop(bytes32 runId)', 'function refundRun(bytes32 runId)', 'function refundAt(bytes32 runId) view returns (uint256)',
  'event LeashCreated(bytes32 indexed leashId,address indexed owner,address indexed agent)',
  'event LeashUpdated(bytes32 indexed leashId,address indexed agent)',
  'event RunOpened(bytes32 indexed runId,bytes32 indexed leashId,bytes32 indexed hostId,address payer,uint96 ceiling,uint64 openedAt,uint64 maxSeconds)',
  'event RunSettled(bytes32 indexed runId,bytes32 indexed receiptHash,bytes32 receiptLeaf,uint96 hostAmount,uint96 platformFee,uint96 returnedAmount)',
  'event RunRefunded(bytes32 indexed runId,address indexed payer,uint96 amount)',
]);
export const platformHostRegistryAbi = parseAbi([
  'struct Host { address operator; bytes32 hostKey; uint8 kind; bytes32 teeMeasurement; uint96 collateral; uint32 strikes; uint64 unbondAt; bool active; bool gpu; uint64 openRuns; }',
  'function getHost(bytes32 hostId) view returns (Host)', 'function token() view returns (address)',
  'function controller() view returns (address)', 'function evidenceRoot() view returns (address)',
]);
export const PLATFORM_ZERO = `0x${'0'.repeat(64)}` as Hex;
