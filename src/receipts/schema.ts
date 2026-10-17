import { bigint, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { SignedReceipt } from '../service.js';

export const receiptHourLock = pgTable('receipt_hour_lock', { id: integer().primaryKey() });
export const receiptHourBatches = pgTable('receipt_hour_batches', {
  hour: bigint({ mode: 'number' }).primaryKey(), root: text().notNull(), leafCount: integer().notNull(),
  algorithm: text().notNull(), cutoff: timestamp({ withTimezone: true }).notNull(),
  sealedAt: timestamp({ withTimezone: true }).notNull(),
});
export const receiptHourEntries = pgTable('receipt_hour_entries', {
  runId: text().primaryKey(), hour: bigint({ mode: 'number' }).notNull().references(() => receiptHourBatches.hour),
  owner: text().notNull(), receiptHash: text().notNull(), leaf: text().notNull(), position: integer().notNull(),
  receipt: jsonb().$type<SignedReceipt>().notNull(),
}, table => [uniqueIndex('receipt_hour_entries_hash').on(table.receiptHash),
  uniqueIndex('receipt_hour_entries_position').on(table.hour, table.position)]);

// Fixed DDL, exported for the controller's existing migration transaction.
export const receiptHourMigrationSQL = `
CREATE TABLE IF NOT EXISTS receipt_hour_lock (id integer PRIMARY KEY CHECK (id = 1));
INSERT INTO receipt_hour_lock(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS receipt_hour_batches (
 hour bigint PRIMARY KEY CHECK (hour >= 0 AND hour < 2400000000), root text NOT NULL,
 leaf_count integer NOT NULL CHECK (leaf_count BETWEEN 0 AND 4096),
 algorithm text NOT NULL CHECK (algorithm = 'double-keccak-receipt-v1'),
 cutoff timestamptz NOT NULL, sealed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_hour_entries (
 run_id text PRIMARY KEY REFERENCES jobs(id), hour bigint NOT NULL REFERENCES receipt_hour_batches(hour),
 owner text NOT NULL, receipt_hash text NOT NULL, leaf text NOT NULL,
 position integer NOT NULL CHECK (position BETWEEN 0 AND 4095), receipt jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS receipt_hour_entries_hash ON receipt_hour_entries(receipt_hash);
CREATE UNIQUE INDEX IF NOT EXISTS receipt_hour_entries_position ON receipt_hour_entries(hour, position);
CREATE INDEX IF NOT EXISTS receipt_hour_entries_owner_run ON receipt_hour_entries(owner, run_id);
`;
