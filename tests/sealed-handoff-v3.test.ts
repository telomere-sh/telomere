import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomId } from '../src/common.js';
import { encryptCheckpoint, decryptCheckpoint } from '../src/sdk/cysts.js';
import type { CystCheckpointState, CystCheckpointVault } from '../src/sdk/cyst-checkpoints.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { cystMetadataSchema } from '../src/cysts/types.js';
import { cystRegistryPinsSchema, cystRegistrySnapshotSchema, cystRegistryStorageRef, type CystRegistryReader } from '../src/cysts/registry-types.js';
import { SealedHandoffJournalV3 } from '../src/sealed-keys/journal-v3.js';
import { SealedCystHandoffOwnerV3, SealedCystHandoffRecipientV3, releaseAuthenticatedSealedCystV3,
  sealedAppraiserKeyFingerprint } from '../src/sealed-keys/handoff-v3.js';
import type { SealedHandoffSignerV3 } from '../src/sealed-keys/handoff-v3.js';
import { sealedPacketTypedData, sealedPolicyV3Schema, sealedScopeV3 } from '../src/sealed-keys/protocol-v3.js';
import { sealedCellMeasurementDigest, type SealedCellMeasurementProfile, type SignedCellAppraisal,
  type SignedCellAppraiserConfig } from '../src/sealed-keys/signed-appraiser.js';
import type { SealedCellChallenge } from '../src/sealed-keys/release.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const operationId = 'cyst-hook-' + '11'.repeat(32);
const signal = () => new AbortController().signal;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-sealed-v3-'));
  const account = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const owner = account.address.toLowerCase(), agent = other.address.toLowerCase();
  const encrypted = await encryptCheckpoint(new TextEncoder().encode('actual private checkpoint; fixture appraisal only'),
    { owner, agent, applicationSchema: 'sealed.demo/v1' });
  const { ciphertext: _ciphertext, ...header } = encrypted.envelope; void _ciphertext;
  const metadata = cystMetadataSchema.parse({ ...header, ciphertextBytes: encrypted.envelope.plaintextBytes + 16,
    createdAt: new Date().toISOString(), state: 'ready' });
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
  const recipient = { publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: pair.privateKey };
  const appraiserKeys = generateKeyPairSync('ed25519');
  const appraiserPem = appraiserKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const measurements: SealedCellMeasurementProfile = { tee_tcb_svn: '00'.repeat(16), mr_seam: '00'.repeat(48),
    mr_signer_seam: '00'.repeat(48), seam_attributes: '00'.repeat(8), td_attributes: '00'.repeat(8), xfam: '00'.repeat(8),
    mr_td: '11'.repeat(48), mr_config_id: '00'.repeat(48), mr_owner: '00'.repeat(48), mr_owner_config: '00'.repeat(48),
    rt_mr0: '00'.repeat(48), rt_mr1: '00'.repeat(48), rt_mr2: '00'.repeat(48), rt_mr3: '00'.repeat(48) };
  const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: privateKeyToAccount(generatePrivateKey()).address,
    registryCodeHash: randomId(), selectionRegistryAddress: privateKeyToAccount(generatePrivateKey()).address,
    selectionRegistryCodeHash: randomId(), confirmations: 0 });
  let now = Date.now(), loadCount = 0, keyCount = 0, vaultCount = 0, collectorCount = 0;
  const policy = sealedPolicyV3Schema.parse({ version: 3, registryPins: pins, owner, agent, agentId: randomId(),
    vault: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), applicationSchema: 'sealed.demo/v1',
    generation: 1, notBeforeMs: now - 1000, expiresAtMs: now + 120_000, runId: randomId(), hostId: randomId(),
    bootId: randomId(), leaseHash: randomId(), fenceEpoch: 1, leaseExpiresAtMs: now + 120_000,
    recipientPublicKey: recipient.publicKey, appraiserKeySha256: sealedAppraiserKeyFingerprint(appraiserPem),
    teeMeasurement: sealedCellMeasurementDigest(measurements), policySha256: randomId() });
  const snapshot = cystRegistrySnapshotSchema.parse({ binding: { agentId: policy.agentId, owner, agentWallet: agent,
    vault: policy.vault, status: 1, frozen: false }, current: { agentId: policy.agentId,
      cystHash: '0x' + metadata.sha256, sizeBytes: String(metadata.ciphertextBytes), storageRef: cystRegistryStorageRef(metadata),
      revision: '1', committedAt: String(Math.floor(now / 1000)), retired: false, block: { number: '10', hash: randomId() } } });
  const registry: CystRegistryReader = { pins, check: async () => undefined, snapshot: async () => structuredClone(snapshot) };
  const state: CystCheckpointState = { version: 1, scope: { owner, agent, applicationSchema: policy.applicationSchema },
    intervalMs: 900000, paused: false, nextDueAtMs: now + 900000, pending: null,
    latest: { operationId, trigger: 'owner_request', completedAtMs: now, checkpoint: metadata } };
  let keyCopy: Uint8Array | undefined;
  const checkpointVault: CystCheckpointVault = { exclusive: async (_scope, run) => {
    vaultCount++;
    return run({ load: async () => { loadCount++; return structuredClone(state); },
      checkpoint: async () => { keyCount++; keyCopy = Uint8Array.from(encrypted.recoveryKey);
        return { envelope: structuredClone(encrypted.envelope), recoveryKey: keyCopy }; },
      save: async () => { throw new Error('Source state must not change'); }, saveCheckpoint: async () => { throw new Error('Source key must not change'); } });
  } };
  const ownerKey = randomBytes(32), recipientKey = randomBytes(32), journals: SealedHandoffJournalV3[] = [];
  const journal = (role: 'owner' | 'recipient', key = role === 'owner' ? ownerKey : recipientKey) => {
    const value = new SealedHandoffJournalV3({ path: join(directory, role + '.json'), masterKey: key,
      role, scopeHash: sealedScopeV3(policy) }); journals.push(value); return value;
  };
  const ownerJournal = journal('owner'), recipientJournal = journal('recipient');
  await ownerJournal.initializeFresh(); await recipientJournal.initializeFresh();
  const appraiser: SignedCellAppraiserConfig = { endpoint: 'https://fixture-appraiser.example/verify', verifierPublicKeyPem: appraiserPem,
    signerNotBeforeMs: now - 1000, signerExpiresAtMs: now + 120000, approvedMeasurements: measurements, policySha256: policy.policySha256 };
  let challenge: SealedCellChallenge | undefined;
  const evidence = new Uint8Array(1500).fill(42);
  let failCollector = false;
  const collectEvidence = async (input: { challenge: SealedCellChallenge }) => {
    collectorCount++; challenge = input.challenge;
    if (failCollector) throw new Error('Unknown fixture collection outcome'); return evidence;
  };
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!challenge) throw new Error('Quote challenge absent');
    const verifiedAtMs = Date.now();
    const payload: SignedCellAppraisal = { version: 1, verification: 'hardware_verified',
      evidenceSha256: '0x' + createHash('sha256').update(evidence).digest('hex'), challenge: challenge.challenge,
      reportData: challenge.reportData, runId: challenge.runId, recipientPublicKey: challenge.recipientPublicKey,
      teeMeasurement: challenge.teeMeasurement, policySha256: challenge.policySha256, verifiedAtMs,
      expiresAtMs: verifiedAtMs + 60_000, collateralExpiresAtMs: verifiedAtMs + 120_000,
      quoteStatus: 'UpToDate', qeStatus: 'UpToDate', platformStatus: 'UpToDate', advisories: [], measurements };
    const bytes = Buffer.from(JSON.stringify(payload));
    return new Response(JSON.stringify({ payloadB64: bytes.toString('base64'), signatureB64: sign(null,
      Buffer.concat([Buffer.from('telomere.sealed-cell.signed-appraisal.v1\0'), bytes]), appraiserKeys.privateKey).toString('base64') }));
  }));
  const makeOwner = (next = policy, saved = ownerJournal, source = checkpointVault) => new SealedCystHandoffOwnerV3({ policy: next,
    registry, journal: saved, checkpointVault: source, appraiser, collectEvidence, now: () => now });
  const makeRecipient = (next = policy, saved = recipientJournal, key = recipient) => new SealedCystHandoffRecipientV3({
    policy: next, registry, journal: saved, recipient: key, now: () => now });
  const completed = { operationId, checkpoint: metadata };
  const ownerService = makeOwner(), recipientService = makeRecipient();
  const signOwner: SealedHandoffSignerV3 = typed => typed.primaryType === 'SealedReleaseIntent'
    ? account.signTypedData(typed) : account.signTypedData(typed);
  const finish = async (service = ownerService, releaseId = randomId()) => {
    const result = await releaseAuthenticatedSealedCystV3(service, releaseId, completed,
      signOwner, signal());
    if (result.status !== 'complete') throw new Error('Unexpected retained fixture'); return result.envelope;
  };
  return { directory, account, other, encrypted, metadata, policy, snapshot, registry, state, checkpointVault, recipient,
    appraiser, ownerJournal, recipientJournal, ownerService, recipientService, makeOwner, makeRecipient, journal, completed, finish,
    counts: () => ({ load: loadCount, key: keyCount, vault: vaultCount, collect: collectorCount }), keyCopy: () => keyCopy,
    setNow: (value: number) => { now = value; }, now: () => now, setCollectorFailure: () => { failCollector = true; },
    async close() { for (const value of journals) value.close(); encrypted.recoveryKey.fill(0); ownerKey.fill(0); recipientKey.fill(0);
      const target = resolve(directory), parent = resolve(tmpdir());
      if (!target.startsWith(parent + sep) || !basename(target).startsWith('telomere-sealed-v3-')) throw new Error('Unsafe fixture cleanup');
      await rm(target, { recursive: true }); },
  };
}

it('authenticates two real EOA signatures, binds a signed fixture appraisal, decrypts real Cyst and consumes before return across restart', async () => {
  const f = await fixture();
  try {
    const result = await f.finish(); expect(result.version).toBe(3);
    expect(f.counts()).toEqual({ load: 1, key: 1, vault: 1, collect: 1 });
    expect(f.keyCopy()?.every(value => value === 0)).toBe(true);
    expect(result.packet.expiresAtMs).toBeGreaterThanOrEqual(result.context.expiresAtMs); // normal appraisal latency is accepted
    const key = await f.recipientService.accept(result, signal());
    try { expect(await decryptCheckpoint(f.encrypted.envelope, key)).toEqual(new TextEncoder().encode('actual private checkpoint; fixture appraisal only')); }
    finally { key.fill(0); }
    const reopened = f.journal('recipient');
    await expect(f.makeRecipient(f.policy, reopened).accept(result, signal())).rejects.toThrow('consumed');
    expect((await reopened.read()).entries[0]?.phase).toBe('consumed');
    const serialized = await readFile(join(f.directory, 'owner.json'), 'utf8');
    expect(serialized).not.toContain(Buffer.from(f.encrypted.recoveryKey).toString('hex'));
    expect(serialized).not.toContain('private checkpoint'); expect(serialized).not.toContain(f.policy.recipientPublicKey);
  } finally { await f.close(); }
});

it('performs zero vault methods, collector or ECDH for unsigned/forged owner intent and refuses direct unauthenticated v2 packets', async () => {
  const f = await fixture();
  try {
    const intent = await f.ownerService.prepareIntent(randomId(), f.completed);
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 0 });
    const signature = await f.other.signTypedData(intent.typedData);
    await expect(f.ownerService.preparePacket(intent.entry.context.releaseId, signature, signal())).rejects.toThrow('signature');
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 0 });
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    await expect(f.recipientService.accept({ version: 2 }, signal())).rejects.toThrow();
    expect(derive).not.toHaveBeenCalled();
    const mutated = { ...f.completed, checkpoint: { ...f.metadata, sha256: '22'.repeat(32) } };
    await expect(f.ownerService.prepareIntent(randomId(), mutated)).rejects.toThrow('canonical');
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 0 });
  } finally { await f.close(); }
});

it('defers the real encrypted FileVault load until owner intent, then authenticates and restores its exact canonical checkpoint', async () => {
  const f = await fixture(), masterKey = randomBytes(32);
  const source = new CystCheckpointFileVault({ directory: join(f.directory, 'actual-source-vault'), masterKey });
  try {
    await source.exclusive(f.state.scope, async journal => {
      await journal.saveCheckpoint(operationId, { envelope: f.encrypted.envelope, recoveryKey: f.encrypted.recoveryKey });
      await journal.save(f.state);
    });
    let calls = 0;
    const guarded: CystCheckpointVault = { exclusive: (scope, operation) => { calls++; return source.exclusive(scope, operation); } };
    const owner = f.makeOwner(f.policy, f.ownerJournal, guarded), id = randomId();
    const intent = await owner.prepareIntent(id, f.completed); expect(calls).toBe(0);
    await expect(owner.preparePacket(id, await f.other.signTypedData(intent.typedData), signal())).rejects.toThrow('signature');
    expect(calls).toBe(0);
    const prepared = await owner.preparePacket(id, await f.account.signTypedData(intent.typedData), signal());
    const envelope = await owner.complete(id, await f.account.signTypedData(prepared.typedData));
    expect(calls).toBe(1);
    const recovered = await f.recipientService.accept(envelope, signal());
    try { expect(await decryptCheckpoint(f.encrypted.envelope, recovered)).toEqual(new TextEncoder().encode('actual private checkpoint; fixture appraisal only')); }
    finally { recovered.fill(0); }
  } finally { source.close(); masterKey.fill(0); await f.close(); }
});

it('rejects forged full packet signature and every changed signed context before consumption or ECDH', async () => {
  const f = await fixture();
  try {
    const packet = await f.finish(), derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const forged = await f.other.signTypedData(sealedPacketTypedData(packet.context, packet.packet));
    await expect(f.recipientService.accept({ ...packet, ownerPacketSignature: forged }, signal())).rejects.toThrow('signature');
    for (const change of [{ owner: f.other.address.toLowerCase() }, { bootId: randomId() }, { runId: randomId() },
      { leaseHash: randomId() }, { fenceEpoch: 2 }, { vault: f.other.address.toLowerCase() }, { agentId: randomId() },
      { appraiserKeySha256: randomId() }, { recipientPublicKey: '33'.repeat(32) }]) {
      await expect(f.recipientService.accept({ ...packet, context: { ...packet.context,
        policy: { ...packet.context.policy, ...change } } }, signal())).rejects.toThrow();
    }
    await expect(f.recipientService.accept({ ...packet, packet: { ...packet.packet, ciphertext: '00'.repeat(48) } }, signal())).rejects.toThrow('signature');
    expect(derive).not.toHaveBeenCalled(); expect((await f.recipientJournal.read()).entries).toHaveLength(0);
  } finally { await f.close(); }
});

it('retains uncertain preparation across restart without recollection, source-key access, re-encryption or automatic signing', async () => {
  const f = await fixture();
  try {
    f.setCollectorFailure(); const id = randomId(), intent = await f.ownerService.prepareIntent(id, f.completed);
    const first = await f.account.signTypedData(intent.typedData);
    await expect(f.ownerService.preparePacket(id, first, signal())).rejects.toThrow('Unknown fixture');
    const reopened = f.makeOwner(f.policy, f.journal('owner'));
    await expect(reopened.preparePacket(id, first, signal())).rejects.toThrow('unknown');
    const signer = vi.fn<SealedHandoffSignerV3>(typed => typed.primaryType === 'SealedReleaseIntent'
      ? f.account.signTypedData(typed) : f.account.signTypedData(typed));
    const result = await releaseAuthenticatedSealedCystV3(reopened, id, f.completed, signer, signal());
    expect(result).toMatchObject({ status: 'retained', phase: 'preparing' }); expect(signer).not.toHaveBeenCalled();
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 1 });
    await expect(reopened.prepareIntent(randomId(), f.completed)).rejects.toThrow('binding retained');
  } finally { await f.close(); }
});

it('preserves exact prepared ciphertext after response loss and refuses source metadata change before reading recovery key', async () => {
  const f = await fixture();
  try {
    const id = randomId(), intent = await f.ownerService.prepareIntent(id, f.completed);
    const signature = await f.account.signTypedData(intent.typedData);
    const prepared = await f.ownerService.preparePacket(id, signature, signal());
    const reopened = f.makeOwner(f.policy, f.journal('owner'));
    const replay = await reopened.preparePacket(id, signature, signal());
    expect(replay.packet).toEqual(prepared.packet); expect(f.counts()).toEqual({ load: 1, key: 1, vault: 1, collect: 1 });
    const envelope = await reopened.complete(id, await f.account.signTypedData(replay.typedData));
    expect(await reopened.complete(id, await f.account.signTypedData(replay.typedData))).toEqual(envelope);
  } finally { await f.close(); }
  const changed = await fixture();
  try {
    const intent = await changed.ownerService.prepareIntent(randomId(), changed.completed);
    if (!changed.state.latest) throw new Error('Fixture state absent');
    changed.state.latest.checkpoint = { ...changed.metadata, sha256: '44'.repeat(32) };
    await expect(changed.ownerService.preparePacket(intent.entry.context.releaseId,
      await changed.account.signTypedData(intent.typedData), signal())).rejects.toThrow('metadata changed');
    expect(changed.counts().key).toBe(0);
  } finally { await changed.close(); }
});

it('rejects current Cyst/owner changes and independent context/appraisal expiry, without consuming or refreshing intent', async () => {
  const f = await fixture();
  try {
    const packet = await f.finish();
    f.snapshot.current.revision = '2';
    await expect(f.recipientService.accept(packet, signal())).rejects.toThrow('revision');
    f.snapshot.current.revision = '1'; f.snapshot.binding.frozen = true;
    await expect(f.recipientService.accept(packet, signal())).rejects.toThrow('binding');
    f.snapshot.binding.frozen = false; f.setNow(packet.context.expiresAtMs);
    await expect(f.recipientService.accept(packet, signal())).rejects.toThrow('expired');
    await expect(f.ownerService.prepareIntent(packet.context.releaseId, f.completed)).rejects.toThrow('expired');
    expect((await f.recipientJournal.read()).entries).toHaveLength(0);
  } finally { await f.close(); }
});

it('rotation during post-consume registry await blocks the old recipient before ECDH and retains consumed state', async () => {
  const f = await fixture();
  try {
    const packet = await f.finish(); let ready!: () => void, resume!: () => void, held = false;
    const reached = new Promise<void>(done => { ready = done; }), continuation = new Promise<void>(done => { resume = done; });
    const original = f.registry.snapshot;
    f.registry.snapshot = async id => {
      if (!held && (await f.recipientJournal.read()).entries.some(item => item.phase === 'consumed')) {
        held = true; ready(); await continuation;
      }
      return original(id);
    };
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const attempt = f.recipientService.accept(packet, signal());
    await reached;
    const rotated = sealedPolicyV3Schema.parse({ ...f.policy, generation: 2, fenceEpoch: 2 });
    await f.makeRecipient(rotated).activatePolicy(); resume();
    await expect(attempt).rejects.toThrow('generation'); expect(derive).not.toHaveBeenCalled();
    expect((await f.recipientJournal.read()).entries[0]?.phase).toBe('consumed');
  } finally { await f.close(); }
}, 15_000);

it('rotation while quote appraisal is pending refuses the old owner before any source-vault access', async () => {
  const f = await fixture();
  try {
    const intent = await f.ownerService.prepareIntent(randomId(), f.completed);
    const originalFetch = globalThis.fetch; let ready!: () => void, resume!: () => void;
    const reached = new Promise<void>(done => { ready = done; }), continuation = new Promise<void>(done => { resume = done; });
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => { ready(); await continuation; return originalFetch(...args); });
    const attempt = f.ownerService.preparePacket(intent.entry.context.releaseId, await f.account.signTypedData(intent.typedData), signal());
    const failure = expect(attempt).rejects.toThrow('generation');
    await reached;
    await f.makeOwner({ ...f.policy, generation: 2, fenceEpoch: 2 }).activatePolicy();
    resume(); await failure;
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 1 });
    expect((await f.ownerJournal.read()).entries[0]?.phase).toBe('preparing');
  } finally { await f.close(); }
}, 15_000);

it('retains retired key fingerprints and per-run fences across rotation/restart, and bounds policy/write lifetime budgets', async () => {
  const f = await fixture();
  try {
    await f.recipientService.activatePolicy();
    await expect(f.makeRecipient({ ...f.policy, generation: 2, bootId: randomId(), fenceEpoch: 2 }).activatePolicy()).rejects.toThrow('run/boot');
    await expect(f.makeRecipient({ ...f.policy, generation: 2, runId: randomId() }).activatePolicy()).rejects.toThrow('run/boot');
    const nextPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    const nextRecipient = { publicKey: Buffer.from(await crypto.subtle.exportKey('raw', nextPair.publicKey)).toString('hex'), privateKey: nextPair.privateKey };
    const next = sealedPolicyV3Schema.parse({ ...f.policy, generation: 2, recipientPublicKey: nextRecipient.publicKey,
      bootId: randomId(), fenceEpoch: 2, appraiserKeySha256: randomId() });
    await f.makeRecipient(next, f.recipientJournal, nextRecipient).activatePolicy();
    const reopen = f.journal('recipient');
    await expect(f.makeRecipient(f.policy, reopen).activatePolicy()).rejects.toThrow('generation');
    const retired = sealedPolicyV3Schema.parse({ ...f.policy, generation: 3, fenceEpoch: 3 });
    await expect(f.makeRecipient(retired, reopen).activatePolicy()).rejects.toThrow('Retired');
    const thirdPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    const thirdRecipient = { publicKey: Buffer.from(await crypto.subtle.exportKey('raw', thirdPair.publicKey)).toString('hex'), privateKey: thirdPair.privateKey };
    const otherRun = sealedPolicyV3Schema.parse({ ...next, generation: 3, runId: randomId(), bootId: randomId(), recipientPublicKey: thirdRecipient.publicKey });
    await f.makeRecipient(otherRun, reopen, thirdRecipient).activatePolicy();
    const oldRunLowFence = sealedPolicyV3Schema.parse({ ...next, generation: 4, fenceEpoch: 1 });
    await expect(f.makeRecipient(oldRunLowFence, reopen, nextRecipient).activatePolicy()).rejects.toThrow('fence');
    await reopen.transact(state => { state.policyTransitions = 16; });
    await expect(f.makeRecipient({ ...otherRun, generation: 4 }, reopen, thirdRecipient).activatePolicy()).rejects.toThrow('budget');
    await expect(reopen.transact(async () => undefined)).rejects.toThrow('synchronous');
    await expect(reopen.transact(state => { state.lifetimeBytes = 67_108_863; })).rejects.toThrow();
    await reopen.transact(state => { state.writes = 511; });
    await expect(reopen.transact(() => undefined)).rejects.toThrow();
  } finally { await f.close(); }
});

it('bounds retained lifetime release inventory without eviction, new key callbacks or policy-budget renewal', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 64; index++) {
      f.snapshot.current.revision = String(index + 1);
      await f.ownerService.prepareIntent(randomId(), f.completed);
    }
    f.snapshot.current.revision = '65';
    await expect(f.ownerService.prepareIntent(randomId(), f.completed)).rejects.toThrow('lifetime capacity');
    expect((await f.ownerJournal.read()).entries).toHaveLength(64);
    expect(f.counts()).toEqual({ load: 0, key: 0, vault: 0, collect: 0 });
  } finally { await f.close(); }
}, 30_000);

it('keeps consumption after cancellation during the final authorize commit and rejects wrong journal master key', async () => {
  const f = await fixture();
  try {
    const packet = await f.finish(), abort = new AbortController();
    const original = f.recipientJournal.authorize.bind(f.recipientJournal);
    let opened: Uint8Array | undefined;
    vi.spyOn(f.recipientJournal, 'authorize').mockImplementation(async (check, operation) => {
      const result = await original(check, operation); if (result instanceof Uint8Array) opened = result;
      abort.abort(); return result;
    });
    await expect(f.recipientService.accept(packet, abort.signal)).rejects.toThrow();
    expect(opened?.length).toBe(32); expect(opened?.every(byte => byte === 0)).toBe(true);
    expect((await f.recipientJournal.read()).entries[0]?.phase).toBe('consumed');
    await expect(f.journal('recipient', randomBytes(32)).read()).rejects.toThrow();
    await expect(f.ownerJournal.initializeFresh()).rejects.toThrow('already exists');
  } finally { await f.close(); }
});

it('clears the actual opened key when the original owner-context deadline expires during final commit', async () => {
  const f = await fixture();
  try {
    const packet = await f.finish(), original = f.recipientJournal.authorize.bind(f.recipientJournal);
    let opened: Uint8Array | undefined;
    vi.spyOn(f.recipientJournal, 'authorize').mockImplementation(async (check, operation) => {
      const result = await original(check, operation); if (result instanceof Uint8Array) opened = result;
      f.setNow(packet.context.expiresAtMs); return result;
    });
    await expect(f.recipientService.accept(packet, signal())).rejects.toThrow('expired');
    expect(opened?.length).toBe(32); expect(opened?.every(byte => byte === 0)).toBe(true);
    expect((await f.recipientJournal.read()).entries[0]?.phase).toBe('consumed');
  } finally { await f.close(); }
});
