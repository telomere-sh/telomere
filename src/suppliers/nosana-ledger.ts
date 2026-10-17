import { z } from 'zod';
import { addressSchema, bytes32Schema } from '../common.js';
import { nosanaCidSchema, solanaAddressSchema } from './nosana-reader.js';
import { PrivateSupplierJournal } from './private-journal.js';

const integerString = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const nosanaRecordSchema = z.object({
  id: bytes32Schema, owner: addressSchema, runId: bytes32Schema,
  idemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), requestHash: bytes32Schema,
  jobAddress: solanaAddressSchema, payer: solanaAddressSchema, market: solanaAddressSchema,
  node: solanaAddressSchema, ipfsJob: nosanaCidSchema,
  priceNosBaseUnitsPerSecond: integerString, timeoutSeconds: z.number().int().positive().max(86_400),
  timeStartSeconds: z.number().int().positive(),
  reservedNosBaseUnits: integerString, reservedUsdcMicros: integerString,
  quoteSource: z.string().min(1).max(256), quoteAsOfMs: z.number().int().nonnegative(),
  usdcMicrosPerMillionNosBaseUnits: integerString,
  state: z.enum(['active_observed', 'closed_unsettled', 'quarantined']),
  reason: z.string().max(160).nullable(), version: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  lastObservedAt: z.number().int().nonnegative(),
}).strict();
export type NosanaReservation = z.infer<typeof nosanaRecordSchema>;
const ledgerSchema = z.object({ version: z.literal(1), records: z.array(nosanaRecordSchema).max(128) }).strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>(), keys = new Set<string>(), runs = new Set<string>(), jobs = new Set<string>();
    for (const row of file.records) {
      const key = row.owner + ':' + row.idemKey, run = row.owner + ':' + row.runId;
      if (ids.has(row.id) || keys.has(key) || runs.has(run) || jobs.has(row.jobAddress)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate Nosana reservation' }); break;
      }
      ids.add(row.id); keys.add(key); runs.add(run); jobs.add(row.jobAddress);
    }
  });
type LedgerFile = z.infer<typeof ledgerSchema>;
const MAX_FILE_BYTES = 262_144;

/** Crash-consistent local admission journal. A stale lock requires confirmed operator recovery. */
export class FileNosanaLedger {
  readonly path: string;
  private readonly journal: PrivateSupplierJournal<LedgerFile>;
  constructor(path: string) {
    this.journal = new PrivateSupplierJournal({ path, kind: 'telomere-nosana-reservations-v1', schema: ledgerSchema, maximum: MAX_FILE_BYTES });
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
