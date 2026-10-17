import { pgTable, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
export const workspaceDocuments = pgTable('workspace_documents', {
  owner: text().primaryKey(), revision: integer().notNull(), document: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const workspaceMigration = `CREATE TABLE IF NOT EXISTS quote_admission_lock (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO quote_admission_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner,created_at);
CREATE TABLE IF NOT EXISTS workspace_documents (
owner text PRIMARY KEY, revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
updated_at timestamptz NOT NULL DEFAULT now());`;
