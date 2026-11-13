import { z } from 'zod';
import { verifyTypedData, type Hex } from 'viem';
import { bytes32Schema, hashJson, sameAddress } from '../common.js';
import { escrowDomain, settlementTypes } from '../chain/typed-data.js';
import { receiptBodySchema, receiptSettlement, signedReceiptSchema, type SignedReceipt } from '../service.js';
import { validateTicks } from '../runtime/validation.js';
import { receiptProofSchema, verifyHourlyReceipt, type ReceiptRootReader, type ReceiptVerificationPins } from './verifier.js';
import type { ChainBridge } from '../bridge.js';

export type VerificationStepStatus = 'passed' | 'failed' | 'not_applicable' | 'not_checked' | 'unavailable';
export type PublicReceiptReport = {
  outcome: 'verified' | 'invalid' | 'incomplete' | 'unavailable';
  checkedAt: string;
  steps: { id: string; label: string; status: VerificationStepStatus; detail: string }[];
  summary?: { runId: string; receiptHash: string; billableSeconds: number; charged: string; refund: string;
    ceiling: string; token: string; escrow: string; chainId: number; settlementTxHash?: string };
};
export const publicReceiptInputSchema = z.union([
  z.object({ runId: bytes32Schema, settlementTxHash: bytes32Schema.optional() }).strict(),
  z.object({ receipt: z.unknown().refine(value => value !== undefined), settlementTxHash: bytes32Schema.optional() }).strict(),
]);
type PublicReceiptInput = z.infer<typeof publicReceiptInputSchema>;
export type PublicReceiptRecord = { receipt: unknown; settlementTxHash: string | null };
export interface PublicReceiptReader {
  check(): Promise<void>;
  run(id: Hex): ReturnType<ChainBridge['run']>;
  record(id: Hex): Promise<PublicReceiptRecord | undefined>;
  settlement(receipt: SignedReceipt, hash: Hex): Promise<{
    matches: boolean; canonical: boolean; confirmations: bigint; blockNumber: bigint;
  }>;
}
const labels = [
  ['input', 'Receipt format'], ['domain', 'Chain and escrow'], ['hash', 'Receipt integrity'],
  ['signature', 'Operator signature'], ['billing', 'Amounts and recorded usage'], ['meter', 'Meter record chain'],
  ['chain', 'On-chain run'], ['settlement', 'Settlement event'], ['confirmations', 'Canonical confirmations'],
  ['host_signatures', 'Independent host signatures'], ['hourly_root', 'Hourly ReceiptRoot'],
] as const;

/** Read-only, fixed-scope report. Never returns a stored receipt, prompt, output or owner metadata. */
export class PublicReceiptVerifier {
  constructor(readonly pins: ReceiptVerificationPins, private readonly reader: PublicReceiptReader,
    private readonly rootReader?: ReceiptRootReader, readonly minConfirmations = 12) {
    if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1) throw new Error('Invalid verification depth');
  }
  async verify(input: PublicReceiptInput): Promise<PublicReceiptReport> {
    const report: PublicReceiptReport = { outcome: 'incomplete', checkedAt: new Date().toISOString(),
      steps: labels.map(([id, label]) => ({ id, label, status: 'not_checked', detail: 'Not checked yet.' })) };
    const step = (id: string, status: VerificationStepStatus, detail: string): void => {
      const item = report.steps.find(item => item.id === id);
      if (item) { item.status = status; item.detail = detail; }
    };
    step('host_signatures', 'not_applicable', 'This profile signs the receipt with the operator key. Meter hashes are not independent host signatures or hardware attestation.');
    step('hourly_root', 'not_applicable', this.pins.receiptRootAddress
      ? 'Paste an exported hourly proof to check its published root.' : 'This deployment settles receipts directly; no hourly ReceiptRoot is configured.');
    let supplied: unknown, record: PublicReceiptRecord | undefined, run: Awaited<ReturnType<ChainBridge['run']>> | undefined;
    let txHash: Hex | undefined = input.settlementTxHash;
    if ('runId' in input) {
      try {
        await this.reader.check(); run = await this.reader.run(input.runId);
        if (run.status !== 2) {
          step('chain', 'not_checked', 'No settled run is available for this ID in the configured escrow. Paste a signed receipt, or retry after settlement.');
          return report;
        }
        record = await this.reader.record(input.runId); supplied = record?.receipt;
        if (supplied == null) {
          step('chain', 'passed', 'A settled run exists on-chain. Its signed receipt is not available here; paste the receipt JSON to continue.');
          return report;
        }
      } catch {
        step('chain', 'unavailable', 'The chain or receipt store is temporarily unavailable. Retry this read-only check.');
        report.outcome = 'unavailable'; return report;
      }
    } else supplied = input.receipt;

    // Accept a downloaded receipt, an execution-record export, or a bounded hourly proof.
    const object = z.record(z.unknown()).safeParse(supplied);
    const proof = receiptProofSchema.safeParse(supplied);
    if (!proof.success && object.success && ['proof', 'algorithm', 'leafCount', 'root'].some(key => key in object.data)) {
      step('input', 'failed', 'The hourly proof format is invalid. Use the original proof export.');
      report.outcome = 'invalid'; return report;
    }
    if (proof.success) supplied = proof.data.receipt;
    else if (object.success && object.data.receipt !== undefined && object.data.body === undefined) {
      const candidate = bytes32Schema.safeParse(object.data.settlementTxHash);
      txHash ??= candidate.success ? candidate.data : undefined;
      supplied = object.data.receipt;
    }
    const parsed = signedReceiptSchema.safeParse(supplied);
    const body = parsed.success ? receiptBodySchema.safeParse(parsed.data.body) : undefined;
    if (!parsed.success || !body?.success || parsed.data.body.version !== 1) {
      step('input', 'failed', 'Use a Telomere signed receipt JSON, its execution-record export, or an exported hourly proof. Required receipt fields are missing or invalid.');
      report.outcome = 'invalid'; return report;
    }
    const receipt = parsed.data, b = body.data;
    step('input', 'passed', 'The signed receipt format is valid.');
    if ('runId' in input && receipt.settlement.runId !== input.runId) {
      step('input', 'failed', 'The stored receipt does not match the requested run ID.');
      report.outcome = 'invalid'; return report;
    }
    const domainValid = receipt.domain.chainId === this.pins.chainId
      && sameAddress(receipt.domain.verifyingContract, this.pins.escrowAddress)
      && sameAddress(receipt.signer, this.pins.receiptSigner);
    step('domain', domainValid ? 'passed' : 'failed', domainValid
      ? 'The chain, escrow and signer match this Telomere deployment.' : 'The receipt belongs to a different chain, escrow or signer.');
    const hashValid = hashJson(receipt.body) === receipt.receiptHash && receipt.settlement.receiptHash === receipt.receiptHash;
    step('hash', hashValid ? 'passed' : 'failed', hashValid
      ? 'The complete receipt body matches its committed hash.' : 'The body or settlement hash has been changed.');
    let signatureValid = false;
    if (domainValid && hashValid) {
      try { signatureValid = await verifyTypedData({ address: this.pins.receiptSigner,
        domain: escrowDomain(this.pins.chainId, this.pins.escrowAddress), types: settlementTypes,
        primaryType: 'Settlement', message: receiptSettlement(receipt), signature: receipt.signature }); } catch { /* Verification failure, not a server fault. */ }
      step('signature', signatureValid ? 'passed' : 'failed', signatureValid
        ? 'The EIP-712 settlement signature matches the configured operator.' : 'The settlement signature is invalid for the configured operator.');
    }
    const inference = BigInt(b.near?.inferenceCharge ?? '0');
    const charged = BigInt(b.cpu.billableSeconds) * BigInt(b.cpu.pricePerSecond) + inference;
    const consistent = b.runId === receipt.settlement.runId
      && b.cpu.billableSeconds <= b.cpu.measuredSeconds
      && BigInt(b.cpu.billableSeconds) === BigInt(receipt.settlement.billableSeconds)
      && inference === BigInt(receipt.settlement.inferenceCharge)
      && charged === BigInt(b.billing.charged) && charged <= BigInt(b.billing.ceiling)
      && charged + BigInt(b.billing.refund) === BigInt(b.billing.ceiling)
      && sameAddress(b.billing.token, this.pins.tokenAddress);
    step('billing', consistent ? 'passed' : 'failed', consistent
      ? 'Recorded seconds and price reproduce the charge; charge plus refund equals the reservation.'
      : 'Check the run ID, billed seconds, token, charge or refund: the receipt amounts do not reconcile.');
    let meterValid = false;
    try {
      const ticks = validateTicks(b.cpu.ticks, b.runId, 120), last = ticks.at(-1);
      meterValid = last !== undefined && last.state !== 'running' && last.billableSeconds === b.cpu.measuredSeconds;
    } catch { /* Tampered meter evidence fails its own step. */ }
    step('meter', meterValid ? 'passed' : 'failed', meterValid
      ? 'Tick sequence, hashes and measured time are internally consistent and covered by the signed receipt.'
      : 'Meter records are missing, changed, out of sequence or inconsistent with measured time.');
    if (!domainValid || !hashValid || !signatureValid || !consistent || !meterValid) { report.outcome = 'invalid'; return report; }
    try {
      if (!run) { await this.reader.check(); run = await this.reader.run(receipt.settlement.runId); }
      const bound = sameAddress(b.payer, run.payer) && b.leashId === run.leashId && b.workloadHash === run.workloadHash
        && BigInt(b.cpu.pricePerSecond) === run.pricePerSecond && BigInt(b.billing.ceiling) === run.ceiling
        && BigInt(b.cpu.measuredSeconds) <= run.maxSeconds && (inference === 0n || inference === run.inferencePrice);
      const settled = run.status === 2 && run.receiptHash === receipt.receiptHash
        && run.billableSeconds === BigInt(b.cpu.billableSeconds) && run.inferenceCharge === inference;
      if (!bound || (run.status === 2 && !settled) || run.status === 0 || run.status === 3) {
        step('chain', 'failed', 'The signed record does not match the run stored in the configured escrow.');
        report.outcome = 'invalid'; return report;
      }
      if (!settled) { step('chain', 'not_checked', 'The receipt is signed, but the run has not settled on-chain yet. Retry after settlement.'); return report; }
      step('chain', 'passed', 'The payer, workload commitment, price, reservation and settled usage match the on-chain run.');
      // Expose only fixed, already chain-public accounting fields after signature and run binding checks.
      report.summary = { runId: b.runId, receiptHash: receipt.receiptHash, billableSeconds: b.cpu.billableSeconds,
        charged: b.billing.charged, refund: b.billing.refund, ceiling: b.billing.ceiling, token: this.pins.tokenAddress,
        escrow: this.pins.escrowAddress, chainId: this.pins.chainId };
      record ??= await this.reader.record(receipt.settlement.runId);
      if (!txHash && record?.settlementTxHash) {
        const hash = bytes32Schema.safeParse(record.settlementTxHash); if (hash.success) txHash = hash.data;
      }
      if (txHash) {
        const event = await this.reader.settlement(receipt, txHash);
        step('settlement', event.matches ? 'passed' : 'failed', event.matches
          ? 'The successful escrow transaction contains the matching RunSettled event, including charge and returned amount.'
          : 'The supplied settlement transaction does not contain the matching escrow event and amounts.');
        const confirmed = event.canonical && event.confirmations >= BigInt(this.minConfirmations);
        step('confirmations', confirmed ? 'passed' : 'not_checked', confirmed
          ? `The settlement is canonical with at least ${this.minConfirmations} blocks of confirmation.`
          : `The settlement is not canonical or has fewer than ${this.minConfirmations} confirmations. Retry later.`);
        if (!event.matches) { report.outcome = 'invalid'; return report; }
        if (confirmed) report.summary.settlementTxHash = txHash;
      } else step('settlement', 'not_checked', 'The run state matches, but its settlement transaction hash is unavailable. Paste an execution-record export containing settlementTxHash.');
      if (proof.success && this.pins.receiptRootAddress) {
        const root = await verifyHourlyReceipt(proof.data, this.pins, this.rootReader);
        step('hourly_root', root.onchain_verified ? 'passed' : root.evidence === 'chain_unavailable' ? 'unavailable'
          : root.evidence === 'chain_root_mismatch' || !root.valid ? 'failed' : 'not_checked', root.onchain_verified
          ? 'The receipt Merkle path matches the configured published hourly root.'
          : 'The hourly proof could not be verified against the configured root.');
      }
      report.outcome = report.steps.some(item => item.status === 'failed') ? 'invalid'
        : report.steps.some(item => item.status === 'unavailable') ? 'unavailable'
        : report.steps.some(item => item.status === 'not_checked') ? 'incomplete' : 'verified';
      return report;
    } catch {
      const next = report.steps.find(item => ['chain', 'settlement', 'confirmations', 'hourly_root'].includes(item.id) && item.status === 'not_checked');
      if (next) step(next.id, 'unavailable', 'On-chain evidence is temporarily unavailable. No payment or transaction was requested. Retry the check.');
      report.outcome = 'unavailable'; return report;
    }
  }
}
