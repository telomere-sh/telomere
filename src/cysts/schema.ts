import { integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { CystHeader } from './types.js';

export const cystOwners = pgTable('cyst_owners', {
  owner: text().primaryKey(), usedBytes: integer().notNull().default(0), checkpoints: integer().notNull().default(0),
});
export const cysts = pgTable('cysts', {
  owner: text().notNull(), id: text().notNull(), agent: text().notNull(),
  idemKey: text().notNull(), requestHash: text().notNull(),
  version: integer().notNull(), algorithm: text().$type<CystHeader['algorithm']>().notNull(),
  applicationSchema: text().notNull(), plaintextBytes: integer().notNull(), nonce: text().notNull(),
  sha256: text().notNull(), ciphertextBytes: integer().notNull(),
  state: text().$type<'pending' | 'ready'>().notNull().default('pending'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.owner, table.id] }),
  uniqueIndex('cysts_owner_idem').on(table.owner, table.idemKey), uniqueIndex('cysts_owner_nonce').on(table.owner, table.nonce)]);
export type CystRecord = typeof cysts.$inferSelect;
export const cystMigrationSQL = `
CREATE TABLE IF NOT EXISTS cyst_owners (
 owner text PRIMARY KEY, used_bytes integer NOT NULL DEFAULT 0 CHECK (used_bytes >= 0 AND used_bytes <= 33554432),
 checkpoints integer NOT NULL DEFAULT 0 CHECK (checkpoints >= 0 AND checkpoints <= 512)
);
CREATE TABLE IF NOT EXISTS cysts (
 owner text NOT NULL REFERENCES cyst_owners(owner), id text NOT NULL, agent text NOT NULL,
 idem_key text NOT NULL, request_hash text NOT NULL,
 version integer NOT NULL CHECK (version = 1), algorithm text NOT NULL CHECK (algorithm = 'xchacha20-poly1305'),
 application_schema text NOT NULL, plaintext_bytes integer NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 2097152),
 nonce text NOT NULL, sha256 text NOT NULL,
 ciphertext_bytes integer NOT NULL CHECK (ciphertext_bytes = plaintext_bytes + 16),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cysts_owner_idem ON cysts(owner, idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS cysts_owner_nonce ON cysts(owner, nonce);
CREATE INDEX IF NOT EXISTS cysts_owner_agent_id ON cysts(owner, agent, id);
`;
// Execute only under the explicit reviewed v2 policy, in one SQL transaction.
export const cystQuotaV2MigrationSQL = `
ALTER TABLE cyst_owners DROP CONSTRAINT IF EXISTS cyst_owners_checkpoints_check;
ALTER TABLE cyst_owners ADD CONSTRAINT cyst_owners_checkpoints_check CHECK (checkpoints >= 0 AND checkpoints <= 4096);
`;
