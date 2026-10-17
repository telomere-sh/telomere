import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { addressSchema, bytes32Schema, canonical, hashJson } from '../common.js';
import { LARGE_CYST_MAX_PLAINTEXT_BYTES } from '../cysts/large-checkpoints.js';

export const HOST_TICK_MS = 5000;
export const HOST_MAX_SECONDS = 120;
export const hostKeySchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const imageDigestSchema = z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[0-9a-f]{64}$/);
export const leaseSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema, runId: bytes32Schema,
  owner: addressSchema.transform(value => value.toLowerCase()), image: imageDigestSchema,
  argv: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0'))).min(1).max(32)
    .refine(values => values.reduce((size, value) => size + Buffer.byteLength(value), 0) <= 8192)
    .refine(values => !/^(?:.*\/)?(?:sh|bash|dash|zsh|ksh|fish|busybox)$/.test(values[0] ?? ''), 'A default shell is not permitted'),
  stdin: z.string().max(131072).refine(value => Buffer.byteLength(value, 'utf8') <= 131072).optional(),
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
  maxSeconds: z.number().int().min(1).max(HOST_MAX_SECONDS), nonce: bytes32Schema,
}).strict();
export type HostLease = z.infer<typeof leaseSchema>;
export const heartbeatSchema = z.object({ sequence: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  receivedAt: z.number().int().nonnegative().safe() }).strict();
export const hostTickSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema, runId: bytes32Schema,
  owner: addressSchema.transform(value => value.toLowerCase()), leaseHash: bytes32Schema,
  sequence: z.number().int().min(0).max(100), timestamp: z.number().int().nonnegative().safe(),
  elapsedMs: z.number().int().min(0).max(HOST_MAX_SECONDS * 1000), cpuMs: z.number().int().min(0).safe(),
  state: z.enum(['RUNNING', 'EXITED', 'FAULT', 'STOPPED']), previousHash: bytes32Schema.nullable(),
  heartbeat: heartbeatSchema.nullable(), gpuUtil: z.literal(0), gpuMemoryBytes: z.literal(0), powerWatts: z.literal(0),
}).strict();
export type HostTick = z.infer<typeof hostTickSchema>;
export const ackSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema, runId: bytes32Schema,
  leaseHash: bytes32Schema, sequence: z.number().int().min(0).max(100), tickHash: bytes32Schema,
  acceptedAt: z.number().int().nonnegative().safe(), billableSeconds: z.number().int().min(0).max(HOST_MAX_SECONDS),
  billableDelta: z.number().int().min(0).max(8), fault: z.boolean() }).strict();
export type HostAck = z.infer<typeof ackSchema>;
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export const signedLeaseSchema = z.object({ body: leaseSchema, signature }).strict();
export const signedTickSchema = z.object({ body: hostTickSchema, signature }).strict();
export const signedAckSchema = z.object({ body: ackSchema, signature }).strict();
export type SignedHostLease = z.infer<typeof signedLeaseSchema>;
export type SignedHostTick = z.infer<typeof signedTickSchema>;
export type SignedHostAck = z.infer<typeof signedAckSchema>;
export type HostMessageKind = 'lease' | 'tick' | 'ack' | 'control' | 'session-control' | 'session-status'
  | 'capacity-challenge' | 'capacity' | 'paid-preemption-optin' | 'paid-preemption-request' | 'paid-preemption'
  | 'v2-admission' | 'cyst-input-request' | 'cyst-input-result';
export class Ed25519Identity {
  readonly publicKey: string;
  private readonly key: KeyObject;
  constructor(privatePem?: string) {
    this.key = privatePem ? createPrivateKey(privatePem) : generateKeyPairSync('ed25519').privateKey;
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('Host Kit requires an Ed25519 key');
    const publicBytes = createPublicKey(this.key).export({ format: 'der', type: 'spki' });
    this.publicKey = hostKeySchema.parse('0x' + publicBytes.subarray(-32).toString('hex'));
  }
  exportPrivatePem(): string { return this.key.export({ format: 'pem', type: 'pkcs8' }).toString(); }
  sign<T>(kind: HostMessageKind, body: T): { body: T; signature: string } {
    return { body, signature: sign(null, signedPayload(kind, body), this.key).toString('base64') };
  }
}
function signedPayload(kind: HostMessageKind, body: unknown): Buffer {
  return Buffer.from(canonical({ domain: 'telomere-host-kit/v1', kind, body }), 'utf8');
}
export function verifyHostMessage(key: string, kind: HostMessageKind, value: { body: unknown; signature: string }): boolean {
  try {
    const publicKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hostKeySchema.parse(key).slice(2), 'hex')]) });
    const bytes = Buffer.from(value.signature, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === value.signature && verify(null, signedPayload(kind, value.body), publicKey, bytes);
  } catch { return false; }
}
export function hostMessageHash(value: { body: unknown; signature: string }): `0x${string}` { return hashJson(value); }
export const hostControlSchema = z.object({ body: z.object({ version: z.literal(1), hostKey: hostKeySchema,
  runId: bytes32Schema, owner: addressSchema.transform(value => value.toLowerCase()),
  action: z.enum(['status', 'stop', 'ack']), nonce: bytes32Schema, issuedAt: z.number().int().nonnegative().safe(),
  ack: signedAckSchema.optional() }).strict(), signature }).strict();
export type SignedHostControl = z.infer<typeof hostControlSchema>;
export const capacityChallengeSchema = z.object({ body: z.object({ version: z.literal(1), hostKey: hostKeySchema,
  image: imageDigestSchema, kind: z.enum(['one_shot', 'session']), nonce: bytes32Schema,
  cystInputBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES).optional(),
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict(), signature }).strict();
export const capacityResponseSchema = z.object({ body: z.object({ version: z.literal(1), hostKey: hostKeySchema,
  image: imageDigestSchema, kind: z.enum(['one_shot', 'session']), nonce: bytes32Schema,
  challengeHash: bytes32Schema, isolation: z.enum(['gvisor', 'kata', 'docker_development', 'local_process_fixture']),
  available: z.boolean(), issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
  cystInput: z.object({ requestedBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES),
    maxBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES), available: z.boolean(),
    spoolIdentity: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict(), signature }).strict();
export type SignedCapacityChallenge = z.infer<typeof capacityChallengeSchema>;
export type SignedCapacityResponse = z.infer<typeof capacityResponseSchema>;
