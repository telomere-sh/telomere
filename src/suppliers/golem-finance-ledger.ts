import { z } from 'zod';
import { bytes32Schema, hashJson } from '../common.js';
import { PrivateSupplierJournal } from './private-journal.js';
import { golemFinanceIdSchema, golemFinanceIntentId, golemFinancePolicySchema, golemFinanceUnitsSchema,
  golemOriginalRunSchema, golemTreasuryEvidenceSchema, type GolemFinancePolicy, type GolemTreasuryEvidence } from './golem-finance-types.js';

export const GOLEM_FINANCE_MAX_RUNS = 16;
export const GOLEM_FINANCE_MAX_DOCUMENTS = 32;
export const GOLEM_FINANCE_MAX_PAYMENTS = 32;
export const GOLEM_FINANCE_MAX_INTENTS = 64;
const timestamp = z.number().int().nonnegative().safe();
const documentSchema = z.object({ kind: z.enum(['debit', 'invoice']), id: golemFinanceIdSchema,
  hash: bytes32Schema, totalBaseUnits: golemFinanceUnitsSchema,
  accepted: z.boolean() }).strict();
const intentSchema = z.object({ id: bytes32Schema, key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  requestHash: bytes32Schema, action: z.enum(['accept_debit', 'accept_invoice', 'destroy_activity', 'terminate_agreement', 'release_allocation']),
  resourceId: golemFinanceIdSchema, totalBaseUnits: golemFinanceUnitsSchema.nullable(),
  status: z.enum(['pending', 'unknown', 'confirmed', 'aborted_before_send']), createdAtMs: timestamp }).strict();
export const golemFinanceRecordSchema = z.object({ original: golemOriginalRunSchema.omit({ active: true, asOfMs: true }),
  bindingHash: bytes32Schema, admissionKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  createdAtMs: timestamp, stopRequestedAtMs: timestamp.nullable(), disputed: z.boolean(),
  acceptedBaseUnits: golemFinanceUnitsSchema, paidBaseUnits: golemFinanceUnitsSchema, settledBaseUnits: golemFinanceUnitsSchema,
  documents: z.array(documentSchema).max(GOLEM_FINANCE_MAX_DOCUMENTS),
  intents: z.array(intentSchema).max(GOLEM_FINANCE_MAX_INTENTS),
  payments: z.array(z.object({ id: golemFinanceIdSchema, hash: bytes32Schema,
    scopedBaseUnits: golemFinanceUnitsSchema, totalBaseUnits: golemFinanceUnitsSchema,
    confirmed: z.boolean(), proofHash: bytes32Schema.nullable(),
    settlementReference: bytes32Schema.nullable().default(null), checkedAtMs: timestamp }).strict()).max(GOLEM_FINANCE_MAX_PAYMENTS),
  stopProofHash: bytes32Schema.nullable(), releaseProofHash: bytes32Schema.nullable(),
}).strict();
export type GolemFinanceRecord = z.infer<typeof golemFinanceRecordSchema>;
export type GolemFinanceIntent = GolemFinanceRecord['intents'][number];
const fileSchema = z.object({ version: z.literal(1), policyHash: bytes32Schema,
  initialTreasury: golemTreasuryEvidenceSchema, records: z.array(golemFinanceRecordSchema).max(GOLEM_FINANCE_MAX_RUNS) }).strict()
  .superRefine((file, context) => {
    const seen = new Set<string>(), payments = new Map<string, { hash: string; total: bigint; assigned: bigint; reference: string | null }>();
    const settlements = new Map<string, string>();
    for (const row of file.records) {
      const identities = ['run:' + row.original.owner + ':' + row.original.runId,
        'key:' + row.original.owner + ':' + row.admissionKey, 'allocation:' + row.original.allocationId,
        'agreement:' + row.original.agreementId, 'activity:' + row.original.activityId];
      const unique = <T>(values: readonly T[], key: (value: T) => string) => new Set(values.map(key)).size === values.length;
      if (identities.some(value => seen.has(value)) || hashJson(row.original) !== row.bindingHash
        || !unique(row.documents, value => value.kind + ':' + value.id) || !unique(row.intents, value => value.id)
        || !unique(row.intents, value => value.key) || !unique(row.payments, value => value.id)
        || BigInt(row.acceptedBaseUnits) !== row.documents.reduce((amount, doc) => doc.accepted && BigInt(doc.totalBaseUnits) > amount ? BigInt(doc.totalBaseUnits) : amount, 0n)
        || BigInt(row.acceptedBaseUnits) > BigInt(row.original.maxGlmBaseUnits)
        || BigInt(row.settledBaseUnits) > BigInt(row.paidBaseUnits)
        || BigInt(row.paidBaseUnits) > BigInt(row.original.maxGlmBaseUnits)
        || row.payments.reduce((sum, value) => sum + BigInt(value.scopedBaseUnits), 0n) !== BigInt(row.paidBaseUnits)
        || row.payments.reduce((sum, value) => sum + (value.confirmed ? BigInt(value.scopedBaseUnits) : 0n), 0n) !== BigInt(row.settledBaseUnits)
        || row.payments.some(value => value.confirmed !== (value.proofHash !== null)
          || value.confirmed && value.settlementReference === null)) {
        context.addIssue({ code: 'custom', message: 'Golem financial journal invariants differ' });
      }
      for (const intent of row.intents) {
        const money = intent.action === 'accept_debit' || intent.action === 'accept_invoice';
        const doc = row.documents.find(value => value.kind === (intent.action === 'accept_debit' ? 'debit' : 'invoice') && value.id === intent.resourceId);
        const resource = intent.action === 'destroy_activity' ? row.original.activityId
          : intent.action === 'terminate_agreement' ? row.original.agreementId : row.original.allocationId;
        if (intent.id !== golemFinanceIntentId(row.bindingHash, intent.action, intent.resourceId)
          || intent.requestHash !== hashJson({ id: intent.id, totalBaseUnits: intent.totalBaseUnits })
          || (money ? !doc || intent.totalBaseUnits !== doc.totalBaseUnits
            || intent.status === 'confirmed' && !doc.accepted
            : intent.totalBaseUnits !== null || intent.resourceId !== resource)) {
          context.addIssue({ code: 'custom', message: 'Golem financial intent binding differs' });
        }
      }
      for (const doc of row.documents) if (doc.accepted && !row.intents.some(value => value.status === 'confirmed'
        && value.action === (doc.kind === 'debit' ? 'accept_debit' : 'accept_invoice') && value.resourceId === doc.id)) {
        context.addIssue({ code: 'custom', message: 'Golem accepted document lacks original intent' });
      }
      for (const payment of row.payments) {
        const old = payments.get(payment.id), total = BigInt(payment.totalBaseUnits), scoped = BigInt(payment.scopedBaseUnits);
        if (old && (old.hash !== payment.hash || old.total !== total
          || old.reference !== null && payment.settlementReference !== null && old.reference !== payment.settlementReference) || scoped > total) {
          context.addIssue({ code: 'custom', message: 'Golem original batch payment differs' });
        }
        const assigned = (old?.assigned ?? 0n) + scoped;
        if (assigned > total) context.addIssue({ code: 'custom', message: 'Golem batch payment is assigned more than once' });
        const reference = payment.settlementReference ?? old?.reference ?? null;
        if (reference !== null) {
          const originalId = settlements.get(reference);
          if (originalId !== undefined && originalId !== payment.id) {
            context.addIssue({ code: 'custom', message: 'Golem settlement is assigned to another payment identity' });
          }
          settlements.set(reference, payment.id);
        }
        payments.set(payment.id, { hash: payment.hash, total, assigned, reference });
      }
      for (const value of identities) seen.add(value);
    }
  });
export type GolemFinanceFile = z.infer<typeof fileSchema>;

/** Separate kind and identity; existing Akash/Nosana/shared journals are untouched.
 * This is bounded private local storage, not rollback-proof external accounting. */
export class FileGolemFinanceLedger {
  readonly policy: GolemFinancePolicy;
  readonly policyHash: ReturnType<typeof hashJson>;
  private readonly journal: PrivateSupplierJournal<GolemFinanceFile>;
  constructor(path: string, policy: unknown) {
    this.policy = Object.freeze(golemFinancePolicySchema.parse(policy)); this.policyHash = hashJson(this.policy);
    this.journal = new PrivateSupplierJournal({ path, kind: 'telomere-golem-financial-lifecycle-v1',
      binding: this.policyHash, maximum: 1_048_576, schema: fileSchema });
  }
  async initializeFresh(initial: GolemTreasuryEvidence): Promise<void> {
    await this.journal.initializeFresh({ version: 1, policyHash: this.policyHash, initialTreasury: initial, records: [] });
  }
  async read(): Promise<GolemFinanceFile> {
    const file = await this.journal.read();
    if (file.policyHash !== this.policyHash) throw new Error('Golem financial policy differs');
    return file;
  }
  async transact<T>(change: (file: GolemFinanceFile) => T | Promise<T>): Promise<T> {
    return this.journal.transact(file => {
      if (file.policyHash !== this.policyHash) throw new Error('Golem financial policy differs');
      return change(file);
    });
  }
  /** The initial pending intent must already be durable. The caller marks
   * uncertainty before the bounded external mutation and catches protocol
   * outcomes inside this callback so unknown can itself commit durably. */
  async authorize<T>(change: (file: GolemFinanceFile, uncertain: () => void) => Promise<T>): Promise<T> {
    return this.journal.transact(async (file, uncertain) => {
      if (file.policyHash !== this.policyHash) throw new Error('Golem financial policy differs');
      return change(file, uncertain);
    });
  }
}
