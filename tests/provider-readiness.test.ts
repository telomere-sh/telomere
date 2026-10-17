import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createNearProvider, createVerifiedNearProvider, getNearProviderReadiness,
  type VerifiedNearProviderOptions, type NearProvider } from '../src/providers/index.js';
import { checkVerifiedNearReadiness, type VerifiedNearReadinessOptions } from '../src/providers/verified/readiness.js';
import type { NearAttestationVerifier, NearVerifiedFetch } from '../src/providers/verified/inference.js';

const model = 'operator/model', apiKey = 'private-key-readiness-canary';
const temporary: string[] = [];
const digest = (value: string) => `0x${createHash('sha256').update(value).digest('hex')}`;
const measurementSizes = { tee_tcb_svn: 16, mr_seam: 48, mr_signer_seam: 48, seam_attributes: 8, td_attributes: 8, xfam: 8,
  mr_td: 48, mr_config_id: 48, mr_owner: 48, mr_owner_config: 48, rt_mr0: 48, rt_mr1: 48, rt_mr2: 48, rt_mr3: 48 };
const measurements = Object.fromEntries(Object.entries(measurementSizes).map(([name, bytes]) => [name, '01'.repeat(bytes)]));
const profile = { model, appComposeSha256: '02'.repeat(32), composeManagerActionsSha256: '03'.repeat(32),
  composeManagerImage: `nearaidev/compose-manager@sha256:${'04'.repeat(32)}`, measurements, gpuCount: 1, gpuModels: ['NVIDIA H100'] };
const gatewayProfiles = [{ appComposeSha256: '05'.repeat(32), measurements }];
const nvidiaLocalPolicy = { mode: 'local', sdkVersion: '1.2.2',
  binarySha256: 'ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6',
  librarySha256: '088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24' };

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(overrides: Record<string, unknown> = {}): Promise<VerifiedNearProviderOptions> {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-near-readiness-')); temporary.push(directory);
  const policyPath = join(directory, 'policy.json'), verifierPath = join(directory, 'verify.py');
  const bytes = JSON.stringify({ schemaVersion: 1, version: 'reviewed-readiness-fixture-v1',
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(),
    maxSessionSeconds: 120, profiles: [profile], gatewayProfiles, ...overrides });
  await Promise.all([writeFile(policyPath, bytes), writeFile(verifierPath, '# metadata fixture; never executed\n'),
    writeFile(join(directory, 'verifier.py'), '# metadata fixture; never executed\n')]);
  return { endpoint: 'https://cloud-api.near.ai/v1', model, apiKey, policyPath, verifierPath,
    policySha256: digest(bytes), pythonPath: process.execPath };
}

function optionsForProbe(options: VerifiedNearProviderOptions): VerifiedNearReadinessOptions {
  return { model: options.model, pythonPath: options.pythonPath, policyPath: options.policyPath,
    policySha256: options.policySha256, verifierPath: options.verifierPath!, cloud: true,
    ...(options.nvidiaLocal ? { nvidiaLocal: options.nvidiaLocal } : {}) };
}

describe('NEAR public local readiness', () => {
  it('reports disabled when no provider is configured', async () => {
    expect(await getNearProviderReadiness()).toMatchObject({ state: 'disabled', reasonCode: 'NOT_CONFIGURED',
      verification: null, liveAttestationChecked: false, scope: 'local_configuration' });
  });

  it('makes the plain TLS boundary explicit and performs no request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await getNearProviderReadiness(createNearProvider({ endpoint: 'https://cloud-api.near.ai/v1', model, apiKey, fetch }));
    expect(result).toMatchObject({ state: 'ready', reasonCode: 'TLS_ONLY', verification: 'provider_tls', liveAttestationChecked: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not claim a synthetic/legacy provider supports readiness', async () => {
    const complete = vi.fn<NearProvider['complete']>();
    expect(await getNearProviderReadiness({ complete })).toMatchObject({ state: 'unavailable', reasonCode: 'READINESS_UNSUPPORTED' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('redacts arbitrary readiness errors', async () => {
    const complete = vi.fn<NearProvider['complete']>();
    const result = await getNearProviderReadiness({ complete, readiness: async () => { throw new Error(apiKey); } });
    expect(result).toMatchObject({ state: 'unavailable', reasonCode: 'READINESS_CHECK_FAILED', verification: null });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('checks exact policy, full local shape and artifact metadata without attestation, GET or POST', async () => {
    const options = await fixture(), verifyAttestation = vi.fn<NearAttestationVerifier>(), fetch = vi.spyOn(globalThis, 'fetch');
    const result = await getNearProviderReadiness(createVerifiedNearProvider(options, { verifyAttestation }));
    expect(result).toMatchObject({ state: 'ready', reasonCode: 'CONFIGURATION_READY', verification: 'enclave_verified',
      scope: 'local_configuration', liveAttestationChecked: false });
    expect(Date.parse(result.checkedAt)).toBeLessThanOrEqual(Date.now());
    expect(result.policyExpiresAt).toBe(JSON.parse(await readFile(options.policyPath, 'utf8')).validUntil);
    expect(Object.keys(result).sort()).toEqual(['checkedAt', 'liveAttestationChecked', 'policyExpiresAt', 'reasonCode', 'scope', 'state', 'verification']);
    expect(verifyAttestation).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { validUntil: new Date(Date.now() - 1_000).toISOString() }, 'POLICY_EXPIRED'],
    ['candidate', { version: 'candidate-new-profile' }, 'POLICY_NOT_REVIEWED'],
    ['development', { version: 'development.sample' }, 'POLICY_NOT_REVIEWED'],
  ] as const)('rejects %s policy with no report GET or paid POST', async (_label, overrides, reasonCode) => {
    const options = await fixture(overrides), verifyAttestation = vi.fn<NearAttestationVerifier>(), fetch = vi.fn<NearVerifiedFetch>();
    const provider = createVerifiedNearProvider(options, { verifyAttestation });
    expect(await provider.readiness()).toMatchObject({ state: 'unavailable', reasonCode });
    await expect(provider.verifyAttestation(new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
    await expect(provider.complete({ prompt: 'private prompt', maxTokens: 16, runId: 'readiness-test' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
    expect(verifyAttestation).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('detects exact-byte change after configuration and never performs provider admission', async () => {
    const options = await fixture(), verifyAttestation = vi.fn<NearAttestationVerifier>(), provider = createVerifiedNearProvider(options, { verifyAttestation });
    await writeFile(options.policyPath, (await readFile(options.policyPath, 'utf8')) + '\n');
    expect(await provider.readiness()).toMatchObject({ state: 'unavailable', reasonCode: 'POLICY_CHANGED' });
    await expect(provider.verifyAttestation(new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it('rechecks expiry for each probe without trusting a previous ready state', async () => {
    const options = await fixture(), provider = createVerifiedNearProvider(options);
    expect((await provider.readiness()).state).toBe('ready');
    const future = new Date(Date.now() + 300_001); vi.spyOn(Date, 'now').mockReturnValue(future.valueOf());
    expect(await provider.readiness()).toMatchObject({ state: 'unavailable', reasonCode: 'POLICY_EXPIRED' });
  });

  it.each([
    [{ profiles: [{ ...profile, model: 'different/model' }] }, 'MODEL_NOT_APPROVED'],
    [{ validFrom: new Date(Date.now() + 60_000).toISOString() }, 'POLICY_NOT_YET_VALID'],
    [{ validFrom: new Date(Date.now() + 600_000).toISOString() }, 'POLICY_INVALID'],
    [{ profiles: [{ model }] }, 'POLICY_INVALID'],
    [{ gatewayProfiles: undefined }, 'GATEWAY_POLICY_MISSING'],
    [{ profiles: [{ ...profile, measurements: { ...measurements, unreviewed_field: '00' } }] }, 'POLICY_INVALID'],
    [{ nvidiaVerifier: nvidiaLocalPolicy }, 'NVIDIA_VERIFIER_MISMATCH'],
    [{ nvidiaVerifier: { ...nvidiaLocalPolicy, sdkVersion: '999' } }, 'POLICY_INVALID'],
  ] as const)('returns safe local rejection for invalid/mismatched policy %j', async (overrides, reasonCode) => {
    const options = await fixture(overrides);
    expect(await checkVerifiedNearReadiness(optionsForProbe(options))).toMatchObject({ state: 'unavailable', reasonCode });
  });

  it('does not require a Gateway policy for a direct endpoint', async () => {
    const options = await fixture({ gatewayProfiles: undefined });
    expect(await checkVerifiedNearReadiness({ ...optionsForProbe(options), cloud: false })).toMatchObject({ state: 'ready' });
  });

  it.each(['policy', 'runtime', 'verifier', 'helper'] as const)('detects a missing %s file without returning paths', async kind => {
    const options = await fixture(), probe = optionsForProbe(options);
    if (kind === 'policy') await rm(options.policyPath);
    else if (kind === 'runtime') probe.pythonPath = join(dirname(options.policyPath), 'missing-private-runtime-canary');
    else await rm(kind === 'verifier' ? probe.verifierPath : join(dirname(probe.verifierPath), 'verifier.py'));
    const reasonCode = kind === 'policy' ? 'POLICY_UNAVAILABLE' : kind === 'runtime' ? 'RUNTIME_UNAVAILABLE' : 'VERIFIER_UNAVAILABLE';
    const result = await checkVerifiedNearReadiness(probe);
    expect(result).toMatchObject({ state: 'unavailable', reasonCode }); expect(JSON.stringify(result)).not.toContain(dirname(options.policyPath));
  });

  it('bounds policy size before reading or parsing it', async () => {
    const options = await fixture(); await writeFile(options.policyPath, 'x'.repeat(1_048_577));
    expect(await checkVerifiedNearReadiness(optionsForProbe(options))).toMatchObject({ state: 'unavailable', reasonCode: 'POLICY_TOO_LARGE' });
  });

  it('requires local native metadata and loader soname, leaving actual hashes to the live verifier', async () => {
    const options = await fixture({ nvidiaVerifier: nvidiaLocalPolicy }), directory = dirname(options.policyPath);
    const binaryPath = join(directory, 'nvat'), libraryPath = join(directory, 'libnvat.so');
    await Promise.all([writeFile(binaryPath, 'native-fixture'), writeFile(libraryPath, 'library-fixture')]); await chmod(binaryPath, 0o755);
    const probe = { ...optionsForProbe(options), nvidiaLocal: { binaryPath, libraryPath } };
    expect(await checkVerifiedNearReadiness(probe)).toMatchObject({ state: 'unavailable', reasonCode: 'NVIDIA_ARTIFACTS_UNAVAILABLE' });
    await writeFile(join(directory, 'libnvat.so.1'), 'soname-fixture');
    expect(await checkVerifiedNearReadiness(probe)).toMatchObject(process.platform === 'linux' && process.arch === 'x64'
      ? { state: 'ready', reasonCode: 'CONFIGURATION_READY', liveAttestationChecked: false }
      : { state: 'unavailable', reasonCode: 'NVIDIA_RUNTIME_UNSUPPORTED', liveAttestationChecked: false });
  });
});
