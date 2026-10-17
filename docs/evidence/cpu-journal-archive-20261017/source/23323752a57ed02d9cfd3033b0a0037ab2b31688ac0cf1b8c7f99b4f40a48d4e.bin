import { pgTable, text, jsonb, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';

export const journalArchiveBatches = pgTable('settlement_journal_archive_batches', {
  id: text().primaryKey(), sequence: integer().notNull(), body: jsonb().$type<unknown>().notNull(),
  signature: text().notNull(), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('settlement_archive_sequence').on(table.sequence)]);

export const journalMigration = [
  `CREATE TABLE IF NOT EXISTS settlement_journal_archive_batches (
    id text PRIMARY KEY, sequence integer NOT NULL UNIQUE, body jsonb NOT NULL,
    signature text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE transaction_journal ADD COLUMN IF NOT EXISTS archive_batch_id text REFERENCES settlement_journal_archive_batches(id)`,
  `CREATE INDEX IF NOT EXISTS settlement_journal_hot ON transaction_journal(run_id) WHERE archive_batch_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS settlement_journal_batch ON transaction_journal(archive_batch_id,run_id)`,
  `CREATE TABLE IF NOT EXISTS settlement_journal_lock (id integer PRIMARY KEY CHECK(id=1))`,
  `INSERT INTO settlement_journal_lock(id) VALUES(1) ON CONFLICT DO NOTHING`,
  `CREATE OR REPLACE FUNCTION telomere_journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' OR TG_TABLE_NAME = 'settlement_journal_archive_batches' THEN
        RAISE EXCEPTION 'Signed settlement history is immutable';
      END IF;
      IF (to_jsonb(NEW) - 'archive_batch_id') IS DISTINCT FROM (to_jsonb(OLD) - 'archive_batch_id')
         OR OLD.archive_batch_id IS NOT NULL OR NEW.archive_batch_id IS NULL THEN
        RAISE EXCEPTION 'Signed settlement history is immutable';
      END IF;
      RETURN NEW;
    END $$`,
  `DROP TRIGGER IF EXISTS settlement_journal_immutable ON transaction_journal`,
  `CREATE TRIGGER settlement_journal_immutable BEFORE UPDATE OR DELETE ON transaction_journal
    FOR EACH ROW EXECUTE FUNCTION telomere_journal_immutable()`,
  `DROP TRIGGER IF EXISTS settlement_archive_immutable ON settlement_journal_archive_batches`,
  `CREATE TRIGGER settlement_archive_immutable BEFORE UPDATE OR DELETE ON settlement_journal_archive_batches
    FOR EACH ROW EXECUTE FUNCTION telomere_journal_immutable()`,
  `DROP TRIGGER IF EXISTS settlement_journal_no_truncate ON transaction_journal`,
  `CREATE TRIGGER settlement_journal_no_truncate BEFORE TRUNCATE ON transaction_journal
    FOR EACH STATEMENT EXECUTE FUNCTION telomere_journal_immutable()`,
  `DROP TRIGGER IF EXISTS settlement_archive_no_truncate ON settlement_journal_archive_batches`,
  `CREATE TRIGGER settlement_archive_no_truncate BEFORE TRUNCATE ON settlement_journal_archive_batches
    FOR EACH STATEMENT EXECUTE FUNCTION telomere_journal_immutable()`,
];
