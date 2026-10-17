import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SignedHostAck, SignedHostLease, SignedHostTick } from './protocol.js';
export const controllerHostRuns = pgTable('controller_host_runs', {
  runId: text().primaryKey(), owner: text().notNull(), hostKey: text().notNull(), leaseHash: text().notNull(),
  lease: jsonb().$type<SignedHostLease>().notNull(), ticks: jsonb().$type<SignedHostTick[]>().notNull().default([]),
  acknowledgments: jsonb().$type<SignedHostAck[]>().notNull().default([]), cleanupConfirmed: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const controllerHostMigrationSQL = `
CREATE TABLE IF NOT EXISTS controller_host_runs (
 run_id text PRIMARY KEY REFERENCES jobs(id), owner text NOT NULL, host_key text NOT NULL, lease_hash text NOT NULL,
 lease jsonb NOT NULL, ticks jsonb NOT NULL DEFAULT '[]', acknowledgments jsonb NOT NULL DEFAULT '[]',
 cleanup_confirmed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
`;
