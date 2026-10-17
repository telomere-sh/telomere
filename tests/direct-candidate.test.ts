import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDirectCandidate, saveDirectCandidate, type DirectCandidateTransport } from '../src/providers/direct-candidate.js';
import { runDirectEvidence } from '../scripts/near-direct-evidence.js';

const endpoint = 'https://glm-5-3-flash.completions.near.ai/v1';
const model = 'z-ai/glm-5.3-flash', spki = 'ab'.repeat(32), keyCanary = 'private-inference-key-canary';
const reportCanary = 'private-report-canary';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

function transport(options?: { status?: number; mutate?: (report: Record<string, unknown>) => unknown; body?: Buffer }) {
  return vi.fn<DirectCandidateTransport>().mockImplementation(async url => {
    const report: Record<string, unknown> = { model_name: model, signing_algo: 'ecdsa',
      request_nonce: url.searchParams.get('nonce'), tls_cert_fingerprint: spki,
      compose_manager_attestation: { actions: [] }, secret: reportCanary };
    return { httpStatus: options?.status ?? 200,
      body: options?.body ?? Buffer.from(JSON.stringify(options?.mutate ? options.mutate(report) : report)),
      tlsSpkiSha256: spki, peerCertificatePem: 'PUBLIC CERTIFICATE METADATA' };
  });
}

describe('unapproved direct NEAR report capture', () => {
  it('uses one fixed direct GET route and fresh ECDSA/TLS nonce without an API key or paid POST', async () => {
    const request = transport(), capture = await captureDirectCandidate({ endpoint, model }, { request });
    expect(request).toHaveBeenCalledOnce();
    const [url, config] = request.mock.calls[0]!;
    expect(url.origin).toBe('https://glm-5-3-flash.completions.near.ai');
    expect(url.pathname).toBe('/v1/attestation/report');
    expect(Object.fromEntries(url.searchParams)).toEqual({ nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
      signing_algo: 'ecdsa', include_tls_fingerprint: 'true' });
    expect(config.headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity' });
    expect(config.maximumBytes).toBe(8_388_608);
    expect(capture.summary).toMatchObject({ status: 'captured', reasonCode: 'CANDIDATE_CAPTURED', approval: 'UNAPPROVED',
      hardwareVerified: false, reportGets: 1, paidPosts: 0 });
    expect(capture.privateEvidence?.input).toMatchObject({ model, nonce: url.searchParams.get('nonce'), tlsSpkiSha256: spki });
    expect(JSON.stringify(capture.summary)).not.toContain(keyCanary);
    await captureDirectCandidate({ endpoint, model }, { request });
    expect(request.mock.calls[1]![0].searchParams.get('nonce')).not.toBe(url.searchParams.get('nonce'));
  });

  it.each(['https://cloud-api.near.ai/v1', 'http://glm-5-3-flash.completions.near.ai/v1',
    'https://glm-5-3-flash.completions.near.ai.attacker.test/v1',
    'https://glm-5-3-flash.completions.near.ai/v1?key=secret',
    'https://user:pass@glm-5-3-flash.completions.near.ai/v1',
    'https://other.completions.near.ai/v1'])('rejects other route %s before GET', async candidate => {
    const request = transport();
    expect((await captureDirectCandidate({ endpoint: candidate, model }, { request })).summary).toMatchObject({
      status: 'rejected', reasonCode: 'INVALID_CONFIGURATION', reportGets: 0, paidPosts: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects another model and a cancelled call before GET', async () => {
    const request = transport(), controller = new AbortController(); controller.abort();
    expect((await captureDirectCandidate({ endpoint, model: 'other/model' }, { request })).summary.reasonCode).toBe('INVALID_CONFIGURATION');
    expect((await captureDirectCandidate({ endpoint, model, signal: controller.signal }, { request })).summary.reasonCode).toBe('TIMEOUT');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['nonce', (report: Record<string, unknown>) => ({ ...report, request_nonce: 'bad' }), 'NONCE_MISMATCH'],
    ['TLS', (report: Record<string, unknown>) => ({ ...report, tls_cert_fingerprint: 'bad' }), 'TLS_MISMATCH'],
    ['model', (report: Record<string, unknown>) => ({ ...report, model_name: 'other' }), 'MODEL_MISMATCH'],
    ['algorithm', (report: Record<string, unknown>) => ({ ...report, signing_algo: 'rsa' }), 'SIGNING_ALGORITHM_REJECTED'],
  ] as const)('keeps %s mismatch private and labels it unusable', async (_label, mutate, reasonCode) => {
    const capture = await captureDirectCandidate({ endpoint, model }, { request: transport({ mutate }) });
    expect(capture.summary).toMatchObject({ status: 'unusable', reasonCode, hardwareVerified: false });
    expect(capture.privateEvidence?.responseBody.toString()).toContain(reportCanary);
    expect(JSON.stringify(capture.summary)).not.toContain(reportCanary);
  });

  it.each([[401, 'AUTH_REJECTED'], [403, 'AUTH_REJECTED'], [429, 'RATE_LIMITED'],
    [302, 'REDIRECT_REJECTED'], [500, 'HTTP_REJECTED']] as const)
    ('does not retry HTTP%d or publish its body', async (status, reasonCode) => {
      const request = transport({ status, body: Buffer.from(keyCanary) });
      const capture = await captureDirectCandidate({ endpoint, model }, { request });
      expect(request).toHaveBeenCalledOnce();
      expect(capture.summary).toMatchObject({ status: 'rejected', reasonCode, reportGets: 1, paidPosts: 0 });
      expect(capture.privateEvidence).toBeUndefined();
      expect(JSON.stringify(capture)).not.toContain(keyCanary);
    });

  it('redacts transport exceptions and never retries', async () => {
    const request = vi.fn<DirectCandidateTransport>().mockRejectedValue(new Error(keyCanary));
    const result = await captureDirectCandidate({ endpoint, model }, { request });
    expect(request).toHaveBeenCalledOnce();
    expect(result.summary.reasonCode).toBe('TRANSPORT_ERROR');
    expect(JSON.stringify(result)).not.toContain(keyCanary);
  });

  it('bounds the body and retains malformed bytes only in a private packet', async () => {
    const tooLarge = await captureDirectCandidate({ endpoint, model }, { request: transport({ body: Buffer.alloc(8_388_609) }) });
    expect(tooLarge.summary.reasonCode).toBe('RESPONSE_LIMIT');
    const invalid = await captureDirectCandidate({ endpoint, model }, { request: transport({ body: Buffer.from(keyCanary) }) });
    expect(invalid.summary.reasonCode).toBe('INVALID_REPORT');
    expect(invalid.privateEvidence?.responseBody.toString()).toBe(keyCanary);
    expect(JSON.stringify(invalid.summary)).not.toContain(keyCanary);
  });

  it('writes a new private four-file packet with no inference key and refuses overwrite', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'telomere-direct-candidate-')); temporary.push(parent);
    const directory = join(parent, 'candidate');
    const request = transport();
    const result = await runDirectEvidence(['--output', directory], {
      NEAR_ENDPOINT: endpoint, NEAR_MODEL: model, NEAR_ALLOWED_MODELS: model, NEAR_API_KEY: keyCanary }, request);
    expect(result.exitCode).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.summary)).not.toContain(keyCanary);
    for (const file of ['summary.json', 'report-response.bin', 'candidate-input.json', 'connection-request.json']) {
      const full = join(directory, file), bytes = await readFile(full);
      expect(bytes.toString()).not.toContain(keyCanary);
      if (process.platform !== 'win32') expect((await stat(full)).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(await readFile(join(directory, 'candidate-input.json'), 'utf8'));
    expect(saved).toMatchObject({ model, nonce: expect.stringMatching(/^[a-f0-9]{64}$/), tlsSpkiSha256: spki,
      attestation: { model_name: model } });
    await expect(saveDirectCandidate(directory, await captureDirectCandidate({ endpoint, model }, { request: transport() })))
      .rejects.toThrow('CAPTURE_IO_ERROR');
  });

  it('requires operator allowlist and absolute output without using the protected key', async () => {
    const request = transport();
    const result = await runDirectEvidence(['--output', 'relative/path'], {
      NEAR_ENDPOINT: endpoint, NEAR_MODEL: model, NEAR_ALLOWED_MODELS: model, NEAR_API_KEY: keyCanary }, request);
    expect(result).toMatchObject({ exitCode: 1, summary: { reasonCode: 'INVALID_CONFIGURATION_OR_OUTPUT', paidPosts: 0 } });
    expect(JSON.stringify(result)).not.toContain(keyCanary);
    expect(request).not.toHaveBeenCalled();
  });
});
