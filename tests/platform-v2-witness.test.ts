import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson, randomId } from '../src/common.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, hostTickSchema, leaseSchema } from '../src/host-kit/protocol.js';
import { platformQuoteSchema, platformQuoteTypes, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData,
  platformV2EvidenceDigest, platformV2ReceiptHash, preparePlatformV2EvidenceCore,
  type PlatformV2HistoricalAuthority } from '../src/receipts/platform-v2.js';
import { PlatformV2AdmissionWitnessJournal, platformV2AdmissionWitnessRows,
  verifyPlatformV2AdmissionWitness } from '../src/receipts/platform-v2-witness.js';
import { openStore } from '../src/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const escrow = '0x2222222222222222222222222222222222222222';
const registry = '0x3333333333333333333333333333333333333333';
const issuedAt = 1_700_000_000_000;
const image = `registry.example/telomere/cpu@sha256:${'a'.repeat(64)}`;

async function fixture() {
  const controller = new Ed25519Identity(), host = new Ed25519Identity();
  const signer = privateKeyToAccount(randomId()), runId = randomId();
  const quote = platformQuoteSchema.parse({ runId, leashId: randomId(), hostId: randomId(), payer: owner,
    hwClass: 0, regionHash: randomId(), imageHash: keccak256(toHex(image.split('@')[1]!)),
    workloadHash: randomId(), maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0',
    quoteExpiry: Math.floor(issuedAt / 1000) + 10 });
  const quoteSignature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: 31337, verifyingContract: escrow }, types: platformQuoteTypes,
  primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
  const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: host.publicKey,
    runId, owner, image, argv: ['/app/run', 'PRIVATE_ARGV'], stdin: 'PRIVATE_STDIN',
    issuedAt, expiresAt: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() }));
  const delegationBody = platformV2DelegationSchema.parse({ version: 2, chainId: 31337,
    escrow, hostRegistry: registry, runId, hostId: quote.hostId, hostKey: host.publicKey,
    controllerKey: controller.publicKey, quoteHash: hashJson(quote),
    signedLeaseHash: hostMessageHash(lease),
    meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }),
    leaseIssuedAtMs: issuedAt, leaseExpiresAtMs: lease.body.expiresAt,
    maxSeconds: 20, nonce: randomId() });
  const delegation = { body: delegationBody,
    signature: await signer.signTypedData(platformV2DelegationTypedData(delegationBody)) };
  const meter = new HostMeterVerifier(lease.body, controller, () => issuedAt + 1_000);
  const tick = host.sign('tick', hostTickSchema.parse({ version: 1, hostKey: host.publicKey,
    runId, owner, leaseHash: meter.leaseHash, sequence: 0, timestamp: issuedAt + 1_000,
    elapsedMs: 1_000, cpuMs: 100, state: 'EXITED', previousHash: null, heartbeat: null,
    gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
  const ack = meter.accept(tick);
  const historical: PlatformV2HistoricalAuthority = { chainId: 31337, escrow, hostRegistry: registry,
    quoteSigner: signer.address, runId, hostId: quote.hostId, hostKey: host.publicKey as Hex,
    payer: owner, leashId: quote.leashId, hwClass: 0, regionHash: quote.regionHash,
    imageHash: quote.imageHash, workloadHash: quote.workloadHash, pricePerSecond: '100',
    inferencePrice: '0', quoteExpiry: quote.quoteExpiry, maxSeconds: 20,
    openedAt: Math.floor(issuedAt / 1000), cutoff: Math.floor(issuedAt / 1000) + 20 };
  const prepared = await preparePlatformV2EvidenceCore({ quote, quoteSignature, delegation,
    lease, ticks: [tick], acknowledgments: [ack], endedAt: Math.floor(tick.body.timestamp / 1000),
    billableSeconds: 0, inferenceCharge: '0', status: 'completed', output: 'PRIVATE_OUTPUT',
    outputSalt: randomId() }, historical);
  const opening = { transactionHash: randomId(), blockHash: randomId() };
  const envelope = { version: 2 as const, admissionTx: opening.transactionHash,
    lease, quote, quoteSignature, delegation };
  const admission = host.sign('v2-admission', { version: 2 as const, chainId: 31337 as const,
    escrow, hostRegistry: registry, runId, hostId: quote.hostId, hostKey: host.publicKey,
    controllerKey: controller.publicKey, owner, admissionTx: opening.transactionHash,
    openingBlockHash: opening.blockHash, quoteHash: hashJson(quote),
    signedLeaseHash: hostMessageHash(lease), meterLeaseHash: delegationBody.meterLeaseHash,
    delegationHash: hashJson(delegation), envelopeHash: hashJson(envelope), acceptedAtMs: issuedAt });
  const witness = { protocol: 'telomere-platform-v2-admission-witness' as const,
    receiptHash: prepared.receiptHash, evidenceCoreDigest: prepared.evidenceCoreDigest,
    openingTransactionHash: opening.transactionHash, openingBlockHash: opening.blockHash,
    envelope, admission };
  return { witness, core: prepared.core, historical, opening, host, lease };
}

describe('private Platform v2 host admission witness', () => {
  it('cross-binds the original lease, host receipt, delegation, full core and opening', async () => {
    const value = await fixture();
    const checked = await verifyPlatformV2AdmissionWitness(value.witness, value.core,
      value.historical, value.opening);
    expect(checked).toMatchObject({ hostAdmissionVerified: true,
      onchainReceiptVerified: false, independentlyPublished: false,
      historicalDelegationIssuanceTimeProven: false });
    expect(JSON.stringify(value.core)).not.toContain('PRIVATE_ARGV');
    expect(JSON.stringify(value.core)).not.toContain('PRIVATE_STDIN');
    expect(JSON.stringify(value.core)).not.toContain('PRIVATE_OUTPUT');
    expect(JSON.stringify(checked.witness)).toContain('PRIVATE_ARGV');
  });

  it('rejects a different opening, envelope, host signature, lease and core', async () => {
    const value = await fixture();
    await expect(verifyPlatformV2AdmissionWitness(value.witness, value.core,
      value.historical, { ...value.opening, blockHash: randomId() })).rejects.toThrow('opening');
    await expect(verifyPlatformV2AdmissionWitness({ ...value.witness,
      envelope: { ...value.witness.envelope, admissionTx: randomId() } }, value.core,
    value.historical, value.opening)).rejects.toThrow('opening');
    await expect(verifyPlatformV2AdmissionWitness({ ...value.witness,
      admission: { ...value.witness.admission, signature: value.lease.signature } }, value.core,
    value.historical, value.opening)).rejects.toThrow('host admission');
    const lateAdmission = value.host.sign('v2-admission', {
      ...value.witness.admission.body, acceptedAtMs: issuedAt + 2_000 });
    await expect(verifyPlatformV2AdmissionWitness({ ...value.witness, admission: lateAdmission },
      value.core, value.historical, value.opening)).rejects.toThrow('tick ordering');
    await expect(verifyPlatformV2AdmissionWitness({ ...value.witness,
      envelope: { ...value.witness.envelope, lease: { ...value.lease,
        body: { ...value.lease.body, nonce: randomId() } } } }, value.core,
    value.historical, value.opening)).rejects.toThrow('signed lease');
    await expect(verifyPlatformV2AdmissionWitness(value.witness,
      { ...value.core, outputCommitment: randomId() }, value.historical,
    value.opening)).rejects.toThrow('core');
  });

  it('requires the private witness to equal the admission receipt committed by the public core', async () => {
    const value = await fixture();
    const core = { ...value.core, hostAdmission: value.witness.admission };
    const witness = { ...value.witness, receiptHash: platformV2ReceiptHash(core),
      evidenceCoreDigest: platformV2EvidenceDigest(core) };
    expect(await verifyPlatformV2AdmissionWitness(witness, core, value.historical, value.opening))
      .toMatchObject({ hostAdmissionVerified: true, historicalDelegationIssuanceTimeProven: false });
    const changedAdmission = value.host.sign('v2-admission', {
      ...witness.admission.body, acceptedAtMs: issuedAt + 500 });
    await expect(verifyPlatformV2AdmissionWitness({ ...witness, admission: changedAdmission }, core,
      value.historical, value.opening)).rejects.toThrow('original core or opening');
  });

  it('reopens one exact witness and rejects changed retries and corrupted rows', async () => {
    const value = await fixture(), directory = await mkdtemp(join(tmpdir(), 'telomere-v2-witness-'));
    let store = await openStore({ DATA_DIR: directory });
    try {
      let journal = new PlatformV2AdmissionWitnessJournal(store.db, 31337, escrow, registry);
      await journal.initialize();
      const wrongScope = new PlatformV2AdmissionWitnessJournal(store.db, 31337, escrow,
        '0x4444444444444444444444444444444444444444');
      await expect(wrongScope.record(value.witness, value.core, value.historical,
        value.opening)).rejects.toThrow('deployment scope');
      expect(await store.db.select().from(platformV2AdmissionWitnessRows)).toHaveLength(0);
      const first = await journal.record(value.witness, value.core, value.historical, value.opening);
      await store.close();
      store = await openStore({ DATA_DIR: directory });
      journal = new PlatformV2AdmissionWitnessJournal(store.db, 31337, escrow, registry);
      expect(await journal.get(value.core.quote.runId, value.core, value.historical, value.opening)).toEqual(first);
      expect(await journal.record(value.witness, value.core, value.historical, value.opening)).toEqual(first);
      const changedAdmission = value.host.sign('v2-admission', {
        ...value.witness.admission.body, acceptedAtMs: issuedAt + 500 });
      await expect(journal.record({ ...value.witness, admission: changedAdmission },
        value.core, value.historical, value.opening)).rejects.toThrow('conflicts');
      await store.db.update(platformV2AdmissionWitnessRows).set({ witnessHash: randomId() })
        .where(eq(platformV2AdmissionWitnessRows.runId, value.core.quote.runId));
      await expect(journal.get(value.core.quote.runId, value.core, value.historical,
        value.opening)).rejects.toThrow('changed after insertion');
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
