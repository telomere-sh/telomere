import { createHash } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { z } from 'zod';
import type { NearCompletionResult } from './near.js';

const hashSchema = z.string().regex(/^(?:0x)?[a-f0-9]{64}$/);
const prefixedHashSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const modelSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._/-]+$/);
const timeSchema = z.string().max(64).datetime({ offset: true });
const commonEvidence = { endpoint: z.string().max(2048).url(), receivedAt: timeSchema,
  requestHash: hashSchema, responseHash: hashSchema };
const evidenceSchema = z.discriminatedUnion('verification', [
  z.object({ verification: z.literal('provider_tls'), ...commonEvidence, outputHash: hashSchema.optional() }).strict(),
  z.object({ verification: z.literal('enclave_verified'), ...commonEvidence,
    attestationRef: prefixedHashSchema, policySha256: prefixedHashSchema, providerEvidenceHash: prefixedHashSchema,
    outputHash: prefixedHashSchema, signingAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value)),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), signatureText: z.string().max(1024),
    verifiedAt: timeSchema, expiresAt: timeSchema }).strict(),
]);
const resultSchema = z.object({ output: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 16384),
  model: modelSchema, requestId: z.string().min(1).max(256),
  usage: z.object({ promptTokens: z.number().int().min(0).max(10_000_000), completionTokens: z.number().int().min(0).max(512),
    totalTokens: z.number().int().min(0).max(10_000_512) }).strict().optional(), evidence: evidenceSchema }).strict();
const optionsSchema = z.object({ model: modelSchema, maxTokens: z.number().int().min(1).max(512) }).strict();
const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export class ProviderRecoveryRejectedError extends Error {
  readonly code = 'PROVIDER_RECOVERY_REJECTED';
  constructor() { super('Stored provider result failed recovery validation'); this.name = 'ProviderRecoveryRejectedError'; }
}

function allowedEndpoint(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.search && !url.hash
    && url.pathname === '/v1/chat/completions'
    && (url.hostname === 'cloud-api.near.ai' || /^[a-z0-9-]+\.completions\.near\.ai$/.test(url.hostname));
}
const unprefix = (value: string) => value.startsWith('0x') ? value.slice(2) : value;

/**
 * Offline integrity checks for a result already accepted and stored by the live adapter.
 * This does not reverify hardware/provenance, reconstruct the private HTTP transcript,
 * establish an exact model instance, or authorize another request under current policy.
 */
export async function validateRecoveredNearResult(value: unknown, options: { model: string; maxTokens: number }): Promise<NearCompletionResult> {
  try {
    const expected = optionsSchema.parse(options), parsed = resultSchema.parse(value), evidence = parsed.evidence;
    if (parsed.model !== expected.model || !allowedEndpoint(evidence.endpoint)
      || parsed.usage && (parsed.usage.completionTokens > expected.maxTokens
        || parsed.usage.totalTokens !== parsed.usage.promptTokens + parsed.usage.completionTokens)) throw new Error();
    if (evidence.outputHash !== undefined && unprefix(evidence.outputHash) !== createHash('sha256').update(parsed.output, 'utf8').digest('hex')) throw new Error();
    if (evidence.verification === 'enclave_verified') {
      const issued = Date.parse(evidence.verifiedAt), expires = Date.parse(evidence.expiresAt), received = Date.parse(evidence.receivedAt);
      // The original adapter accepts at most 300-second sessions. receivedAt records the later local return,
      // so it can follow expiry after a delayed policy-file read; it is not a signed completion timestamp.
      if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(received)
        || expires <= issued || expires > issued + 300_000 || issued > received + 30_000
        || !/^[A-Za-z0-9_-]{1,256}$/.test(parsed.requestId)) throw new Error();
      const text = `${parsed.model}:${unprefix(evidence.requestHash)}:${unprefix(evidence.responseHash)}`;
      if (evidence.signatureText !== text) throw new Error();
      const r = BigInt(`0x${evidence.signature.slice(2, 66)}`), s = BigInt(`0x${evidence.signature.slice(66, 130)}`);
      const v = Number.parseInt(evidence.signature.slice(130), 16);
      if (r === 0n || r >= curveOrder || s === 0n || s > curveOrder / 2n || ![0, 1, 27, 28].includes(v)) throw new Error();
      // REASON: the bounded schema and canonical r/s/v checks establish a 65-byte ECDSA signature.
      const signer = await recoverMessageAddress({ message: text, signature: evidence.signature as `0x${string}` });
      if (signer.toLowerCase() !== evidence.signingAddress.toLowerCase()) throw new Error();
    }
    const { usage, evidence: parsedEvidence, ...required } = parsed;
    const { outputHash, ...requiredEvidence } = parsedEvidence;
    return { ...required, ...(usage === undefined ? {} : { usage }),
      evidence: { ...requiredEvidence, ...(outputHash === undefined ? {} : { outputHash }) } };
  } catch { throw new ProviderRecoveryRejectedError(); }
}
