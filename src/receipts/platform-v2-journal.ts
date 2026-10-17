import { and, eq, sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { addressSchema, bytes32Schema, canonical, hashJson } from '../common.js';
import type { Database } from '../store.js';
import { platformV2EvidenceCoreSchema, platformV2EvidenceDigest, platformV2ReceiptHash,
  preparePlatformV2EvidenceCore, type PlatformV2EvidenceCore, type PlatformV2HistoricalAuthority,
  type PlatformV2PrivateInput } from './platform-v2.js';

/** Private, opt-in pre-settlement journal. Neither the runtime nor migrations mount it by default. */
export const platformV2EvidenceJournal = pgTable('platform_v2_evidence_journal', {
  scope: text().notNull(), runId: text().notNull(), receiptHash: text().notNull(),
  evidenceCoreDigest: text().notNull(), core: jsonb().$type<PlatformV2EvidenceCore>().notNull(),
  outputSalt: text().notNull(), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.scope, table.runId] }),
  uniqueIndex('platform_v2_receipt_hash_unique').on(table.scope, table.receiptHash)]);
const ddl = `
CREATE TABLE IF NOT EXISTS platform_v2_evidence_journal (
 scope text NOT NULL, run_id text NOT NULL, receipt_hash text NOT NULL,
 evidence_core_digest text NOT NULL, core jsonb NOT NULL, output_salt text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_v2_receipt_hash_unique
 ON platform_v2_evidence_journal(scope,receipt_hash);
`;
const zero = `0x${'0'.repeat(64)}`;

export class PlatformV2EvidenceJournal {
  readonly scope: string;
  constructor(private readonly db: Database, chainId: number, escrowValue: string, registryValue: string) {
    if (![31337, 8453, 84532].includes(chainId)) throw new Error('Invalid Platform v2 journal chain');
    const escrow = addressSchema.parse(escrowValue), hostRegistry = addressSchema.parse(registryValue);
    this.scope = hashJson({ protocol: 'telomere-platform-v2-journal', chainId,
      escrow: escrow.toLowerCase(), hostRegistry: hostRegistry.toLowerCase() });
  }
  async initialize(): Promise<void> {
    for (const statement of ddl.split(';').map(value => value.trim()).filter(Boolean)) {
      await this.db.execute(sql.raw(statement));
    }
  }
  private check(coreValue: unknown, saltValue: string) {
    const core = platformV2EvidenceCoreSchema.parse(coreValue), salt = bytes32Schema.parse(saltValue);
    if (salt === zero || Buffer.byteLength(JSON.stringify(core), 'utf8') > 256 * 1024) {
      throw new Error('Invalid private Platform v2 evidence or salt');
    }
    const body = core.delegation.body;
    const expectedScope = hashJson({ protocol: 'telomere-platform-v2-journal', chainId: body.chainId,
      escrow: body.escrow.toLowerCase(), hostRegistry: body.hostRegistry.toLowerCase() });
    if (expectedScope !== this.scope || core.quote.runId !== body.runId) {
      throw new Error('Platform v2 evidence does not belong to this deployment scope');
    }
    return { core, salt, receiptHash: platformV2ReceiptHash(core), evidenceCoreDigest: platformV2EvidenceDigest(core) };
  }
  /** Exactly one original core/salt may be recorded. Lost insert responses are read back, never replaced. */
  async record(original: PlatformV2PrivateInput, historical: PlatformV2HistoricalAuthority) {
    const prepared = await preparePlatformV2EvidenceCore(original, historical);
    const checked = this.check(prepared.core, original.outputSalt), runId = checked.core.quote.runId;
    await this.db.insert(platformV2EvidenceJournal).values({
      scope: this.scope, runId, receiptHash: checked.receiptHash,
      evidenceCoreDigest: checked.evidenceCoreDigest, core: checked.core, outputSalt: checked.salt,
    }).onConflictDoNothing();
    const saved = await this.get(runId);
    if (!saved || saved.receiptHash !== checked.receiptHash
      || saved.evidenceCoreDigest !== checked.evidenceCoreDigest
      || saved.outputSalt !== checked.salt || canonical(saved.core) !== canonical(checked.core)) {
      throw new Error('Platform v2 original evidence conflicts with the durable preimage');
    }
    return saved;
  }
  async get(runValue: string) {
    const runId = bytes32Schema.parse(runValue);
    const [row] = await this.db.select().from(platformV2EvidenceJournal)
      .where(and(eq(platformV2EvidenceJournal.scope, this.scope), eq(platformV2EvidenceJournal.runId, runId))).limit(1);
    if (!row) return undefined;
    const checked = this.check(row.core, row.outputSalt);
    if (row.receiptHash !== checked.receiptHash || row.evidenceCoreDigest !== checked.evidenceCoreDigest) {
      throw new Error('Platform v2 durable preimage changed after insertion');
    }
    return { runId, core: checked.core, outputSalt: checked.salt,
      receiptHash: checked.receiptHash, evidenceCoreDigest: checked.evidenceCoreDigest };
  }
}
