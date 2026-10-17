import { keccak256, toHex, verifyTypedData, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema, randomId, sameAddress, signatureSchema } from '../common.js';
import { billableHostInterval } from '../host-kit/meter.js';
import { HOST_TICK_MS, hostKeySchema, hostMessageHash, signedAckSchema, signedLeaseSchema,
  signedTickSchema, verifyHostMessage, type SignedHostTick } from '../host-kit/protocol.js';
import { platformFeeDiscountBpsSchema, platformQuoteSchema, platformQuoteTypes, typedPlatformQuote } from '../platform-runtime/types.js';
import { hostV2AdmissionReceiptSchema } from '../host-kit/v2-admission-receipt.js';

const zero = `0x${'0'.repeat(64)}` as Hex;
const maxPairs = 100;
export const PLATFORM_V2_CORE_MAX_BYTES = 256 * 1024;
const boundedTime = z.number().int().nonnegative().safe();
const statusSchema = z.enum(['completed', 'failed', 'cancelled', 'timed_out']);

/** The quote EOA delegates exactly one private HostKit lease to one controller key. */
export const platformV2DelegationSchema = z.object({
  version: z.literal(2), chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]),
  escrow: addressSchema, hostRegistry: addressSchema, runId: bytes32Schema, hostId: bytes32Schema,
  hostKey: hostKeySchema, controllerKey: hostKeySchema, quoteHash: bytes32Schema,
  signedLeaseHash: bytes32Schema, meterLeaseHash: bytes32Schema,
  leaseIssuedAtMs: boundedTime, leaseExpiresAtMs: boundedTime,
  maxSeconds: z.number().int().min(1).max(120), nonce: bytes32Schema,
}).strict().refine(value => value.leaseExpiresAtMs === value.leaseIssuedAtMs + value.maxSeconds * 1000
  && value.leaseIssuedAtMs > 0 && value.signedLeaseHash !== zero && value.meterLeaseHash !== zero,
  'Delegation must bind one bounded original lease');
export type PlatformV2Delegation = z.infer<typeof platformV2DelegationSchema>;
export const signedPlatformV2DelegationSchema = z.object({
  body: platformV2DelegationSchema, signature: signatureSchema,
}).strict();
export type SignedPlatformV2Delegation = z.infer<typeof signedPlatformV2DelegationSchema>;
export const platformV2DelegationTypes = { MeterDelegation: [
  { name: 'hostRegistry', type: 'address' }, { name: 'runId', type: 'bytes32' },
  { name: 'hostId', type: 'bytes32' }, { name: 'hostKey', type: 'bytes32' },
  { name: 'controllerKey', type: 'bytes32' }, { name: 'quoteHash', type: 'bytes32' },
  { name: 'signedLeaseHash', type: 'bytes32' }, { name: 'meterLeaseHash', type: 'bytes32' },
  { name: 'leaseIssuedAtMs', type: 'uint64' }, { name: 'leaseExpiresAtMs', type: 'uint64' },
  { name: 'maxSeconds', type: 'uint64' }, { name: 'nonce', type: 'bytes32' },
] } as const;
export function platformV2DelegationTypedData(body: PlatformV2Delegation) {
  return { domain: { name: 'TelomereMeterDelegation', version: '2', chainId: body.chainId,
    verifyingContract: body.escrow }, types: platformV2DelegationTypes, primaryType: 'MeterDelegation' as const,
  message: { hostRegistry: body.hostRegistry, runId: body.runId, hostId: body.hostId,
    hostKey: body.hostKey as Hex, controllerKey: body.controllerKey as Hex, quoteHash: body.quoteHash,
    signedLeaseHash: body.signedLeaseHash, meterLeaseHash: body.meterLeaseHash,
    leaseIssuedAtMs: BigInt(body.leaseIssuedAtMs), leaseExpiresAtMs: BigInt(body.leaseExpiresAtMs),
    maxSeconds: BigInt(body.maxSeconds), nonce: body.nonce } };
}
export function newPlatformV2OutputSalt(): Hex { return randomId(); }
export function platformV2OutputCommitment(output: string, saltValue: string): Hex {
  const salt = bytes32Schema.parse(saltValue);
  if (salt === zero || Buffer.byteLength(output, 'utf8') > 16_384
    || Buffer.from(output, 'utf8').toString('utf8') !== output) {
    throw new Error('Platform v2 output or private random salt is invalid');
  }
  return hashJson({ protocol: 'telomere-platform-output-commitment-v2', salt,
    digest: keccak256(toHex(output)) });
}

/** Only public data: no command argv/stdin, raw output or output salt. */
export const platformV2EvidenceCoreSchema = z.object({
  protocol: z.literal('telomere-platform-evidence-core-v2'),
  quote: platformQuoteSchema, quoteSignature: signatureSchema,
  delegation: signedPlatformV2DelegationSchema,
  /** Optional only for historical v2 compatibility; new producers require this testimony. */
  hostAdmission: hostV2AdmissionReceiptSchema.optional(),
  ticks: z.array(signedTickSchema).min(1).max(maxPairs),
  acknowledgments: z.array(signedAckSchema).min(1).max(maxPairs),
  hostEvidenceRoot: bytes32Schema, hostPairCount: z.number().int().min(1).max(maxPairs),
  endedAt: z.number().int().positive().safe(), billableSeconds: z.number().int().min(0).max(120),
  inferenceCharge: z.literal('0'), status: statusSchema, outputCommitment: bytes32Schema,
}).strict();
export type PlatformV2EvidenceCore = z.infer<typeof platformV2EvidenceCoreSchema>;
export function platformV2EvidenceDigest(core: PlatformV2EvidenceCore): Hex {
  return hashJson(platformV2EvidenceCoreSchema.parse(core));
}
export function platformV2ReceiptHash(core: PlatformV2EvidenceCore): Hex {
  return hashJson({ protocol: 'telomere-platform-receipt-v2', evidenceCoreDigest: platformV2EvidenceDigest(core) });
}
export const platformV2HistoricalAuthoritySchema = z.object({
  /** These values must come from a canonical archive-RPC snapshot at RunOpened, not from the bundle. */
  chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]), escrow: addressSchema,
  hostRegistry: addressSchema, quoteSigner: addressSchema, runId: bytes32Schema,
  /** Omitted for immutable v1 compatibility. Only a reviewed economics-v2
   * archive reader may select domain 2 and its admission-locked fee tier. */
  quoteDomainVersion: z.literal('2').optional(), feeDiscountBps: platformFeeDiscountBpsSchema.optional(),
  hostId: bytes32Schema, hostKey: hostKeySchema, payer: addressSchema, leashId: bytes32Schema,
  hwClass: z.literal(0), regionHash: bytes32Schema,
  imageHash: bytes32Schema, workloadHash: bytes32Schema,
  pricePerSecond: moneySchema, inferencePrice: moneySchema,
  /** The escrow does not store this field; a future reader must decode the canonical open transaction. */
  quoteExpiry: z.number().int().positive().safe(),
  maxSeconds: z.number().int().min(1).max(120), openedAt: boundedTime, cutoff: boundedTime,
}).strict().refine(value => (value.quoteDomainVersion === '2') === (value.feeDiscountBps !== undefined)
  && value.quoteExpiry >= value.openedAt
  && value.cutoff >= value.openedAt
  && value.cutoff <= value.openedAt + value.maxSeconds, 'Historical run cutoff is invalid');
export type PlatformV2HistoricalAuthority = z.infer<typeof platformV2HistoricalAuthoritySchema>;

function checkedPairs(core: PlatformV2EvidenceCore): { hostEvidenceRoot: Hex; eligibleBillableSeconds: number } {
  const { body: delegation } = core.delegation;
  if (core.ticks.length !== core.acknowledgments.length || core.hostPairCount !== core.ticks.length) {
    throw new Error('Platform v2 signed HostKit pair count changed');
  }
  let root = hashJson({ protocol: 'telomere-platform-host-evidence-v2', runId: delegation.runId,
    hostKey: delegation.hostKey, controllerKey: delegation.controllerKey,
    signedLeaseHash: delegation.signedLeaseHash, meterLeaseHash: delegation.meterLeaseHash });
  let previous: SignedHostTick | undefined, billable = 0, eligible = 0, faulted = false;
  let acceptedAt = delegation.leaseIssuedAtMs;
  for (const [index, tick] of core.ticks.entries()) {
    const ack = core.acknowledgments[index]!, body = tick.body, accepted = ack.body;
    if (faulted || !verifyHostMessage(delegation.hostKey, 'tick', tick)
      || !verifyHostMessage(delegation.controllerKey, 'ack', ack)
      || body.hostKey !== delegation.hostKey || accepted.hostKey !== delegation.hostKey
      || body.runId !== delegation.runId || accepted.runId !== delegation.runId
      || body.owner !== core.quote.payer.toLowerCase()
      || body.leaseHash !== delegation.meterLeaseHash || accepted.leaseHash !== delegation.meterLeaseHash
      || body.sequence !== index || accepted.sequence !== index
      || body.previousHash !== (previous ? hostMessageHash(previous) : null)
      || accepted.tickHash !== hostMessageHash(tick)
      || body.elapsedMs > delegation.maxSeconds * 1000
      || body.timestamp < delegation.leaseIssuedAtMs - 5000 || body.timestamp > delegation.leaseExpiresAtMs + 5000
      || body.timestamp - (previous?.body.timestamp ?? delegation.leaseIssuedAtMs) >= HOST_TICK_MS * 3
      || Math.abs(accepted.acceptedAt - body.timestamp) > 5000 || accepted.acceptedAt < acceptedAt
      || previous && (previous.body.state !== 'RUNNING' || body.timestamp <= previous.body.timestamp
        || body.elapsedMs < previous.body.elapsedMs || body.cpuMs < previous.body.cpuMs
        || body.elapsedMs - previous.body.elapsedMs > body.timestamp - previous.body.timestamp + 1000)) {
      throw new Error('Platform v2 signed HostKit tick/ACK history changed');
    }
    const delta = billableHostInterval(previous, tick, billable, delegation.maxSeconds);
    billable += delta; faulted = body.state === 'FAULT'; acceptedAt = accepted.acceptedAt;
    if (accepted.billableDelta !== delta || accepted.billableSeconds !== billable || accepted.fault !== faulted) {
      throw new Error('Platform v2 HostKit ACK accounting changed');
    }
    if (body.timestamp <= (core.endedAt + 1) * 1000) eligible = billable;
    root = hashJson({ protocol: 'telomere-platform-host-pair-v2', previousRoot: root,
      sequence: index, tickHash: hostMessageHash(tick), ackHash: hostMessageHash(ack) });
    previous = tick;
  }
  const terminal = previous?.body.state;
  const statusConsistent = core.status === 'completed' ? terminal === 'EXITED'
    : core.status === 'failed' ? terminal === 'EXITED' || terminal === 'FAULT'
      : terminal === 'STOPPED';
  if (!statusConsistent || core.billableSeconds > eligible
    || root !== core.hostEvidenceRoot) {
    throw new Error('Platform v2 terminal meter, commitment or settlement is inconsistent');
  }
  return { hostEvidenceRoot: root, eligibleBillableSeconds: eligible };
}

/** The host's signed clock is testimony, not an independent proof of delegation issuance time. */
function checkedHostAdmission(core: PlatformV2EvidenceCore, authority: PlatformV2HistoricalAuthority): boolean {
  const admission = core.hostAdmission;
  if (!admission) return false;
  const body = admission.body, delegation = core.delegation.body;
  if (!verifyHostMessage(delegation.hostKey, 'v2-admission', admission)
    || body.chainId !== delegation.chainId || !sameAddress(body.escrow, delegation.escrow)
    || !sameAddress(body.hostRegistry, delegation.hostRegistry)
    || body.runId !== delegation.runId || body.hostId !== delegation.hostId
    || body.hostKey !== delegation.hostKey || body.controllerKey !== delegation.controllerKey
    || !sameAddress(body.owner, core.quote.payer) || body.quoteHash !== delegation.quoteHash
    || body.signedLeaseHash !== delegation.signedLeaseHash || body.meterLeaseHash !== delegation.meterLeaseHash
    || body.delegationHash !== hashJson(core.delegation)
    || [body.runId, body.hostId, body.hostKey, body.controllerKey, body.admissionTx, body.openingBlockHash,
      body.quoteHash, body.signedLeaseHash, body.meterLeaseHash, body.delegationHash, body.envelopeHash].includes(zero)
    || [body.escrow, body.hostRegistry, body.owner].some(address => /^0x0{40}$/i.test(address))
    || body.acceptedAtMs < delegation.leaseIssuedAtMs - 5000
    || body.acceptedAtMs < authority.openedAt * 1000 - 5000
    || body.acceptedAtMs > delegation.leaseExpiresAtMs || body.acceptedAtMs > authority.cutoff * 1000
    || body.acceptedAtMs > core.ticks[0]!.body.timestamp) {
    throw new Error('Platform v2 host admission signature, scope or tick ordering changed');
  }
  return true;
}

/** Cryptographic half of the public verifier. Historical authority must be supplied by canonical RPC reads. */
export async function verifyPlatformV2EvidenceCore(raw: unknown, expectedReceiptHash: string,
  historical: PlatformV2HistoricalAuthority) {
  const core = platformV2EvidenceCoreSchema.parse(raw), authority = platformV2HistoricalAuthoritySchema.parse(historical);
  if (Buffer.byteLength(JSON.stringify(core), 'utf8') > PLATFORM_V2_CORE_MAX_BYTES) {
    throw new Error('Platform v2 evidence core exceeds its public bound');
  }
  const { body: delegation, signature } = core.delegation, quote = core.quote;
  if (delegation.chainId !== authority.chainId || !sameAddress(delegation.escrow, authority.escrow)
    || !sameAddress(delegation.hostRegistry, authority.hostRegistry)
    || delegation.runId !== authority.runId || delegation.hostId !== authority.hostId
    || delegation.hostKey !== authority.hostKey || quote.runId !== authority.runId
    || quote.hostId !== authority.hostId || !sameAddress(quote.payer, authority.payer)
    || quote.leashId !== authority.leashId || quote.hwClass !== authority.hwClass
    || quote.regionHash !== authority.regionHash || quote.pricePerSecond !== authority.pricePerSecond
    || quote.inferencePrice !== authority.inferencePrice || quote.quoteExpiry !== authority.quoteExpiry
    || quote.imageHash !== authority.imageHash || quote.workloadHash !== authority.workloadHash
    || quote.maxSeconds !== authority.maxSeconds || delegation.maxSeconds !== quote.maxSeconds
    || delegation.quoteHash !== hashJson(quote) || quote.inferencePrice !== '0'
    || delegation.leaseIssuedAtMs < authority.openedAt * 1000 - 5000
    || core.endedAt < authority.openedAt || core.endedAt > authority.cutoff
    || core.outputCommitment === zero) {
    throw new Error('Platform v2 public core differs from its historical run authority');
  }
  const delegated = await verifyTypedData({ address: authority.quoteSigner,
    ...platformV2DelegationTypedData(delegation), signature });
  const quoted = await verifyTypedData({ address: authority.quoteSigner,
    domain: { name: 'TelomerePlatformEscrow', version: authority.quoteDomainVersion ?? '1', chainId: authority.chainId,
      verifyingContract: authority.escrow }, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote), signature: core.quoteSignature });
  if (!delegated || !quoted) throw new Error('Platform v2 controller delegation or original quote signature is invalid');
  const hostAdmissionVerified = checkedHostAdmission(core, authority);
  const pairs = checkedPairs(core), receiptHash = platformV2ReceiptHash(core);
  if (receiptHash !== bytes32Schema.parse(expectedReceiptHash)) {
    throw new Error('Platform v2 evidence differs from the committed receipt hash');
  }
  return { receiptHash, evidenceCoreDigest: platformV2EvidenceDigest(core),
    hostEvidenceRoot: pairs.hostEvidenceRoot, hostPairCount: core.hostPairCount,
    eligibleBillableSeconds: pairs.eligibleBillableSeconds, evidenceCorePairSignaturesVerified: true as const,
    terminalTickStateConsistent: true as const, executionStatusProven: false as const,
    hostAdmissionVerified, historicalDelegationIssuanceTimeProven: false as const,
    historicalAuthoritySource: 'caller-supplied' as const, onchainReceiptVerified: false as const,
    independentlyPublished: false as const, outputVerified: false as const };
}

export const platformV2PrivateInputSchema = z.object({
  quote: platformQuoteSchema, quoteSignature: signatureSchema,
  delegation: signedPlatformV2DelegationSchema, lease: signedLeaseSchema,
  hostAdmission: hostV2AdmissionReceiptSchema.optional(),
  ticks: z.array(signedTickSchema).min(1).max(maxPairs),
  acknowledgments: z.array(signedAckSchema).min(1).max(maxPairs),
  endedAt: z.number().int().positive().safe(), billableSeconds: z.number().int().min(0).max(120),
  inferenceCharge: z.literal('0'), status: statusSchema,
  output: z.string(), outputSalt: bytes32Schema,
}).strict();
export type PlatformV2PrivateInput = z.input<typeof platformV2PrivateInputSchema>;

/** Prepares immutable public bytes from already persisted private HostKit evidence. No settlement is submitted. */
export async function preparePlatformV2EvidenceCore(raw: PlatformV2PrivateInput,
  historical: PlatformV2HistoricalAuthority) {
  const input = platformV2PrivateInputSchema.parse(raw), { body: delegation } = input.delegation;
  const lease = input.lease, quote = input.quote;
  if (!verifyHostMessage(delegation.controllerKey, 'lease', lease)
    || lease.body.hostKey !== delegation.hostKey || lease.body.runId !== delegation.runId
    || lease.body.owner !== quote.payer.toLowerCase() || lease.body.maxSeconds !== quote.maxSeconds
    || lease.body.issuedAt !== delegation.leaseIssuedAtMs
    || lease.body.expiresAt !== delegation.leaseExpiresAtMs
    || hostMessageHash(lease) !== delegation.signedLeaseHash
    || hostMessageHash({ body: lease.body, signature: '' }) !== delegation.meterLeaseHash
    || keccak256(toHex(lease.body.image.split('@')[1]!)) !== quote.imageHash) {
    throw new Error('Platform v2 private signed lease differs from its public delegation');
  }
  if (input.hostAdmission && input.hostAdmission.body.envelopeHash !== hashJson({ version: 2,
    admissionTx: input.hostAdmission.body.admissionTx, lease, quote,
    quoteSignature: input.quoteSignature, delegation: input.delegation })) {
    throw new Error('Platform v2 host admission differs from the exact original private envelope');
  }
  const initial = hashJson({ protocol: 'telomere-platform-host-evidence-v2', runId: delegation.runId,
    hostKey: delegation.hostKey, controllerKey: delegation.controllerKey,
    signedLeaseHash: delegation.signedLeaseHash, meterLeaseHash: delegation.meterLeaseHash });
  const hostEvidenceRoot = input.ticks.reduce((root, tick, index) => hashJson({
    protocol: 'telomere-platform-host-pair-v2', previousRoot: root, sequence: index,
    tickHash: hostMessageHash(tick), ackHash: hostMessageHash(input.acknowledgments[index]!) }), initial);
  const core = platformV2EvidenceCoreSchema.parse({
    protocol: 'telomere-platform-evidence-core-v2', quote, quoteSignature: input.quoteSignature,
    delegation: input.delegation, ticks: input.ticks, acknowledgments: input.acknowledgments,
    ...(input.hostAdmission ? { hostAdmission: input.hostAdmission } : {}),
    hostEvidenceRoot, hostPairCount: input.ticks.length,
    endedAt: input.endedAt, billableSeconds: input.billableSeconds,
    inferenceCharge: input.inferenceCharge, status: input.status,
    outputCommitment: platformV2OutputCommitment(input.output, input.outputSalt),
  });
  const receiptHash = platformV2ReceiptHash(core);
  await verifyPlatformV2EvidenceCore(core, receiptHash, historical);
  return { core, receiptHash, evidenceCoreDigest: platformV2EvidenceDigest(core) };
}
