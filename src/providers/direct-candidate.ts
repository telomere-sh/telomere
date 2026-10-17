import https from 'node:https';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { approvedNearEndpoint } from './near.js';

const directOrigin = 'https://glm-5-3-flash.completions.near.ai';
const directModel = 'z-ai/glm-5.3-flash';
const maximumBytes = 8_388_608;
const digest = (value: Buffer | string) => `0x${createHash('sha256').update(value).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

export const directCandidateReasons = ['CANDIDATE_CAPTURED', 'INVALID_CONFIGURATION', 'AUTH_REJECTED', 'RATE_LIMITED',
  'HTTP_REJECTED', 'REDIRECT_REJECTED', 'RESPONSE_LIMIT', 'RESPONSE_ENCODING', 'TRANSPORT_ERROR', 'TIMEOUT',
  'INVALID_REPORT', 'MODEL_MISMATCH', 'NONCE_MISMATCH', 'TLS_MISMATCH', 'SIGNING_ALGORITHM_REJECTED', 'CAPTURE_IO_ERROR'] as const;
export type DirectCandidateReason = typeof directCandidateReasons[number];
class CandidateError extends Error {
  constructor(readonly reason: DirectCandidateReason, readonly httpStatus?: number) { super(reason); }
}

export type DirectCandidateWire = { httpStatus: number; body: Buffer; tlsSpkiSha256: string; peerCertificatePem: string };
export type DirectCandidateTransport = (url: URL, options: { headers: Record<string, string>; signal: AbortSignal;
  maximumBytes: number }) => Promise<DirectCandidateWire>;
export type DirectCandidateSummary = {
  schemaVersion: 1; status: 'captured' | 'unusable' | 'rejected'; reasonCode: DirectCandidateReason;
  checkedAt: string; endpoint: typeof directOrigin; model: string; approval: 'UNAPPROVED'; hardwareVerified: false;
  reportGets: number; paidPosts: 0; httpStatus?: number; response?: { sha256: string; bytes: number };
};
export type DirectCandidateCapture = {
  summary: DirectCandidateSummary;
  privateEvidence?: { responseBody: Buffer; input: { attestation: unknown; nonce: string; tlsSpkiSha256: string; model: string };
    nonce: string; requestUrl: string; requestHeaders: { accept: 'application/json'; acceptEncoding: 'identity' };
    tlsSpkiSha256: string; peerCertificatePem: string };
};

/** Exactly one GET on the direct origin. Node's default CA and hostname checks remain enabled. */
const requestReport: DirectCandidateTransport = async (url, options) => {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  try {
    return await new Promise<DirectCandidateWire>((resolve, reject) => {
      const request = https.request(url, { method: 'GET', headers: options.headers, agent, signal: options.signal,
        rejectUnauthorized: true }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.destroy();
          reject(new CandidateError(status === 401 || status === 403 ? 'AUTH_REJECTED' : status === 429 ? 'RATE_LIMITED'
            : status >= 300 && status < 400 ? 'REDIRECT_REJECTED' : 'HTTP_REJECTED', status)); return;
        }
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > options.maximumBytes)) {
          response.destroy(); reject(new CandidateError('RESPONSE_LIMIT')); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new CandidateError('RESPONSE_ENCODING')); return;
        }
        let tlsSpkiSha256: string, peerCertificatePem: string;
        try {
          // Capture the certificate on the socket that returned this report.
          const certificate = new X509Certificate((response.socket as TLSSocket).getPeerCertificate().raw);
          tlsSpkiSha256 = digest(certificate.publicKey.export({ format: 'der', type: 'spki' })).slice(2);
          peerCertificatePem = certificate.toString();
        } catch { response.destroy(); reject(new CandidateError('TRANSPORT_ERROR')); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maximumBytes) { response.destroy(); reject(new CandidateError('RESPONSE_LIMIT')); }
          else chunks.push(Buffer.from(chunk));
        });
        response.on('aborted', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
        response.on('error', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
        response.on('end', () => resolve({ httpStatus: status, body: Buffer.concat(chunks), tlsSpkiSha256, peerCertificatePem }));
      });
      request.on('error', () => reject(new CandidateError(options.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
      request.end();
    });
  } finally { agent.destroy(); }
};

/** Discovery only: a captured report is never a verified or approved workload. */
export async function captureDirectCandidate(options: { endpoint: string; model: string; signal?: AbortSignal },
  dependencies?: { request: DirectCandidateTransport }): Promise<DirectCandidateCapture> {
  let reportGets = 0;
  const base = (status: DirectCandidateSummary['status'], reasonCode: DirectCandidateReason): DirectCandidateSummary => ({
    schemaVersion: 1, status, reasonCode, checkedAt: new Date().toISOString(), endpoint: directOrigin,
    model: directModel, approval: 'UNAPPROVED', hardwareVerified: false, reportGets, paidPosts: 0,
  });
  let completion: URL;
  try { completion = approvedNearEndpoint(options.endpoint); }
  catch { return { summary: base('rejected', 'INVALID_CONFIGURATION') }; }
  if (completion.href !== `${directOrigin}/v1/chat/completions` || options.model !== directModel) {
    return { summary: base('rejected', 'INVALID_CONFIGURATION') };
  }
  const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { summary: base('rejected', 'TIMEOUT') };
  const nonce = randomBytes(32).toString('hex'), url = new URL('/v1/attestation/report', directOrigin);
  for (const [name, value] of Object.entries({ nonce, signing_algo: 'ecdsa', include_tls_fingerprint: 'true' })) {
    url.searchParams.set(name, value);
  }
  try {
    reportGets = 1;
    const wire = await (dependencies?.request ?? requestReport)(url, { signal, maximumBytes,
      headers: { accept: 'application/json', 'accept-encoding': 'identity' } });
    if (signal.aborted) throw new CandidateError('TIMEOUT');
    if (wire.httpStatus !== 200) return { summary: { ...base('rejected', wire.httpStatus === 401 || wire.httpStatus === 403
      ? 'AUTH_REJECTED' : wire.httpStatus === 429 ? 'RATE_LIMITED' : wire.httpStatus >= 300 && wire.httpStatus < 400
        ? 'REDIRECT_REJECTED' : 'HTTP_REJECTED'), httpStatus: wire.httpStatus } };
    if (wire.body.length > maximumBytes) throw new CandidateError('RESPONSE_LIMIT');
    let report: unknown;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire.body)); }
    catch { report = null; }
    const candidate = record(report);
    const reasonCode: DirectCandidateReason = !candidate ? 'INVALID_REPORT'
      : candidate.model_name !== directModel ? 'MODEL_MISMATCH'
      : candidate.request_nonce !== nonce ? 'NONCE_MISMATCH'
      : typeof candidate.tls_cert_fingerprint !== 'string'
        || candidate.tls_cert_fingerprint.replace(/^0x/, '').toLowerCase() !== wire.tlsSpkiSha256.toLowerCase() ? 'TLS_MISMATCH'
      : candidate.signing_algo !== 'ecdsa' ? 'SIGNING_ALGORITHM_REJECTED' : 'CANDIDATE_CAPTURED';
    return { summary: { ...base(reasonCode === 'CANDIDATE_CAPTURED' ? 'captured' : 'unusable', reasonCode),
      httpStatus: 200, response: { sha256: digest(wire.body), bytes: wire.body.length } },
      privateEvidence: { responseBody: wire.body, input: { attestation: report, nonce, tlsSpkiSha256: wire.tlsSpkiSha256,
        model: directModel }, nonce, requestUrl: url.href,
        requestHeaders: { accept: 'application/json', acceptEncoding: 'identity' },
        tlsSpkiSha256: wire.tlsSpkiSha256, peerCertificatePem: wire.peerCertificatePem } };
  } catch (error) {
    return { summary: { ...base('rejected', error instanceof CandidateError ? error.reason : signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR'),
      ...(error instanceof CandidateError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } };
  }
}

/** The caller supplies a new absolute private directory; a summary is written last. */
export async function saveDirectCandidate(directory: string, capture: DirectCandidateCapture): Promise<void> {
  if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new CandidateError('CAPTURE_IO_ERROR');
  try {
    await mkdir(directory, { mode: 0o700 });
    const save = async (name: string, bytes: Buffer | string) => {
      const file = await open(join(directory, name), 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    };
    if (capture.privateEvidence) {
      const { responseBody, input, ...metadata } = capture.privateEvidence;
      await save('report-response.bin', responseBody);
      await save('candidate-input.json', JSON.stringify(input) + '\n');
      await save('connection-request.json', JSON.stringify({ approval: 'UNAPPROVED', hardwareVerified: false,
        ...metadata }, null, 2) + '\n');
    }
    await save('summary.json', JSON.stringify(capture.summary, null, 2) + '\n');
  } catch { throw new CandidateError('CAPTURE_IO_ERROR'); }
}
