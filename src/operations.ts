import { and, eq, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import type { Config } from './config.js';
import { jobs, type Database } from './store.js';
import type { Worker, WorkerSnapshot } from './worker.js';
import { nearReadinessSnapshot, type NearProviderReadiness } from './providers/readiness.js';

export type Operations = { worker: WorkerSnapshot; counts: Record<string, number>;
  near: { configured: boolean; verification: 'disabled' | 'provider_tls' | 'enclave_verified'; model?: string; readiness?: NearProviderReadiness }; cpu: { mode: 'demo' | 'docker' | 'hostkit' } };

export function createOperations(db: Database, worker: Worker, config: Config, nearAvailable: boolean, readiness?: () => Promise<NearProviderReadiness>) {
  return async (owner?: Address): Promise<Operations> => {
    await db.execute(sql`select 1`);
    const snapshot = worker.snapshot(), counts: Record<string, number> = {};
    if (owner) {
      const grouped = await db.select({ status: jobs.status, count: sql<number>`count(*)::integer` }).from(jobs)
        .where(eq(jobs.owner, owner.toLowerCase())).groupBy(jobs.status);
      for (const item of grouped) counts[item.status] = item.count;
      if (snapshot.activeRunId) {
        const ownRun = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.owner, owner.toLowerCase()), eq(jobs.id, snapshot.activeRunId))).limit(1))[0];
        if (!ownRun) delete snapshot.activeRunId;
      }
    } else delete snapshot.activeRunId;
    const nearReadiness = readiness ? await readiness() : nearReadinessSnapshot(nearAvailable ? 'ready' : 'disabled', nearAvailable ? 'CONFIGURATION_READY' : 'NOT_CONFIGURED', nearAvailable ? config.NEAR_VERIFICATION_MODE : null);
    return { worker: snapshot, counts, near: { configured: nearAvailable, readiness: nearReadiness, verification: nearAvailable ? config.NEAR_VERIFICATION_MODE : 'disabled',
      ...(nearAvailable && config.NEAR_MODEL ? { model: config.NEAR_MODEL } : {}) }, cpu: { mode: config.CPU_MODE } };
  };
}
