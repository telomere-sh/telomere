import { eq } from 'drizzle-orm';
import type { Database } from '../store.js';
import { addressSchema, bytes32Schema, hashJson, sameAddress, signatureSchema } from '../common.js';
import { hostMessageHash, signedLeaseSchema } from '../host-kit/protocol.js';
import { platformHostLeases, platformRuns } from '../platform-runtime/schema.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import type { PlatformReceiptService } from './platform-service.js';
import { platformFinancialLeaf } from './platform-merkle.js';
import { platformEscrowAbi, platformQuoteSchema, platformSettlementSchema,
  platformWorkloadHash, typedPlatformSettlement } from '../platform-runtime/types.js';
import { validateCpuResult } from '../runtime/validation.js';
import { preparePlatformV2EvidenceCore, signedPlatformV2DelegationSchema,
  type PlatformV2HistoricalAuthority, type PlatformV2PrivateInput } from './platform-v2.js';

/**
 * Default-off bridge from the actual paid HostKit journal to a v2 candidate.
 * This does not authorize a controller, publish evidence, or submit settlement.
 * In the current runtime the durable settlement is always v1, so the result
 * explicitly reports that its new v2 hash is not the onchain commitment.
 */
export async function preparePlatformV2FromDurableRun(
  db: Database, runValue: string, ownerValue: string,
  delegationValue: unknown, outputSalt: string, historical: PlatformV2HistoricalAuthority,
) {
  const runId = bytes32Schema.parse(runValue), owner = addressSchema.parse(ownerValue);
  const delegation = signedPlatformV2DelegationSchema.parse(delegationValue);
  const [row] = await db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
  const [host] = await db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId)).limit(1);
  if (!row || !host || !sameAddress(row.owner, owner) || !['receipt_pending', 'settling', 'completed'].includes(row.status)
    || !row.admissionTx || !row.result || !row.settlement || row.input.near || row.nearResult
    || row.input.task.kind === 'near_inference' || row.input.task.kind === 'session'
    || host.cleanupConfirmed !== 1
    || !sameAddress(host.owner, owner) || host.hostId !== row.quote.hostId) {
    throw new Error('Platform v2 requires one terminal, cleaned-up, original paid CPU HostKit run');
  }
  const quote = platformQuoteSchema.parse(row.quote), settlement = platformSettlementSchema.parse(row.settlement);
  const result = validateCpuResult(row.result, runId, quote.maxSeconds);
  const lease = signedLeaseSchema.parse(host.lease);
  if (row.id !== quote.runId || settlement.runId !== runId || !sameAddress(quote.payer, owner)
    || hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== quote.workloadHash
    || host.leaseHash !== hostMessageHash(lease) || lease.body.runId !== runId
    || !sameAddress(lease.body.owner, owner) || lease.body.hostKey !== delegation.body.hostKey
    || lease.body.maxSeconds !== quote.maxSeconds || settlement.inferenceCharge !== '0'
    || quote.inferencePrice !== '0' || settlement.billableSeconds > result.billableSeconds) {
    throw new Error('Platform v2 durable quote, lease, task or terminal settlement changed');
  }
  const originalV1Hash = hashJson({ protocol: 'telomere-platform-receipt-v1',
    chainId: historical.chainId, escrow: addressSchema.parse(historical.escrow), quote,
    endedAt: settlement.endedAt, billableSeconds: settlement.billableSeconds,
    output: result.output, status: result.status, ticks: result.ticks,
    hostLeaseHash: host.leaseHash });
  const input: PlatformV2PrivateInput = { quote, quoteSignature: signatureSchema.parse(row.signature),
    delegation, lease, ticks: host.ticks, acknowledgments: host.acknowledgments,
    endedAt: settlement.endedAt, billableSeconds: settlement.billableSeconds,
    inferenceCharge: '0', status: result.status, output: result.output, outputSalt };
  const candidate = await preparePlatformV2EvidenceCore(input, historical);
  const receiptVersion = settlement.receiptHash === candidate.receiptHash ? 'v2-local-commitment'
    : settlement.receiptHash === originalV1Hash ? 'v1-existing' : undefined;
  if (!receiptVersion) throw new Error('Platform durable settlement differs from both original v1 and complete v2 evidence');
  return { runId, admissionTx: bytes32Schema.parse(row.admissionTx),
    settlementTx: row.settlementTx ? bytes32Schema.parse(row.settlementTx) : null,
    settlement: { ...settlement }, receiptVersion, originalV1Hash,
    candidate, onchainReceiptVerified: false as const, independentlyPublished: false as const,
    historicalAuthoritySource: 'caller-supplied' as const };
}

/** A local v2 hash is not a chain proof; callers must verify the canonical settlement separately. */
export function requirePlatformV2DurableHash(value: Awaited<ReturnType<typeof preparePlatformV2FromDurableRun>>) {
  if (value.receiptVersion !== 'v2-local-commitment' || value.settlement.receiptHash !== value.candidate.receiptHash) {
    throw new Error('The original durable settlement does not commit the complete Platform v2 evidence');
  }
  return value;
}

/**
 * Post-settlement check for a local v2 commitment. The financial proof port
 * verifies the canonical receipt root; historical signer authority and the
 * independent public evidence copies remain separate, unsatisfied gates.
 */
export async function confirmPlatformV2DurableSettlement(
  value: Awaited<ReturnType<typeof preparePlatformV2FromDurableRun>>,
  bridge: PlatformBridge,
  financialProof: Pick<PlatformReceiptService, 'proof'>,
  ownerValue: string,
) {
  requirePlatformV2DurableHash(value);
  const owner = addressSchema.parse(ownerValue), scope = value.candidate.core.delegation.body;
  if (!value.settlementTx || bridge.pins.chainId !== scope.chainId
    || !sameAddress(bridge.pins.escrowAddress, scope.escrow)
    || !sameAddress(bridge.pins.hostRegistryAddress, scope.hostRegistry)
    || !sameAddress(value.candidate.core.quote.payer, owner)) {
    throw new Error('Platform v2 canonical settlement scope or transaction is unavailable');
  }
  await bridge.check();
  const proof = await financialProof.proof(owner, value.runId);
  if (!proof) throw new Error('Platform v2 canonical published financial root proof is unavailable');
  const run = await bridge.run(value.runId);
  const leaf = platformFinancialLeaf(bridge.pins.chainId, bridge.pins.escrowAddress, run, value.settlement);
  const onchainLeaf = await bridge.public.readContract({ address: bridge.pins.escrowAddress,
    abi: platformEscrowAbi, functionName: 'receiptLeaf',
    args: [typedPlatformSettlement(value.settlement)] });
  if (!bridge.matches(value.candidate.core.quote, run)
    || proof.hour !== Math.floor(value.settlement.endedAt / 3600)
    || proof.leaf !== leaf || onchainLeaf !== leaf) {
    throw new Error('Platform v2 financial proof differs from the canonical quoted run or settlement leaf');
  }
  const confirmed = await bridge.confirmedSettlement(value.settlement, value.settlementTx);
  // Re-read the root after the settlement event to catch a shallow replacement.
  const finalProof = await financialProof.proof(owner, value.runId);
  if (!finalProof || finalProof.root !== proof.root || finalProof.leaf !== proof.leaf
    || finalProof.transactionHash !== proof.transactionHash) {
    throw new Error('Platform v2 financial root disappeared during canonical settlement verification');
  }
  return { ...value, financial: confirmed, onchainReceiptVerified: true as const,
    financialRootVerified: true as const, independentlyPublished: false as const,
    historicalAuthoritySource: 'caller-supplied' as const };
}
