import { z } from 'zod';

export const CYST_CAPABILITIES = Object.freeze({
  version: 1 as const, algorithm: 'xchacha20-poly1305' as const,
  maxPlaintextBytes: 2 * 1024 * 1024, maxCiphertextBytes: 2 * 1024 * 1024 + 16,
  maxUploadBodyBytes: Math.ceil((2 * 1024 * 1024 + 16) / 3) * 4 + 4096,
  maxOwnerBytes: 32 * 1024 * 1024, maxOwnerCheckpoints: 512, listLimit: 100,
  storage: 'local-private-ciphertext' as const, checkpoint: 'application-state' as const,
  keyManagement: 'client-recovery-key' as const,
});
export const cystAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const cystIdSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const cystDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const cystIdempotencySchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const cystHeaderSchema = z.object({
  version: z.literal(1), algorithm: z.literal('xchacha20-poly1305'),
  id: cystIdSchema, owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
  plaintextBytes: z.number().int().min(1).max(CYST_CAPABILITIES.maxPlaintextBytes),
  nonce: z.string().regex(/^[0-9a-f]{48}$/),
}).strict();
export const cystEnvelopeSchema = cystHeaderSchema.extend({
  sha256: cystDigestSchema,
  ciphertext: z.string().min(24).max(Math.ceil(CYST_CAPABILITIES.maxCiphertextBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const cystMetadataSchema = cystHeaderSchema.extend({
  sha256: cystDigestSchema, ciphertextBytes: z.number().int().min(17).max(CYST_CAPABILITIES.maxCiphertextBytes),
  state: z.enum(['pending', 'ready']), createdAt: z.string().datetime(),
}).strict();
export type CystHeader = z.infer<typeof cystHeaderSchema>;
export type CystEnvelope = z.infer<typeof cystEnvelopeSchema>;
export type CystMetadata = z.infer<typeof cystMetadataSchema>;

// A fixed ordered tuple makes the cross-runtime AEAD context unambiguous.
// SHA-256 is checked independently; it cannot be included in AAD before encryption.
export function cystAuthenticatedData(header: CystHeader): Uint8Array {
  const value = cystHeaderSchema.parse(header);
  return new TextEncoder().encode(JSON.stringify(['telomere.application-cyst', value.version, value.algorithm,
    value.id, value.owner, value.agent, value.applicationSchema, value.plaintextBytes, value.nonce]));
}
