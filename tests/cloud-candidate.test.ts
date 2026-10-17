import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCloudCandidate, saveCloudCandidate, type CloudCandidateTransport } from '../src/providers/cloud-candidate.js';

const model = 'z-ai/glm-5.3-flash', apiKey = 'private-cloud-key-canary', spki = 'aa'.repeat(32);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true }))); vi.restoreAllMocks(); });

function transport(overrides?: { httpStatus?: number; mutate?: (report: Record<string, unknown>) => unknown; body?: Buffer }) {
  return vi.fn<CloudCandidateTransport>().mockImplementation(async url => {
    const nonce = url.searchParams.get('nonce');
    const compose = `services:\n  gateway:\n    image: nearaidev/cloud-api@sha256:${'bb'.repeat(32)}\n`;
    const info = { tcb_info: JSON.stringify({ app_compose: compose }) };
    const report: Record<string, unknown> = { gateway_attestation: { request_nonce: nonce, tls_cert_fingerprint: spki, info },
      model_attestations: [{ model_name: model, request_nonce: nonce, info }, { model_name: model, request_nonce: nonce, info }] };
    return { httpStatus: overrides?.httpStatus ?? 200, body: overrides?.body ?? Buffer.from(JSON.stringify(overrides?.mutate ? overrides.mutate(report) : report)),
      tlsSpkiSha256: spki, peerCertificatePem: 'PUBLIC CERTIFICATE METADATA CANARY' };
  });
}

describe('unapproved Cloud evidence capture', () => {
  it('requests gateway and model candidates exactly once at a fixed official URL without POST or approval', async () => {
    const request = transport(), capture = await captureCloudCandidate({ apiKey, model }, { request });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url.origin).toBe('https://cloud-api.near.ai'); expect(url.pathname).toBe('/v1/attestation/report');
    expect(url.searchParams.get('nonce')).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model, provider: 'near', signing_algo: 'ecdsa', include_tls_fingerprint: 'true' });
    expect(options.headers).toMatchObject({ authorization: `Bearer ${apiKey}`, 'x-no-aliasing': 'true', 'accept-encoding': 'identity' });
    expect(options.maximumBytes).toBe(16_777_216);
    expect(capture.summary).toMatchObject({ status: 'captured', reasonCode: 'CANDIDATE_CAPTURED', approval: 'UNAPPROVED', hardwareVerified: false,
      reportGets: 1, paidPosts: 0, inventory: { gatewayReports: 1, modelCandidates: 2, manifests: 3, immutableImageClaims: 1 } });
    expect(JSON.stringify(capture.summary)).not.toContain(apiKey);
    expect(JSON.stringify(capture.privateEvidence)).not.toContain(apiKey);
    expect(capture.privateEvidence?.manifests[0]?.imageClaims).toEqual([`nearaidev/cloud-api@sha256:${'bb'.repeat(32)}`]);
  });

  it('uses a fresh nonce on each separately requested capture', async () => {
    const request = transport();
    await captureCloudCandidate({ apiKey, model }, { request }); await captureCloudCandidate({ apiKey, model }, { request });
    expect(request.mock.calls[0]![0].searchParams.get('nonce')).not.toBe(request.mock.calls[1]![0].searchParams.get('nonce'));
  });

  it.each([[401, 'AUTH_REJECTED'], [403, 'AUTH_REJECTED'], [429, 'RATE_LIMITED'], [302, 'REDIRECT_REJECTED'], [500, 'HTTP_REJECTED']] as const)
    ('stops at HTTP%d with fixed-safe classification and no retry', async (httpStatus, reasonCode) => {
      const request = transport({ httpStatus, body: Buffer.from(apiKey) });
      const capture = await captureCloudCandidate({ apiKey, model }, { request });
      expect(request).toHaveBeenCalledOnce(); expect(capture.summary).toMatchObject({ status: 'rejected', reasonCode, httpStatus, reportGets: 1, paidPosts: 0 });
      expect(capture.privateEvidence).toBeUndefined(); expect(JSON.stringify(capture)).not.toContain(apiKey);
    });

  it('bounds even a trusted test transport response and keeps errors out of public output', async () => {
    const request = transport({ body: Buffer.alloc(16_777_217) });
    expect((await captureCloudCandidate({ apiKey, model }, { request })).summary).toMatchObject({ reasonCode: 'RESPONSE_LIMIT', paidPosts: 0 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('redacts arbitrary transport exceptions and does not retry', async () => {
    const request = vi.fn<CloudCandidateTransport>().mockRejectedValue(new Error(apiKey));
    const capture = await captureCloudCandidate({ apiKey, model }, { request });
    expect(capture.summary).toMatchObject({ reasonCode: 'TRANSPORT_ERROR', reportGets: 1 }); expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(capture)).not.toContain(apiKey);
  });

  it('rejects invalid configuration or an already cancelled capture before any GET', async () => {
    const request = transport();
    for (const config of [{ apiKey: 'bad\nkey', model }, { apiKey, model: 'https://evil.test?secret' }]) {
      expect((await captureCloudCandidate(config, { request })).summary).toMatchObject({ reasonCode: 'INVALID_CONFIGURATION', reportGets: 0 });
    }
    const controller = new AbortController(); controller.abort();
    expect((await captureCloudCandidate({ apiKey, model, signal: controller.signal }, { request })).summary).toMatchObject({ reasonCode: 'TIMEOUT', reportGets: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['gateway', (report: Record<string, unknown>) => ({ ...report, gateway_attestation: undefined }), 'MISSING_GATEWAY'],
    ['models', (report: Record<string, unknown>) => ({ ...report, model_attestations: [] }), 'MISSING_MODEL_CANDIDATES'],
    ['model', (report: Record<string, unknown>) => ({ ...report, model_attestations: [{ model_name: 'different' }] }), 'MODEL_MISMATCH'],
    ['nonce', (report: Record<string, unknown>) => ({ ...report, gateway_attestation: { request_nonce: 'bad' } }), 'NONCE_MISMATCH'],
    ['TLS', (report: Record<string, unknown>) => ({ ...report, gateway_attestation: { ...(report.gateway_attestation as object), tls_cert_fingerprint: 'bad' } }), 'TLS_MISMATCH'],
  ] as const)('labels %s mismatch as unusable and retains raw evidence only privately', async (_label, mutate, reasonCode) => {
    const request = transport({ mutate }); const capture = await captureCloudCandidate({ apiKey, model }, { request });
    expect(capture.summary).toMatchObject({ status: 'unusable', reasonCode, approval: 'UNAPPROVED', hardwareVerified: false });
    expect(capture.privateEvidence?.responseBody.length).toBeGreaterThan(0); expect(request).toHaveBeenCalledOnce();
  });

  it('preserves malformed response bytes privately without publishing the payload', async () => {
    const capture = await captureCloudCandidate({ apiKey, model }, { request: transport({ body: Buffer.from('raw-public-report-canary invalid JSON') }) });
    expect(capture.summary.reasonCode).toBe('INVALID_REPORT'); expect(capture.privateEvidence?.responseBody.toString()).toContain('raw-public-report-canary');
    expect(JSON.stringify(capture.summary)).not.toContain('raw-public-report-canary');
  });

  it('creates new private packet files without API-key headers and refuses overwrite', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'telomere-cloud-candidate-')); temporary.push(parent);
    const directory = join(parent, 'candidate'), capture = await captureCloudCandidate({ apiKey, model }, { request: transport() });
    await saveCloudCandidate(directory, capture);
    for (const name of ['summary.json', 'report-response.bin', 'connection-request.json', 'candidate-input.json', 'claimed-image-inventory.json']) {
      const bytes = await readFile(join(directory, name)); expect(bytes.toString()).not.toContain(apiKey);
      if (process.platform !== 'win32') expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    expect((await readFile(join(directory, 'report-response.bin'))).equals(capture.privateEvidence!.responseBody)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(saveCloudCandidate(directory, capture)).rejects.toThrow('CAPTURE_IO_ERROR');
  });
});
