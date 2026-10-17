import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { exactAuthorizationSchema, requirementsSchema, resourceSchema, type PaymentPayload } from '../../payments/protocol.js';
import type { VaultIncomePins } from '../../payments/vault-income-chain.js';
import { incomeAddressSchema, incomeBlockSchema, incomeEndpointPinsSchema, incomeHashSchema, incomeUrlSchema,
  type IncomeSnapshot } from '../../selection/income-endpoints/types.js';
import { assetFacetPinsSchema } from '../../payments/asset-facets.js';
import { isNativeBaseUsdc, nativeBaseUsdcName } from '../../payments/circle-usdc.js';

export const vaultIncomeClientPinsSchema = z.object({ chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]), asset: incomeAddressSchema,
  tokenCodeHash: incomeHashSchema, payTo: incomeAddressSchema, facilitator: incomeAddressSchema,
  reviewedTokenKind: z.enum(['immutable', 'eip1967', 'circle_proxy']),
  assetImplementation: z.object({ address: incomeAddressSchema, codeHash: incomeHashSchema }).strict().optional(),
  assetFacet: assetFacetPinsSchema.optional(),
  archiveAnchor: z.object({ number: z.string().regex(/^[1-9][0-9]{0,19}$/), hash: incomeHashSchema,
    timestamp: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().optional(),
  confirmations: z.number().int().min(1).max(64),
  exact: z.object({ reviewedEip3009: z.literal(true), name: z.string().min(1).max(100), version: z.string().min(1).max(30) }).strict(),
  selection: incomeEndpointPinsSchema, agentId: incomeHashSchema, treasury: incomeAddressSchema,
}).strict().superRefine((value, context) => {
  if (value.chainId !== value.selection.chainId || value.confirmations !== value.selection.confirmations
    || value.reviewedTokenKind !== 'immutable' && !value.assetImplementation
    || value.reviewedTokenKind === 'immutable' && (!!value.assetImplementation || !!value.assetFacet)
    || value.reviewedTokenKind === 'circle_proxy' && !!value.assetFacet
    || value.chainId === 31337 && !!value.archiveAnchor
    || value.chainId !== 31337 && (!isNativeBaseUsdc(value.chainId, value.asset)
      || value.reviewedTokenKind !== 'circle_proxy' || !value.assetImplementation || !!value.assetFacet
      || !value.archiveAnchor || value.exact.name !== nativeBaseUsdcName(value.chainId)
      || value.exact.version !== '2')) context.addIssue({ code: 'custom', message: 'Reviewed pins differ.' });
});
export const vaultIncomePublicProfileSchema = z.object({ resourceUrl: incomeUrlSchema,
  grossAmount: z.string().regex(/^[1-9][0-9]{0,28}$/).refine(value => BigInt(value) < 2n ** 96n),
  pins: vaultIncomeClientPinsSchema }).strict().superRefine((value, context) => {
    const url = new URL(value.resourceUrl);
    if (url.pathname !== '/x402/vault-income' || url.protocol !== 'https:'
      && !(value.pins.chainId === 31337 && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) {
      context.addIssue({ code: 'custom', message: 'Use reviewed HTTPS intake or a local Anvil fixture.' });
    }
  });
export type VaultIncomePublicProfile = { resourceUrl: string; grossAmount: string; pins: VaultIncomePins };
export const vaultIncomeInspectionSchema = z.object({ status: z.enum(['pending', 'settled', 'reverted']), transactionHash: incomeHashSchema,
  block: incomeBlockSchema.optional(), classification: z.enum(['income', 'subsidy']).optional(), grossAmount: z.string().optional(),
  incomeFee: z.string().optional(), netAmount: z.string().optional(), paymentRef: incomeHashSchema.optional(), payer: incomeAddressSchema.optional() }).strict();
export type VaultIncomeInspection = z.infer<typeof vaultIncomeInspectionSchema>;
export interface VaultIncomeReader {
  readonly profile: Readonly<VaultIncomePublicProfile>;
  check(): Promise<IncomeSnapshot>;
  inspect(input: { transactionHash: Hex; payment: PaymentPayload }): Promise<VaultIncomeInspection>;
}
export const vaultIncomePlanSchema = z.object({ operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  profileHash: incomeHashSchema, resource: resourceSchema, accepted: requirementsSchema,
  authorization: exactAuthorizationSchema }).strict();
export type VaultIncomePlan = z.infer<typeof vaultIncomePlanSchema>;
export type VaultIncomeTypedData = { domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { readonly TransferWithAuthorization: readonly [{ readonly name: 'from'; readonly type: 'address' },
    { readonly name: 'to'; readonly type: 'address' }, { readonly name: 'value'; readonly type: 'uint256' },
    { readonly name: 'validAfter'; readonly type: 'uint256' }, { readonly name: 'validBefore'; readonly type: 'uint256' },
    { readonly name: 'nonce'; readonly type: 'bytes32' }] };
  primaryType: 'TransferWithAuthorization'; message: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex } };
export const vaultIncomeAttemptSchema = z.object({ plan: vaultIncomePlanSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(), signedHeader: z.string().max(8192).optional(),
  submitted: z.boolean(), candidateHash: incomeHashSchema.optional(), observation: vaultIncomeInspectionSchema.optional() }).strict();
export type VaultIncomeAttempt = z.infer<typeof vaultIncomeAttemptSchema>;
export const vaultIncomeJournalStateSchema = z.object({ version: z.literal(1), profileHash: incomeHashSchema,
  attempts: z.array(vaultIncomeAttemptSchema).max(128) }).strict();
export type VaultIncomeJournalState = z.infer<typeof vaultIncomeJournalStateSchema>;
/** A save is atomic and durable BEFORE resolving, including when its surrounding callback later throws.
 * One process owns the journal. exclusive serializes all instances for a scope; no in-memory default is provided.
 * Storage must be private: signed authorizations are bearer payment instructions. Retain all attempts, including expired ones. */
export interface VaultIncomeJournal {
  exclusive<T>(scope: Hex, callback: (transaction: { load(): Promise<unknown>; save(state: VaultIncomeJournalState): Promise<void> }) => Promise<T>): Promise<T>;
}
export class VaultIncomeClientError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VaultIncomeClientError'; }
}
