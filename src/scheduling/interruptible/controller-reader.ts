import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { bytes32Schema, hashJson, moneySchema, Problem } from '../../common.js';
import { jobs, type Database } from '../../store.js';
import { receiptSettlement, signedReceiptSchema, type SignedReceipt } from '../../service.js';
import { validateCpuResult } from '../../runtime/validation.js';
import { verifySignedReceipt, type ReceiptVerificationPins } from '../../receipts/verifier.js';
import { interruptibleOwnerSchema, type CompletedInterruptibleSettlement } from './types.js';

export interface InterruptibleSettlementConfirmation {
  /** Verify the canonical chain receipt/event and current run receipt hash, e.g. ChainBridge.confirmedSettlement. */
  confirmSettlement(receipt: SignedReceipt, transactionHash: `0x${string}`): Promise<void>;
  /** Must be true only after actual process/container removal, not merely an HTTP stop request. */
  cleanupConfirmed(owner: string, runId: string): Promise<boolean>;
}
const cpuReceiptSchema = z.object({ billableSeconds: z.number().int().min(0).max(120),
  measuredSeconds: z.number().int().min(0).max(120), pricePerSecond: moneySchema, ticks: z.unknown(), outputHash: bytes32Schema }).passthrough();
const billingSchema = z.object({ ceiling: moneySchema, charged: moneySchema, refund: moneySchema }).passthrough();

/** Concrete root-controller receipt reader. Neither a stored tx hash nor an API assertion is chain confirmation. */
export function createControllerInterruptibleSettlementReader(db: Database, pins: ReceiptVerificationPins,
  confirmation: InterruptibleSettlementConfirmation) {
  return async (ownerValue: string, agentValue: string, runIdValue: string): Promise<CompletedInterruptibleSettlement | null> => {
    const owner = interruptibleOwnerSchema.parse(ownerValue), agent = interruptibleOwnerSchema.parse(agentValue), runId = bytes32Schema.parse(runIdValue);
    const [job] = await db.select().from(jobs).where(and(eq(jobs.id, runId), eq(jobs.owner, owner))).limit(1);
    if (!job || job.agentAddress !== agent) throw new Problem(404, 'interruptible_receipt_not_found', 'Controller run not found.');
    if (!['completed', 'cancelled', 'failed', 'timed_out'].includes(job.status) || !job.receipt || !job.settlementTxHash) return null;
    if (job.input.nearPrompt || job.nearResult !== null || job.quote.inferencePrice !== '0')
      throw new Problem(409, 'interruptible_cpu_only', 'Interruptible settlement currently supports CPU-only runs.');
    const receipt = signedReceiptSchema.parse(job.receipt), cpu = cpuReceiptSchema.parse(receipt.body.cpu), billing = billingSchema.parse(receipt.body.billing);
    const result = validateCpuResult(job.cpuResult, runId, job.input.maxSeconds);
    if (!(await verifySignedReceipt(receipt, pins)).valid || receipt.body.runId !== runId
      || String(receipt.body.payer).toLowerCase() !== owner || receipt.body.leashId !== job.leashId
      || receipt.body.workloadHash !== job.quote.workloadHash || receipt.body.near !== null
      || cpu.pricePerSecond !== job.quote.pricePerSecond || cpu.measuredSeconds !== result.billableSeconds
      || cpu.billableSeconds !== job.billableSeconds || cpu.billableSeconds > result.billableSeconds
      || hashJson(cpu.ticks) !== hashJson(result.ticks) || hashJson(job.ticks) !== hashJson(result.ticks)
      || cpu.outputHash !== hashJson(result.output) || billing.ceiling !== job.ceiling
      || billing.charged !== job.charged || billing.refund !== job.refund
      || BigInt(billing.charged) !== BigInt(cpu.billableSeconds) * BigInt(cpu.pricePerSecond))
      throw new Problem(409, 'interruptible_receipt_invalid', 'Controller receipt, completed CPU observations and accounting disagree.');
    if (!await confirmation.cleanupConfirmed(owner, runId)) return null;
    // The caller supplies a reviewed chain reader; no signing or payment occurs at this boundary.
    await confirmation.confirmSettlement(receipt, bytes32Schema.parse(job.settlementTxHash));
    return { runId, owner, agent, receiptId: receipt.receiptHash, billableSeconds: cpu.billableSeconds,
      pricePerSecond: cpu.pricePerSecond, ceiling: billing.ceiling, charged: billing.charged, refund: billing.refund,
      confirmed: true, cleanupConfirmed: true };
  };
}
/** Convenience adapter retains only the bridge's read-only confirmation capability. */
export function canonicalSettlementConfirmation(bridge: { confirmedSettlement(settlement: ReturnType<typeof receiptSettlement>, hash: `0x${string}`): Promise<Date> }) {
  return async (receipt: SignedReceipt, hash: `0x${string}`) => { await bridge.confirmedSettlement(receiptSettlement(receipt), hash); };
}
