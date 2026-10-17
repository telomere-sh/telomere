import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema, signatureSchema } from '../common.js';
import { vaultIncomeProfileSchema } from '../payments/vault-income-configured.js';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const solanaKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const solanaSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
export const amountSchema = moneySchema.refine(value => BigInt(value) > 0n && BigInt(value) <= 250_000_000n);
const path = z.string().min(1).max(4096);
export const topUpProfileSchema = z.object({ version: z.literal(1), kind: z.literal('telomere-solana-usdc-topups-v1'),
  localFixture: z.boolean().default(false), journalPath: path,
  solana: z.object({ rpcUrl: z.string().url().max(2048), genesisHash: solanaKey,
    mint: z.literal(SOLANA_USDC_MINT), tokenProgram: z.literal(SOLANA_TOKEN_PROGRAM),
    recipient: solanaKey, recipientAta: solanaKey }).strict(),
  base: vaultIncomeProfileSchema.innerType().shape.pins,
  notBefore: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(),
  maxInvoiceMicros: amountSchema, maxTotalCreditMicros: moneySchema.refine(value => BigInt(value) > 0n && BigInt(value) <= 2_500_000_000n),
  maxInvoices: z.number().int().min(1).max(128), maxWaitingInvoices: z.number().int().min(1).max(128),
  invoiceSeconds: z.number().int().min(60).max(3600), authorizationSeconds: z.number().int().min(60).max(900),
  feeBps: z.literal(0), maxRelayerGas: z.number().int().min(21_000).max(1_000_000),
  maxRelayerFeePerGas: z.string().regex(/^[1-9][0-9]{0,14}$/), broadcastEnabled: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.notBefore || value.expiresAt - value.notBefore > 86_400
    || BigInt(value.maxInvoiceMicros) > BigInt(value.maxTotalCreditMicros) || value.maxWaitingInvoices > value.maxInvoices
    || value.base.chainId !== value.base.selection.chainId
    || !value.localFixture && (value.solana.genesisHash !== SOLANA_MAINNET_GENESIS || value.base.chainId !== 8453)) {
    context.addIssue({ code: 'custom', message: 'Top-up policy exceeds the finite reviewed scope' });
  }
  const checked = vaultIncomeProfileSchema.safeParse({ pins: value.base, facilitatorKeyFile: 'external-only',
    resourceUrl: 'https://topup.invalid/', grossAmount: '1', localFixture: value.localFixture });
  if (!checked.success || value.localFixture !== (value.base.chainId === 31337)) {
    context.addIssue({ code: 'custom', message: 'Top-up Base/native USDC pins differ' });
  }
});
export type TopUpProfile = z.infer<typeof topUpProfileSchema>;
export const sourceProofSchema = z.object({ genesisHash: solanaKey, signature: solanaSignature,
  slot: z.number().int().nonnegative().safe(), blockHash: solanaKey, instructionIndex: z.number().int().min(0).max(63),
  mint: z.literal(SOLANA_USDC_MINT), recipient: solanaKey, recipientAta: solanaKey,
  reference: solanaKey, amountMicros: amountSchema, proofHash: bytes32Schema }).strict();
export type SolanaTopUpProof = z.infer<typeof sourceProofSchema>;
export const topUpAuthorizationSchema = z.object({ from: addressSchema, to: addressSchema, value: amountSchema,
  validAfter: z.number().int().nonnegative().safe(), validBefore: z.number().int().positive().safe(), nonce: bytes32Schema }).strict();
export type TopUpAuthorization = z.infer<typeof topUpAuthorizationSchema>;
export const topUpRecordSchema = z.object({ id: bytes32Schema, clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/),
  owner: addressSchema, agentId: bytes32Schema, vault: addressSchema, reference: solanaKey, amountMicros: amountSchema,
  createdAt: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(),
  source: sourceProofSchema.nullable(), authorization: topUpAuthorizationSchema.nullable(), signature: signatureSchema.nullable(),
  rawTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4096).nullable(), transactionHash: bytes32Schema.nullable(),
  relayerNonce: z.number().int().nonnegative().safe().nullable(),
  state: z.enum(['waiting_source', 'source_finalized', 'authorization_recorded', 'base_pending', 'credited', 'base_reverted']),
  creditedBlockHash: bytes32Schema.nullable(), creditedBlockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).nullable(),
}).strict();
export type TopUpRecord = z.infer<typeof topUpRecordSchema>;
/** Independent of invoice, reference and target Vault: one source transfer has
 * one USDC authorization nonce for the fixed treasury payer. */
export function sourceCreditNonce(proof: SolanaTopUpProof) {
  return hashJson({ domain: 'TelomereSolanaSourceCreditV1', genesisHash: proof.genesisHash,
    signature: proof.signature, instructionIndex: proof.instructionIndex });
}
