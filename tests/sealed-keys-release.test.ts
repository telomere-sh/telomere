import { describe, expect, it, vi } from 'vitest';
import { decryptCheckpoint, encryptCheckpoint } from '../src/sdk/cysts.js';
import type { CystCheckpointJournal, CystCheckpointState, CystCheckpointVault } from '../src/sdk/cyst-checkpoints.js';
import { openSealedCystKey, releaseCystKeyToSealedCell, sealedCellReportData, sealedEvidenceSha256,
  type SealedCellEvidenceCollector, type SealedCellHardwareVerifier,
  type SealedCystKeyRequest } from '../src/sealed-keys/release.js';

const owner = '0x' + '11'.repeat(20), agent = '0x' + '22'.repeat(20);
const runId = '0x' + '33'.repeat(32), hostId = '0x' + '44'.repeat(32);
const teeMeasurement = '0x' + '55'.repeat(32), policySha256 = '0x' + '66'.repeat(32);
const operationId = 'cyst-hook-' + '77'.repeat(32);
const nowMs = 1_800_000_000_000;
const evidence = new TextEncoder().encode('fixture evidence only, never hardware proof');

async function fixture() {
  const plaintext = new TextEncoder().encode('a private application state checkpoint');
  const encrypted = await encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'demo/v1' });
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
  const recipientPublicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
  const request: SealedCystKeyRequest = { owner, agent, applicationSchema: 'demo/v1',
    checkpointId: encrypted.envelope.id, operationId, runId, hostId, audience: 'telomere.cell/v1',
    teeMeasurement, policySha256, recipientPublicKey };
  const { ciphertext: _ciphertext, ...envelopeHeader } = encrypted.envelope;
  void _ciphertext;
  const state: CystCheckpointState = { version: 1, scope: { owner, agent, applicationSchema: 'demo/v1' },
    intervalMs: 900_000, paused: false, nextDueAtMs: nowMs + 900_000, pending: null,
    latest: { operationId, trigger: 'owner_request', completedAtMs: nowMs - 10_000,
      checkpoint: { ...envelopeHeader, ciphertextBytes: encrypted.envelope.plaintextBytes + 16,
        state: 'ready', createdAt: new Date(nowMs - 10_000).toISOString() } } };
  let lastKeyCopy: Uint8Array | undefined;
  let reads = 0;
  const journal: CystCheckpointJournal = {
    load: async () => { reads++; return structuredClone(state); },
    save: async () => { throw new Error('Key release must not write state'); },
    checkpoint: async (id) => {
      if (id !== operationId) return undefined;
      lastKeyCopy = Uint8Array.from(encrypted.recoveryKey);
      return { envelope: structuredClone(encrypted.envelope), recoveryKey: lastKeyCopy };
    },
    saveCheckpoint: async () => { throw new Error('Key release must not write keys'); },
  };
  const vault: CystCheckpointVault = { exclusive: async (_scope, operation) => operation(journal) };
  const collectEvidence: SealedCellEvidenceCollector = vi.fn(async () => Uint8Array.from(evidence));
  const verifier: SealedCellHardwareVerifier = vi.fn(async ({ challenge }) => ({
    verification: 'hardware_verified', attestationRef: '0x' + '88'.repeat(32),
    challenge: challenge.challenge, reportData: challenge.reportData,
    verifiedAtMs: nowMs - 1000, expiresAtMs: nowMs + 40_000,
    owner: challenge.owner, agent: challenge.agent, applicationSchema: challenge.applicationSchema,
    operationId: challenge.operationId, checkpointId: challenge.checkpointId, runId: challenge.runId, hostId: challenge.hostId,
    audience: challenge.audience, teeMeasurement: challenge.teeMeasurement,
    policySha256: challenge.policySha256, recipientPublicKey: challenge.recipientPublicKey,
  }));
  const signal = new AbortController().signal;
  const release = (override: Partial<Parameters<typeof releaseCystKeyToSealedCell>[0]> = {}) =>
    releaseCystKeyToSealedCell({ request, collectEvidence, verify: verifier, vault, signal, now: () => nowMs, ...override });
  return { plaintext, encrypted, pair, recipientPublicKey, request, state, vault, collectEvidence, verifier, signal, release,
    keyCopy: () => lastKeyCopy, reads: () => reads };
}

describe('owner-side sealed Cyst key release boundary', () => {
  it('releases only a quote-context ciphertext and clears the loaded recovery key', async () => {
    const f = await fixture();
    const packet = await f.release();
    expect(packet.version).toBe(2);
    expect(packet.reportData).toMatch(/^0x[a-f0-9]{128}$/);
    expect(packet.reportData.slice(66)).toBe(packet.challenge.slice(2));
    expect(packet).not.toHaveProperty('operationId');
    expect(JSON.stringify(packet)).not.toContain(Buffer.from(f.encrypted.recoveryKey).toString('hex'));
    expect(JSON.stringify(packet)).not.toContain(Buffer.from(f.plaintext).toString('hex'));
    expect(f.keyCopy()?.every(byte => byte === 0)).toBe(true);
    const { operationId: _operationId, ...expected } = f.request;
    void _operationId;
    const key = await openSealedCystKey(packet, expected,
      { publicKey: f.recipientPublicKey, privateKey: f.pair.privateKey }, () => nowMs);
    try {
      const restored = await decryptCheckpoint(f.encrypted.envelope, key);
      expect(restored).toEqual(f.plaintext);
      restored.fill(0);
    } finally { key.fill(0); f.encrypted.recoveryKey.fill(0); }
    expect(f.reads()).toBe(1);
  });

  it('issues the challenge before collecting evidence and passes the same challenge to the verifier', async () => {
    const f = await fixture();
    const order: string[] = [];
    let issuedChallenge = '';
    const collectEvidence: SealedCellEvidenceCollector = async ({ challenge }) => {
      order.push('collect');
      issuedChallenge = challenge.challenge;
      expect(challenge.reportData).toBe(sealedCellReportData({ ...f.request, challenge: challenge.challenge }));
      return new TextEncoder().encode(challenge.challenge);
    };
    const verify: SealedCellHardwareVerifier = async input => {
      order.push('verify');
      expect(input.challenge.challenge).toBe(issuedChallenge);
      expect(new TextDecoder().decode(input.evidence)).toBe(issuedChallenge);
      return f.verifier(input);
    };
    await f.release({ collectEvidence, verify });
    expect(order).toEqual(['collect', 'verify']);
    expect(issuedChallenge).toMatch(/^0x[a-f0-9]{64}$/);
    expect(f.reads()).toBe(1);
  });

  it('fixes the 64-byte quote report-data encoding and binds every selected field', async () => {
    const f = await fixture(), challenge = '0x' + '12'.repeat(32);
    const input = { ...f.request, challenge };
    const canonical = sealedCellReportData(input);
    expect(canonical).toMatch(/^0x[0-9a-f]{128}$/);
    expect(canonical.slice(66)).toBe(challenge.slice(2));
    for (const field of ['owner', 'agent', 'applicationSchema', 'checkpointId', 'operationId', 'runId',
      'hostId', 'audience', 'teeMeasurement', 'policySha256', 'recipientPublicKey'] as const) {
      const changed = field === 'owner' || field === 'agent' ? '0x' + '99'.repeat(20)
        : field === 'applicationSchema' || field === 'audience' ? 'different/v1'
          : field === 'operationId' ? 'cyst-hook-' + '99'.repeat(32)
            : field === 'recipientPublicKey' ? '99'.repeat(32) : '0x' + '99'.repeat(32);
      expect(sealedCellReportData({ ...input, [field]: changed })).not.toBe(canonical);
    }
    expect(sealedCellReportData({ ...input, challenge: '0x' + '13'.repeat(32) })).not.toBe(canonical);
    expect(() => sealedCellReportData({ ...input, challenge: challenge.toUpperCase() })).toThrow();
    expect(() => sealedCellReportData({ ...input, recipientPublicKey: '00'.repeat(32) })).toThrow();
  });

  it('has a cross-language report-data fixture with an explicit 64-byte expected value', () => {
    expect(sealedCellReportData({
      owner, agent, applicationSchema: 'demo/v1', checkpointId: '0x' + 'aa'.repeat(32),
      operationId, runId, hostId, audience: 'telomere.cell/v1', teeMeasurement,
      policySha256, recipientPublicKey: '99'.repeat(32), challenge: '0x' + '12'.repeat(32),
    })).toBe('0x2dec2348ed49f3e9c2aa4081df931b0eae381ec3b0163266f5b4fd57d54a6400'
      + '12'.repeat(32));
  });

  it('rejects evidence collected for an earlier challenge before opening the vault', async () => {
    const f = await fixture();
    let replayedEvidence: Uint8Array | undefined;
    const collectEvidence: SealedCellEvidenceCollector = async ({ challenge }) => {
      replayedEvidence ??= new TextEncoder().encode(challenge.challenge);
      return Uint8Array.from(replayedEvidence);
    };
    // This fake verifier tests ordering and rejection only, not hardware authenticity.
    const verify: SealedCellHardwareVerifier = async input => {
      if (new TextDecoder().decode(input.evidence) !== input.challenge.challenge) {
        throw new Error('Hardware challenge mismatch');
      }
      return f.verifier(input);
    };
    await f.release({ collectEvidence, verify });
    await expect(f.release({ collectEvidence, verify })).rejects.toThrow('Hardware challenge mismatch');
    expect(f.reads()).toBe(1);
  });

  it('collects once, never retries a failed verifier, and stops on cancellation before verification', async () => {
    const f = await fixture();
    const collectEvidence = vi.fn<SealedCellEvidenceCollector>(async () => Uint8Array.from(evidence));
    const verify = vi.fn<SealedCellHardwareVerifier>(async () => { throw new Error('Quote rejected'); });
    await expect(f.release({ collectEvidence, verify })).rejects.toThrow('Quote rejected');
    expect(collectEvidence).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(f.reads()).toBe(0);

    const controller = new AbortController();
    const abortedCollector = vi.fn<SealedCellEvidenceCollector>(async () => {
      controller.abort();
      return Uint8Array.from(evidence);
    });
    await expect(f.release({ collectEvidence: abortedCollector, verify, signal: controller.signal })).rejects.toThrow();
    expect(abortedCollector).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(f.reads()).toBe(0);
  });

  it.each(['owner', 'agent', 'applicationSchema', 'operationId', 'checkpointId', 'runId', 'hostId', 'audience', 'teeMeasurement', 'policySha256', 'recipientPublicKey'] as const)(
    'rejects a verifier verdict with a mismatched %s', async field => {
      const f = await fixture();
      const verify: SealedCellHardwareVerifier = async input => ({ ...(await f.verifier(input)) as Record<string, unknown>, [field]: field === 'audience'
        ? 'another.cell/v1' : field === 'applicationSchema' ? 'another/v1'
          : field === 'operationId' ? 'cyst-hook-' + '99'.repeat(32)
            : field === 'recipientPublicKey' ? '99'.repeat(32)
              : field === 'owner' || field === 'agent' ? '0x' + '99'.repeat(20) : '0x' + '99'.repeat(32) });
      await expect(f.release({ verify })).rejects.toThrow('binding changed');
      expect(f.reads()).toBe(0);
    });

  it('rejects replayed challenge, stale, future, expired and long-lived verdicts before vault access', async () => {
    const f = await fixture();
    for (const changed of [
      { challenge: '0x' + 'aa'.repeat(32) }, { reportData: '0x' + 'aa'.repeat(64) },
      { verifiedAtMs: nowMs - 61_000 },
      { verifiedAtMs: nowMs + 5_001 }, { expiresAtMs: nowMs },
      { expiresAtMs: nowMs + 61_000 },
    ]) {
      const verify: SealedCellHardwareVerifier = async input => ({ ...(await f.verifier(input)) as Record<string, unknown>, ...changed });
      await expect(f.release({ verify })).rejects.toThrow();
    }
    expect(f.reads()).toBe(0);
  });

  it('rejects a NEAR inference session as insufficient Cell evidence', async () => {
    const f = await fixture();
    const verify: SealedCellHardwareVerifier = async () => ({ tlsBound: true, allowedSigners: [owner],
      attestationRef: '0x' + '88'.repeat(32), verifiedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 40_000).toISOString(), fetch: async () => new Response() });
    await expect(f.release({ verify })).rejects.toThrow();
    expect(f.reads()).toBe(0);
  });

  it('rechecks expiry after slow vault access and never encrypts on a late result', async () => {
    const f = await fixture();
    let time = nowMs;
    const vault: CystCheckpointVault = { exclusive: async (scope, operation) => {
      const result = await f.vault.exclusive(scope, async journal => {
        const delayed: CystCheckpointJournal = { ...journal, load: async () => { time = nowMs + 41_000; return journal.load(); } };
        return operation(delayed);
      });
      return result;
    } };
    await expect(f.release({ vault, now: () => time })).rejects.toThrow('stale or expired');
  });

  it('requires the exact completed checkpoint and rejects wrong or corrupt recovery records', async () => {
    const f = await fixture();
    const other = { ...f.request, checkpointId: '0x' + 'aa'.repeat(32) };
    await expect(f.release({ request: other })).rejects.toThrow('matching completed checkpoint');
    const vault: CystCheckpointVault = { exclusive: async (scope, operation) => f.vault.exclusive(scope, async journal => {
      const bad: CystCheckpointJournal = { ...journal, checkpoint: async id => {
        const record = await journal.checkpoint(id);
        if (record) record.recoveryKey[0] = record.recoveryKey[0]! ^ 0xff;
        return record;
      } };
      return operation(bad);
    }) };
    await expect(f.release({ vault })).rejects.toThrow('authentication failed');
    expect(f.keyCopy()?.every(byte => byte === 0)).toBe(true);
  });

  it('clears the loaded recovery key when cancellation races after vault retrieval', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const vault: CystCheckpointVault = { exclusive: async (scope, operation) => f.vault.exclusive(scope, async journal => {
      const interrupted: CystCheckpointJournal = { ...journal, checkpoint: async id => {
        const record = await journal.checkpoint(id);
        controller.abort();
        return record;
      } };
      return operation(interrupted);
    }) };
    await expect(f.release({ vault, signal: controller.signal })).rejects.toThrow();
    expect(f.keyCopy()?.every(byte => byte === 0)).toBe(true);
  });

  it('rejects an aborted request, malformed evidence and verifier failure before reading secrets', async () => {
    const f = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(f.release({ signal: controller.signal })).rejects.toThrow();
    await expect(f.release({ collectEvidence: async () => new Uint8Array(0) })).rejects.toThrow();
    await expect(f.release({ collectEvidence: async () => new Uint8Array(4_194_305) })).rejects.toThrow();
    await expect(f.release({ verify: async () => { throw new Error('hardware rejected'); } })).rejects.toThrow('hardware rejected');
    expect(f.reads()).toBe(0);
  });

  it('binds decryption to the exact Cell context, recipient and fresh packet', async () => {
    const f = await fixture(), packet = await f.release();
    const { operationId: _operationId, ...expected } = f.request;
    void _operationId;
    const recipient = { publicKey: f.recipientPublicKey, privateKey: f.pair.privateKey };
    await expect(openSealedCystKey(packet, { ...expected, runId: '0x' + 'aa'.repeat(32) }, recipient, () => nowMs))
      .rejects.toThrow('context changed');
    await expect(openSealedCystKey(packet, expected, { ...recipient, publicKey: 'aa'.repeat(32) }, () => nowMs))
      .rejects.toThrow('recipient changed');
    await expect(openSealedCystKey(packet, expected, recipient, () => nowMs + 41_000))
      .rejects.toThrow('stale or expired');
    await expect(openSealedCystKey({ ...packet, ciphertext: 'aa'.repeat(48) }, expected, recipient, () => nowMs))
      .rejects.toThrow('authentication failed');
    await expect(openSealedCystKey({ ...packet, reportData: '0x' + 'aa'.repeat(64) }, expected, recipient, () => nowMs))
      .rejects.toThrow('authentication failed');
  });

  it('hashes bounded evidence without exposing it', () => {
    expect(sealedEvidenceSha256(evidence)).toMatch(/^0x[a-f0-9]{64}$/);
    expect(() => sealedEvidenceSha256(new Uint8Array(0))).toThrow();
  });
});
