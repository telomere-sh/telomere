import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson, randomId } from '../src/common.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, hostTickSchema, leaseSchema,
  type SignedHostAck, type SignedHostTick } from '../src/host-kit/protocol.js';
import { platformQuoteSchema, platformQuoteTypes, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData, platformV2EvidenceCoreSchema,
  platformV2ReceiptHash, preparePlatformV2EvidenceCore, verifyPlatformV2EvidenceCore,
  type PlatformV2HistoricalAuthority, type PlatformV2PrivateInput } from '../src/receipts/platform-v2.js';
import { hostV2AdmissionReceiptSchema } from '../src/host-kit/v2-admission-receipt.js';
import { PlatformV2EvidenceJournal, platformV2EvidenceJournal } from '../src/receipts/platform-v2-journal.js';
import { openStore } from '../src/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const escrow = '0x2222222222222222222222222222222222222222';
const registry = '0x3333333333333333333333333333333333333333';
const image = `registry.example/telomere/cpu@sha256:${'a'.repeat(64)}`;
const issuedAt = 1_700_000_000_000;
const outputSalt = `0x${'d'.repeat(64)}`;

async function fixture() {
  const control = new Ed25519Identity(), host = new Ed25519Identity();
  const signer = privateKeyToAccount(randomId());
  const runId = randomId();
  const quote = platformQuoteSchema.parse({ runId, leashId: randomId(), hostId: randomId(), payer: owner,
    hwClass: 0, regionHash: randomId(), imageHash: keccak256(toHex(image.split('@')[1]!)),
    workloadHash: randomId(), maxSeconds: 30, pricePerSecond: '100', inferencePrice: '0',
    quoteExpiry: Math.floor(issuedAt / 1000) + 20 });
  const quoteSignature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: 31337, verifyingContract: escrow }, types: platformQuoteTypes, primaryType: 'PlatformQuote',
  message: typedPlatformQuote(quote) });
  const body = leaseSchema.parse({ version: 1, hostKey: host.publicKey, runId, owner, image,
    argv: ['/app/run', 'PRIVATE_ARGV_NEVER_PUBLISH'], stdin: 'PRIVATE_STDIN_NEVER_PUBLISH',
    issuedAt, expiresAt: issuedAt + 30_000, maxSeconds: 30, nonce: randomId() });
  const lease = control.sign('lease', body);
  const delegationBody = platformV2DelegationSchema.parse({ version: 2, chainId: 31337,
    escrow, hostRegistry: registry, runId, hostId: quote.hostId, hostKey: host.publicKey,
    controllerKey: control.publicKey, quoteHash: hashJson(quote),
    signedLeaseHash: hostMessageHash(lease), meterLeaseHash: hostMessageHash({ body, signature: '' }),
    leaseIssuedAtMs: issuedAt, leaseExpiresAtMs: issuedAt + 30_000, maxSeconds: 30, nonce: randomId() });
  const delegation = { body: delegationBody,
    signature: await signer.signTypedData(platformV2DelegationTypedData(delegationBody)) };
  let now = issuedAt;
  const meter = new HostMeterVerifier(body, control, () => now);
  const ticks: SignedHostTick[] = [], acknowledgments: SignedHostAck[] = [];
  for (const [sequence, state] of ['RUNNING', 'RUNNING', 'EXITED'].entries()) {
    const elapsedMs = sequence * 5000;
    now = issuedAt + elapsedMs;
    const tick = host.sign('tick', hostTickSchema.parse({ version: 1, hostKey: host.publicKey,
      runId, owner, leaseHash: meter.leaseHash, sequence, timestamp: now, elapsedMs,
      cpuMs: elapsedMs, state, previousHash: ticks.length ? hostMessageHash(ticks.at(-1)!) : null,
      heartbeat: state === 'RUNNING' ? { sequence, elapsedMs, receivedAt: now } : null,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    const ack = meter.accept(tick);
    ticks.push(tick); acknowledgments.push(ack);
  }
  const input: PlatformV2PrivateInput = { quote, quoteSignature, delegation, lease, ticks, acknowledgments,
    endedAt: Math.floor(now / 1000), billableSeconds: meter.billableSeconds, inferenceCharge: '0',
    status: 'completed', output: 'low entropy result', outputSalt };
  const historical: PlatformV2HistoricalAuthority = { chainId: 31337, escrow, hostRegistry: registry,
    quoteSigner: signer.address, runId: quote.runId, hostId: quote.hostId, hostKey: host.publicKey as Hex,
    payer: owner, leashId: quote.leashId, hwClass: quote.hwClass, regionHash: quote.regionHash,
    imageHash: quote.imageHash, workloadHash: quote.workloadHash,
    pricePerSecond: quote.pricePerSecond, inferencePrice: quote.inferencePrice,
    quoteExpiry: quote.quoteExpiry, maxSeconds: 30,
    openedAt: Math.floor(issuedAt / 1000), cutoff: Math.floor(issuedAt / 1000) + 30 };
  return { input, historical, control, host, signer };
}

describe('default-off Platform v2 ordered signed tick/ACK evidence core', () => {
  it('commits all ordered pairs with historical quote-signer delegation without exposing private lease or output', async () => {
    const { input, historical } = await fixture();
    const prepared = await preparePlatformV2EvidenceCore(input, historical);
    const checked = await verifyPlatformV2EvidenceCore(prepared.core, prepared.receiptHash, historical);
    expect(checked).toMatchObject({ receiptHash: prepared.receiptHash,
      hostPairCount: 3, eligibleBillableSeconds: 5, evidenceCorePairSignaturesVerified: true,
      terminalTickStateConsistent: true, executionStatusProven: false,
      hostAdmissionVerified: false, historicalDelegationIssuanceTimeProven: false,
      onchainReceiptVerified: false, independentlyPublished: false, outputVerified: false });
    const publicBytes = JSON.stringify(prepared.core);
    for (const secret of ['PRIVATE_ARGV_NEVER_PUBLISH', 'PRIVATE_STDIN_NEVER_PUBLISH',
      'low entropy result', outputSalt]) expect(publicBytes).not.toContain(secret);
    expect(prepared.core.delegation.body.signedLeaseHash).not.toBe(prepared.core.delegation.body.meterLeaseHash);
    expect(platformV2ReceiptHash(platformV2EvidenceCoreSchema.parse(JSON.parse(publicBytes)))).toBe(prepared.receiptHash);
    const restarted = JSON.parse(JSON.stringify(input)) as PlatformV2PrivateInput;
    expect(await preparePlatformV2EvidenceCore(restarted, historical)).toEqual(prepared);
    const changedSalt = await preparePlatformV2EvidenceCore({ ...input, outputSalt: `0x${'e'.repeat(64)}` }, historical);
    expect(changedSalt.receiptHash).not.toBe(prepared.receiptHash);
  });

  it('preserves the original v2 digest without admission and commits a host-signed receipt when present', async () => {
    const { input, historical, host } = await fixture();
    const legacy = await preparePlatformV2EvidenceCore(input, historical);
    // This is the original pre-extension receipt formula and complete field set.
    const legacyCore = { protocol: legacy.core.protocol, quote: input.quote, quoteSignature: input.quoteSignature,
      delegation: input.delegation, ticks: input.ticks, acknowledgments: input.acknowledgments,
      hostEvidenceRoot: legacy.core.hostEvidenceRoot, hostPairCount: legacy.core.hostPairCount,
      endedAt: input.endedAt, billableSeconds: input.billableSeconds, inferenceCharge: input.inferenceCharge,
      status: input.status, outputCommitment: legacy.core.outputCommitment };
    expect(legacy.evidenceCoreDigest).toBe(hashJson(legacyCore));
    expect(legacy.receiptHash).toBe(hashJson({ protocol: 'telomere-platform-receipt-v2',
      evidenceCoreDigest: hashJson(legacyCore) }));
    expect('hostAdmission' in legacy.core).toBe(false);
    const envelope = { version: 2, admissionTx: randomId(), lease: input.lease,
      quote: input.quote, quoteSignature: input.quoteSignature, delegation: input.delegation };
    const hostAdmission = hostV2AdmissionReceiptSchema.parse(host.sign('v2-admission', {
      version: 2, chainId: 31337, escrow, hostRegistry: registry,
      runId: input.quote.runId, hostId: input.quote.hostId, hostKey: host.publicKey,
      controllerKey: input.delegation.body.controllerKey, owner,
      admissionTx: envelope.admissionTx, openingBlockHash: randomId(),
      quoteHash: input.delegation.body.quoteHash, signedLeaseHash: input.delegation.body.signedLeaseHash,
      meterLeaseHash: input.delegation.body.meterLeaseHash, delegationHash: hashJson(input.delegation),
      envelopeHash: hashJson(envelope), acceptedAtMs: issuedAt,
    }));
    const prepared = await preparePlatformV2EvidenceCore({ ...input, hostAdmission }, historical);
    expect(prepared.core.hostAdmission).toEqual(hostAdmission);
    expect(prepared.receiptHash).not.toBe(legacy.receiptHash);
    expect(await verifyPlatformV2EvidenceCore(prepared.core, prepared.receiptHash, historical))
      .toMatchObject({ hostAdmissionVerified: true, historicalDelegationIssuanceTimeProven: false });
    await expect(verifyPlatformV2EvidenceCore(legacy.core, prepared.receiptHash, historical))
      .rejects.toThrow('receipt hash');
    const changedSignature = { ...prepared.core, hostAdmission: {
      ...hostAdmission, signature: input.lease.signature } };
    await expect(verifyPlatformV2EvidenceCore(changedSignature, platformV2ReceiptHash(changedSignature), historical))
      .rejects.toThrow('host admission');
    for (const changed of [{ chainId: 84532 as const }, { escrow: owner }, { hostRegistry: owner },
      { runId: randomId() }, { hostId: randomId() }, { hostKey: randomId() }, { controllerKey: randomId() },
      { owner: escrow }, { quoteHash: randomId() }, { signedLeaseHash: randomId() },
      { meterLeaseHash: randomId() }, { delegationHash: randomId() },
      { admissionTx: `0x${'0'.repeat(64)}` }, { openingBlockHash: `0x${'0'.repeat(64)}` },
      { envelopeHash: `0x${'0'.repeat(64)}` }, { acceptedAtMs: issuedAt - 5001 },
      { acceptedAtMs: issuedAt + 1 }, { acceptedAtMs: input.lease.body.expiresAt + 1 }]) {
      const changedCore = { ...prepared.core, hostAdmission: hostV2AdmissionReceiptSchema.parse(
        host.sign('v2-admission', { ...hostAdmission.body, ...changed })) };
      await expect(verifyPlatformV2EvidenceCore(changedCore, platformV2ReceiptHash(changedCore), historical))
        .rejects.toThrow('host admission');
    }
    const wrongEnvelope = host.sign('v2-admission', { ...hostAdmission.body, envelopeHash: randomId() });
    await expect(preparePlatformV2EvidenceCore({ ...input, hostAdmission: wrongEnvelope }, historical))
      .rejects.toThrow('exact original private envelope');
    const publicBytes = JSON.stringify(prepared.core);
    for (const secret of ['PRIVATE_ARGV_NEVER_PUBLISH', 'PRIVATE_STDIN_NEVER_PUBLISH',
      input.output, outputSalt]) expect(publicBytes).not.toContain(secret);
  });

  it('fails closed on delegated-controller, quote, host, pair-order, signature and billing changes', async () => {
    const { input, historical, control, host } = await fixture();
    const { core, receiptHash } = await preparePlatformV2EvidenceCore(input, historical);
    await expect(verifyPlatformV2EvidenceCore(core, receiptHash,
      { ...historical, quoteSigner: owner })).rejects.toThrow('delegation');
    await expect(verifyPlatformV2EvidenceCore(core, receiptHash,
      { ...historical, hostKey: randomId() })).rejects.toThrow('authority');
    for (const changed of [{ leashId: randomId() }, { regionHash: randomId() },
      { pricePerSecond: '101' }, { inferencePrice: '1' }, { quoteExpiry: historical.quoteExpiry + 1 },
      { imageHash: randomId() },
      { workloadHash: randomId() }]) {
      await expect(verifyPlatformV2EvidenceCore(core, receiptHash,
        { ...historical, ...changed })).rejects.toThrow('authority');
    }
    await expect(verifyPlatformV2EvidenceCore({ ...core, quoteSignature: core.delegation.signature },
      receiptHash, historical)).rejects.toThrow('quote signature');
    await expect(verifyPlatformV2EvidenceCore({ ...core, ticks: [...core.ticks].reverse() },
      receiptHash, historical)).rejects.toThrow('tick/ACK');
    await expect(verifyPlatformV2EvidenceCore({ ...core, ticks: core.ticks.slice(0, 2),
      acknowledgments: core.acknowledgments.slice(0, 2), hostPairCount: 2 },
    receiptHash, historical)).rejects.toThrow();
    const forgedTick = host.sign('tick', { ...core.ticks[1]!.body, cpuMs: 9999 });
    await expect(verifyPlatformV2EvidenceCore({ ...core,
      ticks: [core.ticks[0]!, forgedTick, core.ticks[2]!] }, receiptHash, historical)).rejects.toThrow('tick/ACK');
    const forgedAck = control.sign('ack', { ...core.acknowledgments[1]!.body, billableSeconds: 0 });
    await expect(verifyPlatformV2EvidenceCore({ ...core,
      acknowledgments: [core.acknowledgments[0]!, forgedAck, core.acknowledgments[2]!] },
    receiptHash, historical)).rejects.toThrow('accounting');
    await expect(verifyPlatformV2EvidenceCore({ ...core, billableSeconds: 6 },
      receiptHash, historical)).rejects.toThrow('settlement');
    await expect(verifyPlatformV2EvidenceCore({ ...core, status: 'cancelled' },
      receiptHash, historical)).rejects.toThrow('terminal meter');
    await expect(verifyPlatformV2EvidenceCore(core, randomId(), historical)).rejects.toThrow('receipt hash');
    await expect(preparePlatformV2EvidenceCore({ ...input,
      lease: control.sign('lease', { ...input.lease.body, runId: randomId() }) }, historical)).rejects.toThrow('lease');
    await expect(preparePlatformV2EvidenceCore({ ...input,
      outputSalt: `0x${'0'.repeat(64)}` }, historical)).rejects.toThrow('salt');
  });

  it('persists one immutable-by-API core and private salt across disk reopen, rejecting replay changes and row corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-v2-core-'));
    const { input, historical } = await fixture();
    const prepared = await preparePlatformV2EvidenceCore(input, historical);
    let store = await openStore({ DATA_DIR: directory });
    try {
      let journal = new PlatformV2EvidenceJournal(store.db, 31337, escrow, registry);
      await journal.initialize();
      const first = await journal.record(input, historical);
      expect(first.receiptHash).toBe(prepared.receiptHash);
      await store.close();
      store = await openStore({ DATA_DIR: directory });
      journal = new PlatformV2EvidenceJournal(store.db, 31337, escrow, registry);
      expect(await journal.get(input.quote.runId)).toEqual(first);
      expect(await journal.record(input, historical)).toEqual(first);
      await expect(journal.record({ ...input, outputSalt: `0x${'e'.repeat(64)}` },
        historical)).rejects.toThrow('conflicts');
      await expect(journal.record({ ...input, output: 'changed result' },
        historical)).rejects.toThrow('conflicts');
      await store.db.update(platformV2EvidenceJournal).set({ receiptHash: randomId() })
        .where(eq(platformV2EvidenceJournal.runId, input.quote.runId));
      await expect(journal.get(input.quote.runId)).rejects.toThrow('preimage changed');
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
