import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SharedReceiptSummary } from './receipt-links.js';

/** Consent record only. The signed receipt remains in the private job store. */
export const receiptLinks = pgTable('receipt_links', {
  runId: text().primaryKey(), owner: text().notNull(), receiptHash: text().notNull(),
  summary: jsonb().$type<SharedReceiptSummary>().notNull(),
  publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp({ withTimezone: true }),
});
export const receiptLinkMigrationSQL = `
CREATE TABLE IF NOT EXISTS receipt_links (
 run_id text PRIMARY KEY REFERENCES jobs(id), owner text NOT NULL, receipt_hash text NOT NULL,
 summary jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
`;
