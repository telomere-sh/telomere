import { and, eq } from 'drizzle-orm';
import type { Database } from '../store.js';
import { jobs } from '../store.js';
import { CpuCleanupError } from '../runtime/index.js';
import type { CpuExecutor, CpuRunInput, TickHandler } from '../runtime/types.js';
import { HostKitClient, HostKitCpuExecutor } from './client.js';
import { controllerHostRuns } from './controller-schema.js';
import { hostMessageHash, signedAckSchema, signedLeaseSchema, signedTickSchema, verifyHostMessage } from './protocol.js';

/** Durable controller half of Host Kit. No host operation runs before its original signed lease is saved. */
export class ControllerHostKitCpu implements CpuExecutor {
  constructor(private readonly db: Database, private readonly client: HostKitClient, private readonly image: string) {}
  async run(input: CpuRunInput, signal: AbortSignal, onTick?: TickHandler) {
    const [job] = await this.db.select().from(jobs).where(and(eq(jobs.id, input.runId), eq(jobs.status, 'running'))).limit(1);
    if (!job) throw new Error('Host dispatch requires a claimed durable controller run');
    const executor = new HostKitCpuExecutor(this.client, job.owner, this.image, {
      onLease: async value => {
        const lease = signedLeaseSchema.parse(value), leaseHash = hostMessageHash(lease);
        if (!verifyHostMessage(this.client.control.publicKey, 'lease', lease) || lease.body.hostKey !== this.client.hostKey
          || lease.body.runId !== job.id || lease.body.owner !== job.owner || lease.body.image !== this.image) throw new Error('Host lease scope changed');
        const inserted = await this.db.insert(controllerHostRuns).values({ runId: job.id, owner: job.owner,
          hostKey: this.client.hostKey, leaseHash, lease }).onConflictDoNothing().returning();
        if (!inserted.length) throw new Error('This run already owns a durable Host Kit lease; recover its original lease');
      },
      onEvidence: async (tickValue, ackValue) => {
        const tick = signedTickSchema.parse(tickValue), ack = signedAckSchema.parse(ackValue);
        await this.db.transaction(async tx => {
          const [record] = await tx.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId, job.id)).for('update');
          if (!record || record.cleanupConfirmed || !verifyHostMessage(this.client.hostKey, 'tick', tick)
            || !verifyHostMessage(this.client.control.publicKey, 'ack', ack) || tick.body.runId !== job.id || ack.body.runId !== job.id
            || tick.body.owner.toLowerCase() !== job.owner || ack.body.tickHash !== hostMessageHash(tick)
            || tick.body.sequence !== record.ticks.length || ack.body.sequence !== record.acknowledgments.length
            || tick.body.leaseHash !== hostMessageHash({ body: record.lease.body, signature: '' })
            || ack.body.leaseHash !== tick.body.leaseHash || record.ticks.length >= 100) throw new Error('Host evidence differs from the original lease');
          await tx.update(controllerHostRuns).set({ ticks: [...record.ticks, tick], acknowledgments: [...record.acknowledgments, ack], updatedAt: new Date() })
            .where(eq(controllerHostRuns.runId, job.id));
        });
      },
    });
    try {
      const result = await executor.run(input, signal, onTick);
      if (!signal.aborted || (await this.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId, job.id)).limit(1)).length) {
        const [record] = await this.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId, job.id)).limit(1);
        if (record) {
          const status = await this.client.command(record.lease, 'status');
          if (!status.cleanupConfirmed || ['starting', 'running'].includes(status.state)) throw new CpuCleanupError(job.id);
          await this.db.update(controllerHostRuns).set({ cleanupConfirmed: true, updatedAt: new Date() }).where(eq(controllerHostRuns.runId, job.id));
        }
      }
      return result;
    } catch (error) {
      // The original lease remains available for explicit startup cleanup; no replacement run is dispatched.
      throw error;
    }
  }
  async cleanupOrphans(): Promise<void> {
    const pending = await this.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.cleanupConfirmed, false)).limit(101);
    if (pending.length > 100) throw new CpuCleanupError('host-lease-review-limit');
    for (const record of pending) {
      const lease = signedLeaseSchema.parse(record.lease);
      if (record.hostKey !== this.client.hostKey || record.runId !== lease.body.runId || record.owner !== lease.body.owner
        || record.hostKey !== lease.body.hostKey || !verifyHostMessage(this.client.control.publicKey, 'lease', lease)
        || hostMessageHash(lease) !== record.leaseHash) throw new CpuCleanupError(record.runId);
      try {
        const status = await this.client.command(lease, 'stop');
        if (!status.cleanupConfirmed || ['starting', 'running'].includes(status.state)) throw new Error('cleanup not confirmed');
        await this.db.update(controllerHostRuns).set({ cleanupConfirmed: true, updatedAt: new Date() }).where(eq(controllerHostRuns.runId, record.runId));
      } catch { throw new CpuCleanupError(record.runId); }
    }
  }
}
