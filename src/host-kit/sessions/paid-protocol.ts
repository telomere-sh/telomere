import { z } from 'zod';
import { paidCpuSchedulingSchema } from '../../scheduling/paid-lanes.js';
import { addressSchema, bytes32Schema } from '../../common.js';
import { cystInputDescriptorSchema } from './cyst-input-protocol.js';
import { hostKeySchema, signedAckSchema, signedLeaseSchema, signedTickSchema } from '../protocol.js';
import { commandResultSchema, sessionCommandSchema, sessionEventSchema, sessionPolicySchema,
  sessionSpecSchema, cpuResourceProfileSchema, CPU_PROFILE_QUOTAS } from './types.js';

export const PAID_SESSION_ARGV = ['/usr/local/bin/node', '/opt/telomere/session-init.mjs'] as const;
export const paidSessionTaskSchema = z.object({ kind: z.literal('session'),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), maxCommands: z.number().int().min(1).max(32),
  resourceProfile: cpuResourceProfileSchema.optional(), cystInput: cystInputDescriptorSchema.optional() }).strict();
export type PaidSessionTask = z.infer<typeof paidSessionTaskSchema>;
export const paidSessionPayloadSchema = z.object({ spec: sessionSpecSchema, quoteHash: bytes32Schema,
  admissionTx: bytes32Schema, resourceProfile: cpuResourceProfileSchema.optional(),
  cpuScheduling: paidCpuSchedulingSchema.optional() }).strict();
export type PaidSessionPayload = z.infer<typeof paidSessionPayloadSchema>;

/** The fixed 120-second CPU policy is part of the signed financial workload. */
export function paidSessionPolicy(maxCommands: number, resourceProfile: 'full' | 'lean' | 'torpor' = 'full') {
  return sessionPolicySchema.parse({ version: 1, cpu: CPU_PROFILE_QUOTAS[cpuResourceProfileSchema.parse(resourceProfile)], memoryBytes: 268_435_456, pids: 64,
    temporaryBytes: 16_777_216, network: 'none', readOnlyRoot: true,
    maxCommands, maxOutputBytesPerCommand: 16_384, maxSessionOutputBytes: 65_536,
    maxOutputFrames: 1024 });
}
export function parsePaidSessionLease(raw: unknown) {
  const lease = signedLeaseSchema.parse(raw), body = lease.body;
  if (body.argv.length !== PAID_SESSION_ARGV.length || body.argv.some((item, index) => item !== PAID_SESSION_ARGV[index])
    || body.stdin === undefined || Buffer.byteLength(body.stdin) > 4096) throw new Error('Invalid signed session lease task');
  const payload = paidSessionPayloadSchema.parse(JSON.parse(body.stdin));
  if (JSON.stringify(payload) !== body.stdin || payload.spec.sessionId !== body.runId || payload.spec.image !== body.image
    || payload.spec.lifetimeSeconds !== body.maxSeconds
    || JSON.stringify(payload.spec.policy) !== JSON.stringify(paidSessionPolicy(payload.spec.policy.maxCommands, payload.resourceProfile))) {
    throw new Error('Signed session lease differs from its fixed CPU policy');
  }
  return { lease, payload };
}

const commonControl = z.object({ version: z.literal(1), hostKey: hostKeySchema, runId: bytes32Schema,
  owner: addressSchema.transform(value => value.toLowerCase()), leaseHash: bytes32Schema,
  nonce: bytes32Schema, issuedAt: z.number().int().nonnegative().safe() });
export const paidSessionControlSchema = z.object({ body: z.discriminatedUnion('action', [
  commonControl.extend({ action: z.literal('status'), afterSequence: z.number().int().min(-1).max(4095).default(-1),
    limit: z.number().int().min(1).max(8).default(8) }).strict(),
  commonControl.extend({ action: z.literal('stop') }).strict(),
  commonControl.extend({ action: z.literal('ack'), ack: signedAckSchema }).strict(),
  commonControl.extend({ action: z.literal('execute'), command: sessionCommandSchema }).strict(),
]), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type PaidSessionControl = z.infer<typeof paidSessionControlSchema>;

export const paidSessionStatusSchema = z.object({ body: z.object({ version: z.literal(1), hostKey: hostKeySchema,
  runId: bytes32Schema, owner: addressSchema.transform(value => value.toLowerCase()), leaseHash: bytes32Schema,
  requestNonce: bytes32Schema,
  isolation: z.enum(['gvisor', 'kata', 'local_process_fixture']),
  state: z.enum(['starting', 'running', 'completed', 'stopped', 'expired', 'fault']),
  ticks: z.array(signedTickSchema).max(100), acks: z.array(signedAckSchema).max(100),
  billableSeconds: z.number().int().min(0).max(120), cleanupConfirmed: z.boolean(),
  eventCount: z.number().int().min(0).max(4096), eventsHash: bytes32Schema, events: z.array(sessionEventSchema).max(8),
  nextSequence: z.number().int().min(-1).max(4095),
  command: commandResultSchema.nullable(),
}).strict(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type PaidSessionStatus = z.infer<typeof paidSessionStatusSchema>['body'];
