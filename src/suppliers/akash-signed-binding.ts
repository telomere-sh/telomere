import { hashTypedData, verifyTypedData, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, moneySchema, sameAddress, signatureSchema } from '../common.js';
import { platformQuoteSchema, platformQuoteTypes, typedPlatformQuote } from '../platform-runtime/types.js';
import { akashAddressSchema, akashDseqSchema } from './akash-console.js';
import { akashCanonicalPriceSchema } from './akash-price.js';

/** This owner authorization is separate from, and never modifies, PlatformRunEscrow. */
export const akashBindingPinsSchema = z.object({
  chainId: z.number().int().positive().safe(), escrowAddress: addressSchema, quoteSigner: addressSchema,
}).strict();
export type AkashBindingPins = z.infer<typeof akashBindingPinsSchema>;

export const akashSupplierQuoteSchema = platformQuoteSchema.extend({
  maxSeconds: z.number().int().min(3_600).max(86_400),
});
export const akashSupplierIntentSchema = z.object({
  owner: addressSchema, runId: bytes32Schema, quoteDigest: bytes32Schema,
  akashOwner: akashAddressSchema, dseq: akashDseqSchema,
  gseq: z.number().int().positive().safe(), oseq: z.number().int().positive().safe(),
  provider: akashAddressSchema, deploymentHash: z.string().min(1).max(256),
  pricePerBlockUact: akashCanonicalPriceSchema,
  runtimeHours: z.number().int().min(1).max(24), maxBlocksPerHour: z.number().int().min(3_600).max(100_000),
  maxSpendUsdcMicros: moneySchema.refine(value => BigInt(value) > 0n && BigInt(value) <= 250_000_000n),
  expiresAt: z.number().int().positive().safe(),
}).strict();
export type AkashSupplierIntent = z.infer<typeof akashSupplierIntentSchema>;
export const akashSignedBindingSchema = z.object({
  quote: akashSupplierQuoteSchema, quoteSignature: signatureSchema,
  intent: akashSupplierIntentSchema, ownerSignature: signatureSchema,
}).strict();
export type AkashSignedBinding = z.infer<typeof akashSignedBindingSchema>;

export const akashSupplierIntentTypes = { AkashSupplierIntent: [
  { name: 'owner', type: 'address' }, { name: 'runId', type: 'bytes32' }, { name: 'quoteDigest', type: 'bytes32' },
  { name: 'akashOwner', type: 'string' }, { name: 'dseq', type: 'string' },
  { name: 'gseq', type: 'uint64' }, { name: 'oseq', type: 'uint64' },
  { name: 'provider', type: 'string' }, { name: 'deploymentHash', type: 'string' },
  { name: 'pricePerBlockUact', type: 'string' }, { name: 'runtimeHours', type: 'uint64' },
  { name: 'maxBlocksPerHour', type: 'uint64' }, { name: 'maxSpendUsdcMicros', type: 'uint96' },
  { name: 'expiresAt', type: 'uint64' },
] } as const;

export function typedAkashSupplierIntent(value: AkashSupplierIntent) {
  return { ...value, gseq: BigInt(value.gseq), oseq: BigInt(value.oseq), runtimeHours: BigInt(value.runtimeHours),
    maxBlocksPerHour: BigInt(value.maxBlocksPerHour), maxSpendUsdcMicros: BigInt(value.maxSpendUsdcMicros),
    expiresAt: BigInt(value.expiresAt) };
}

export interface ExpectedAkashBinding {
  owner: string; runId: string; approvedQuoteDigest: string | undefined;
  approvedMaxSeconds: number; approvedMaxSpendUsdcMicros: string;
  akashOwner: string; dseq: string; gseq: number; oseq: number; provider: string;
  deploymentHash: string; pricePerBlockUact: string; runtimeHours: number;
  maxBlocksPerHour: number; maxSpendUsdcMicros: string; nowMs: number;
}

/** Fail-closed local proof; the trusted approvedRun source must also verify this digest against the admitted run. */
export async function verifyAkashSignedBinding(raw: unknown, rawPins: unknown, expected: ExpectedAkashBinding): Promise<Hex> {
  const binding = akashSignedBindingSchema.parse(raw), pins = akashBindingPinsSchema.parse(rawPins);
  const { quote, intent } = binding;
  const quoteDigest = hashTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
  primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
  if (!expected.approvedQuoteDigest || quoteDigest !== expected.approvedQuoteDigest
    || quoteDigest !== intent.quoteDigest || !sameAddress(quote.payer, intent.owner)
    || !sameAddress(intent.owner, addressSchema.parse(expected.owner))
    || quote.runId !== expected.runId || intent.runId !== expected.runId
    || quote.maxSeconds !== expected.approvedMaxSeconds || quote.inferencePrice !== '0'
    || BigInt(quote.maxSeconds) * BigInt(quote.pricePerSecond) < BigInt(intent.maxSpendUsdcMicros)
    || BigInt(intent.maxSpendUsdcMicros) > BigInt(expected.approvedMaxSpendUsdcMicros)
    || intent.akashOwner !== expected.akashOwner || intent.dseq !== expected.dseq
    || intent.gseq !== expected.gseq || intent.oseq !== expected.oseq
    || intent.provider !== expected.provider || intent.deploymentHash !== expected.deploymentHash
    || intent.pricePerBlockUact !== expected.pricePerBlockUact
    || intent.runtimeHours !== expected.runtimeHours || intent.maxBlocksPerHour !== expected.maxBlocksPerHour
    || intent.maxSpendUsdcMicros !== expected.maxSpendUsdcMicros
    || quote.maxSeconds < intent.runtimeHours * 3_600
    || !Number.isSafeInteger(expected.nowMs) || intent.expiresAt <= Math.floor(expected.nowMs / 1000) + 120
    || intent.expiresAt > Math.floor(expected.nowMs / 1000) + 86_400) {
    throw new Error('Akash signed supplier binding differs from the admitted run or exact reservation');
  }
  if (!await verifyTypedData({ address: pins.quoteSigner, domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote), signature: binding.quoteSignature })) {
    throw new Error('Akash supplier quote signature is invalid');
  }
  if (!await verifyTypedData({ address: intent.owner, domain: { name: 'TelomereAkashSupplierIntent', version: '1',
    chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: akashSupplierIntentTypes,
    primaryType: 'AkashSupplierIntent', message: typedAkashSupplierIntent(intent), signature: binding.ownerSignature })) {
    throw new Error('Akash owner supplier-intent signature is invalid');
  }
  return hashTypedData({ domain: { name: 'TelomereAkashSupplierIntent', version: '1',
    chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: akashSupplierIntentTypes,
  primaryType: 'AkashSupplierIntent', message: typedAkashSupplierIntent(intent) });
}
