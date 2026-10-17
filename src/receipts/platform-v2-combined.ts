import type { Hex } from 'viem';
import { bytes32Schema, hashJson, sameAddress } from '../common.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import { PlatformPublicFinancialReader } from '../platform-runtime/public-financial.js';
import { platformEscrowAbi } from '../platform-runtime/types.js';
import { recheckPlatformV2Opening, verifyPlatformV2OpeningEvidence } from './platform-v2-history.js';
import { platformV2EvidenceCoreSchema, platformV2ReceiptHash } from './platform-v2.js';
import type { PlatformV2PublishedEvidenceReader } from './platform-v2-publication.js';

type ReadOnlyBridge = Pick<PlatformBridge, 'pins' | 'public' | 'check' | 'canonicalReceipt'>;

/** Stable financial fields; confirmation counts may legitimately grow between reads. */
function financialSnapshot(proof: Awaited<ReturnType<PlatformPublicFinancialReader['verify']>>) {
  if (proof.kind !== 'settlement') throw new Error('Platform v2 requires a canonical settlement, not a timeout refund');
  return hashJson({ protocol: 'telomere-platform-v2-financial-snapshot',
    chainId: proof.chainId, escrowAddress: proof.escrowAddress, runId: proof.runId,
    transactionHash: proof.transactionHash, blockNumber: proof.blockNumber, blockHash: proof.blockHash,
    payer: proof.payer, ceiling: proof.ceiling, receiptHash: proof.receiptHash,
    receiptRootAddress: proof.receiptRootAddress, receiptRoot: proof.receiptRoot,
    receiptLeaf: proof.receiptLeaf, hour: proof.hour, billableSeconds: proof.billableSeconds,
    endedAt: proof.endedAt, hwClass: proof.hwClass, sealedHost: proof.sealedHost,
    pricePerSecond: proof.pricePerSecond, inferenceCharge: proof.inferenceCharge,
    hostAmount: proof.hostAmount, platformFee: proof.platformFee, charged: proof.charged,
    ...(proof.feeDiscountBps !== undefined ? { feeDiscountBps: proof.feeDiscountBps } : {}),
    returnedAmount: proof.returnedAmount });
}

/** Fetches both configured copies; their declared failure domains are not independently audited. */
export async function verifyPlatformV2PublishedEvidence(bridge: ReadOnlyBridge,
  reader: Pick<PlatformV2PublishedEvidenceReader, 'retrieve'>,
  runIdValue: string, settlementHashValue: string, minConfirmations = 12) {
  const runId = bytes32Schema.parse(runIdValue), settlementHash = bytes32Schema.parse(settlementHashValue);
  const retrieved = await reader.retrieve(runId);
  const verified = await verifyPlatformV2CombinedEvidence(bridge,
    retrieved.manifest.opening.transactionHash, settlementHash, retrieved.core, minConfirmations);
  const opening = retrieved.manifest.opening;
  if (verified.runId !== runId || verified.receiptHash !== retrieved.manifest.receiptHash
    || verified.evidenceCoreDigest !== retrieved.manifest.evidenceCoreDigest
    || verified.opening.transactionHash !== opening.transactionHash || verified.opening.blockHash !== opening.blockHash
    || verified.opening.blockNumber.toString() !== opening.blockNumber || verified.opening.logIndex !== opening.logIndex) {
    throw new Error('Platform v2 retrieved manifest differs from the canonical opening or settlement');
  }
  const finalCopies = await reader.retrieve(runId, { expectedReceiptHash: verified.receiptHash });
  if (finalCopies.manifestDigest !== retrieved.manifestDigest) {
    throw new Error('Platform v2 publication changed during canonical verification');
  }
  return { verification: verified, core: finalCopies.core, publication: {
    manifest: finalCopies.manifest, manifestDigest: finalCopies.manifestDigest,
    configuredCopiesVerified: finalCopies.configuredCopiesVerified,
    storageAssurance: finalCopies.storageAssurance, independentlyPublished: false as const } };
}

/**
 * Default-unmounted read-only composition of a caller-presented v2 core,
 * archive-backed RunOpened authority, and the canonical financial settlement.
 * A committed core proves its signed pair sequence, not that no physical tick
 * was ever omitted or that the controller signed before execution.
 */
export async function verifyPlatformV2CombinedEvidence(bridge: ReadOnlyBridge,
  openHashValue: string, settlementHashValue: string, rawCore: unknown,
  minConfirmations = 12) {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
    throw new Error('Platform v2 combined confirmation depth is invalid');
  }
  const openHash = bytes32Schema.parse(openHashValue), settlementHash = bytes32Schema.parse(settlementHashValue);
  const core = platformV2EvidenceCoreSchema.parse(rawCore);
  const runId = core.quote.runId, expectedReceiptHash = platformV2ReceiptHash(core);
  const reader = new PlatformPublicFinancialReader(bridge, minConfirmations);
  const financial = await reader.verify(runId, settlementHash);
  if (financial.kind !== 'settlement' || financial.receiptHash !== expectedReceiptHash
    || financial.billableSeconds !== core.billableSeconds || financial.endedAt !== core.endedAt
    || financial.inferenceCharge !== '0' || financial.hwClass !== 0 || financial.sealedHost
    || financial.pricePerSecond !== core.quote.pricePerSecond
    || !sameAddress(financial.payer, core.quote.payer)) {
    throw new Error('Platform v2 core differs from its canonical CPU financial settlement');
  }
  const opening = await verifyPlatformV2OpeningEvidence(bridge.public, bridge.pins,
    openHash, core, financial.receiptHash, minConfirmations);
  if (bridge.pins.financialProfile && opening.feeDiscountBps !== financial.feeDiscountBps) {
    throw new Error('Platform v2 admission-locked fee tier changed before settlement');
  }
  // A reviewed contract should keep original quote fields immutable. Verify
  // that claim at the settlement block as well as at the opening block.
  const finalRun = await bridge.public.readContract({ address: bridge.pins.escrowAddress,
    abi: platformEscrowAbi, functionName: 'getRun', args: [runId],
    blockHash: financial.blockHash as Hex, requireCanonical: true });
  if (finalRun.status !== 2 || !finalRun.hostReleased || finalRun.sealedHost
    || !sameAddress(finalRun.payer, core.quote.payer)
    || finalRun.leashId !== core.quote.leashId || finalRun.hostId !== core.quote.hostId
    || finalRun.hwClass !== 0 || finalRun.regionHash !== core.quote.regionHash
    || finalRun.imageHash !== core.quote.imageHash || finalRun.workloadHash !== core.quote.workloadHash
    || finalRun.maxSeconds !== BigInt(core.quote.maxSeconds)
    || finalRun.pricePerSecond !== BigInt(core.quote.pricePerSecond)
    || finalRun.inferencePrice !== 0n || finalRun.receiptHash !== expectedReceiptHash
    || finalRun.billableSeconds !== BigInt(core.billableSeconds)) {
    throw new Error('Platform v2 original quote differs from the canonical settled run');
  }
  // Repeat both chain checks after the cross-block reads. A mixed response or
  // shallow reorg must not turn two individually valid partial checks into one verdict.
  const finalFinancial = await reader.verify(runId, settlementHash);
  if (financialSnapshot(finalFinancial) !== financialSnapshot(financial)) {
    throw new Error('Platform v2 financial proof changed during combined verification');
  }
  await recheckPlatformV2Opening(bridge.public, opening.opening, minConfirmations);
  const [settlementBlock, head] = await Promise.all([
    bridge.public.getBlock({ blockNumber: BigInt(financial.blockNumber) }),
    bridge.public.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (settlementBlock.hash !== financial.blockHash || head < settlementBlock.number
    || head - settlementBlock.number + 1n < BigInt(minConfirmations)) {
    throw new Error('Platform v2 financial settlement reorged during combined verification');
  }
  return { verification: 'caller-presented-v2-core-with-canonical-financial-commitment' as const,
    runId, openTransactionHash: openHash, settlementTransactionHash: settlementHash,
    receiptHash: expectedReceiptHash, evidenceCoreDigest: opening.evidenceCoreDigest,
    hostEvidenceRoot: opening.hostEvidenceRoot, hostPairCount: opening.hostPairCount,
    eligibleBillableSeconds: opening.eligibleBillableSeconds,
    opening: opening.opening, financial: finalFinancial,
    historicalAuthoritySource: 'archive-rpc' as const,
    ...(bridge.pins.financialProfile ? { quoteDomainVersion: '2' as const, feeDiscountBps: opening.feeDiscountBps! } : {}),
    hostAdmissionVerified: opening.hostAdmissionVerified,
    onchainReceiptVerified: true as const, committedTickAckSequenceVerified: true as const,
    physicalTickStreamCompletenessProven: false as const,
    historicalDelegationIssuanceTimeProven: false as const,
    independentlyPublished: false as const, executionStatusProven: false as const,
    outputVerified: false as const };
}
