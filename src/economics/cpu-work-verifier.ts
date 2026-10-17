import { z } from 'zod';
import { bytes32Schema, hashJson } from '../common.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import { platformEscrowAbi } from '../platform-runtime/types.js';
import { verifyPlatformV2PublishedEvidence } from '../receipts/platform-v2-combined.js';
import type { PlatformV2PublishedEvidenceReader } from '../receipts/platform-v2-publication.js';
import { verifiedWorkActivitySchema, type VerifiedWorkActivity, type WorkActivityVerifier } from './work-allocation.js';

const handleSchema = z.object({ runId: bytes32Schema, transactionHash: bytes32Schema }).strict();
type CpuWorkHandle = z.infer<typeof handleSchema>;
type ReadOnlyBridge = Pick<PlatformBridge, 'pins' | 'public' | 'check' | 'canonicalReceipt'>;

/** Actual paid CPU work only. Both published v2 copies, signed tick/ACK sequence,
 * historical host admission and canonical financial commitment must agree.
 * This does not claim confidential execution or independently proven correctness. */
export class CanonicalCpuWorkVerifier implements WorkActivityVerifier {
  private readonly handles = new Map<string, CpuWorkHandle>();
  constructor(private readonly bridge: ReadOnlyBridge,
    private readonly copies: Pick<PlatformV2PublishedEvidenceReader, 'retrieve'>,
    private readonly minConfirmations = 12) {}

  async read(raw: unknown): Promise<VerifiedWorkActivity> {
    const handle = handleSchema.parse(raw);
    const result = await verifyPlatformV2PublishedEvidence(this.bridge, this.copies, handle.runId,
      handle.transactionHash, this.minConfirmations);
    const proof = result.verification, financial = proof.financial;
    if (financial.kind !== 'settlement' || result.core.status !== 'completed' || financial.billableSeconds <= 0
      || !proof.hostAdmissionVerified || !proof.committedTickAckSequenceVerified || !proof.onchainReceiptVerified
      || !result.publication.configuredCopiesVerified || financial.hwClass !== 0 || financial.sealedHost) {
      throw new Error('Work allocation requires an accepted published CPU completion with positive signed billing');
    }
    const [run, block] = await Promise.all([
      this.bridge.public.readContract({ address: this.bridge.pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getRun', args: [handle.runId], blockHash: financial.blockHash, requireCanonical: true }),
      this.bridge.public.getBlock({ blockHash: financial.blockHash }),
    ]);
    if (run.receiptHash !== proof.receiptHash || block.hash !== financial.blockHash || run.status !== 2
      || run.billableSeconds !== BigInt(financial.billableSeconds)) throw new Error('Canonical work finalization scope changed');
    const activity = verifiedWorkActivitySchema.parse({ kind: 'cpu', receiptId: proof.receiptHash,
      recipient: run.hostOperator, units: financial.billableSeconds.toString(), week: Number(block.timestamp / 604800n),
      chainId: financial.chainId, blockNumber: financial.blockNumber, blockHash: financial.blockHash,
      evidenceDigest: proof.evidenceCoreDigest });
    this.handles.set(activity.receiptId, handle);
    return activity;
  }

  async recheck(activity: VerifiedWorkActivity): Promise<void> {
    const handle = this.handles.get(activity.receiptId);
    if (!handle || hashJson(await this.read(handle)) !== hashJson(activity)) {
      throw new Error('CPU work receipt changed before weekly allocation');
    }
  }
}
