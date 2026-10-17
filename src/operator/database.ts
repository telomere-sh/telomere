import { asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import { parseTransaction } from 'viem';
import { bytes32Schema } from '../common.js';
import { jobs, transactions } from '../store.js';
import { platformRuns } from '../platform-runtime/schema.js';

/** Never uses openStore, migrations, or pg_try_advisory_lock. All statements share a read-only snapshot. */
export async function databaseSnapshot(connectionString: string, chainNonce: number, platformConfigured = false) {
  z.string().url().parse(connectionString); z.number().int().min(0).parse(chainNonce);
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
    statement_timeout: 5000, application_name: 'telomere-readonly-diagnostics' });
  try {
    const db = drizzle(pool, { casing: 'snake_case' });
    return await db.transaction(async transaction => {
      const statusCounts = await transaction.select({ status: jobs.status, count: sql<number>`count(*)::integer` }).from(jobs).groupBy(jobs.status);
      const oldestQueued = await transaction.select({ createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.createdAt)).limit(1);
      const oldestActive = await transaction.select({ updatedAt: jobs.updatedAt }).from(jobs)
        .where(inArray(jobs.status, ['running', 'near_dispatching', 'settling'])).orderBy(asc(jobs.updatedAt)).limit(1);
      const table = await transaction.execute<{ present: boolean }>(sql`SELECT to_regclass('platform_runs') IS NOT NULL AS present`);
      const platformInstalled = table.rows[0]?.present === true;
      if (!platformInstalled && platformConfigured) throw new Error('Configured paid platform journal is missing');
      const platformStatusCounts = platformInstalled ? await transaction.select({ status: platformRuns.status,
        count: sql<number>`count(*)::integer` }).from(platformRuns).groupBy(platformRuns.status) : [];
      const platformQueued = platformInstalled ? await transaction.select({ createdAt: platformRuns.createdAt }).from(platformRuns)
        .where(eq(platformRuns.status, 'queued')).orderBy(asc(platformRuns.createdAt)).limit(1) : [];
      const platformRunning = platformInstalled ? await transaction.select({ updatedAt: platformRuns.updatedAt }).from(platformRuns)
        .where(eq(platformRuns.status, 'running')).orderBy(asc(platformRuns.updatedAt)).limit(1) : [];
      const platformFinancial = platformInstalled ? await transaction.select({ createdAt: platformRuns.createdAt }).from(platformRuns)
        .where(inArray(platformRuns.status, ['receipt_pending', 'settling']))
        .orderBy(asc(platformRuns.createdAt)).limit(1) : [];
      const platformPrepared = platformInstalled ? await transaction.select({ createdAt: platformRuns.createdAt }).from(platformRuns)
        .where(eq(platformRuns.status, 'prepared')).orderBy(asc(platformRuns.createdAt)).limit(1) : [];
      const platformVaultSync = platformInstalled ? await transaction.select({ createdAt: platformRuns.createdAt }).from(platformRuns)
        .where(sql`${platformRuns.vaultBinding} IS NOT NULL AND ${platformRuns.vaultSyncTx} IS NULL
          AND ${platformRuns.status} IN ('completed', 'refunded')`)
        .orderBy(asc(platformRuns.createdAt)).limit(1) : [];
      const journalSummary = await transaction.select({ count: sql<number>`count(*)::integer`, unknownNonceCount: sql<number>`count(*) filter (where nonce is null)::integer`,
        highestNonce: sql<number | null>`max(nonce)` }).from(transactions);
      const journal = await transaction.select({ runId: transactions.runId, raw: transactions.raw, txHash: transactions.hash, nonce: transactions.nonce,
        status: jobs.status, errorCode: jobs.errorCode }).from(transactions).innerJoin(jobs, eq(jobs.id, transactions.runId))
        .where(or(gte(transactions.nonce, chainNonce), isNull(transactions.nonce), inArray(jobs.status, ['settling', 'reconciliation'])))
        .orderBy(asc(transactions.createdAt)).limit(26);
      const reconciliation = await transaction.select({ runId: jobs.id, status: jobs.status, errorCode: jobs.errorCode })
        .from(jobs).where(eq(jobs.status, 'reconciliation')).orderBy(asc(jobs.createdAt)).limit(26);
      const pendingReceipts = await transaction.select({ runId: jobs.id, targetStatus: jobs.targetStatus, updatedAt: jobs.updatedAt })
        .from(jobs).where(eq(jobs.status, 'receipt_pending')).orderBy(asc(jobs.createdAt)).limit(26);
      const lock = await transaction.execute<{ held: boolean }>(sql`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
        AND classid = 0 AND objid = 728419023 AND objsubid = 1 AND mode = 'ExclusiveLock'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      ) AS held`);
      const counts = Object.fromEntries(statusCounts.map(item => [item.status, item.count]));
      const platformCounts = Object.fromEntries(platformStatusCounts.map(item => [item.status, item.count]));
      const knownPlatformStatuses = new Set(['prepared', 'queued', 'running', 'receipt_pending', 'settling',
        'reconciliation', 'completed', 'refunded']);
      const unknownPlatformStatusCount = platformStatusCounts.filter(item => !knownPlatformStatuses.has(item.status))
        .reduce((sum, item) => sum + item.count, 0);
      // Legacy bytes are only parsed in memory. Neither raw bytes nor private request columns leave this function.
      const publicJournal = journal.slice(0, 25).map(item => {
        let nonce = item.nonce;
        if (nonce === null) {
          try { nonce = parseTransaction(z.string().regex(/^0x[0-9a-fA-F]+$/).transform(value => {
            // REASON: the schema proves hexadecimal transaction bytes from the existing journal.
            return value as `0x${string}`;
          }).parse(item.raw)).nonce ?? null; } catch { nonce = null; }
        }
        return { runId: bytes32Schema.parse(item.runId), txHash: bytes32Schema.parse(item.txHash), nonce,
          status: z.string().max(64).parse(item.status), errorCode: z.string().max(128).nullable().parse(item.errorCode) };
      });
      return { controllerLockHeld: lock.rows[0]?.held ?? false, counts, oldestQueuedAt: oldestQueued[0]?.createdAt.toISOString() ?? null,
        oldestActiveUpdatedAt: oldestActive[0]?.updatedAt.toISOString() ?? null,
        platform: !platformInstalled ? { status: 'not_installed' as const } : { counts: platformCounts,
          unknownStatusCount: unknownPlatformStatusCount,
          oldestQueuedCreatedAt: platformQueued[0]?.createdAt.toISOString() ?? null,
          oldestRunningUpdatedAt: platformRunning[0]?.updatedAt.toISOString() ?? null,
          oldestFinancialCreatedAt: platformFinancial[0]?.createdAt.toISOString() ?? null,
          oldestPreparedCreatedAt: platformPrepared[0]?.createdAt.toISOString() ?? null,
          oldestVaultSyncCreatedAt: platformVaultSync[0]?.createdAt.toISOString() ?? null },
        journal: { ...(journalSummary[0] ?? { count: 0, unknownNonceCount: 0, highestNonce: null }), selected: publicJournal,
          truncated: journal.length > 25 }, reconciliation: reconciliation.slice(0, 25), reconciliationTruncated: reconciliation.length > 25,
        pendingReceipts: pendingReceipts.slice(0, 25), pendingReceiptsTruncated: pendingReceipts.length > 25 };
    }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
  } finally { await pool.end(); }
}
