import { createPrivateKey, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { Ed25519Identity, type SignedHostAck, type SignedHostLease, type SignedHostTick } from './protocol.js';
import type { SignedHostV2AdmissionReceipt } from './v2-admission.js';
import type { SessionRecord, SessionSpec } from './sessions/types.js';

export const hostRuns = pgTable('host_runs', {
  runId: text().primaryKey(), owner: text().notNull(), leaseHash: text().notNull(), lease: jsonb().$type<SignedHostLease>().notNull(),
  state: text().$type<'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'fault'>().notNull(),
  ticks: jsonb().$type<SignedHostTick[]>().notNull().default([]), acks: jsonb().$type<SignedHostAck[]>().notNull().default([]),
  billableSeconds: integer().notNull().default(0), output: text().notNull().default(''), exitCode: integer().notNull().default(-1),
  cleanupConfirmed: boolean().notNull().default(false),
  v2Admission: jsonb().$type<SignedHostV2AdmissionReceipt>(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const hostCommands = pgTable('host_commands', { nonce: text().primaryKey(), hash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull() });
export const hostBinding = pgTable('host_binding', { slot: text().primaryKey(), scopeHash: text().notNull(), scope: jsonb().notNull() });
export const hostClaims = pgTable('host_claims', { slot: text().primaryKey(), kind: text().$type<'oneshot' | 'session'>().notNull(),
  resourceId: text().notNull(), token: text().notNull(), scopeHash: text().notNull(), inputHash: text().notNull(), original: jsonb().notNull(),
  dispatchStarted: boolean().notNull().default(false) });
export const hostSessions = pgTable('host_sessions', { sessionId: text().primaryKey(), spec: jsonb().$type<SessionSpec>().notNull(),
  specHash: text().notNull(), backend: jsonb().$type<SessionRecord['backend']>().notNull(), claimToken: text().notNull(),
  record: jsonb().$type<SessionRecord>(), updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow() });
export const hostPaidSessions = pgTable('host_paid_sessions', { sessionId: text().primaryKey(), owner: text().notNull(),
  leaseHash: text().notNull(), lease: jsonb().$type<SignedHostLease>().notNull(),
  ticks: jsonb().$type<SignedHostTick[]>().notNull().default([]), acks: jsonb().$type<SignedHostAck[]>().notNull().default([]),
  billableSeconds: integer().notNull().default(0), state: text().$type<'starting' | 'running' | 'completed' | 'stopped' | 'expired' | 'fault'>().notNull(),
  cleanupConfirmed: boolean().notNull().default(false), updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow() });
export const hostPaidPreemptions = pgTable('host_paid_preemptions', {
  sessionId: text().primaryKey(), optIn: jsonb().$type<unknown>().notNull(), optInHash: text().notNull(),
  optInNonce: text().notNull().unique(), notice: jsonb().$type<unknown>(),
  requestHash: text(), requestNonce: text().unique(), cleanupConfirmed: boolean().notNull().default(false),
  enforcedAt: timestamp({ withTimezone: true }), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
const schema = { hostRuns, hostCommands, hostBinding, hostClaims, hostSessions, hostPaidPreemptions, hostPaidSessions };
export type HostRun = typeof hostRuns.$inferSelect;
export type HostJournal = Awaited<ReturnType<typeof openHostJournal>>;
export async function openHostJournal(path: string): Promise<{ db: ReturnType<typeof drizzle<typeof schema>>; identity: Ed25519Identity; close(): Promise<void> }> {
  let release: (() => Promise<void>) | undefined, identity: Ed25519Identity;
  if (path === ':memory:') identity = new Ed25519Identity();
  else {
    const directory = resolve(path); await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || (process.platform !== 'win32' && (state.mode & 0o077) !== 0)) throw new Error('Host state directory must be private');
    const lockPath = join(directory, 'host.lock');
    const acquire = () => open(lockPath, 'wx', 0o600);
    let lock;
    try { lock = await acquire(); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const metadata = await lstat(lockPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 512) throw new Error('Host lock rejected');
      const saved: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('pid' in saved) || !Number.isSafeInteger(saved.pid) || Number(saved.pid) <= 0) throw new Error('Host lock rejected');
      try { process.kill(Number(saved.pid), 0); throw new Error('Another Host Kit process owns this directory'); }
      catch (failure) { if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH')) throw failure; }
      const checked = await lstat(lockPath);
      if (checked.ino !== metadata.ino || checked.dev !== metadata.dev || checked.mtimeMs !== metadata.mtimeMs) throw new Error('Host lock changed');
      await unlink(lockPath); lock = await acquire();
    }
    const nonce = randomBytes(16).toString('hex'); await lock.writeFile(JSON.stringify({ pid: process.pid, nonce })); await lock.sync();
    release = async () => { await lock.close(); const saved = JSON.parse(await readFile(lockPath, 'utf8')) as { nonce?: string };
      if (saved.nonce !== nonce) throw new Error('Host lock ownership changed'); await unlink(lockPath); };
    try {
      const keyPath = join(directory, 'host-ed25519.pem');
      try {
        const metadata = await lstat(keyPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 1024
          || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw new Error('Host key file must be private');
        const pem = await readFile(keyPath, 'utf8'); createPrivateKey(pem); identity = new Ed25519Identity(pem);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        identity = new Ed25519Identity(); const key = await open(keyPath, 'wx', 0o600);
        try { await key.writeFile(identity.exportPrivatePem()); await key.sync(); } finally { await key.close(); }
      }
    } catch (error) { await release(); throw error; }
  }
  const client = new PGlite(path === ':memory:' ? undefined : join(resolve(path), 'journal'));
  const db = drizzle(client, { schema, casing: 'snake_case' });
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS host_runs (run_id text PRIMARY KEY, owner text NOT NULL,
      lease_hash text NOT NULL, lease jsonb NOT NULL, state text NOT NULL,
      ticks jsonb NOT NULL DEFAULT '[]', acks jsonb NOT NULL DEFAULT '[]', billable_seconds integer NOT NULL DEFAULT 0,
      output text NOT NULL DEFAULT '', exit_code integer NOT NULL DEFAULT -1, updated_at timestamptz NOT NULL DEFAULT now())`));
    await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS host_one_active ON host_runs ((1)) WHERE state IN ('starting','running')"));
    await db.execute(sql.raw('ALTER TABLE host_runs ADD COLUMN IF NOT EXISTS cleanup_confirmed boolean NOT NULL DEFAULT false'));
    await db.execute(sql.raw('ALTER TABLE host_runs ADD COLUMN IF NOT EXISTS v2_admission jsonb'));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS host_commands (nonce text PRIMARY KEY, hash text NOT NULL, created_at timestamptz NOT NULL)'));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS host_binding (slot text PRIMARY KEY, scope_hash text NOT NULL, scope jsonb NOT NULL)'));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS host_claims (slot text PRIMARY KEY, kind text NOT NULL, resource_id text NOT NULL, token text NOT NULL, scope_hash text NOT NULL, input_hash text NOT NULL, original jsonb NOT NULL)'));
    await db.execute(sql.raw('ALTER TABLE host_claims ADD COLUMN IF NOT EXISTS dispatch_started boolean NOT NULL DEFAULT false'));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS host_sessions (session_id text PRIMARY KEY, spec jsonb NOT NULL, spec_hash text NOT NULL, backend jsonb NOT NULL, claim_token text NOT NULL, record jsonb, updated_at timestamptz NOT NULL DEFAULT now())'));
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS host_paid_sessions (session_id text PRIMARY KEY, owner text NOT NULL, lease_hash text NOT NULL, lease jsonb NOT NULL, ticks jsonb NOT NULL DEFAULT '[]', acks jsonb NOT NULL DEFAULT '[]', billable_seconds integer NOT NULL DEFAULT 0, state text NOT NULL, cleanup_confirmed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())"));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS host_paid_preemptions (session_id text PRIMARY KEY, opt_in jsonb NOT NULL, opt_in_hash text NOT NULL, opt_in_nonce text NOT NULL UNIQUE, notice jsonb, request_hash text, request_nonce text UNIQUE, cleanup_confirmed boolean NOT NULL DEFAULT false, enforced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())'));
  } catch (error) { await client.close(); await release?.(); throw error; }
  return { db, identity, close: async () => { await client.close(); await release?.(); } };
}
