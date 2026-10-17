import https from 'node:https';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const cloudOrigin = 'https://cloud-api.near.ai';
const maximumBytes = 16_777_216;
const modelSchema = z.string().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/);
const keySchema = z.string().trim().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value));
const sha256 = (bytes: Buffer | string) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined; // REASON: shape is narrowed; every accessed field remains unknown.

export const cloudCandidateReasonCodes = ['CANDIDATE_CAPTURED', 'AUTH_REJECTED', 'RATE_LIMITED', 'HTTP_REJECTED', 'REDIRECT_REJECTED',
  'TRANSPORT_ERROR', 'TIMEOUT', 'RESPONSE_LIMIT', 'RESPONSE_ENCODING', 'INVALID_REPORT', 'MISSING_GATEWAY',
  'MISSING_MODEL_CANDIDATES', 'MODEL_MISMATCH', 'NONCE_MISMATCH', 'TLS_MISMATCH', 'INVALID_CONFIGURATION', 'CAPTURE_IO_ERROR'] as const;
export type CloudCandidateReason = typeof cloudCandidateReasonCodes[number];
class CandidateError extends Error { constructor(readonly reason: CloudCandidateReason, readonly httpStatus?: number) { super(reason); } }

export type CloudCandidateWire = { httpStatus: number; body: Buffer; tlsSpkiSha256: string; peerCertificatePem: string };
/** Trusted test seam; the CLI never accepts an endpoint, transport, certificate or nonce override. */
export type CloudCandidateTransport = (url: URL, options: { headers: Record<string, string>; signal: AbortSignal; maximumBytes: number }) => Promise<CloudCandidateWire>;
export type CloudCandidateSummary = {
  schemaVersion: 1; status: 'captured' | 'unusable' | 'rejected'; reasonCode: CloudCandidateReason;
  checkedAt: string; endpoint: typeof cloudOrigin; model: string; approval: 'UNAPPROVED'; hardwareVerified: false;
  reportGets: number; paidPosts: 0; httpStatus?: number;
  response?: { sha256: string; bytes: number };
  inventory: { gatewayReports: number; modelCandidates: number; manifests: number; immutableImageClaims: number };
  pendingChecks: readonly string[];
};
type ManifestInventory = { role: 'gateway' | 'model'; candidateIndex: number; manifestSha256: string; manifestBytes: number; imageClaims: string[] };
export type CloudCandidateCapture = { summary: CloudCandidateSummary; privateEvidence?: { nonce: string; requestUrl: string;
  requestHeaders: { accept: string; acceptEncoding: string; noAliasing: string }; tlsSpkiSha256: string; peerCertificatePem: string;
  responseBody: Buffer; input: { attestation: unknown; model: string; nonce: string; tlsSpkiSha256: string }; manifests: ManifestInventory[] } };

const pendingChecks = ['Intel quote/collateral, accepted TCB/advisories and debug rejection',
  'Verified quote nonce/signer binding and RTMR3 event-log replay', 'Raw app-compose hash versus verified MRCONFIGID',
  'NVIDIA evidence for every model candidate', 'Gateway TLS SPKI binding on the captured connection',
  'Cryptographic image provenance, subject digests, publisher/build/source identities',
  'Independent measured-workload review and separately approved bounded Cloud policy',
  'Fresh live admission and one separately authorized bounded completion/signature acceptance',
  'Shared model-key and incomplete model/Gateway/response binding limitations'] as const;

/** Exactly one HTTPS GET. Node retains normal CA and hostname verification; redirects and encoding changes are rejected. */
const requestReport: CloudCandidateTransport = async (url, options) => {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  try {
    return await new Promise<CloudCandidateWire>((accept, reject) => {
      const request = https.request(url, { method: 'GET', headers: options.headers, agent, signal: options.signal, rejectUnauthorized: true }, response => {
        const httpStatus = response.statusCode ?? 0;
        if (httpStatus !== 200) {
          response.destroy();
          reject(new CandidateError(httpStatus === 401 || httpStatus === 403 ? 'AUTH_REJECTED' : httpStatus === 429 ? 'RATE_LIMITED'
            : httpStatus >= 300 && httpStatus < 400 ? 'REDIRECT_REJECTED' : 'HTTP_REJECTED', httpStatus)); return;
        }
        const declared = response.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > options.maximumBytes)) {
          response.destroy(); reject(new CandidateError('RESPONSE_LIMIT')); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new CandidateError('RESPONSE_ENCODING')); return;
        }
        let tlsSpkiSha256: string, peerCertificatePem: string;
        try {
          // This is the certificate from the same socket that delivered the report response.
          const certificate = new X509Certificate((response.socket as TLSSocket).getPeerCertificate().raw);
          tlsSpkiSha256 = sha256(certificate.publicKey.export({ format: 'der', type: 'spki' })).slice(2);
          peerCertificatePem = certificate.toString();
        } catch { response.destroy(); reject(new CandidateError('TRANSPORT_ERROR')); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maximumBytes) { response.destroy(); reject(new CandidateError('RESPONSE_LIMIT')); }
          else chunks.push(Buffer.from(chunk));
        });
        response.on('aborted', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
        response.on('error', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
        response.on('end', () => accept({ httpStatus, body: Buffer.concat(chunks), tlsSpkiSha256, peerCertificatePem }));
      });
      request.on('error', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
      request.end();
    });
  } finally { agent.destroy(); }
};

function manifestInventory(report: unknown, role: ManifestInventory['role'], candidateIndex: number): ManifestInventory | undefined {
  const info = record(record(report)?.info);
  let tcb: unknown = info?.tcb_info;
  if (typeof tcb === 'string') { try { tcb = JSON.parse(tcb); } catch { return undefined; } }
  const compose = record(tcb)?.app_compose;
  if (typeof compose !== 'string' || Buffer.byteLength(compose) > 1_048_576) return undefined;
  // Claimed digest references are discovery metadata only, not authenticated/provenance-verified image identities.
  const imageClaims = [...new Set([...compose.matchAll(/(?:^|[\s"'])(([a-zA-Z0-9._:/-]{1,512})@sha256:[a-f0-9]{64})(?=$|[\s"'])/g)].map(match => match[1]!))].slice(0, 256);
  return { role, candidateIndex, manifestSha256: sha256(compose), manifestBytes: Buffer.byteLength(compose), imageClaims };
}

/** Candidate discovery only: neither returned HTTP fields nor their hashes constitute verified hardware/policy admission. */
export async function captureCloudCandidate(options: { apiKey: string; model: string; signal?: AbortSignal },
  dependencies?: { request: CloudCandidateTransport }): Promise<CloudCandidateCapture> {
  let model = 'invalid', reportGets = 0;
  const base = (status: CloudCandidateSummary['status'], reasonCode: CloudCandidateReason): CloudCandidateSummary => ({ schemaVersion: 1,
    status, reasonCode, checkedAt: new Date().toISOString(), endpoint: cloudOrigin, model, approval: 'UNAPPROVED', hardwareVerified: false,
    reportGets, paidPosts: 0, inventory: { gatewayReports: 0, modelCandidates: 0, manifests: 0, immutableImageClaims: 0 }, pendingChecks });
  const parsedModel = modelSchema.safeParse(options.model), parsedKey = keySchema.safeParse(options.apiKey);
  if (!parsedModel.success || !parsedKey.success) return { summary: base('rejected', 'INVALID_CONFIGURATION') };
  model = parsedModel.data;
  const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { summary: base('rejected', 'TIMEOUT') };
  const nonce = randomBytes(32).toString('hex'), url = new URL('/v1/attestation/report', cloudOrigin);
  for (const [name, value] of Object.entries({ model, provider: 'near', nonce, signing_algo: 'ecdsa', include_tls_fingerprint: 'true' })) url.searchParams.set(name, value);
  try {
    reportGets = 1;
    const wire = await (dependencies?.request ?? requestReport)(url, { signal, maximumBytes,
      headers: { accept: 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', authorization: `Bearer ${parsedKey.data}` } });
    if (signal.aborted) throw new CandidateError('TIMEOUT');
    if (wire.httpStatus !== 200) return { summary: { ...base('rejected', wire.httpStatus === 401 || wire.httpStatus === 403 ? 'AUTH_REJECTED'
      : wire.httpStatus === 429 ? 'RATE_LIMITED' : wire.httpStatus >= 300 && wire.httpStatus < 400 ? 'REDIRECT_REJECTED' : 'HTTP_REJECTED'), httpStatus: wire.httpStatus } };
    if (wire.body.length > maximumBytes) throw new CandidateError('RESPONSE_LIMIT');
    let report: unknown;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire.body)); }
    catch { report = null; } // Preserve exact unusable response bytes privately for review; no parser diagnostics enter output.
    const root = record(report), gateway = record(root?.gateway_attestation), candidates = Array.isArray(root?.model_attestations) ? root.model_attestations : [];
    const manifests = [manifestInventory(gateway, 'gateway', 0), ...candidates.slice(0, 64).map((candidate, index) => manifestInventory(candidate, 'model', index))]
      .filter((item): item is ManifestInventory => item !== undefined);
    const reasonCode: CloudCandidateReason = !root ? 'INVALID_REPORT' : !gateway ? 'MISSING_GATEWAY'
      : !candidates.length || candidates.length > 64 || candidates.some(candidate => !record(candidate)) ? 'MISSING_MODEL_CANDIDATES'
      : candidates.some(candidate => record(candidate)?.model_name !== model) ? 'MODEL_MISMATCH'
      : gateway.request_nonce !== nonce || candidates.some(candidate => record(candidate)?.request_nonce !== nonce) ? 'NONCE_MISMATCH'
      : typeof gateway.tls_cert_fingerprint !== 'string' || gateway.tls_cert_fingerprint.replace(/^0x/, '').toLowerCase() !== wire.tlsSpkiSha256 ? 'TLS_MISMATCH'
      : 'CANDIDATE_CAPTURED';
    return { summary: { ...base(reasonCode === 'CANDIDATE_CAPTURED' ? 'captured' : 'unusable', reasonCode), httpStatus: 200,
      response: { sha256: sha256(wire.body), bytes: wire.body.length },
      inventory: { gatewayReports: gateway ? 1 : 0, modelCandidates: candidates.length, manifests: manifests.length,
        immutableImageClaims: [...new Set(manifests.flatMap(item => item.imageClaims))].length } },
      privateEvidence: { nonce, requestUrl: url.href, requestHeaders: { accept: 'application/json', acceptEncoding: 'identity', noAliasing: 'true' },
        tlsSpkiSha256: wire.tlsSpkiSha256, peerCertificatePem: wire.peerCertificatePem, responseBody: wire.body,
        input: { attestation: report, model, nonce, tlsSpkiSha256: wire.tlsSpkiSha256 }, manifests } };
  } catch (error) { return { summary: { ...base('rejected', error instanceof CandidateError ? error.reason : signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR'),
    ...(error instanceof CandidateError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } }; }
}

/** The directory must be new; captured raw reports never enter public output or source control. */
export async function saveCloudCandidate(directory: string, capture: CloudCandidateCapture): Promise<void> {
  if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new CandidateError('CAPTURE_IO_ERROR');
  try {
    await mkdir(directory, { mode: 0o700 });
    const save = async (name: string, bytes: string | Buffer) => {
      const file = await open(join(directory, name), 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    };
    if (capture.privateEvidence) {
      const { responseBody, input, manifests, ...metadata } = capture.privateEvidence;
      await save('report-response.bin', responseBody);
      await save('connection-request.json', JSON.stringify({ approval: 'UNAPPROVED', hardwareVerified: false, ...metadata }, null, 2) + '\n');
      await save('candidate-input.json', JSON.stringify(input) + '\n');
      await save('claimed-image-inventory.json', JSON.stringify({ approval: 'UNAPPROVED', hardwareVerified: false, manifests }, null, 2) + '\n');
    }
    // A partial/interrupted raw capture must not carry a completed summary marker.
    await save('summary.json', JSON.stringify(capture.summary, null, 2) + '\n');
  } catch { throw new CandidateError('CAPTURE_IO_ERROR'); }
}
