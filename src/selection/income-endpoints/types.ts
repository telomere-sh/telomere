import { getAddress, type Hex } from 'viem';
import { z } from 'zod';
import { canonical } from '../../payments/protocol.js';

export const incomeHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
export const incomeAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
export const incomeRevisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) < 2n ** 64n);
export const incomeIdempotencySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const incomeUrlSchema = z.string().min(1).max(2048).refine(value => Buffer.from(value).toString('utf8') === value && !/[\u0000-\u0020\u007f]/.test(value)).refine(value => {
  try { const url = new URL(value); return url.href === value && ['https:', 'http:'].includes(url.protocol)
    && !url.username && !url.password && !value.includes('?') && !value.includes('#'); } catch { return false; }
}, 'Use an exact canonical HTTP(S) URL without credentials, query or fragment.');
export const incomeEndpointPinsSchema = z.object({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  selectionRegistryAddress: incomeAddressSchema, selectionRegistryCodeHash: incomeHashSchema,
  vaultImplementationAddress: incomeAddressSchema, vaultImplementationCodeHash: incomeHashSchema,
  confirmations: z.number().int().min(0).max(64) }).strict();
export const incomeEndpointProfileSchema = z.object({ pins: incomeEndpointPinsSchema,
  network: z.string().regex(/^eip155:[1-9][0-9]{0,15}$/), asset: incomeAddressSchema,
  allowedOrigins: z.array(z.string().min(1).max(2048)).min(1).max(32), localFixture: z.boolean().default(false),
  verificationTtlSeconds: z.number().int().min(60).max(3600).default(900),
  challengeTtlSeconds: z.number().int().min(30).max(300).default(300) }).strict().superRefine((value, context) => {
    if (value.network !== `eip155:${value.pins.chainId}` || value.localFixture && value.pins.chainId !== 31337
      || !value.localFixture && value.pins.confirmations < 1) context.addIssue({ code: 'custom', message: 'Reviewed chain/network/confirmation policy differs.' });
    const origins = new Set<string>();
    for (const raw of value.allowedOrigins) {
      try {
        const origin = new URL(raw), loopback = ['127.0.0.1', '[::1]'].includes(origin.hostname);
        if (raw !== origin.origin || origin.hostname.includes('*') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
          || origin.protocol !== 'https:' && !(value.localFixture && loopback && origin.protocol === 'http:')
          || origins.has(raw)) throw new Error('origin');
        origins.add(raw);
      } catch { context.addIssue({ code: 'custom', message: 'Use distinct exact HTTPS origins, or explicit local-fixture loopback origins.' }); }
    }
  });
export type IncomeEndpointPins = z.infer<typeof incomeEndpointPinsSchema>;
export type IncomeEndpointProfile = z.infer<typeof incomeEndpointProfileSchema>;
export const incomeBindingSchema = z.object({ agentId: incomeHashSchema, owner: incomeAddressSchema,
  agentWallet: incomeAddressSchema, vault: incomeAddressSchema, status: z.number().int().min(1).max(3), frozen: z.boolean() }).strict();
export const incomeBlockSchema = z.object({ number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), hash: incomeHashSchema,
  timestamp: z.string().regex(/^(0|[1-9][0-9]{0,19})$/) }).strict();
export type IncomeBinding = z.infer<typeof incomeBindingSchema>;
export type IncomeBlock = z.infer<typeof incomeBlockSchema>;
export type IncomeSnapshot = { binding: IncomeBinding; block: IncomeBlock };
export interface IncomeEndpointReader {
  readonly pins: IncomeEndpointPins; readonly asset: string;
  check(): Promise<void>; snapshot(agentId: string): Promise<IncomeSnapshot>; canonical(block: IncomeBlock): Promise<void>;
}
export const incomeChallengeSchema = z.object({ protocol: z.literal('telomere-income-endpoint-v1'),
  chainId: z.number().int().positive(), selectionRegistryAddress: incomeAddressSchema, agentId: incomeHashSchema,
  owner: incomeAddressSchema, agentWallet: incomeAddressSchema, vault: incomeAddressSchema, url: incomeUrlSchema,
  revision: incomeRevisionSchema, nonce: incomeHashSchema, expiresAt: z.string().regex(/^[1-9][0-9]{0,12}$/) }).strict();
export type IncomeChallenge = z.infer<typeof incomeChallengeSchema>;
export function incomeEndpointProofMessage(input: IncomeChallenge): string {
  return 'Telomere income endpoint control v1\n' + canonical(incomeChallengeSchema.parse(input));
}
export const incomeProofSchema = z.object({ challenge: incomeChallengeSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex) }).strict();
export type IncomeProof = z.infer<typeof incomeProofSchema>;
export type IncomeVerification = { proof: IncomeProof; block: IncomeBlock; profileHash: string; termsDigest: string;
  verifiedAt: string; expiresAt: string; termsMatchReviewedProfile: boolean };
export type IncomeEndpointView = { id: string; agentId: string; url: string; revision: string; declared: boolean;
  declaredAt: string; binding: IncomeBinding; controlVerified: boolean; termsMatchReviewedProfile: boolean;
  verification: { verifiedAt: string; expiresAt: string; block: IncomeBlock; termsDigest: string } | null;
  incomeCredit: 'none'; paymentCapabilityVerified: false };

const paymentAmount = z.string().regex(/^[1-9][0-9]{0,77}$/).refine(value => BigInt(value) < 2n ** 256n);
/** Observed v2 offer terms only. No authorization, token capability or payment execution is inferred. */
export const incomePaymentRequiredSchema = z.object({ x402Version: z.literal(2),
  resource: z.object({ url: incomeUrlSchema }).passthrough(), accepts: z.array(z.object({ scheme: z.enum(['exact', 'upto']),
    network: z.string().regex(/^eip155:[1-9][0-9]{0,15}$/), asset: incomeAddressSchema,
    payTo: incomeAddressSchema, amount: paymentAmount, maxTimeoutSeconds: z.number().int().min(1).max(3600) }).passthrough()).min(1).max(8) }).passthrough();
