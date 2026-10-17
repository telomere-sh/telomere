import { z } from 'zod';
import { keccak256 } from 'viem';
import { addressSchema, bytes32Schema } from '../common.js';
import { paymentPayloadSchema, requirementsSchema, resourceSchema } from './protocol.js';

// No runtime, escrow ABI or RPC-proof dependencies belong in this schema leaf.
export const CPU_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const CPU_UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
export const X402_RESERVATION_DOMAIN = keccak256(new TextEncoder().encode('TelomereX402CpuReservationV1'));
export const x402CpuProfileSchema = z.object({ kind: z.literal('x402_cpu_v1'), permit2Address: addressSchema,
  permit2CodeHash: bytes32Schema, proxyAddress: addressSchema, proxyCodeHash: bytes32Schema,
  tokenName: z.string().min(1).max(100), tokenVersion: z.string().min(1).max(30) }).strict();
export const x402CpuRequestSchema = z.object({ scheme: z.enum(['exact', 'upto']) }).strict();
export const x402ReservationSchema = z.object({ challengeId: z.string().uuid(), scheme: z.enum(['exact', 'upto']),
  resourceUrl: z.string().url().max(2048), requestHash: bytes32Schema, salt: bytes32Schema, leashTermsHash: bytes32Schema,
  maximum: z.string().regex(/^[1-9][0-9]{0,8}$/).refine(value => BigInt(value) <= 250_000_000n),
  validAfter: z.number().int().nonnegative().safe(), validBefore: z.number().int().positive().safe() }).strict();
export type X402CpuReservation = z.infer<typeof x402ReservationSchema>;
const extensionSchema = z.object({ version: z.literal(1), authorizationType: z.enum(['ReceiveWithAuthorization', 'PermitWitnessTransferFrom']),
  runId: bytes32Schema, quoteHash: bytes32Schema, leashTermsHash: bytes32Schema, requestHash: bytes32Schema,
  settlementModel: z.literal('upfront_ceiling_then_escrow_refund'), reservationCeiling: z.string().regex(/^[1-9][0-9]{0,8}$/),
  refundBeneficiary: addressSchema, externalWalletGas: z.literal(true) }).strict();
export const x402CpuPaymentSchema = z.object({ x402Version: z.literal(2), resource: resourceSchema, accepted: requirementsSchema,
  payload: paymentPayloadSchema.shape.payload,
  extensions: z.object({ 'telomere-cpu-reservation': extensionSchema }).strict() }).strict();
export type X402CpuPayment = z.infer<typeof x402CpuPaymentSchema>;
