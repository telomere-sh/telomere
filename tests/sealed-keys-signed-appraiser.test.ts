import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealedCellReportData, releaseCystKeyToSealedCell,
  type SealedCellChallenge, type SealedCystKeyRequest } from '../src/sealed-keys/release.js';
import { createSignedCellAppraiserVerifier, sealedCellMeasurementDigest,
  type SealedCellMeasurementProfile, type SignedCellAppraisal } from '../src/sealed-keys/signed-appraiser.js';

const domain = Buffer.from('telomere.sealed-cell.signed-appraisal.v1\0', 'utf8');
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const measurements: SealedCellMeasurementProfile = {
  tee_tcb_svn: '01'.repeat(16), mr_seam: '02'.repeat(48), mr_signer_seam: '03'.repeat(48),
  seam_attributes: '04'.repeat(8), td_attributes: '00'.repeat(8), xfam: '05'.repeat(8),
  mr_td: '06'.repeat(48), mr_config_id: '07'.repeat(48), mr_owner: '08'.repeat(48),
  mr_owner_config: '09'.repeat(48), rt_mr0: '0a'.repeat(48), rt_mr1: '0b'.repeat(48),
  rt_mr2: '0c'.repeat(48), rt_mr3: '0d'.repeat(48),
};
const policySha256 = `0x${'aa'.repeat(32)}`;
const request: SealedCystKeyRequest = {
  owner: `0x${'11'.repeat(20)}`, agent: `0x${'22'.repeat(20)}`, applicationSchema: 'demo/v1',
  operationId: `cyst-hook-${'33'.repeat(32)}`, checkpointId: `0x${'44'.repeat(32)}`,
  runId: `0x${'55'.repeat(32)}`, hostId: `0x${'66'.repeat(32)}`,
  audience: 'telomere.cell/v1', teeMeasurement: sealedCellMeasurementDigest(measurements),
  policySha256, recipientPublicKey: '77'.repeat(32),
};
const challenge: SealedCellChallenge = Object.freeze({ ...request, challenge: `0x${'88'.repeat(32)}`,
  reportData: sealedCellReportData({ ...request, challenge: `0x${'88'.repeat(32)}` }) });
const quoteFixture = new Uint8Array(1_200).fill(0x42); // Not a TDX quote; only exercises the signed transport.

function config() {
  const now = Date.now();
  return { endpoint: 'https://operator-verifier.example/verify-cell', verifierPublicKeyPem: publicKeyPem,
    signerNotBeforeMs: now - 60_000, signerExpiresAtMs: now + 600_000,
    policySha256, approvedMeasurements: measurements, timeoutMs: 5_000 };
}

function appraisal(change: Partial<SignedCellAppraisal> = {}): SignedCellAppraisal {
  const now = Date.now();
  return { version: 1, verification: 'hardware_verified',
    evidenceSha256: `0x${createHash('sha256').update(quoteFixture).digest('hex')}`,
    challenge: challenge.challenge, reportData: challenge.reportData, runId: challenge.runId,
    recipientPublicKey: challenge.recipientPublicKey, teeMeasurement: challenge.teeMeasurement,
    policySha256, verifiedAtMs: now, expiresAtMs: now + 30_000,
    collateralExpiresAtMs: now + 120_000, quoteStatus: 'UpToDate', qeStatus: 'UpToDate',
    platformStatus: 'UpToDate', advisories: [], measurements, ...change };
}

function signedResponse(payload: SignedCellAppraisal, options: { wrongSigner?: boolean; malformedPayload?: string;
  tamperSignature?: boolean; duplicateEnvelope?: boolean } = {}): Response {
  const payloadBytes = Buffer.from(options.malformedPayload ?? JSON.stringify(payload), 'utf8');
  const signingKey = options.wrongSigner ? generateKeyPairSync('ed25519').privateKey : keys.privateKey;
  const signature = sign(null, Buffer.concat([domain, payloadBytes]), signingKey);
  if (options.tamperSignature) signature[0] = signature[0]! ^ 1;
  const envelope = { payloadB64: payloadBytes.toString('base64'), signatureB64: signature.toString('base64') };
  const body = options.duplicateEnvelope
    ? `{"payloadB64":"bad","payloadB64":"${envelope.payloadB64}","signatureB64":"${envelope.signatureB64}"}`
    : JSON.stringify(envelope);
  return new Response(body, { status: 200 });
}

function serve(payload = appraisal(), options: Parameters<typeof signedResponse>[1] = {}) {
  const fetchMock = vi.fn(async () => signedResponse(payload, options));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('operator-pinned signed Cell appraiser transport (fixture signatures, not hardware proof)', () => {
  it('sends only bounded raw quote evidence and returns a verdict bound to the exact challenge', async () => {
    const fetched = serve();
    const verify = createSignedCellAppraiserVerifier(config());
    const verdict = await verify({ evidence: quoteFixture, challenge, signal: new AbortController().signal });
    expect(verdict).toMatchObject({ verification: 'hardware_verified', runId: challenge.runId,
      recipientPublicKey: challenge.recipientPublicKey, reportData: challenge.reportData,
      teeMeasurement: challenge.teeMeasurement, policySha256 });
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, options] = fetched.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://operator-verifier.example/verify-cell');
    expect(options.redirect).toBe('error');
    expect(JSON.parse(String(options.body))).toMatchObject({ challenge: challenge.challenge,
      reportData: challenge.reportData, runId: challenge.runId, recipientPublicKey: challenge.recipientPublicKey });
  });

  it.each([
    ['quote digest', { evidenceSha256: `0x${'01'.repeat(32)}` }],
    ['old challenge', { challenge: `0x${'02'.repeat(32)}` }],
    ['different report_data', { reportData: `0x${'03'.repeat(64)}` }],
    ['different run', { runId: `0x${'04'.repeat(32)}` }],
    ['different recipient', { recipientPublicKey: '05'.repeat(32) }],
    ['different policy', { policySha256: `0x${'06'.repeat(32)}` }],
    ['different measurement digest', { teeMeasurement: `0x${'07'.repeat(32)}` }],
    ['changed raw measurement', { measurements: { ...measurements, mr_td: '08'.repeat(48) } }],
    ['debug TD', { measurements: { ...measurements, td_attributes: '01' + '00'.repeat(7) } }],
    ['expired collateral', { collateralExpiresAtMs: Date.now() - 1 }],
    ['TCB downgrade', { platformStatus: 'OutOfDate' as 'UpToDate' }],
    ['advisory', { advisories: ['INTEL-SA-00000'] as unknown as [] }],
  ])('rejects a signed appraisal with %s', async (_reason, change) => {
    serve(appraisal(change));
    const verify = createSignedCellAppraiserVerifier(config());
    await expect(verify({ evidence: quoteFixture, challenge, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('rejects wrong signing key, tampered signature, duplicate JSON fields and noncanonical signed payload', async () => {
    const verify = createSignedCellAppraiserVerifier(config());
    for (const options of [
      { wrongSigner: true }, { tamperSignature: true }, { duplicateEnvelope: true },
      { malformedPayload: JSON.stringify(appraisal()).replace('"version":1', '"version":1,"version":1') },
    ]) {
      serve(appraisal(), options);
      await expect(verify({ evidence: quoteFixture, challenge, signal: new AbortController().signal })).rejects.toThrow();
    }
  });

  it('fails closed on stale signer pin, insecure endpoint, short quote and changed local profile', async () => {
    expect(() => createSignedCellAppraiserVerifier({ ...config(), endpoint: 'http://operator-verifier.example' }))
      .toThrow('HTTPS');
    const stale = createSignedCellAppraiserVerifier({ ...config(), signerExpiresAtMs: Date.now() - 1 });
    await expect(stale({ evidence: quoteFixture, challenge, signal: new AbortController().signal }))
      .rejects.toThrow('pin expired');
    const verify = createSignedCellAppraiserVerifier(config());
    await expect(verify({ evidence: new Uint8Array(1), challenge, signal: new AbortController().signal }))
      .rejects.toThrow('bounded raw TDX quote');
    const wrong = createSignedCellAppraiserVerifier({ ...config(), approvedMeasurements: {
      ...measurements, mr_td: 'ff'.repeat(48),
    } });
    await expect(wrong({ evidence: quoteFixture, challenge, signal: new AbortController().signal }))
      .rejects.toThrow('policy or challenge binding');
  });

  it('does not read a checkpoint vault after a signed quote hash mismatch', async () => {
    const fetched = vi.fn(async (_url: URL, options: RequestInit) => {
      const sent = JSON.parse(String(options.body)) as { challenge: string; reportData: string };
      return signedResponse(appraisal({ challenge: sent.challenge, reportData: sent.reportData,
        evidenceSha256: `0x${'99'.repeat(32)}` }));
    });
    vi.stubGlobal('fetch', fetched);
    const verifier = createSignedCellAppraiserVerifier(config());
    let vaultReads = 0;
    await expect(releaseCystKeyToSealedCell({ request, collectEvidence: async () => quoteFixture,
      verify: verifier, vault: { exclusive: async () => { vaultReads++; throw new Error('vault accessed'); } },
      signal: new AbortController().signal })).rejects.toThrow('binding changed');
    expect(vaultReads).toBe(0);
  });
});
