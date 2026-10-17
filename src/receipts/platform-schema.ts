import { bigint, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PlatformSettlement } from '../platform-runtime/types.js';
import type { PlatformLeafRun } from './platform-merkle.js';

export const platformReceiptLock = pgTable('platform_receipt_lock', { id: integer().primaryKey() });
export const platformReceiptBatches = pgTable('platform_receipt_batches', {
  scope: text().notNull(), hour: bigint({ mode: 'number' }).notNull(), root: text().notNull(), count: integer().notNull(),
  algorithm: text().notNull(), transactionHash: text(), blockHash: text(), blockNumber: text(), signer: text(),
}, table => [primaryKey({ columns: [table.scope, table.hour] })]);
export const platformReceiptEntries = pgTable('platform_receipt_entries', {
  scope: text().notNull(), runId: text().notNull(), owner: text().notNull(), hour: bigint({ mode: 'number' }).notNull(),
  receiptHash: text().notNull(), leaf: text().notNull(), settlement: jsonb().$type<PlatformSettlement>().notNull(),
  run: jsonb().$type<PlatformLeafRun>().notNull(), position: integer(),
}, table => [primaryKey({ columns: [table.scope, table.runId] }),
  uniqueIndex('platform_receipt_hash_unique').on(table.scope, table.receiptHash),
  uniqueIndex('platform_receipt_position_unique').on(table.scope, table.hour, table.position)]);
export const platformReceiptTables = { platformReceiptLock, platformReceiptBatches, platformReceiptEntries };
export const platformReceiptDdl = `
CREATE TABLE IF NOT EXISTS platform_receipt_lock (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO platform_receipt_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_receipt_batches (
 scope text NOT NULL, hour bigint NOT NULL CHECK(hour>=0 AND hour<2400000000), root text NOT NULL,
 count integer NOT NULL CHECK(count BETWEEN 1 AND 4096), algorithm text NOT NULL CHECK(algorithm='platform-financial-double-keccak-v1'),
 transaction_hash text, block_hash text, block_number text, signer text, PRIMARY KEY(scope,hour)
);
CREATE TABLE IF NOT EXISTS platform_receipt_entries (
 scope text NOT NULL, run_id text NOT NULL, owner text NOT NULL, hour bigint NOT NULL CHECK(hour>=0 AND hour<2400000000),
 receipt_hash text NOT NULL, leaf text NOT NULL, settlement jsonb NOT NULL, run jsonb NOT NULL,
 position integer CHECK(position BETWEEN 0 AND 4095), PRIMARY KEY(scope,run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_receipt_hash_unique ON platform_receipt_entries(scope,receipt_hash);
CREATE UNIQUE INDEX IF NOT EXISTS platform_receipt_position_unique ON platform_receipt_entries(scope,hour,position);
CREATE INDEX IF NOT EXISTS platform_receipt_owner ON platform_receipt_entries(scope,owner,run_id);
CREATE INDEX IF NOT EXISTS platform_receipt_hour ON platform_receipt_entries(scope,hour);
`;
