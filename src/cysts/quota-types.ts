import { z } from 'zod';
import { CYST_CAPABILITIES } from './types.js';

export const CYST_QUOTA_HEADER = 'X-Telomere-Cyst-Quota';
export const cystQuotaPolicySchema = z.object({ version: z.literal(2), kind: z.literal('telomere-cyst-quota-v2'),
  maxOwnerCheckpoints: z.literal(4096), maxOwnerBytes: z.literal(33_554_432) }).strict();
export type CystQuotaPolicy = z.infer<typeof cystQuotaPolicySchema>;
export const cystCapabilitiesV1Schema = z.object({ version: z.literal(1), algorithm: z.literal('xchacha20-poly1305'),
  maxPlaintextBytes: z.literal(CYST_CAPABILITIES.maxPlaintextBytes), maxCiphertextBytes: z.literal(CYST_CAPABILITIES.maxCiphertextBytes),
  maxUploadBodyBytes: z.literal(CYST_CAPABILITIES.maxUploadBodyBytes), maxOwnerBytes: z.literal(CYST_CAPABILITIES.maxOwnerBytes),
  maxOwnerCheckpoints: z.literal(512), listLimit: z.literal(100), storage: z.literal('local-private-ciphertext'),
  checkpoint: z.literal('application-state'), keyManagement: z.literal('client-recovery-key') }).strict();
export const cystCapabilitiesV2Schema = cystCapabilitiesV1Schema.extend({ maxOwnerCheckpoints: z.literal(4096), quotaPolicy: cystQuotaPolicySchema }).strict();
