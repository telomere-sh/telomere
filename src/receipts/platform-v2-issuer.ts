import { and, eq, sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { addressSchema, bytes32Schema, canonical, hashJson, sameAddress, signatureSchema } from '../common.js';
import { hostMessageHash } from '../host-kit/protocol.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import { platformHostLeases, platformRuns } from '../platform-runtime/schema.js';
import type { PlatformV2ReceiptPort } from '../platform-runtime/service.js';
import { platformSettlementSchema, platformWorkloadHash, type PlatformSettlement } from '../platform-runtime/types.js';
import type { CpuRunResult } from '../runtime/types.js';
import { validateCpuResult } from '../runtime/validation.js';
import type { Database } from '../store.js';
import { PlatformV2AdmissionJournal } from './platform-v2-admission.js';
import { readPlatformV2OpeningAuthority, recheckPlatformV2Opening } from './platform-v2-history.js';
import { PlatformV2EvidenceJournal } from './platform-v2-journal.js';
import { PlatformV2EvidencePublisher, platformV2PublicationOpeningSchema } from './platform-v2-publication.js';
import { verifyPlatformV2AdmissionWitness } from './platform-v2-witness.js';
import { newPlatformV2OutputSalt, platformV2PrivateInputSchema, preparePlatformV2EvidenceCore,
  type PlatformV2PrivateInput } from './platform-v2.js';

type RunRow = typeof platformRuns.$inferSelect;
const draftSchema = z.object({ input: platformV2PrivateInputSchema,
  opening: platformV2PublicationOpeningSchema, resultHash: bytes32Schema }).strict();
type Draft = z.infer<typeof draftSchema>;
/** Private outcome/salt fence. Never expose its input through the public retrieval route. */
export const platformV2IssuanceDrafts = pgTable('platform_v2_issuance_drafts', {
  scope: text().notNull(), runId: text().notNull(), draft: jsonb().$type<Draft>().notNull(), draftHash: text().notNull(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
const ddl = `CREATE TABLE IF NOT EXISTS platform_v2_issuance_drafts (
 scope text NOT NULL, run_id text NOT NULL, draft jsonb NOT NULL, draft_hash text NOT NULL,
 PRIMARY KEY(scope,run_id))`;

/**
 * Opt-in one-shot CPU producer. The exact original preimage and salt are durable
 * before either store write, and both configured copies precede financial issuance.
 * Store domain declarations do not prove physical independence or TEE execution.
 */
export class PlatformV2ReceiptIssuer implements PlatformV2ReceiptPort {
  readonly scope: string;
  get publishedEvidence() { return this.publisher; }
  constructor(private readonly db: Database, private readonly bridge: PlatformBridge,
    private readonly admission: PlatformV2AdmissionJournal,
    private readonly evidence: PlatformV2EvidenceJournal,
    readonly publisher: PlatformV2EvidencePublisher, readonly minConfirmations = 12) {
    if (!publisher.enabled || !Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
      throw new Error('Platform v2 issuance requires explicit publication and a bounded confirmation depth');
    }
    const pins = bridge.pins;
    this.scope = hashJson({ protocol: 'telomere-platform-v2-issuance', chainId: pins.chainId,
      escrow: pins.escrowAddress.toLowerCase(), hostRegistry: pins.hostRegistryAddress.toLowerCase() });
  }
  async initialize(): Promise<void> {
    await this.db.execute(sql.raw(ddl));
    await this.admission.initialize();
    await this.evidence.initialize();
    await this.publisher.initialize();
  }
  private async original(runId: string) {
    const [row] = await this.db.select().from(platformV2IssuanceDrafts)
      .where(and(eq(platformV2IssuanceDrafts.scope, this.scope), eq(platformV2IssuanceDrafts.runId, runId))).limit(1);
    if (!row) return undefined;
    const draft = draftSchema.parse(row.draft);
    if (row.runId !== draft.input.quote.runId || hashJson(draft) !== row.draftHash) {
      throw new Error('Platform v2 original issuance preimage changed');
    }
    return draft;
  }
  private async checkedSource(row: RunRow, rawResult: CpuRunResult) {
    const result = validateCpuResult(rawResult, row.id, row.quote.maxSeconds);
    const [stored] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, row.id)).limit(1);
    const [host] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id)).limit(1);
    const admitted = await this.admission.originalHostAdmission(row.id);
    if (!stored || !host || !admitted?.admission || stored.receiptVersion !== 2 || row.receiptVersion !== 2
      || !sameAddress(stored.owner, addressSchema.parse(row.owner)) || canonical(stored.quote) !== canonical(row.quote)
      || stored.signature !== row.signature || stored.admissionTx !== row.admissionTx
      || !['running', 'receipt_pending', 'settling', 'completed', 'reconciliation'].includes(stored.status)
      || stored.input.near || stored.nearResult || ['session', 'near_inference'].includes(stored.input.task.kind)
      || hashJson(stored.input) !== stored.inputHash || platformWorkloadHash(stored.input) !== row.quote.workloadHash
      || host.cleanupConfirmed !== 1 || host.hostId !== row.quote.hostId || !sameAddress(host.owner, addressSchema.parse(row.owner))
      || host.leaseHash !== hostMessageHash(admitted.envelope.lease)
      || canonical(host.lease) !== canonical(admitted.envelope.lease)
      || stored.result && canonical(validateCpuResult(stored.result, row.id, row.quote.maxSeconds)) !== canonical(result)) {
      throw new Error('Platform v2 issuance requires the original cleaned-up paid CPU admission and outcome');
    }
    return { result, stored, host, admitted };
  }
  async prepare(row: RunRow, rawResult: CpuRunResult, rawDraft: Omit<PlatformSettlement, 'receiptHash'>): Promise<PlatformSettlement> {
    const source = await this.checkedSource(row, rawResult);
    const draftSettlement = platformSettlementSchema.parse({ ...rawDraft, receiptHash: bytes32Schema.parse(`0x${'1'.repeat(64)}`) });
    if (draftSettlement.runId !== row.id || draftSettlement.inferenceCharge !== '0'
      || draftSettlement.billableSeconds > source.result.billableSeconds || !row.admissionTx) {
      throw new Error('Platform v2 financial draft differs from the original CPU outcome');
    }
    const opening = await readPlatformV2OpeningAuthority(this.bridge.public, this.bridge.pins,
      bytes32Schema.parse(row.admissionTx), this.minConfirmations);
    const openingRef = platformV2PublicationOpeningSchema.parse({ transactionHash: opening.opening.transactionHash,
      blockHash: opening.opening.blockHash, blockNumber: opening.opening.blockNumber, logIndex: opening.opening.logIndex });
    const input: PlatformV2PrivateInput = { quote: row.quote, quoteSignature: signatureSchema.parse(row.signature),
      delegation: source.admitted.envelope.delegation, lease: source.admitted.envelope.lease,
      hostAdmission: source.admitted.admission, ticks: source.host.ticks, acknowledgments: source.host.acknowledgments,
      endedAt: draftSettlement.endedAt, billableSeconds: draftSettlement.billableSeconds, inferenceCharge: '0',
      status: source.result.status, output: source.result.output, outputSalt: newPlatformV2OutputSalt() };
    const candidate = draftSchema.parse({ input, opening: openingRef, resultHash: hashJson(source.result) });
    if (Buffer.byteLength(canonical(candidate), 'utf8') > 512 * 1024) throw new Error('Platform v2 private issuance draft exceeds its bound');
    // Verify before anchoring any private bytes. No external store write occurs yet.
    await preparePlatformV2EvidenceCore(candidate.input, opening.authority);
    await this.db.insert(platformV2IssuanceDrafts).values({ scope: this.scope, runId: row.id,
      draft: candidate, draftHash: hashJson(candidate) }).onConflictDoNothing();
    const saved = await this.original(row.id);
    // A concurrent insert may choose a different random salt; always use the first
    // durable salt. Every other byte, including output and meter history, must agree.
    if (!saved || canonical({ ...saved, input: { ...saved.input, outputSalt: null } })
      !== canonical({ ...candidate, input: { ...candidate.input, outputSalt: null } })) {
      throw new Error('Platform v2 issuance conflicts with its original durable outcome');
    }
    const prepared = await this.evidence.record(saved.input, opening.authority);
    await verifyPlatformV2AdmissionWitness({ protocol: 'telomere-platform-v2-admission-witness',
      receiptHash: prepared.receiptHash, evidenceCoreDigest: prepared.evidenceCoreDigest,
      openingTransactionHash: openingRef.transactionHash, openingBlockHash: openingRef.blockHash,
      envelope: source.admitted.envelope, admission: source.admitted.admission }, prepared.core,
    opening.authority, openingRef);
    await this.publisher.publish(prepared.core, saved.opening);
    await recheckPlatformV2Opening(this.bridge.public, opening.opening, this.minConfirmations);
    return platformSettlementSchema.parse({ ...rawDraft, receiptHash: prepared.receiptHash });
  }
  async assertPublished(row: RunRow): Promise<void> {
    if (row.receiptVersion !== 2 || !row.result || !row.settlement) {
      throw new Error('Platform v2 original financial outcome is unavailable');
    }
    const saved = await this.original(row.id);
    if (!saved || saved.resultHash !== hashJson(validateCpuResult(row.result, row.id, row.quote.maxSeconds))) {
      throw new Error('Platform v2 original issuance outcome is unavailable');
    }
    const checked = await this.prepare(row, row.result, { runId: row.settlement.runId,
      endedAt: row.settlement.endedAt, billableSeconds: row.settlement.billableSeconds, inferenceCharge: row.settlement.inferenceCharge });
    if (canonical(checked) !== canonical(platformSettlementSchema.parse(row.settlement))) {
      throw new Error('Platform v2 durable settlement differs from its published evidence');
    }
  }
  async assertReadable(row: RunRow): Promise<void> {
    if (row.receiptVersion !== 2 || !row.result || !row.settlement) throw new Error('Platform v2 original settlement is unavailable');
    await this.checkedSource(row, row.result);
    const draft = await this.original(row.id), evidence = await this.evidence.get(row.id);
    if (!draft || !evidence || draft.resultHash !== hashJson(row.result)
      || evidence.outputSalt !== draft.input.outputSalt || evidence.receiptHash !== row.settlement.receiptHash
      || evidence.core.endedAt !== row.settlement.endedAt || evidence.core.billableSeconds !== row.settlement.billableSeconds
      || evidence.core.inferenceCharge !== row.settlement.inferenceCharge) {
      throw new Error('Platform v2 original readable evidence differs from its financial leaf');
    }
    const retrieved = await this.publisher.retrieve(row.id, { expectedReceiptHash: evidence.receiptHash });
    if (canonical(retrieved.core) !== canonical(evidence.core) || canonical(retrieved.manifest.opening) !== canonical(draft.opening)) {
      throw new Error('Platform v2 readable copies differ from their original evidence and opening');
    }
  }
}
