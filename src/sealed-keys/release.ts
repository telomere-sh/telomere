import { createHash, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { z } from 'zod';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema, cystMetadataSchema } from '../cysts/types.js';
import { decryptCheckpoint } from '../sdk/cysts.js';
import type { CystCheckpointVault } from '../sdk/cyst-checkpoints.js';

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const hex64 = z.string().regex(/^0x[0-9a-f]{128}$/);
const key32 = z.string().regex(/^[0-9a-f]{64}$/).refine(value => value !== '00'.repeat(32));
const operationId = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const identity = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const instant = z.number().int().nonnegative().safe();
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema }).strict();
const requestSchema = scopeSchema.extend({ checkpointId: cystIdSchema, operationId, runId: hex32,
  hostId: hex32, audience: identity, teeMeasurement: hex32, policySha256: hex32,
  recipientPublicKey: key32 }).strict();
const verdictSchema = z.object({
  verification: z.literal('hardware_verified'), attestationRef: hex32, challenge: hex32, reportData: hex64,
  verifiedAtMs: instant, expiresAtMs: instant, owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema, operationId, checkpointId: cystIdSchema, runId: hex32,
  hostId: hex32, audience: identity, teeMeasurement: hex32, policySha256: hex32,
  recipientPublicKey: key32,
}).strict();
const packetSchema = requestSchema.omit({ operationId: true }).extend({
  version: z.literal(2), algorithm: z.literal('x25519-hkdf-sha256-xchacha20poly1305'),
  attestationRef: hex32, challenge: hex32, reportData: hex64, verifiedAtMs: instant, expiresAtMs: instant,
  ephemeralPublicKey: key32, salt: key32, nonce: z.string().regex(/^[0-9a-f]{48}$/),
  ciphertext: z.string().regex(/^[0-9a-f]{96}$/),
}).strict();

export type SealedCystKeyRequest = z.infer<typeof requestSchema>;
export type SealedCellChallenge = Readonly<SealedCystKeyRequest & { challenge: `0x${string}`; reportData: `0x${string}` }>;
export type VerifiedSealedCell = z.infer<typeof verdictSchema>;
export type SealedCystKeyPacket = z.infer<typeof packetSchema>;

/** Trusted owner-to-Cell transport. Request a new hardware quote only after the
 * owner has issued the challenge. The verifier must still authenticate the quote
 * and prove that its report_data binds this challenge and recipient key.
 */
export type SealedCellEvidenceCollector = (input: {
  challenge: SealedCellChallenge; signal: AbortSignal;
}) => Promise<Uint8Array>;

/** Trusted owner-side adapter. It MUST verify raw hardware evidence, collateral,
 * TCB/debug policy, quote report-data key binding and a fresh challenge. It must
 * derive every verdict field from authenticated evidence, not copy untrusted JSON.
 * The NEAR inference verifier does not implement this Cell-specific contract.
 */
export type SealedCellHardwareVerifier = (input: {
  evidence: Uint8Array; challenge: SealedCellChallenge; signal: AbortSignal;
}) => Promise<unknown>;

const bytes = (value: string): Uint8Array => Uint8Array.from(value.match(/.{2}/g) ?? [], item => Number.parseInt(item, 16));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
/** Exact 64-byte Intel TD report_data protocol for a Telomere CPU Cell. The
 * first half commits to every release selector; the second is the owner's raw
 * one-shot challenge. This encoding is only an expectation, never proof that a
 * quote was signed or that its report_data actually contains these bytes.
 */
export function sealedCellReportData(value: SealedCystKeyRequest & { challenge: string }): `0x${string}` {
  const { challenge, ...candidate } = value;
  const request = requestSchema.parse(candidate), nonce = hex32.parse(challenge);
  const preimage = JSON.stringify(['telomere.sealed-cell.report-data.v1', request.owner, request.agent,
    request.applicationSchema, request.checkpointId, request.operationId, request.runId,
    request.hostId, request.audience, request.teeMeasurement, request.policySha256,
    request.recipientPublicKey, nonce]);
  return `0x${createHash('sha256').update(preimage, 'utf8').digest('hex')}${nonce.slice(2)}`;
}
const sameRequest = (request: SealedCystKeyRequest, verdict: VerifiedSealedCell): boolean =>
  request.owner === verdict.owner && request.agent === verdict.agent
  && request.applicationSchema === verdict.applicationSchema && request.operationId === verdict.operationId
  && request.checkpointId === verdict.checkpointId && request.runId === verdict.runId
  && request.hostId === verdict.hostId && request.audience === verdict.audience
  && request.teeMeasurement === verdict.teeMeasurement && request.policySha256 === verdict.policySha256
  && request.recipientPublicKey === verdict.recipientPublicKey;

function packetContext(value: Omit<SealedCystKeyPacket, 'ciphertext'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['telomere.sealed-cyst-key', value.version, value.algorithm,
    value.owner, value.agent, value.applicationSchema, value.checkpointId, value.runId, value.hostId,
    value.audience, value.teeMeasurement, value.policySha256, value.recipientPublicKey,
    value.attestationRef, value.challenge, value.reportData, value.verifiedAtMs, value.expiresAtMs,
    value.ephemeralPublicKey, value.salt, value.nonce]));
}

async function derive(privateKey: CryptoKey, publicKey: string, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  if (privateKey.type !== 'private' || privateKey.extractable || privateKey.algorithm.name !== 'X25519'
    || !privateKey.usages.includes('deriveBits')) {
    throw new Error('A non-exportable X25519 recipient key is required');
  }
  const publicPart = await crypto.subtle.importKey('raw', Uint8Array.from(bytes(publicKey)).buffer, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicPart }, privateKey, 256));
  try {
    if (shared.every(byte => byte === 0)) throw new Error('Invalid X25519 agreement');
    const hkdf = await crypto.subtle.importKey('raw', Uint8Array.from(shared).buffer, 'HKDF', false, ['deriveBits']);
    // Node's HKDF info is limited to 1024 bytes. Keep the complete packet
    // header in AEAD AAD and commit to all of it with this domain-separated
    // digest in the key schedule.
    const infoDigest = createHash('sha256').update('telomere.sealed-cyst-key.kek.v2', 'utf8').update(info).digest();
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
      salt: Uint8Array.from(salt).buffer, info: Uint8Array.from(infoDigest).buffer }, hkdf, 256));
  } finally { shared.fill(0); }
}

function assertFresh(value: Pick<VerifiedSealedCell, 'verifiedAtMs' | 'expiresAtMs'>, now: number): void {
  if (value.verifiedAtMs > now + 5_000 || value.verifiedAtMs < now - 60_000
    || value.expiresAtMs <= now || value.expiresAtMs <= value.verifiedAtMs
    || value.expiresAtMs > value.verifiedAtMs + 60_000) throw new Error('Sealed Cell attestation is stale or expired');
}

/** Owner-side one-shot release. Only a ciphertext for the quote-bound Cell key
 * leaves this method. The source key and authentication plaintext are cleared.
 */
export async function releaseCystKeyToSealedCell(options: {
  request: SealedCystKeyRequest; collectEvidence: SealedCellEvidenceCollector; verify: SealedCellHardwareVerifier;
  vault: CystCheckpointVault; signal: AbortSignal; now?: () => number;
}): Promise<SealedCystKeyPacket> {
  const request = requestSchema.parse(options.request);
  if (typeof options.collectEvidence !== 'function' || typeof options.verify !== 'function'
    || !options.vault || typeof options.vault.exclusive !== 'function'
    || !(options.signal instanceof AbortSignal)) throw new Error('Invalid sealed Cell release boundary');
  options.signal.throwIfAborted();
  const now = options.now ?? Date.now;
  const nonce = `0x${hex(randomBytes(32))}` as const;
  const challenge: SealedCellChallenge = Object.freeze({ ...request, challenge: nonce,
    reportData: sealedCellReportData({ ...request, challenge: nonce }) });
  const evidence = await options.collectEvidence({ challenge, signal: options.signal });
  if (!(evidence instanceof Uint8Array) || evidence.byteLength < 1 || evidence.byteLength > 4_194_304) {
    throw new Error('Invalid sealed Cell evidence');
  }
  options.signal.throwIfAborted();
  const raw = await options.verify({ evidence: Uint8Array.from(evidence), challenge, signal: options.signal });
  const verdict = verdictSchema.parse(raw);
  const current = instant.parse(now());
  if (verdict.challenge !== challenge.challenge || verdict.reportData !== challenge.reportData
    || !sameRequest(request, verdict)) throw new Error('Sealed Cell attestation binding changed');
  assertFresh(verdict, current);
  options.signal.throwIfAborted();
  return options.vault.exclusive({ owner: request.owner, agent: request.agent, applicationSchema: request.applicationSchema }, async journal => {
    options.signal.throwIfAborted();
    assertFresh(verdict, instant.parse(now()));
    const state = await journal.load();
    if (!state || state.scope.owner !== request.owner || state.scope.agent !== request.agent
      || state.scope.applicationSchema !== request.applicationSchema || state.pending
      || state.latest?.operationId !== request.operationId || state.latest.checkpoint.id !== request.checkpointId
      || state.latest.checkpoint.state !== 'ready') throw new Error('No matching completed checkpoint is available');
    const record = await journal.checkpoint(request.operationId);
    if (!record) throw new Error('Checkpoint recovery record is unavailable');
    try {
      const metadata = cystMetadataSchema.parse(state.latest.checkpoint);
      const envelope = record.envelope;
      if (envelope.id !== metadata.id || envelope.owner !== request.owner || envelope.agent !== request.agent
        || envelope.applicationSchema !== request.applicationSchema || envelope.sha256 !== metadata.sha256
        || envelope.plaintextBytes !== metadata.plaintextBytes || envelope.nonce !== metadata.nonce
        || Buffer.from(envelope.ciphertext, 'base64').byteLength !== metadata.ciphertextBytes) {
        throw new Error('Checkpoint record differs from completed metadata');
      }
      if (!(record.recoveryKey instanceof Uint8Array) || record.recoveryKey.byteLength !== 32) throw new Error('Invalid checkpoint recovery record');
      const plaintext = await decryptCheckpoint(envelope, record.recoveryKey);
      plaintext.fill(0);
      options.signal.throwIfAborted();
      assertFresh(verdict, instant.parse(now()));
      const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
      const header = {
        ...request, version: 2 as const, algorithm: 'x25519-hkdf-sha256-xchacha20poly1305' as const,
        attestationRef: verdict.attestationRef, challenge: verdict.challenge, reportData: verdict.reportData,
        verifiedAtMs: verdict.verifiedAtMs, expiresAtMs: verdict.expiresAtMs,
        ephemeralPublicKey: hex(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))),
        salt: hex(randomBytes(32)), nonce: hex(randomBytes(24)),
      };
      const { operationId: _operationId, ...publicHeader } = header;
      void _operationId;
      const aad = packetContext(publicHeader), kek = await derive(ephemeral.privateKey, verdict.recipientPublicKey,
        bytes(header.salt), aad);
      try {
        options.signal.throwIfAborted();
        assertFresh(verdict, instant.parse(now()));
        const keyCopy = Uint8Array.from(record.recoveryKey);
        try {
          const ciphertext = xchacha20poly1305(kek, bytes(header.nonce), aad).encrypt(keyCopy);
          try {
            options.signal.throwIfAborted();
            assertFresh(verdict, instant.parse(now()));
            return packetSchema.parse({ ...publicHeader, ciphertext: hex(ciphertext) });
          } finally { ciphertext.fill(0); }
        } finally { keyCopy.fill(0); }
      } finally { kek.fill(0); }
    } finally { if (record.recoveryKey instanceof Uint8Array) record.recoveryKey.fill(0); }
  });
}

/** Run only inside the quote-bound Cell. It checks the expected context again
 * before decrypting; the caller must keep the resulting key inside the Cell.
 */
export async function openSealedCystKey(value: unknown, expected: Omit<SealedCystKeyRequest, 'operationId'>,
  recipient: { publicKey: string; privateKey: CryptoKey }, now: () => number = Date.now): Promise<Uint8Array> {
  const packet = packetSchema.parse(value);
  const request = requestSchema.omit({ operationId: true }).parse(expected);
  const publicKey = key32.parse(recipient.publicKey);
  for (const field of ['owner', 'agent', 'applicationSchema', 'checkpointId', 'runId', 'hostId', 'audience',
    'teeMeasurement', 'policySha256', 'recipientPublicKey'] as const) {
    if (packet[field] !== request[field]) throw new Error('Sealed checkpoint key context changed');
  }
  if (packet.recipientPublicKey !== publicKey) throw new Error('Sealed checkpoint key recipient changed');
  assertFresh(packet, instant.parse(now()));
  const { ciphertext, ...header } = packet;
  const aad = packetContext(header), kek = await derive(recipient.privateKey, packet.ephemeralPublicKey, bytes(packet.salt), aad);
  try {
    const key = xchacha20poly1305(kek, bytes(packet.nonce), aad).decrypt(bytes(ciphertext));
    if (key.byteLength !== 32) { key.fill(0); throw new Error('Invalid checkpoint recovery key'); }
    return key;
  } catch { throw new Error('Sealed checkpoint key authentication failed'); }
  finally { kek.fill(0); }
}

/** Safe digest for a private acceptance record; raw evidence stays with the owner. */
export function sealedEvidenceSha256(evidence: Uint8Array): `0x${string}` {
  if (!(evidence instanceof Uint8Array) || evidence.byteLength < 1 || evidence.byteLength > 4_194_304) throw new Error('Invalid evidence bytes');
  return `0x${createHash('sha256').update(evidence).digest('hex')}`;
}
