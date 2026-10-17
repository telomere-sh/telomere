import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { parseLargeCystManifest } from './large-checkpoints.js';
import { CystRegistryUnknownAgentError } from './registry-reader.js';
import { cystRegistryBindingSchema, cystRegistryHashSchema, cystRegistryPinsSchema,
  cystRegistrySnapshotSchema, type CystRegistryBinding, type CystRegistryPins,
  type CystRegistryReader, type CystRegistryState } from './registry-types.js';
import { LargeCystRegistryPlanner, largeCystRegistryDescriptor, largeCystRegistryDescriptorSchema,
  largeCystRegistryMatches, largeCystRegistryPlanSchema,
  type DurableLargeCystStore } from './large-registry.js';
import { largeCystPublicationCatalog as catalog, largeCystPublicationJobs as jobs,
  largeCystPublicationMigrationSQL } from './large-publication-schema.js';
import { largeCystCurrentCheckpointSchema, type LargeCystRegistryPlan } from './large-publication-types.js';
import { cystAddressSchema, cystIdempotencySchema, cystIdSchema } from './types.js';

const jobIdSchema = z.string().uuid();
type Job = typeof jobs.$inferSelect;
const MAX_ACTIVE_JOBS = 8;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const PLAN_LIFETIME_MS = 5 * 60_000;
const CATALOG_ERROR = 'Stored large checkpoint publication descriptor is invalid.';

function bindingIdentity(value: CystRegistryBinding) {
  return { agentId: value.agentId, owner: value.owner.toLowerCase(),
    agentWallet: value.agentWallet.toLowerCase(), vault: value.vault.toLowerCase() };
}

function sameDeployment(left: CystRegistryPins, right: CystRegistryPins): boolean {
  return left.chainId === right.chainId && left.registryAddress === right.registryAddress
    && left.registryCodeHash === right.registryCodeHash
    && left.selectionRegistryAddress === right.selectionRegistryAddress
    && left.selectionRegistryCodeHash === right.selectionRegistryCodeHash;
}

function sameCanonicalState(before: CystRegistryState, after: CystRegistryState): boolean {
  if (BigInt(after.block.number) < BigInt(before.block.number)
    || after.block.number === before.block.number && after.block.hash !== before.block.hash) return false;
  return JSON.stringify({ ...before, block: undefined }) === JSON.stringify({ ...after, block: undefined });
}

/** Durable, single-worker, unsigned publication queue. The controller never signs. */
export class LargeCystPublicationService {
  private readonly planner: LargeCystRegistryPlanner;
  private readonly deadlineMs: number;
  private readonly partReadTimeoutMs: number;
  private readonly now: () => number;
  private initialized = false;
  private closed = false;
  private fatal: unknown;
  private admission: Promise<unknown> = Promise.resolve();
  private pendingAdmissions = 0;
  private activeManifestReads = 0;
  private activePartTransfers = 0;
  private worker: Promise<void> | undefined;
  private wakeRequested = false;
  private active: { id: string; controller: AbortController; reason?: 'cancelled' | 'deadline' | 'closed' } | undefined;

  constructor(private readonly db: Database, private readonly storage: DurableLargeCystStore,
    private readonly reader: CystRegistryReader, options: { deadlineMs?: number; now?: () => number;
      partReadTimeoutMs?: number } = {}) {
    this.planner = new LargeCystRegistryPlanner(storage, reader);
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.partReadTimeoutMs = options.partReadTimeoutMs ?? 20_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1000 || this.deadlineMs > 60 * 60_000) {
      throw new Error('Large Cyst publication deadline must be between one second and one hour');
    }
    if (!Number.isSafeInteger(this.partReadTimeoutMs) || this.partReadTimeoutMs < 1
      || this.partReadTimeoutMs > 60_000) {
      throw new Error('Large Cyst part read timeout must be between one millisecond and one minute');
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.closed) throw new Error('Large Cyst publication service lifecycle changed');
    await this.reader.check();
    for (const statement of largeCystPublicationMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) {
      await this.db.execute(sql.raw(statement));
    }
    // A crashed unsigned plan is safe to recompute. A requested cancellation is not.
    await this.db.update(jobs).set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(jobs.status, 'running'), eq(jobs.cancelRequested, true)));
    await this.db.update(jobs).set({ status: 'queued', updatedAt: new Date() })
      .where(and(eq(jobs.status, 'running'), eq(jobs.cancelRequested, false)));
    this.initialized = true;
    this.wake();
  }

  private ready(): void {
    if (!this.initialized || this.closed || this.fatal) {
      throw new Problem(503, 'cyst_publication_unavailable', 'Large checkpoint publication is unavailable.');
    }
  }

  /** Surface a stopped audit queue through the controller's readiness probe. */
  check(): void { this.ready(); }

  private async authenticatedAgent(principalValue: string, agentIdValue: string) {
    const principal = cystAddressSchema.parse(principalValue);
    const agentId = cystRegistryHashSchema.parse(agentIdValue);
    await this.reader.check();
    let snapshot;
    try { snapshot = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(agentId)); }
    catch (error) {
      if (error instanceof CystRegistryUnknownAgentError) {
        throw new Problem(404, 'cyst_agent_not_found', 'The agent is not registered.');
      }
      throw error;
    }
    if (snapshot.binding.agentId !== agentId || snapshot.current.agentId !== agentId) {
      throw new Error('Cyst registry reader changed the requested identity');
    }
    if (principal !== snapshot.binding.agentWallet.toLowerCase()) {
      throw new Problem(403, 'cyst_agent_forbidden', 'The registered agent wallet is required.');
    }
    if (snapshot.binding.status === 3) {
      throw new Problem(409, 'cyst_agent_dead', 'A dead Selection agent cannot publish a checkpoint.');
    }
    return { principal, agentId, snapshot };
  }

  private async row(principal: string, id: string): Promise<Job> {
    const result = (await this.db.select().from(jobs).where(and(eq(jobs.id, jobIdSchema.parse(id)),
      eq(jobs.principal, cystAddressSchema.parse(principal)))).limit(1))[0];
    if (!result) throw new Problem(404, 'cyst_publication_not_found', 'Publication job not found.');
    return result;
  }

  private publicJob(row: Job, plan?: Job['plan']) {
    return { id: row.id, status: row.status, agentId: row.agentId, checkpointId: row.checkpointId,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(plan ? { plan: largeCystRegistryPlanSchema.parse(plan) } : {}) };
  }

  /** Resolve only descriptors recorded by a completed audit, then independently
   * rebind the catalog candidate to current canonical state and stored bytes.
   */
  async current(principalValue: string, agentIdValue: string) {
    this.ready();
    if (this.activeManifestReads >= MAX_ACTIVE_JOBS) {
      throw new Problem(429, 'cyst_manifest_busy', 'Agent manifest reads are at capacity.');
    }
    this.activeManifestReads++;
    try {
      const { agentId, snapshot } = await this.authenticatedAgent(principalValue, agentIdValue);
      if (BigInt(snapshot.current.revision) === 0n || snapshot.current.retired) {
        throw new Problem(404, 'cyst_current_missing', 'The agent has no live registry checkpoint.');
      }
      const [candidate] = await this.db.select().from(catalog)
        .where(and(eq(catalog.agentId, agentId), eq(catalog.storageRef, snapshot.current.storageRef))).limit(1);
      if (!candidate) throw new Problem(404, 'cyst_current_unresolved',
        'The current registry checkpoint has no audited local locator.');
      let checkpoint;
      try {
        checkpoint = largeCystRegistryDescriptorSchema.parse(candidate.descriptor);
        const original = cystRegistryBindingSchema.parse(candidate.binding);
        const storedPins = cystRegistryPinsSchema.parse(candidate.pins);
        z.string().uuid().parse(candidate.auditedJobId);
        if (cystRegistryHashSchema.parse(candidate.storageRef) !== checkpoint.storageRef
          || cystRegistryHashSchema.parse(candidate.agentId) !== agentId
          || cystIdSchema.parse(candidate.checkpointId) !== checkpoint.id
          || original.agentId !== agentId || checkpoint.owner !== original.owner.toLowerCase()
          || checkpoint.agent !== original.agentWallet.toLowerCase()
          || JSON.stringify(bindingIdentity(original)) !== JSON.stringify(bindingIdentity(snapshot.binding))
          || !sameDeployment(storedPins, cystRegistryPinsSchema.parse(this.reader.pins))) {
          throw new Error(CATALOG_ERROR);
        }
      } catch { throw new Problem(503, 'cyst_catalog_corrupt', CATALOG_ERROR); }
      if (!largeCystRegistryMatches(snapshot.current, checkpoint)) {
        throw new Problem(409, 'cyst_current_changed', 'The current registry checkpoint differs from the audited locator.');
      }
      const raw = await this.storage.manifest(checkpoint.id);
      if (!raw) throw new Problem(503, 'cyst_current_unavailable', 'The current checkpoint manifest is unavailable.');
      let manifest;
      try {
        manifest = parseLargeCystManifest(raw);
        if (JSON.stringify(largeCystRegistryDescriptor(manifest)) !== JSON.stringify(checkpoint)) {
          throw new Error(CATALOG_ERROR);
        }
      } catch { throw new Problem(503, 'cyst_catalog_corrupt', CATALOG_ERROR); }
      const after = await this.authenticatedAgent(principalValue, agentId);
      if (JSON.stringify(after.snapshot.binding) !== JSON.stringify(snapshot.binding)
        || !sameCanonicalState(snapshot.current, after.snapshot.current)
        || !largeCystRegistryMatches(after.snapshot.current, checkpoint)) {
        throw new Problem(409, 'cyst_current_changed', 'The canonical registry checkpoint changed during resolution.');
      }
      return largeCystCurrentCheckpointSchema.parse({ checkpointId: checkpoint.id, checkpoint,
        binding: after.snapshot.binding, current: after.snapshot.current,
        pins: cystRegistryPinsSchema.parse(this.reader.pins), manifest });
    } finally { this.activeManifestReads--; }
  }

  /** Read-only agent access to the original committed manifest. The owner-side
   * upload route stays owner-only; this path never exposes ciphertext parts or keys.
   */
  async manifest(principalValue: string, agentIdValue: string, checkpointIdValue: string) {
    this.ready();
    // Reserve before the first RPC await so a burst of GETs cannot bypass the
    // bounded publication queue and exhaust the registry reader or S3 store.
    if (this.activeManifestReads >= MAX_ACTIVE_JOBS) {
      throw new Problem(429, 'cyst_manifest_busy', 'Agent manifest reads are at capacity.');
    }
    this.activeManifestReads++;
    try {
      const { agentId, snapshot } = await this.authenticatedAgent(principalValue, agentIdValue);
      const checkpointId = cystIdSchema.parse(checkpointIdValue);
      const raw = await this.storage.manifest(checkpointId);
      if (!raw) throw new Problem(404, 'cyst_not_found', 'Checkpoint is unavailable for this registered agent.');
      const manifest = parseLargeCystManifest(raw);
      if (manifest.header.id !== checkpointId || manifest.header.owner !== snapshot.binding.owner.toLowerCase()
        || manifest.header.agent !== snapshot.binding.agentWallet.toLowerCase()) {
        throw new Problem(404, 'cyst_not_found', 'Checkpoint is unavailable for this registered agent.');
      }
      // A canonical state transition while the manifest was read must not leave
      // a newly dead agent able to retrieve the manifest through an old session.
      const after = await this.authenticatedAgent(principalValue, agentId);
      if (JSON.stringify(after.snapshot.binding) !== JSON.stringify(snapshot.binding)) {
        throw new Problem(409, 'cyst_revision_changed', 'The canonical Selection binding changed during the manifest read.');
      }
      return manifest;
    } finally { this.activeManifestReads--; }
  }

  /** Give only the original live agent wallet a digest-checked ciphertext part.
   * Keep the transfer slot until the HTTP body completes or is cancelled.
   */
  async part(principalValue: string, agentIdValue: string, checkpointIdValue: string, indexValue: number):
    Promise<{ bytes: Buffer; release: () => void }> {
    this.ready();
    if (this.activePartTransfers >= 4) {
      throw new Problem(429, 'cyst_part_busy', 'Agent checkpoint transfers are at capacity.');
    }
    this.activePartTransfers++;
    let released = false;
    const release = () => { if (!released) { released = true; this.activePartTransfers--; } };
    try {
      const { agentId, snapshot } = await this.authenticatedAgent(principalValue, agentIdValue);
      const checkpointId = cystIdSchema.parse(checkpointIdValue);
      const index = z.number().int().min(0).max(511).parse(indexValue);
      const raw = await this.storage.manifest(checkpointId);
      if (!raw) throw new Problem(404, 'cyst_not_found', 'Checkpoint is unavailable for this registered agent.');
      const manifest = parseLargeCystManifest(raw);
      if (manifest.header.id !== checkpointId || manifest.header.owner !== snapshot.binding.owner.toLowerCase()
        || manifest.header.agent !== snapshot.binding.agentWallet.toLowerCase()) {
        throw new Problem(404, 'cyst_not_found', 'Checkpoint is unavailable for this registered agent.');
      }
      const expected = manifest.parts[index];
      if (!expected || expected.index !== index) throw new Problem(404, 'cyst_part_not_found', 'Checkpoint part not found.');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const failure = new Problem(503, 'cyst_part_unavailable', 'Verified checkpoint part is unavailable.');
          reject(failure);
          controller.abort(failure);
        }, this.partReadTimeoutMs);
      });
      let bytes: Buffer | undefined;
      try {
        // Reclaim the admission slot even if an injected store ignores abort.
        bytes = await Promise.race([this.storage.part(checkpointId, index, controller.signal), deadline]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally { if (timer) clearTimeout(timer); }
      if (!bytes || bytes.length !== expected.bytes
        || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
        throw new Problem(503, 'cyst_part_unavailable', 'Verified checkpoint part is unavailable.');
      }
      const after = await this.authenticatedAgent(principalValue, agentId);
      if (JSON.stringify(after.snapshot.binding) !== JSON.stringify(snapshot.binding)) {
        throw new Problem(409, 'cyst_revision_changed', 'The canonical Selection binding changed during the part read.');
      }
      return { bytes, release };
    } catch (error) { release(); throw error; }
  }

  async submit(principalValue: string, agentIdValue: string, checkpointIdValue: string, idempotencyValue: string) {
    this.ready();
    // Bound requests waiting on chain authentication or a remote manifest read as well as stored jobs.
    if (this.pendingAdmissions >= MAX_ACTIVE_JOBS) {
      throw new Problem(429, 'cyst_publication_busy', 'Large checkpoint publication queue is full.');
    }
    this.pendingAdmissions++;
    try {
      const { principal, agentId, snapshot } = await this.authenticatedAgent(principalValue, agentIdValue);
      const checkpointId = cystIdSchema.parse(checkpointIdValue), idempotencyKey = cystIdempotencySchema.parse(idempotencyValue);
      const task = this.admission.then(async () => {
        this.ready();
        const existing = (await this.db.select().from(jobs).where(and(eq(jobs.principal, principal),
          eq(jobs.idempotencyKey, idempotencyKey))).limit(1))[0];
        if (existing) {
          if (existing.agentId !== agentId || existing.checkpointId !== checkpointId) {
            throw new Problem(409, 'cyst_publication_idempotency', 'Idempotency key belongs to a different publication.');
          }
          return this.get(principal, existing.id, agentId);
        }
        const [sameAgent] = await this.db.select({ id: jobs.id }).from(jobs)
          .where(and(eq(jobs.agentId, agentId), inArray(jobs.status, ['queued', 'running']))).limit(1);
        if (sameAgent) throw new Problem(429, 'cyst_publication_agent_busy', 'This agent already has an active publication audit.');
        // Cheap admission check. The worker still performs the full two-copy scan and repeats every chain check.
        const manifest = await this.storage.manifest(checkpointId);
        if (!manifest || manifest.header.owner !== snapshot.binding.owner.toLowerCase()
          || manifest.header.agent !== snapshot.binding.agentWallet.toLowerCase()) {
          throw new Problem(404, 'cyst_not_found', 'Checkpoint is unavailable for this registered agent.');
        }
        const [{ count } = { count: MAX_ACTIVE_JOBS }] = await this.db.select({ count: sql<number>`count(*)::int` }).from(jobs)
          .where(inArray(jobs.status, ['queued', 'running']));
        if (count >= MAX_ACTIVE_JOBS) throw new Problem(429, 'cyst_publication_busy', 'Large checkpoint publication queue is full.');
        const now = new Date(this.now());
        const [created] = await this.db.insert(jobs).values({ id: randomUUID(), principal, agentId,
          checkpointId, idempotencyKey, status: 'queued', deadlineAt: new Date(now.getTime() + this.deadlineMs),
          createdAt: now, updatedAt: now }).returning();
        if (!created) throw new Error('Publication job insert failed');
        this.wake();
        return this.publicJob(created);
      });
      this.admission = task.catch(() => undefined);
      return await task;
    } finally { this.pendingAdmissions--; }
  }

  async get(principal: string, id: string, expectedAgentId?: string) {
    this.ready();
    const current = await this.row(principal, id);
    if (expectedAgentId !== undefined && current.agentId !== cystRegistryHashSchema.parse(expectedAgentId)) {
      throw new Problem(404, 'cyst_publication_not_found', 'Publication job not found.');
    }
    if (current.status !== 'succeeded' || !current.plan) return this.publicJob(current);
    const plan = largeCystRegistryPlanSchema.parse(current.plan);
    const pins = cystRegistryPinsSchema.parse(this.reader.pins);
    const fresh = this.now() - current.updatedAt.getTime() <= PLAN_LIFETIME_MS;
    let unchanged = false;
    if (fresh && plan.transaction.chainId === pins.chainId && plan.transaction.to === pins.registryAddress
      && plan.binding.agentId === current.agentId && plan.checkpoint.id === current.checkpointId) {
      await this.reader.check();
      const snapshot = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(current.agentId));
      const substantive = { ...snapshot.current, block: undefined };
      const prepared = { ...plan.current, block: undefined };
      unchanged = snapshot.binding.status !== 3
        && JSON.stringify(snapshot.binding) === JSON.stringify(plan.binding)
        && JSON.stringify(substantive) === JSON.stringify(prepared);
    }
    if (!fresh || !unchanged) {
      await this.db.update(jobs).set({ status: 'stale', plan: null, errorCode: 'cyst_revision_changed', updatedAt: new Date() })
        .where(and(eq(jobs.id, current.id), eq(jobs.status, 'succeeded')));
      return this.publicJob({ ...current, status: 'stale', plan: null, errorCode: 'cyst_revision_changed' });
    }
    return this.publicJob(current, plan);
  }

  async cancel(principal: string, id: string, expectedAgentId?: string) {
    this.ready();
    const row = await this.row(principal, id);
    if (expectedAgentId !== undefined && row.agentId !== cystRegistryHashSchema.parse(expectedAgentId)) {
      throw new Problem(404, 'cyst_publication_not_found', 'Publication job not found.');
    }
    if (row.status === 'queued' || row.status === 'running') {
      // One CAS closes the race between a queued read and the worker's queued→running claim.
      const [requested] = await this.db.update(jobs).set({
        status: sql`case when ${jobs.status} = 'queued' then 'cancelled' else ${jobs.status} end`,
        cancelRequested: true, updatedAt: new Date(),
      }).where(and(eq(jobs.id, row.id), inArray(jobs.status, ['queued', 'running']))).returning();
      if (requested?.status === 'running' && this.active?.id === row.id) {
        this.active.reason = 'cancelled';
        this.active.controller.abort(new Error('Large checkpoint publication cancelled'));
      }
    }
    return this.get(principal, id, expectedAgentId);
  }

  private wake(): void {
    if (!this.initialized || this.closed || this.fatal) return;
    if (this.worker) { this.wakeRequested = true; return; }
    const task = this.drain();
    this.worker = task;
    void task.catch(error => { this.fatal = error; }).finally(() => {
      if (this.worker === task) this.worker = undefined;
      if (this.wakeRequested) { this.wakeRequested = false; this.wake(); }
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const next = (await this.db.select().from(jobs).where(eq(jobs.status, 'queued'))
        .orderBy(asc(jobs.createdAt)).limit(1))[0];
      if (!next) return;
      const [claimed] = await this.db.update(jobs).set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued'), eq(jobs.cancelRequested, false))).returning();
      if (!claimed) continue;
      if (this.closed) return; // Recovery requeues the claimed unsigned job after shutdown.
      await this.run(claimed);
    }
  }

  /** The catalog must never remember a plan whose audited job failed its
   * final cancellation/deadline CAS. A repeated immutable locator is allowed
   * only when it names the same descriptor, identity and deployment.
   */
  private async completeWithCatalog(row: Job, plan: LargeCystRegistryPlan) {
    const pins = cystRegistryPinsSchema.parse(this.reader.pins);
    return this.db.transaction(async tx => {
      const [saved] = await tx.update(jobs).set({ status: 'succeeded', plan, errorCode: null,
        updatedAt: new Date() }).where(and(eq(jobs.id, row.id), eq(jobs.status, 'running'),
        eq(jobs.cancelRequested, false), sql`${jobs.deadlineAt} > clock_timestamp()`)).returning();
      if (!saved) return undefined;
      const [inserted] = await tx.insert(catalog).values({ storageRef: plan.checkpoint.storageRef,
        agentId: row.agentId, checkpointId: row.checkpointId, descriptor: plan.checkpoint,
        binding: plan.binding, pins, auditedJobId: row.id }).onConflictDoNothing().returning();
      if (!inserted) {
        const [existing] = await tx.select().from(catalog)
          .where(and(eq(catalog.agentId, row.agentId), eq(catalog.storageRef, plan.checkpoint.storageRef))).limit(1);
        let compatible = false;
        try {
          const descriptor = largeCystRegistryDescriptorSchema.parse(existing?.descriptor);
          const binding = cystRegistryBindingSchema.parse(existing?.binding);
          const priorPins = cystRegistryPinsSchema.parse(existing?.pins);
          z.string().uuid().parse(existing?.auditedJobId);
          compatible = existing?.agentId === row.agentId && existing.checkpointId === row.checkpointId
            && JSON.stringify(descriptor) === JSON.stringify(plan.checkpoint)
            && JSON.stringify(bindingIdentity(binding)) === JSON.stringify(bindingIdentity(plan.binding))
            && sameDeployment(priorPins, pins);
        } catch { /* A malformed existing row is a conflict, never a replacement. */ }
        if (!compatible) throw new Problem(503, 'cyst_catalog_corrupt', CATALOG_ERROR);
      }
      return saved;
    });
  }

  private async run(row: Job): Promise<void> {
    const controller = new AbortController();
    const active: NonNullable<typeof this.active> = { id: row.id, controller };
    this.active = active;
    const left = Math.max(0, row.deadlineAt.getTime() - this.now());
    const expire = () => {
      active.reason = 'deadline';
      controller.abort(new Error('Large checkpoint publication deadline exceeded'));
    };
    const timer = left === 0 ? undefined : setTimeout(expire, left);
    if (left === 0) expire();
    try {
      if (this.closed) {
        active.reason = 'closed';
        controller.abort(new Error('Large checkpoint publication worker stopping'));
      }
      // A cancellation can be committed after the claim but before this active controller is installed.
      const [starting] = await this.db.select({ status: jobs.status, cancelRequested: jobs.cancelRequested }).from(jobs)
        .where(eq(jobs.id, row.id)).limit(1);
      if (!starting || starting.status !== 'running' || starting.cancelRequested) {
        active.reason = 'cancelled';
        controller.abort(new Error('Large checkpoint publication cancelled before audit'));
      }
      if (this.closed) {
        active.reason = 'closed';
        controller.abort(new Error('Large checkpoint publication worker stopping'));
      }
      controller.signal.throwIfAborted();
      const plan = await this.planner.commitPlan(row.principal, row.agentId, row.checkpointId, controller.signal);
      controller.signal.throwIfAborted();
      if (this.now() >= row.deadlineAt.getTime()) { expire(); controller.signal.throwIfAborted(); }
      if (this.closed) return;
      const saved = await this.completeWithCatalog(row, plan);
      if (!saved) {
        // Classify the latest cancellation flag in the same DB statement; do not overwrite a racing cancel.
        await this.db.update(jobs).set({
          status: sql`case when ${jobs.cancelRequested} then 'cancelled' else 'failed' end`,
          plan: null,
          errorCode: sql`case when ${jobs.cancelRequested} then null else 'cyst_publication_deadline' end`,
          updatedAt: new Date(),
        }).where(and(eq(jobs.id, row.id), eq(jobs.status, 'running'),
          sql`(${jobs.cancelRequested} = true or ${jobs.deadlineAt} <= clock_timestamp())`));
      }
    } catch (error) {
      if (this.closed) return; // Startup recovery requeues this unsigned job.
      const errorCode = active.reason === 'deadline' || this.now() >= row.deadlineAt.getTime()
        ? 'cyst_publication_deadline' : error instanceof Problem ? error.code : 'cyst_publication_failed';
      await this.db.update(jobs).set({ status: sql`case when ${jobs.cancelRequested} then 'cancelled' else 'failed' end`, plan: null,
        errorCode: sql`case when ${jobs.cancelRequested} then null else ${errorCode} end`,
        updatedAt: new Date() }).where(and(eq(jobs.id, row.id), eq(jobs.status, 'running')));
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.active = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active) {
      this.active.reason = 'closed';
      this.active.controller.abort(new Error('Large checkpoint publication worker stopping'));
    }
    await this.worker;
  }
}
