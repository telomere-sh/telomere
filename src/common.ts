import { createHash, randomBytes } from 'node:crypto';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { cpuTaskSchema } from './runtime/types.js';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => {
  // REASON: the preceding boundary schema proves the hex representation.
  return value.toLowerCase() as Hex;
});
export const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => {
  // REASON: EOA signatures are restricted to exactly 65 bytes at the boundary.
  return value as Hex;
});
export const moneySchema = z.string().regex(/^(0|[1-9][0-9]{0,27})$/).refine(value => BigInt(value) < 2n ** 96n, 'Amount exceeds uint96');
export const taskSchema = cpuTaskSchema;
export const quoteInputSchema = z.object({
  leashId: bytes32Schema, task: taskSchema, maxSeconds: z.number().int().min(1).max(120),
  nearPrompt: z.string().min(1).max(8192).refine(value => Buffer.byteLength(value, 'utf8') <= 8192).optional(),
}).strict();
export type QuoteInput = z.infer<typeof quoteInputSchema>;
export const quoteSchema = z.object({
  runId: bytes32Schema, leashId: bytes32Schema, payer: addressSchema, workloadHash: bytes32Schema,
  maxSeconds: z.number().int().min(1).max(120), pricePerSecond: moneySchema,
  inferencePrice: moneySchema, quoteExpiry: z.number().int().positive(),
}).strict();
export type StoredQuote = z.infer<typeof quoteSchema>;
export function typedQuote(quote: StoredQuote) {
  return { ...quote, maxSeconds: BigInt(quote.maxSeconds), pricePerSecond: BigInt(quote.pricePerSecond),
    inferencePrice: BigInt(quote.inferencePrice), quoteExpiry: BigInt(quote.quoteExpiry) };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
    if (encoded === undefined) throw new Error('Cannot hash undefined');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
}
export function hashJson(value: unknown): Hex { return keccak256(toHex(canonical(value))); }
export function randomId(): Hex { return bytes32Schema.parse('0x' + randomBytes(32).toString('hex')); }
export function secretHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function sameAddress(a: string, b: Address): boolean { return a.toLowerCase() === b.toLowerCase(); }
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item));
}
export class Problem extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, public readonly code: string, detail: string) { super(detail); }
}
