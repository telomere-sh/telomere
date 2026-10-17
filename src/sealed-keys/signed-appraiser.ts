import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { sealedCellReportData, type SealedCellHardwareVerifier, type VerifiedSealedCell } from './release.js';

// This is an authenticated transport for an independently operated DCAP
// appraiser. A signature authenticates its verdict; it is not a substitute for
// that appraiser verifying the raw quote and current Intel collateral.
const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));
const rawHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const instant = z.number().int().safe().nonnegative();
const b64 = z.string().min(1).max(48_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const measurementNames = [
  'tee_tcb_svn', 'mr_seam', 'mr_signer_seam', 'seam_attributes', 'td_attributes', 'xfam',
  'mr_td', 'mr_config_id', 'mr_owner', 'mr_owner_config', 'rt_mr0', 'rt_mr1', 'rt_mr2', 'rt_mr3',
] as const;
const measurementsSchema = z.object({
  tee_tcb_svn: rawHex(16), mr_seam: rawHex(48), mr_signer_seam: rawHex(48),
  seam_attributes: rawHex(8), td_attributes: rawHex(8), xfam: rawHex(8),
  mr_td: rawHex(48), mr_config_id: rawHex(48), mr_owner: rawHex(48),
  mr_owner_config: rawHex(48), rt_mr0: rawHex(48), rt_mr1: rawHex(48),
  rt_mr2: rawHex(48), rt_mr3: rawHex(48),
}).strict();
const configSchema = z.object({
  endpoint: z.string().url(), verifierPublicKeyPem: z.string().min(1).max(4096),
  signerNotBeforeMs: instant, signerExpiresAtMs: instant, policySha256: hex(32),
  approvedMeasurements: measurementsSchema, timeoutMs: z.number().int().min(1).max(45_000).default(45_000),
}).strict();
const signedPayloadSchema = z.object({
  version: z.literal(1), verification: z.literal('hardware_verified'),
  evidenceSha256: hex(32), challenge: hex(32), reportData: hex(64),
  runId: hex(32), recipientPublicKey: rawHex(32), teeMeasurement: hex(32), policySha256: hex(32),
  verifiedAtMs: instant, expiresAtMs: instant, collateralExpiresAtMs: instant,
  quoteStatus: z.literal('UpToDate'), qeStatus: z.literal('UpToDate'),
  platformStatus: z.literal('UpToDate'), advisories: z.tuple([]),
  measurements: measurementsSchema,
}).strict();
const envelopeSchema = z.object({ payloadB64: b64, signatureB64: b64 }).strict();
const domain = Buffer.from('telomere.sealed-cell.signed-appraisal.v1\0', 'utf8');

export type SealedCellMeasurementProfile = z.infer<typeof measurementsSchema>;
export type SignedCellAppraisal = z.infer<typeof signedPayloadSchema>;
export type SignedCellAppraiserConfig = z.input<typeof configSchema>;

/** Domain-separated digest of the complete reviewed TDX measurement vector. */
export function sealedCellMeasurementDigest(input: SealedCellMeasurementProfile): `0x${string}` {
  const value = measurementsSchema.parse(input);
  const vector = ['telomere.sealed-cell.tdx-measurements.v1', ...measurementNames.map(name => value[name])];
  return `0x${createHash('sha256').update(JSON.stringify(vector), 'utf8').digest('hex')}`;
}

function canonicalJson<T>(raw: string, schema: z.ZodType<T>): T {
  const parsed = schema.parse(JSON.parse(raw) as unknown);
  if (JSON.stringify(parsed) !== raw) throw new Error('Noncanonical signed appraiser JSON');
  return parsed;
}

function canonicalBase64(value: string, maxBytes: number): Buffer {
  const parsed = b64.parse(value);
  const decoded = Buffer.from(parsed, 'base64');
  if (decoded.byteLength < 1 || decoded.byteLength > maxBytes || decoded.toString('base64') !== parsed) {
    throw new Error('Invalid signed appraiser base64');
  }
  return decoded;
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (response.status !== 200 || response.type === 'opaqueredirect') throw new Error('Signed appraiser rejected evidence');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('Signed appraiser response too large');
  if (!response.body) throw new Error('Signed appraiser response missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw new Error('Signed appraiser response too large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** Operator-configured, default-unmounted adapter. The remote service MUST
 * independently authenticate raw TDX quote signatures/collateral and sign only
 * its verified, policy-appraised result with the pinned Ed25519 key.
 */
export function createSignedCellAppraiserVerifier(rawConfig: SignedCellAppraiserConfig): SealedCellHardwareVerifier {
  const config = configSchema.parse(rawConfig);
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Signed appraiser endpoint must be a fixed HTTPS URL');
  }
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(config.verifierPublicKeyPem)) {
    throw new Error('Signed appraiser requires a public-key PEM pin');
  }
  const key = createPublicKey(config.verifierPublicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signed appraiser requires Ed25519 verifier key');
  if (config.signerExpiresAtMs <= config.signerNotBeforeMs) throw new Error('Signed appraiser signer pin expired');
  const approvedMeasurement = sealedCellMeasurementDigest(config.approvedMeasurements);

  return async ({ evidence, challenge, signal }): Promise<VerifiedSealedCell> => {
    signal.throwIfAborted();
    const startedAt = Date.now();
    if (startedAt < config.signerNotBeforeMs || startedAt >= config.signerExpiresAtMs) {
      throw new Error('Signed appraiser signer pin expired');
    }
    if (!(evidence instanceof Uint8Array) || evidence.byteLength < 1000 || evidence.byteLength > 131_072) {
      throw new Error('Signed appraiser requires bounded raw TDX quote');
    }
    const { reportData: _expectedReportData, ...challengeRequest } = challenge;
    void _expectedReportData;
    if (challenge.policySha256 !== config.policySha256 || challenge.teeMeasurement !== approvedMeasurement
      || challenge.reportData !== sealedCellReportData(challengeRequest)) {
      throw new Error('Signed appraiser policy or challenge binding changed');
    }
    const evidenceSha256 = `0x${createHash('sha256').update(evidence).digest('hex')}`;
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const scopedSignal = AbortSignal.any([signal, deadline]);
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: scopedSignal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ version: 1, evidenceB64: Buffer.from(evidence).toString('base64'),
        challenge: challenge.challenge, reportData: challenge.reportData, runId: challenge.runId,
        recipientPublicKey: challenge.recipientPublicKey, teeMeasurement: challenge.teeMeasurement,
        policySha256: challenge.policySha256 }),
    });
    const rawEnvelope = await boundedResponse(response, 32_768);
    const envelope = canonicalJson(rawEnvelope, envelopeSchema);
    const payloadBytes = canonicalBase64(envelope.payloadB64, 16_384);
    const signature = canonicalBase64(envelope.signatureB64, 64);
    if (signature.byteLength !== 64 || !verifySignature(null, Buffer.concat([domain, payloadBytes]), key, signature)) {
      throw new Error('Signed appraiser signature rejected');
    }
    const payload = canonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes), signedPayloadSchema);
    const now = Date.now();
    signal.throwIfAborted();
    if (deadline.aborted || now < config.signerNotBeforeMs || now >= config.signerExpiresAtMs) {
      throw new Error('Signed appraiser verification expired');
    }
    if (payload.evidenceSha256 !== evidenceSha256 || payload.challenge !== challenge.challenge
      || payload.reportData !== challenge.reportData || payload.runId !== challenge.runId
      || payload.recipientPublicKey !== challenge.recipientPublicKey
      || payload.teeMeasurement !== approvedMeasurement || payload.policySha256 !== config.policySha256) {
      throw new Error('Signed appraiser evidence or request binding changed');
    }
    if (JSON.stringify(payload.measurements) !== JSON.stringify(config.approvedMeasurements)
      || sealedCellMeasurementDigest(payload.measurements) !== approvedMeasurement
      || (Number.parseInt(payload.measurements.td_attributes.slice(0, 2), 16) & 1) !== 0) {
      throw new Error('Signed appraiser TDX measurements rejected');
    }
    if (payload.verifiedAtMs > now + 5_000 || payload.verifiedAtMs < now - 60_000
      || payload.verifiedAtMs < startedAt - 5_000 || payload.expiresAtMs <= now
      || payload.expiresAtMs > payload.verifiedAtMs + 60_000
      || payload.verifiedAtMs < config.signerNotBeforeMs || payload.expiresAtMs > config.signerExpiresAtMs
      || payload.collateralExpiresAtMs <= now || payload.expiresAtMs > payload.collateralExpiresAtMs) {
      throw new Error('Signed appraiser result or collateral expired');
    }
    const attestationRef = `0x${createHash('sha256').update(domain).update(payloadBytes).update(signature).digest('hex')}`;
    return { verification: 'hardware_verified', attestationRef, challenge: payload.challenge,
      reportData: payload.reportData, verifiedAtMs: payload.verifiedAtMs, expiresAtMs: payload.expiresAtMs,
      owner: challenge.owner, agent: challenge.agent, applicationSchema: challenge.applicationSchema,
      operationId: challenge.operationId, checkpointId: challenge.checkpointId, runId: challenge.runId,
      hostId: challenge.hostId, audience: challenge.audience, teeMeasurement: challenge.teeMeasurement,
      policySha256: challenge.policySha256, recipientPublicKey: challenge.recipientPublicKey };
  };
}
