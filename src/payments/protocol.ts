import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAddress, type Address, type Hex } from 'viem';

const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 2n ** 256n, 'uint256 overflow');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex);
export const resourceSchema = z.object({ url: z.string().url().max(2048), description: z.string().max(512).optional(),
  mimeType: z.string().max(128).optional() }).strict();
export const requirementsSchema = z.object({ scheme: z.enum(['exact', 'upto']), network: z.string().regex(/^eip155:[1-9][0-9]{0,15}$/),
  asset: address, amount: uint, payTo: address,
  maxTimeoutSeconds: z.number().int().min(1).max(3600), extra: z.object({ name: z.string().min(1).max(100).optional(),
    version: z.string().min(1).max(30).optional(), assetTransferMethod: z.enum(['eip3009', 'permit2']),
    facilitatorAddress: address, telomere: z.object({ challengeId: z.string().uuid(), nonce: bytes32, requestHash: bytes32 }).strict(),
  }).strict() }).strict();
export const exactAuthorizationSchema = z.object({ from: address, to: address, value: uint,
  validAfter: uint, validBefore: uint, nonce: bytes32 }).strict();
export const permit2AuthorizationSchema = z.object({ permitted: z.object({ token: address, amount: uint }).strict(),
  from: address, spender: address, nonce: z.union([uint, z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)])
    .transform(value => BigInt(value).toString()), deadline: uint,
  witness: z.object({ to: address, facilitator: address, validAfter: uint }).strict() }).strict();
export const paymentPayloadSchema = z.object({ x402Version: z.literal(2), resource: resourceSchema, accepted: requirementsSchema,
  payload: z.union([z.object({ signature, authorization: exactAuthorizationSchema }).strict(),
    z.object({ signature, permit2Authorization: permit2AuthorizationSchema }).strict()]),
  extensions: z.object({ 'telomere-request-binding': z.object({ version: z.literal(1), requestHash: bytes32 }).strict() }).strict().optional() }).strict();
export type PaymentRequirements = z.infer<typeof requirementsSchema>;
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;
export type PaymentResource = z.infer<typeof resourceSchema>;
export type ExactAuthorization = z.infer<typeof exactAuthorizationSchema>;
export type Permit2Authorization = z.infer<typeof permit2AuthorizationSchema>;
export type Scheme = PaymentRequirements['scheme'];
export type VerifyResponse = { isValid: boolean; payer?: Address; invalidReason?: string; invalidMessage?: string };
export type SettleResponse = { success: boolean; transaction: Hex | ''; network: string; payer: Address;
  amount: string; errorReason?: string };
export class PaymentError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): Hex { return `0x${createHash('sha256').update(canonical(value)).digest('hex')}`; }
/** Local extension: a standard authorization nonce is bound to one exact HTTP request. */
export function requestBinding(method: string, url: string, body: Uint8Array = new Uint8Array()): Hex {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new PaymentError(400, 'invalid_resource');
  if (!/^[A-Z]{3,12}$/.test(method)) throw new PaymentError(400, 'invalid_method');
  return digest({ method, url: parsed.href, body: createHash('sha256').update(body).digest('hex') });
}
export function challengeIdentity(): { id: string; nonce: Hex } {
  return { id: randomUUID(), nonce: `0x${randomBytes(32).toString('hex')}` };
}
export function encodePaymentHeader(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64'); }
export function decodePaymentHeader(value: string | undefined): PaymentPayload {
  if (!value || value.length > 32_768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new PaymentError(400, 'invalid_payment_header');
  }
  try { return paymentPayloadSchema.parse(JSON.parse(Buffer.from(value, 'base64').toString('utf8'))); }
  catch { throw new PaymentError(400, 'invalid_payment_payload'); }
}
export function paymentPayer(payment: PaymentPayload): Address {
  return 'authorization' in payment.payload ? payment.payload.authorization.from : payment.payload.permit2Authorization.from;
}
export function authorizationKey(payment: PaymentPayload): Hex {
  const nonce = 'authorization' in payment.payload ? payment.payload.authorization.nonce : BigInt(payment.payload.permit2Authorization.nonce).toString();
  return digest({ network: payment.accepted.network, scheme: payment.accepted.scheme,
    asset: payment.accepted.asset.toLowerCase(), payer: paymentPayer(payment).toLowerCase(), nonce });
}
