import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson } from '../../common.js';
import { LARGE_CYST_MAX_PLAINTEXT_BYTES } from '../../cysts/large-checkpoints.js';
import { largeCystRegistryDescriptorSchema } from '../../cysts/large-registry.js';
import { hostKeySchema } from '../protocol.js';

export const CYST_INPUT_PATH = '/run/telomere-cyst/state.bin';
export const CYST_INPUT_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
export const cystInputDescriptorSchema = z.object({
  protocol: z.literal('telomere-cyst-application-file-v1'),
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  agentId: bytes32Schema, revision: z.string().regex(/^[1-9][0-9]{0,77}$/),
  checkpoint: largeCystRegistryDescriptorSchema,
  plaintextBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES),
  plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CystInputDescriptor = z.infer<typeof cystInputDescriptorSchema>;
export const cystInputMaxBytesSchema = z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES);
export const cystInputBindingSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema,
  runId: bytes32Schema, owner: addressSchema.transform(value => value.toLowerCase()), leaseHash: bytes32Schema,
  expiresAt: z.number().int().positive().safe(), descriptor: cystInputDescriptorSchema }).strict();
export type CystInputBinding = z.infer<typeof cystInputBindingSchema>;
export const cystInputRequestSchema = z.object({ body: cystInputBindingSchema.extend({
  action: z.enum(['upload', 'commit', 'status']), nonce: bytes32Schema,
  issuedAt: z.number().int().nonnegative().safe(),
}).strict(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export const cystInputResultSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema,
  runId: bytes32Schema, owner: addressSchema.transform(value => value.toLowerCase()), leaseHash: bytes32Schema,
  descriptorHash: bytes32Schema, operationId: cystInputDescriptorSchema.shape.operationId,
  state: z.enum(['waiting', 'staged', 'ready', 'cleaned']), committed: z.boolean(),
  plaintextBytes: cystInputDescriptorSchema.shape.plaintextBytes,
  plaintextSha256: cystInputDescriptorSchema.shape.plaintextSha256,
  path: z.literal(CYST_INPUT_PATH), requestNonce: bytes32Schema,
}).strict();
export const signedCystInputResultSchema = z.object({ body: cystInputResultSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type CystInputResult = z.infer<typeof cystInputResultSchema>;
export type SignedCystInputResult = z.infer<typeof signedCystInputResultSchema>;
export const cystInputDescriptorHash = (value: CystInputDescriptor) => hashJson(cystInputDescriptorSchema.parse(value));
