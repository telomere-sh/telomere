import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRecoveryRejectedError, validateRecoveredNearResult } from '../src/providers/recovery.js';
import type { NearCompletionResult } from '../src/providers/near.js';

// Public disposable fixture keys; they sign synthetic offline evidence only.
const signer = privateKeyToAccount(`0x${'01'.repeat(32)}`), otherSigner = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const model = 'operator/model', options = { model, maxTokens: 32 };
const sha256 = (value: string) => `0x${createHash('sha256').update(value).digest('hex')}`;
const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
async function verified(): Promise<NearCompletionResult> {
  const output = 'verified historical output', requestHash = sha256('synthetic request'), responseHash = sha256('synthetic response');
  const signatureText = `${model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
  return { output, model, requestId: 'known-completion-1', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    evidence: { verification: 'enclave_verified', endpoint: 'https://model-1.completions.near.ai/v1/chat/completions',
      receivedAt: '2025-10-01T12:00:20.000Z', verifiedAt: '2025-10-01T12:00:00.000Z', expiresAt: '2025-10-01T12:01:00.000Z',
      requestHash, responseHash, outputHash: sha256(output), signingAddress: signer.address, signatureText,
      signature: await signer.signMessage({ message: signatureText }), attestationRef: sha256('attestation fixture'),
      policySha256: sha256('historical policy fixture'), providerEvidenceHash: sha256('original provider evidence fixture') } };
}
function tls(): NearCompletionResult {
  return { output: 'TLS historical output', model, requestId: 'known TLS completion',
    evidence: { verification: 'provider_tls', endpoint: 'https://cloud-api.near.ai/v1/chat/completions',
      receivedAt: '2025-10-01T12:00:20.000Z', requestHash: '11'.repeat(32), responseHash: '22'.repeat(32) } };
}
async function rejects(value: unknown) {
  await expect(validateRecoveredNearResult(value, options)).rejects.toMatchObject({ name: 'ProviderRecoveryRejectedError',
    code: 'PROVIDER_RECOVERY_REJECTED', message: 'Stored provider result failed recovery validation' });
}
afterEach(() => vi.restoreAllMocks());

describe('offline recovery of already accepted provider results', () => {
  it('accepts a real canonical signature and historically valid expired evidence without current-time or network checks', async () => {
    const fixture = await verified(), request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No current admission clock allowed'); });
    expect(await validateRecoveredNearResult(fixture, options)).toEqual(fixture);
    expect(request).not.toHaveBeenCalled();
  });
  it('permits the adapter recording a known success after its historical session expired', async () => {
    const fixture = await verified(); fixture.evidence.receivedAt = '2025-10-01T12:01:02.000Z';
    expect(await validateRecoveredNearResult(fixture, options)).toEqual(fixture);
  });
  it('keeps TLS evidence TLS-only and checks an optional output hash if provided', async () => {
    const fixture = tls(); expect(await validateRecoveredNearResult(fixture, options)).toEqual(fixture);
    expect((await validateRecoveredNearResult(fixture, options)).evidence).not.toHaveProperty('attestationRef');
    fixture.evidence.outputHash = sha256(fixture.output).slice(2);
    expect(await validateRecoveredNearResult(fixture, options)).toEqual(fixture);
    fixture.output = 'changed'; await rejects(fixture);
  });
  it.each(['output', 'signature', 'signatureText', 'requestHash', 'responseHash', 'signingAddress'] as const)
    ('rejects modified signed evidence (%s)', async field => {
      const fixture = await verified();
      if (field === 'output') fixture.output = 'altered stored output';
      else if (field === 'signature') fixture.evidence.signature = await otherSigner.signMessage({ message: fixture.evidence.signatureText! });
      else if (field === 'signatureText') fixture.evidence.signatureText += '-wrong';
      else if (field === 'signingAddress') fixture.evidence.signingAddress = otherSigner.address;
      else {
        fixture.evidence[field] = sha256('changed hash');
        fixture.evidence.signatureText = `${model}:${fixture.evidence.requestHash.slice(2)}:${fixture.evidence.responseHash.slice(2)}`;
      }
      await rejects(fixture);
    });
  it.each(['attestationRef', 'policySha256', 'providerEvidenceHash', 'outputHash', 'signingAddress', 'signature', 'signatureText', 'verifiedAt', 'expiresAt'] as const)
    ('rejects enclave claims with a missing required field (%s)', async field => {
      const fixture = await verified(); delete fixture.evidence[field]; await rejects(fixture);
    });
  it('rejects malleable high-s signatures even when the equivalent message signature is recoverable', async () => {
    const fixture = await verified(), signature = fixture.evidence.signature!;
    const lowS = BigInt(`0x${signature.slice(66, 130)}`), highS = curveOrder - lowS;
    const flippedV = Number.parseInt(signature.slice(130), 16) === 27 ? '1c' : '1b';
    fixture.evidence.signature = `${signature.slice(0, 66)}${highS.toString(16).padStart(64, '0')}${flippedV}`;
    await rejects(fixture);
  });
  it.each(['zero_r', 'zero_s', 'invalid_v'] as const)('rejects invalid ECDSA components (%s)', async variant => {
    const fixture = await verified(), signature = fixture.evidence.signature!;
    fixture.evidence.signature = variant === 'zero_r' ? `0x${'00'.repeat(32)}${signature.slice(66)}`
      : variant === 'zero_s' ? `${signature.slice(0, 66)}${'00'.repeat(32)}${signature.slice(130)}` : `${signature.slice(0, 130)}02`;
    await rejects(fixture);
  });
  it.each(['before_issued', 'session_too_long', 'future_issuance_vs_recording', 'malformed_time'] as const)
    ('rejects inconsistent historical time metadata (%s)', async variant => {
      const fixture = await verified();
      if (variant === 'before_issued') fixture.evidence.expiresAt = '2025-10-01T11:59:59.000Z';
      else if (variant === 'session_too_long') fixture.evidence.expiresAt = '2025-10-01T12:05:01.000Z';
      else if (variant === 'future_issuance_vs_recording') fixture.evidence.receivedAt = '2025-10-01T11:59:29.000Z';
      else fixture.evidence.verifiedAt = 'bad-timestamp';
      await rejects(fixture);
    });
  it.each(['http://cloud-api.near.ai/v1/chat/completions', 'https://cloud-api.near.ai.evil.example/v1/chat/completions',
    'https://user:secret@cloud-api.near.ai/v1/chat/completions', 'https://cloud-api.near.ai/v1/chat/completions?key=secret',
    'https://cloud-api.near.ai:444/v1/chat/completions', 'https://cloud-api.near.ai/v1/other'])
    ('rejects a stored endpoint outside the TLS allowlist (%s)', async endpoint => { const fixture = tls(); fixture.evidence.endpoint = endpoint; await rejects(fixture); });
  it.each(['model', 'utf8_output_limit', 'tokens_limit', 'tokens_sum', 'unbounded_prompt_tokens', 'request_id_limit'] as const)
    ('rejects invalid stored result bounds (%s)', async variant => {
      const fixture = await verified();
      if (variant === 'model') fixture.model = 'different/model';
      else if (variant === 'utf8_output_limit') fixture.output = 'я'.repeat(8193);
      else if (variant === 'tokens_limit') fixture.usage = { promptTokens: 3, completionTokens: 33, totalTokens: 36 };
      else if (variant === 'tokens_sum') fixture.usage = { promptTokens: 3, completionTokens: 5, totalTokens: 9 };
      else if (variant === 'unbounded_prompt_tokens') fixture.usage = { promptTokens: 10_000_001, completionTokens: 0, totalTokens: 10_000_001 };
      else fixture.requestId = 'a'.repeat(257);
      await rejects(fixture);
    });
  it('emits one safe error class without provider data, schema issues or cryptographic causes', async () => {
    const sensitive = 'private-output-and-key-canary', fixture = tls(); fixture.output = sensitive;
    const invalid = { ...fixture, evidence: { ...fixture.evidence, rawProviderPayload: sensitive } };
    try { await validateRecoveredNearResult(invalid, options); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(ProviderRecoveryRejectedError);
      expect(String(error) + JSON.stringify(error)).not.toContain(sensitive);
      expect(error).not.toHaveProperty('cause'); expect(error).not.toHaveProperty('issues');
    }
  });
});
