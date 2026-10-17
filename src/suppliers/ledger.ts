import { z } from 'zod';
import { addressSchema, bytes32Schema } from '../common.js';
import { akashAddressSchema, akashDseqSchema, akashQuantitySchema } from './akash-console.js';
import { akashCanonicalPriceSchema } from './akash-price.js';
import { PrivateSupplierJournal } from './private-journal.js';

const quantity = akashQuantitySchema;
export const supplierStateSchema = z.enum(['planned', 'canceled_unsubmitted', 'lease_submission_pending',
  'active', 'closure_submission_pending', 'closed_unsettled', 'quarantined']);
export const supplierRecordSchema = z.object({
  id: bytes32Schema, owner: addressSchema, runId: bytes32Schema,
  idemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), requestHash: bytes32Schema,
  akashOwner: akashAddressSchema, dseq: akashDseqSchema,
  gseq: z.number().int().positive().safe(), oseq: z.number().int().positive().safe(),
  provider: akashAddressSchema, deploymentHash: z.string().min(1).max(256),
  pricePerBlockUact: akashCanonicalPriceSchema, runtimeHours: z.number().int().min(1).max(24),
  reservedUact: quantity, reservedUsdcMicros: quantity,
  quoteSource: z.string().min(1).max(256), quoteAsOfMs: z.number().int().nonnegative(),
  usdcMicrosPerMillionUact: quantity, maxBlocksPerHour: z.number().int().min(1).max(100_000),
  signedBindingDigest: bytes32Schema.optional(),
  state: supplierStateSchema, version: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  lastObservedAt: z.number().int().nonnegative().nullable(), reason: z.string().max(160).nullable(),
}).strict();
export type SupplierRecord = z.infer<typeof supplierRecordSchema>;
/** Only an unsubmitted plan can release its local treasury projection. */
export function supplierReserveHeld(record: SupplierRecord): boolean {
  return record.state !== 'canceled_unsubmitted';
}
const fileSchema = z.object({ version: z.literal(1), records: z.array(supplierRecordSchema).max(128) }).strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>(), ownersAndKeys = new Set<string>(), runs = new Set<string>(), deployments = new Set<string>();
    for (const record of value.records) {
      const key = record.owner + ':' + record.idemKey, run = record.owner + ':' + record.runId;
      const deployment = record.akashOwner + ':' + record.dseq;
      if (ids.has(record.id) || ownersAndKeys.has(key) || runs.has(run) || deployments.has(deployment)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate supplier reservation' }); break;
      }
      ids.add(record.id); ownersAndKeys.add(key); runs.add(run); deployments.add(deployment);
    }
  });
type LedgerFile = z.infer<typeof fileSchema>;
const MAX_FILE_BYTES = 262_144;

/** Local durable supplier reservation journal. A held lock after a crash fails closed until operator recovery. */
export class FileSupplierLedger {
  readonly path: string;
  private readonly journal: PrivateSupplierJournal<LedgerFile>;
  constructor(path: string) {
    this.journal = new PrivateSupplierJournal({ path, kind: 'telomere-akash-reservations-v1', schema: fileSchema, maximum: MAX_FILE_BYTES });
    this.path = this.journal.path;
  }
  storagePaths(): readonly string[] { return this.journal.paths(); }
  async initializeFresh(): Promise<void> { await this.journal.initializeFresh({ version: 1, records: [] }); }
  async initializationGeneration(): Promise<string> { return this.journal.initializationGeneration(); }
  async read(): Promise<LedgerFile> { return this.journal.read(); }
  async transact<T>(mutate: (file: LedgerFile) => T | Promise<T>): Promise<T> {
    return this.journal.transact(mutate);
  }
}
