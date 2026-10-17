import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

// REASON: validated hex strings are branded only after their exact runtime checks.
// Preserve original letter case: the frozen review digest covers exact JSON values.
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value))
  .refine(value => { try { getAddress(value); return true; } catch { return false; } }).transform(value => value as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const positiveUnits = units.refine(value => BigInt(value) > 0n);
export const ownerWalletPlanSchema = z.object({
  schemaVersion: z.literal(2), mode: z.literal('unsigned-base-usdc-legacy-escrow'), chainId: z.literal(8453),
  referenceBlock: units, referenceHash: hash,
  reviewedAsset: z.object({ kind: z.literal('circle_proxy'), address,
    proxyCodeHash: hash, implementation: z.object({ address, codeHash: hash }).strict(),
    name: z.literal('USD Coin'), symbol: z.literal('USDC'), decimals: z.literal(6), version: z.literal('2') }).strict(),
  quoteSigner: address, receiptSigner: address, treasury: address, predictedEscrowAddress: address,
  compiler: z.string().min(1).max(128), creationCodeHash: hash, artifactBytecodeHash: hash,
  transaction: z.object({ from: address, to: z.null(), data: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/)
    .max(100_000).transform(value => value as `0x${string}`), value: z.literal('0'), nonce: z.number().int().min(0).max(2 ** 32 - 1),
    gas: positiveUnits.nullable(), gasPrice: positiveUnits }).strict(),
  estimate: z.object({ gas: positiveUnits.nullable(), mode: z.string().min(1).max(128), gasLimitBufferPercent: z.literal(20) }).strict(),
  funding: z.object({ nativeBalance: units, bufferedCost: units.nullable(), sufficientForEstimate: z.boolean(), relayNativeBalance: units }).strict(),
  status: z.literal('prepared; no transaction submitted'), reviewDigest: hash,
}).strict();
export type OwnerWalletPlan = z.infer<typeof ownerWalletPlanSchema>;
export const ownerWalletTrustSchema = z.object({ owner: address, signer: address, treasury: address,
  planSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewDigest: hash,
  maxGas: positiveUnits.refine(value => BigInt(value) <= 10_000_000n),
  maxFeePerGasWei: positiveUnits.refine(value => BigInt(value) <= 1_000_000_000_000n),
  maxTotalGasBudgetWei: positiveUnits.refine(value => BigInt(value) <= 10n ** 18n) }).strict();
export type OwnerWalletTrust = z.infer<typeof ownerWalletTrustSchema>;
export const ownerWalletReviewSchema = z.object({ schemaVersion: z.literal(1),
  status: z.enum(['ready_for_owner_wallet', 'awaiting_base_eth']), reviewedAtMs: z.number().int().safe().positive(),
  expiresAtMs: z.number().int().safe().positive(), referenceBlock: units, referenceHash: hash,
  plan: ownerWalletPlanSchema, trust: ownerWalletTrustSchema,
  gas: z.object({ estimated: positiveUnits, limit: positiveUnits, maxFeePerGasWei: positiveUnits,
    maxPriorityFeePerGasWei: units, l2GasBudgetWei: positiveUnits,
    unsignedTransactionBytes: z.number().int().positive().max(50_000),
    l1DataFeeUpperBoundWei: units, operatorFeeWei: units, totalGasBudgetWei: positiveUnits,
    includesL1DataFee: z.literal(true), futureL1FeeHardCap: z.literal(false),
    nativeBalanceWei: units, balanceOverrideUsed: z.boolean() }).strict(),
  transactionsSent: z.literal(0), ownerKeysLoaded: z.literal(false),
}).strict();
export type OwnerWalletReview = z.infer<typeof ownerWalletReviewSchema>;
