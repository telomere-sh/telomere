import { performance } from 'node:perf_hooks';
import { eq, inArray, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Problem, hashJson } from '../common.js';
import { hostBinding, hostClaims, hostCommands, hostPaidPreemptions, hostPaidSessions,
  hostRuns, hostSessions, type HostJournal, type HostRun } from './journal.js';
import { HOST_TICK_MS, capacityChallengeSchema, hostControlSchema, hostMessageHash, hostTickSchema, signedLeaseSchema, verifyHostMessage,
  type SignedHostControl } from './protocol.js';
import type { HostCell, HostCellRuntime, InitHeartbeat } from './runtime.js';
import { billableHostInterval } from './meter.js';
import { HostCellCleanupError } from './docker-runtime.js';
import { admissionHash, type HostAdmissionCoordinator } from './admission.js';
import { createPaidHostSessionRoutes, type PaidHostSessionAgent } from './sessions/paid-agent.js';
import { createPaidPreemptionRoutes, type PaidHostPreemptionService } from './sessions/paid-preemption.js';
import { hostV2AdmissionEnvelopeSchema, hostV2AdmissionReceiptSchema,
  type ArchiveHostV2AdmissionAuthority, type SignedHostV2AdmissionReceipt } from './v2-admission.js';

type ActiveRun = { runId: string; startedAt: number; budgetMs: number; expiresAt: number;
  claimToken?: string;
  dispatchInvoked?: boolean;
  cell?: HostCell; startFlight?: Promise<HostCell>; cleanupFlight?: Promise<void>;
  stopping?: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'fault';
  result?: { output: string; exitCode: number }; heartbeat?: InitHeartbeat & { receivedAt: number };
  ticker?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout> };
const CPU_SLOT = 'cpu1';
const v2BindingError = () => new Error('Host v2 admission requires its exclusive CPU binding and no shared session history');
const plainBindingError = () => new Error('Plain Host Kit cannot use a permanently bound CPU journal from another mode or scope');
const journalOwners = new WeakMap<HostJournal, HostKitAgent>();
const journalOwnerError = () => new Problem(503, 'host_unavailable', 'Another Host Kit agent owns this journal lifecycle.');

export class HostKitAgent {
  private queue: Promise<unknown> = Promise.resolve();
  private initializeFlight: Promise<{ orphanedCells: string[]; faultedRuns: string[] }> | undefined;
  private closeFlight: Promise<void> | undefined;
  private active: ActiveRun | undefined;
  private ready = false;
  private cleanupFailed = false;
  constructor(readonly journal: HostJournal, readonly runtime: HostCellRuntime, readonly controlKey: string,
    private readonly images: ReadonlySet<string>, private readonly clock: () => number = Date.now,
    private readonly admission?: HostAdmissionCoordinator,
    private readonly v2Admission?: ArchiveHostV2AdmissionAuthority) {
    if (admission && (admission.journal !== journal || admission.runtime !== runtime || admission.scope.controlKey !== controlKey)) throw new Error('Shared host scope mismatch');
    if (admission && v2Admission) throw new Error('Opt-in Host v2 admission cannot share the v1 claim coordinator');
  }
  v2AdmissionEnabled(): boolean { return this.v2Admission !== undefined; }
  private releaseJournalOwner(): void {
    if (journalOwners.get(this.journal) === this) journalOwners.delete(this.journal);
  }
  private assertJournalOwner(): void {
    if (journalOwners.get(this.journal) !== this || this.closeFlight || !this.ready) throw journalOwnerError();
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private backgroundStop(state: 'timed_out' | 'fault', runId: string): void {
    void this.stopActive(state, runId).catch(() => { this.cleanupFailed = true; });
  }
  private plainBinding() {
    const scope = { version: 1, kind: 'host-v1-plain-cpu',
      hostKey: this.journal.identity.publicKey, controlKey: this.controlKey,
      isolation: this.runtime.isolation };
    return { scope, scopeHash: admissionHash(scope) };
  }
  private matchesPlainBinding(rows: (typeof hostBinding.$inferSelect)[]): boolean {
    const { scopeHash } = this.plainBinding();
    return rows.length === 1 && rows[0]!.slot === CPU_SLOT
      && rows[0]!.scopeHash === scopeHash && admissionHash(rows[0]!.scope) === scopeHash;
  }
  private async assertPlainBinding(): Promise<void> {
    const rows = await this.journal.db.select().from(hostBinding).limit(2);
    if (!this.matchesPlainBinding(rows)) throw plainBindingError();
  }
  private async establishPlainBinding(): Promise<void> {
    const { scope, scopeHash } = this.plainBinding();
    await this.journal.db.transaction(async tx => {
      const [rows, claims, sessions, paidSessions, preemptions, runs] = await Promise.all([
        tx.select().from(hostBinding).limit(2),
        tx.select({ slot: hostClaims.slot }).from(hostClaims).limit(1),
        tx.select({ id: hostSessions.sessionId }).from(hostSessions).limit(1),
        tx.select({ id: hostPaidSessions.sessionId }).from(hostPaidSessions).limit(1),
        tx.select({ id: hostPaidPreemptions.sessionId }).from(hostPaidPreemptions).limit(1),
        tx.select().from(hostRuns).limit(4097),
      ]);
      if (claims.length || sessions.length || paidSessions.length || preemptions.length) {
        throw plainBindingError();
      }
      if (rows.length && !this.matchesPlainBinding(rows)) throw plainBindingError();
      if (runs.length > 4096) throw new Error('Host history requires operator archival');
      for (const run of runs) {
        const signed = signedLeaseSchema.safeParse(run.lease);
        if (!signed.success || run.v2Admission !== null
          || signed.data.body.hostKey !== this.journal.identity.publicKey
          || signed.data.body.runId !== run.runId || signed.data.body.owner !== run.owner
          || hostMessageHash(signed.data) !== run.leaseHash
          || !verifyHostMessage(this.controlKey, 'lease', signed.data)) {
          throw new Error('Plain Host Kit original run journal cannot be verified');
        }
      }
      if (!rows.length) {
        // Legacy plain runs may be adopted, but a binding-free shared, paid or v2 journal cannot.
        await tx.insert(hostBinding).values({ slot: CPU_SLOT, scopeHash, scope }).onConflictDoNothing();
      }
    });
    await this.assertPlainBinding();
  }
  private v2Binding() {
    if (!this.v2Admission) throw v2BindingError();
    const scope = { version: 2, kind: 'host-v2-exclusive-cpu',
      hostKey: this.journal.identity.publicKey, controlKey: this.controlKey,
      isolation: this.runtime.isolation, pins: this.v2Admission.pins };
    return { scope, scopeHash: admissionHash(scope) };
  }
  private matchesV2Binding(rows: (typeof hostBinding.$inferSelect)[]): boolean {
    const { scopeHash } = this.v2Binding();
    return rows.length === 1 && rows[0]!.slot === CPU_SLOT
      && rows[0]!.scopeHash === scopeHash && admissionHash(rows[0]!.scope) === scopeHash;
  }
  private async assertV2Binding(): Promise<void> {
    const rows = await Promise.all([
      this.journal.db.select().from(hostBinding).limit(2),
      this.journal.db.select({ slot: hostClaims.slot }).from(hostClaims).limit(1),
      this.journal.db.select({ id: hostSessions.sessionId }).from(hostSessions).limit(1),
      this.journal.db.select({ id: hostPaidSessions.sessionId }).from(hostPaidSessions).limit(1),
      this.journal.db.select({ id: hostPaidPreemptions.sessionId }).from(hostPaidPreemptions).limit(1),
    ]);
    if (!this.matchesV2Binding(rows[0]) || rows.slice(1).some(found => found.length)) throw v2BindingError();
  }
  private async establishV2Binding(): Promise<void> {
    if (!this.v2Admission) return;
    const { scope, scopeHash } = this.v2Binding();
    await this.journal.db.transaction(async tx => {
      const rows = await Promise.all([
        tx.select().from(hostBinding).limit(2),
        tx.select({ slot: hostClaims.slot }).from(hostClaims).limit(1),
        tx.select({ id: hostSessions.sessionId }).from(hostSessions).limit(1),
        tx.select({ id: hostPaidSessions.sessionId }).from(hostPaidSessions).limit(1),
        tx.select({ id: hostPaidPreemptions.sessionId }).from(hostPaidPreemptions).limit(1),
      ]);
      if (rows.slice(1).some(found => found.length)) throw v2BindingError();
      if (!rows[0].length) {
        // An existing run without a CPU binding cannot be retroactively attributed to this mode.
        if ((await tx.select({ id: hostRuns.runId }).from(hostRuns).limit(1)).length) throw v2BindingError();
        await tx.insert(hostBinding).values({ slot: CPU_SLOT, scopeHash, scope });
      } else if (!this.matchesV2Binding(rows[0])) throw v2BindingError();
    });
    await this.assertV2Binding();
  }
  initialize(): Promise<{ orphanedCells: string[]; faultedRuns: string[] }> {
    if (this.ready || this.initializeFlight || this.closeFlight) {
      return Promise.reject(new Error('Host Kit is already initialized'));
    }
    if (journalOwners.has(this.journal)) return Promise.reject(journalOwnerError());
    journalOwners.set(this.journal, this);
    const flight = Promise.resolve().then(() => this.initializeOwned());
    this.initializeFlight = flight;
    return flight.then(recovery => {
      this.initializeFlight = undefined;
      return recovery;
    }, error => {
      this.initializeFlight = undefined;
      this.releaseJournalOwner();
      throw error;
    });
  }
  private async initializeOwned(): Promise<{ orphanedCells: string[]; faultedRuns: string[] }> {
    if (this.admission) { const recovery = await this.admission.initialize(); this.ready = true; this.admission.activate(); return recovery; }
    if (this.v2Admission) await this.establishV2Binding();
    else await this.establishPlainBinding();
    await this.runtime.initialize(this.journal.identity.publicKey);
    const orphanedCells = await this.runtime.cleanupOrphans(this.journal.identity.publicKey);
    const prior = await this.journal.db.select().from(hostRuns).where(inArray(hostRuns.state, ['starting', 'running']));
    for (const run of prior) await this.journal.db.update(hostRuns).set({ state: 'fault', cleanupConfirmed: true, updatedAt: new Date(this.clock()) }).where(eq(hostRuns.runId, run.runId));
    // Exclusive startup inventory/removal established that this host has no owned cells left.
    await this.journal.db.update(hostRuns).set({ cleanupConfirmed: true }).where(eq(hostRuns.cleanupConfirmed, false));
    const historical = await this.journal.db.select().from(hostRuns).limit(4097);
    if (historical.length > 4096) throw new Error('Host history requires operator archival');
    for (const run of historical) {
      if (this.v2Admission && !run.v2Admission) {
        throw new Error('Host v2 exclusive journal contains a v1 admission');
      }
      if (!run.v2Admission) continue;
      const receipt = hostV2AdmissionReceiptSchema.parse(run.v2Admission), body = receipt.body;
      if (!verifyHostMessage(this.journal.identity.publicKey, 'v2-admission', receipt)
        || body.runId !== run.runId || body.owner !== run.owner
        || body.hostKey !== this.journal.identity.publicKey || body.controllerKey !== this.controlKey
        || body.signedLeaseHash !== run.leaseHash || hostMessageHash(run.lease) !== run.leaseHash
        || !verifyHostMessage(this.controlKey, 'lease', run.lease)) {
        throw new Error('Original Host v2 admission journal cannot be verified');
      }
    }
    this.ready = true; return { orphanedCells, faultedRuns: prior.map(run => run.runId) };
  }
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    // A refused replacement must not close the live owner's shared coordinator.
    if (journalOwners.get(this.journal) !== this) return Promise.resolve();
    this.ready = false;
    this.admission?.closeAdmission();
    const flight = Promise.resolve().then(async () => {
      try {
        await this.initializeFlight?.catch(() => undefined);
        this.ready = false;
        this.admission?.closeAdmission();
        await this.stopActive('cancelled');
        await this.queue;
      } finally { this.releaseJournalOwner(); }
    });
    this.closeFlight = flight;
    return flight.finally(() => { if (this.closeFlight === flight) this.closeFlight = undefined; });
  }
  /** Signed, short-lived placement hint. A later lease must still acquire the durable CPU slot. */
  async capacity(value: unknown, paidSessionReady = false) {
    const challenge = capacityChallengeSchema.parse(value);
    if (!verifyHostMessage(this.controlKey, 'capacity-challenge', challenge)
      || challenge.body.hostKey !== this.journal.identity.publicKey) {
      throw new Problem(403, 'capacity_rejected', 'Capacity challenge signature or host scope was rejected.');
    }
    return this.exclusive(async () => {
      const now = this.clock(), request = challenge.body;
      if (Math.abs(request.issuedAt - now) > 5000 || request.expiresAt <= now
        || request.expiresAt > request.issuedAt + 5000) {
        throw new Problem(403, 'capacity_rejected', 'Capacity challenge expired.');
      }
      if (!this.admission && !this.v2Admission && this.ready) await this.assertPlainBinding();
      if (this.v2Admission && this.ready) await this.assertV2Binding();
      const eligible = this.ready && !this.closeFlight && !this.cleanupFailed && !this.active && this.images.has(request.image)
        && (request.kind !== 'session' || !this.v2Admission && paidSessionReady);
      const free = eligible && (this.admission ? await this.admission.capacityAvailable()
        : (await this.journal.db.select({ runId: hostRuns.runId }).from(hostRuns)
          .where(inArray(hostRuns.state, ['starting', 'running'])).limit(1)).length === 0);
      if (request.cystInputBytes !== undefined && request.kind !== 'session') throw new Problem(422,
        'capacity_rejected', 'Declared file input requires a paid CPU session.');
      const spool = this.admission?.backend?.cystInputs;
      const cystAvailable = request.cystInputBytes === undefined ? true
        : !!spool && paidSessionReady && await spool.canReserve(request.cystInputBytes);
      const signedAt = this.clock(), expiresAt = Math.min(request.expiresAt, signedAt + 2000);
      if (expiresAt <= signedAt) throw new Problem(403, 'capacity_rejected', 'Capacity challenge expired.');
      return this.journal.identity.sign('capacity', { version: 1 as const,
        hostKey: this.journal.identity.publicKey, image: request.image, kind: request.kind,
        nonce: request.nonce, challengeHash: hostMessageHash(challenge), isolation: this.runtime.isolation,
        available: free && cystAvailable, issuedAt: signedAt, expiresAt,
        ...(request.cystInputBytes !== undefined && spool ? { cystInput: { requestedBytes: request.cystInputBytes,
          maxBytes: spool.maxInputBytes, available: cystAvailable, spoolIdentity: spool.identity } } : {}) });
    });
  }
  private fresh(lease: ReturnType<typeof signedLeaseSchema.parse>['body']): void {
    const now = this.clock();
    if (Math.abs(lease.issuedAt - now) > 5000 || lease.expiresAt <= now
      || lease.expiresAt > lease.issuedAt + lease.maxSeconds * 1000 + 5000 || !this.images.has(lease.image)) {
      throw new Problem(403, 'lease_rejected', 'Lease deadline, timestamp, or image was rejected.');
    }
  }
  private expired(context: ActiveRun): boolean {
    return this.clock() >= context.expiresAt || performance.now() - context.startedAt >= context.budgetMs;
  }
  async admit(value: unknown): Promise<ReturnType<HostKitAgent['statusBody']>> {
    const signed = signedLeaseSchema.parse(value), lease = signed.body;
    if (!verifyHostMessage(this.controlKey, 'lease', signed) || lease.hostKey !== this.journal.identity.publicKey) {
      throw new Problem(403, 'lease_rejected', 'Lease signature, scope, deadline, or image was rejected.');
    }
    return this.exclusive(async () => {
      this.assertJournalOwner();
      const [existing] = await this.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, lease.runId)).limit(1);
      if (existing) {
        if (existing.leaseHash !== hostMessageHash(signed)) throw new Problem(409, 'lease_conflict', 'Run identifier is already reserved.');
        if (existing.v2Admission) throw new Problem(409, 'lease_conflict', 'Host v2 run requires its original v2 admission.');
        return this.statusBody(existing);
      }
      if (this.v2Admission) throw new Problem(409, 'v1_admission_disabled', 'This host requires a v2 admission envelope.');
      if (!this.ready || this.cleanupFailed || this.admission && !this.admission.available()) throw new Problem(503, 'host_unavailable', 'Host cleanup or initialization is incomplete.');
      if (!this.admission) await this.assertPlainBinding();
      this.fresh(lease);
      const rows = await this.journal.db.select({ runId: hostRuns.runId }).from(hostRuns).limit(4097);
      if (rows.length >= 4096) throw new Problem(503, 'host_journal_full', 'Host history requires operator archival.');
      const active = await this.journal.db.select({ runId: hostRuns.runId }).from(hostRuns).where(inArray(hostRuns.state, ['starting', 'running'])).limit(1);
      if (active.length || this.active) throw new Problem(409, 'host_busy', 'The host already has an active tenant.');
      this.fresh(lease);
      this.assertJournalOwner();
      const context: ActiveRun = { runId: lease.runId, startedAt: performance.now(), expiresAt: lease.expiresAt,
        budgetMs: Math.min(lease.maxSeconds * 1000, lease.expiresAt - this.clock()) };
      let record: HostRun | undefined;
      try {
        if (this.admission) { const reserved = await this.admission.reserveRun(signed); record = reserved.record; context.claimToken = reserved.token; }
        else [record] = await this.journal.db.insert(hostRuns).values({ runId: lease.runId, owner: lease.owner,
          leaseHash: hostMessageHash(signed), lease: signed, state: 'starting' }).returning();
      } catch (error) { if (!(error instanceof Problem)) { this.cleanupFailed = true; this.admission?.fail(); } throw error; }
      if (!record) { this.cleanupFailed = true; throw new Error('Host lease was not persisted'); }
      this.active = context;
      try {
        // Reservation and startup consume the original budget; no timer is reset after start().
        this.fresh(lease);
        if (!this.ready || this.admission && !this.admission.available() || this.expired(context)) {
          this.beginStop(context, this.expired(context) ? 'timed_out' : 'cancelled'); await this.publishStop(context); return this.statusBody(await this.requireRun(lease.runId)); }
        context.deadline = setTimeout(() => { this.backgroundStop('timed_out', lease.runId); }, Math.max(0, context.budgetMs - (performance.now() - context.startedAt)));
        context.startFlight = Promise.resolve().then(async () => {
          this.assertJournalOwner();
          if (this.admission) await this.admission.markDispatch('oneshot', lease.runId, context.claimToken!);
          this.assertJournalOwner();
          if (context.stopping || !this.ready || this.admission && !this.admission.available() || this.expired(context)) {
            this.beginStop(context, this.expired(context) ? 'timed_out' : 'cancelled'); throw new Error('Host lifecycle closed before dispatch'); }
          context.dispatchInvoked = true;
          return this.runtime.start(lease, heartbeat => {
          if (this.active === context && !context.stopping && heartbeat.sequence > (context.heartbeat?.sequence ?? -1)
            && heartbeat.elapsedMs >= (context.heartbeat?.elapsedMs ?? 0)) context.heartbeat = { ...heartbeat, receivedAt: this.clock() };
          });
        }).then(cell => {
          context.cell = cell;
          void cell.wait.then(result => this.finish(context, result), () => this.finish(context, { output: '', exitCode: -1 }, 'fault'))
            .catch(() => { this.cleanupFailed = true; });
          return cell;
        });
        await context.startFlight;
        if (this.expired(context)) this.beginStop(context, 'timed_out');
        if (context.stopping) { await this.publishStop(context); return this.statusBody(await this.requireRun(lease.runId)); }
        await this.persist(lease.runId, { state: 'running', updatedAt: new Date(this.clock()) });
        await this.tick(lease.runId, 'RUNNING');
        if (context.stopping) await this.publishStop(context);
        else context.ticker = setInterval(() => { void this.exclusive(() => this.tick(lease.runId, 'RUNNING')).catch(() => this.backgroundStop('fault', lease.runId)); }, HOST_TICK_MS);
      } catch (error) {
        if (error instanceof HostCellCleanupError) this.cleanupFailed = true;
        this.beginStop(context, this.expired(context) ? 'timed_out' : 'fault');
        try { await this.publishStop(context); } catch { this.cleanupFailed = true; throw error; }
      }
      return this.statusBody((await this.requireRun(lease.runId)));
    });
  }
  /**
   * Separate default-off path: the host verifies the EOA-signed delegation and
   * canonical opening, then journals its own receipt with the lease before any
   * cell dispatch. No v1 request can be upgraded after first admission.
   */
  async admitV2(value: unknown): Promise<{ status: ReturnType<HostKitAgent['statusBody']>;
    admission: SignedHostV2AdmissionReceipt }> {
    const authority = this.v2Admission;
    if (!authority) throw new Problem(404, 'v2_admission_disabled', 'Host v2 admission is not configured.');
    const envelope = hostV2AdmissionEnvelopeSchema.parse(value), signed = envelope.lease, lease = signed.body;
    if (!verifyHostMessage(this.controlKey, 'lease', signed) || lease.hostKey !== this.journal.identity.publicKey) {
      throw new Problem(403, 'lease_rejected', 'Lease signature or host scope was rejected.');
    }
    return this.exclusive(async () => {
      this.assertJournalOwner();
      await this.assertV2Binding();
      const envelopeHash = hashJson(envelope), signedLeaseHash = hostMessageHash(signed);
      const [existing] = await this.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, lease.runId)).limit(1);
      if (existing) {
        const receipt = existing.v2Admission && hostV2AdmissionReceiptSchema.parse(existing.v2Admission);
        if (existing.leaseHash !== signedLeaseHash || existing.owner !== lease.owner
          || hostMessageHash(existing.lease) !== signedLeaseHash
          || !verifyHostMessage(this.controlKey, 'lease', existing.lease) || !receipt
          || !verifyHostMessage(this.journal.identity.publicKey, 'v2-admission', receipt)
          || receipt.body.envelopeHash !== envelopeHash || receipt.body.signedLeaseHash !== signedLeaseHash) {
          throw new Problem(409, 'lease_conflict', 'Original Host v2 admission differs from this request.');
        }
        return { status: this.statusBody(existing), admission: receipt };
      }
      if (!this.ready || this.cleanupFailed) throw new Problem(503, 'host_unavailable', 'Host cleanup or initialization is incomplete.');
      this.fresh(lease);
      const { openingBlockHash, cutoffMs } = await authority.verify(envelope, this.journal.identity.publicKey, this.controlKey);
      await this.assertV2Binding();
      if (!Number.isSafeInteger(cutoffMs) || cutoffMs <= this.clock()
        || cutoffMs > lease.expiresAt + 5000) {
        throw new Problem(403, 'v2_cutoff_invalid', 'Host v2 original run cutoff was rejected.');
      }
      this.fresh(lease);
      const rows = await this.journal.db.select({ runId: hostRuns.runId }).from(hostRuns).limit(4097);
      if (rows.length >= 4096) throw new Problem(503, 'host_journal_full', 'Host history requires operator archival.');
      const active = await this.journal.db.select({ runId: hostRuns.runId }).from(hostRuns)
        .where(inArray(hostRuns.state, ['starting', 'running'])).limit(1);
      if (active.length || this.active) throw new Problem(409, 'host_busy', 'The host already has an active tenant.');
      this.fresh(lease);
      this.assertJournalOwner();
      const body = envelope.delegation.body;
      const admission = hostV2AdmissionReceiptSchema.parse(this.journal.identity.sign('v2-admission', {
        version: 2 as const, chainId: body.chainId, escrow: body.escrow, hostRegistry: body.hostRegistry,
        runId: lease.runId, hostId: body.hostId, hostKey: this.journal.identity.publicKey,
        controllerKey: this.controlKey, owner: lease.owner, admissionTx: envelope.admissionTx,
        openingBlockHash, quoteHash: body.quoteHash, signedLeaseHash,
        meterLeaseHash: body.meterLeaseHash, delegationHash: hashJson(envelope.delegation),
        envelopeHash, acceptedAtMs: this.clock(),
      }));
      const expiresAt = Math.min(lease.expiresAt, cutoffMs);
      const context: ActiveRun = { runId: lease.runId, startedAt: performance.now(), expiresAt,
        budgetMs: Math.min(lease.maxSeconds * 1000, expiresAt - this.clock()) };
      try {
        await this.journal.db.transaction(async tx => {
          const rows = await Promise.all([
            tx.select().from(hostBinding).limit(2),
            tx.select({ slot: hostClaims.slot }).from(hostClaims).limit(1),
            tx.select({ id: hostSessions.sessionId }).from(hostSessions).limit(1),
            tx.select({ id: hostPaidSessions.sessionId }).from(hostPaidSessions).limit(1),
            tx.select({ id: hostPaidPreemptions.sessionId }).from(hostPaidPreemptions).limit(1),
          ]);
          if (!this.matchesV2Binding(rows[0]) || rows.slice(1).some(found => found.length)) throw v2BindingError();
          await tx.insert(hostRuns).values({ runId: lease.runId, owner: lease.owner,
            leaseHash: signedLeaseHash, lease: signed, state: 'starting', v2Admission: admission });
        });
        const [saved] = await this.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, lease.runId)).limit(1);
        if (!saved || saved.state !== 'starting' || saved.owner !== lease.owner
          || saved.leaseHash !== signedLeaseHash || hostMessageHash(saved.lease) !== signedLeaseHash
          || !verifyHostMessage(this.controlKey, 'lease', saved.lease) || !saved.v2Admission
          || hostMessageHash(saved.v2Admission) !== hostMessageHash(admission)
          || !verifyHostMessage(this.journal.identity.publicKey, 'v2-admission', saved.v2Admission)) {
          throw new Error('Original Host v2 admission was not durably read back');
        }
        await this.assertV2Binding();
      } catch (error) { this.cleanupFailed = true; throw error; }
      this.active = context;
      try {
        // The receipt has been durably read back before the first call to runtime.start.
        this.fresh(lease);
        if (!this.ready || this.expired(context)) {
          this.beginStop(context, this.expired(context) ? 'timed_out' : 'cancelled');
          await this.publishStop(context);
          return { status: this.statusBody(await this.requireRun(lease.runId)), admission };
        }
        context.deadline = setTimeout(() => { this.backgroundStop('timed_out', lease.runId); }, Math.max(0, context.budgetMs - (performance.now() - context.startedAt)));
        context.startFlight = Promise.resolve().then(async () => {
          this.assertJournalOwner();
          if (context.stopping || !this.ready || this.expired(context)) {
            this.beginStop(context, this.expired(context) ? 'timed_out' : 'cancelled');
            throw new Error('Host lifecycle closed before dispatch');
          }
          context.dispatchInvoked = true;
          return this.runtime.start(lease, heartbeat => {
            if (this.active === context && !context.stopping && heartbeat.sequence > (context.heartbeat?.sequence ?? -1)
              && heartbeat.elapsedMs >= (context.heartbeat?.elapsedMs ?? 0)) context.heartbeat = { ...heartbeat, receivedAt: this.clock() };
          });
        }).then(cell => {
          context.cell = cell;
          void cell.wait.then(result => this.finish(context, result), () => this.finish(context, { output: '', exitCode: -1 }, 'fault'))
            .catch(() => { this.cleanupFailed = true; });
          return cell;
        });
        await context.startFlight;
        if (this.expired(context)) this.beginStop(context, 'timed_out');
        if (context.stopping) {
          await this.publishStop(context);
          return { status: this.statusBody(await this.requireRun(lease.runId)), admission };
        }
        await this.persist(lease.runId, { state: 'running', updatedAt: new Date(this.clock()) });
        await this.tick(lease.runId, 'RUNNING');
        if (context.stopping) await this.publishStop(context);
        else context.ticker = setInterval(() => { void this.exclusive(() => this.tick(lease.runId, 'RUNNING')).catch(() => this.backgroundStop('fault', lease.runId)); }, HOST_TICK_MS);
      } catch (error) {
        if (error instanceof HostCellCleanupError) this.cleanupFailed = true;
        this.beginStop(context, this.expired(context) ? 'timed_out' : 'fault');
        try { await this.publishStop(context); } catch { this.cleanupFailed = true; throw error; }
      }
      return { status: this.statusBody(await this.requireRun(lease.runId)), admission };
    });
  }
  private async requireRun(runId: string): Promise<HostRun> {
    const [run] = await this.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, runId)).limit(1);
    if (!run) throw new Problem(404, 'lease_not_found', 'Lease not found.'); return run;
  }
  private statusBody(run: HostRun) {
    return { version: 1, hostKey: this.journal.identity.publicKey, isolation: this.runtime.isolation,
      runId: run.runId, owner: run.owner, leaseHash: run.leaseHash, state: run.state,
      ticks: run.ticks, acks: run.acks, billableSeconds: run.billableSeconds, output: run.output, exitCode: run.exitCode, cleanupConfirmed: run.cleanupConfirmed };
  }
  private async persist(runId: string, values: Partial<HostRun>): Promise<void> {
    try {
      if (this.admission) { const token = this.active?.runId === runId ? this.active.claimToken : undefined;
        if (!token) throw new Error('Missing shared host claim'); await this.admission.saveRun(token, runId, values); }
      else await this.journal.db.update(hostRuns).set(values).where(eq(hostRuns.runId, runId));
    } catch (error) { this.cleanupFailed = true; this.admission?.fail(); throw error; }
  }
  private async tick(runId: string, state: 'RUNNING' | 'EXITED' | 'FAULT' | 'STOPPED'): Promise<void> {
    const run = await this.requireRun(runId); if (!['starting', 'running'].includes(run.state)) return;
    const context = this.active; if (!context || context.runId !== runId) return;
    if (state === 'RUNNING' && this.expired(context)) { this.beginStop(context, 'timed_out'); this.backgroundStop('timed_out', runId); return; }
    // Physical cleanup may already have removed the container. Terminal intervals are unbilled;
    // retain only the last durable CPU counter instead of querying a removed resource.
    const sample = state === 'RUNNING' && context.cell ? await context.cell.sample()
      : { running: false, cpuMs: run.ticks.at(-1)?.body.cpuMs ?? 0 };
    if (this.active !== context || state === 'RUNNING' && context.stopping) return;
    if (state === 'RUNNING' && this.expired(context)) { this.beginStop(context, 'timed_out'); this.backgroundStop('timed_out', runId); return; }
    if (state === 'RUNNING' && !sample.running) return;
    if (state === 'RUNNING' && (this.clock() - (run.acks.at(-1)?.body.acceptedAt ?? run.lease.body.issuedAt) >= HOST_TICK_MS * 3
      || this.clock() - (context.heartbeat?.receivedAt ?? run.lease.body.issuedAt) >= HOST_TICK_MS * 3)) throw new Error('Three acknowledgements or init heartbeats were missed');
    const previous = run.ticks.at(-1), elapsedMs = Math.min(run.lease.body.maxSeconds * 1000, Math.max(previous?.body.elapsedMs ?? 0, Math.floor(performance.now() - context.startedAt)));
    const signed = this.journal.identity.sign('tick', hostTickSchema.parse({ version: 1, hostKey: this.journal.identity.publicKey,
      runId, owner: run.owner, leaseHash: hostMessageHash({ body: run.lease.body, signature: '' }), sequence: run.ticks.length,
      timestamp: this.clock(), elapsedMs, cpuMs: Math.max(previous?.body.cpuMs ?? 0, sample.cpuMs), state,
      previousHash: previous ? hostMessageHash(previous) : null, heartbeat: context.heartbeat ?? null,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    await this.persist(runId, { ticks: [...run.ticks, signed], updatedAt: new Date(this.clock()) });
  }
  private async finish(context: ActiveRun, result: { output: string; exitCode: number }, forced?: 'fault'): Promise<void> {
    if (this.active !== context || context.stopping) return;
    const expired = this.expired(context);
    if (!expired) context.result = result;
    this.beginStop(context, expired ? 'timed_out' : forced ?? (result.exitCode === 0 ? 'completed' : 'failed'));
    await this.exclusive(() => this.publishStop(context));
  }
  private clearTimers(context: ActiveRun): void {
    if (context.ticker) clearInterval(context.ticker); if (context.deadline) clearTimeout(context.deadline);
    delete context.ticker; delete context.deadline;
  }
  private beginStop(context: ActiveRun, state: NonNullable<ActiveRun['stopping']>): void {
    if (this.active !== context || context.stopping) return;
    context.stopping = state; this.clearTimers(context);
    // Termination starts outside the serial journal queue, including when a sample or start is blocked.
    if (context.cell) context.cleanupFlight = Promise.resolve().then(() => context.cell!.stop());
    else if (context.startFlight) {
      const early = context.dispatchInvoked ? Promise.resolve().then(() => this.runtime.cleanupOrphans(this.journal.identity.publicKey)).catch(() => undefined) : Promise.resolve();
      context.cleanupFlight = (async () => {
        const final = context.startFlight!.then(cell => cell.stop(), async error => {
          if (error instanceof HostCellCleanupError) this.cleanupFailed = true;
          if (context.dispatchInvoked) await this.runtime.cleanupOrphans(this.journal.identity.publicKey);
        });
        await Promise.all([early, final]);
      })();
    } else context.cleanupFlight = Promise.resolve(); // Durable reservation expired before any dispatch.
    void context.cleanupFlight.catch(() => { this.cleanupFailed = true; });
  }
  private async publishStop(context: ActiveRun): Promise<void> {
    if (this.active !== context || !context.stopping) return;
    let state = context.stopping, cleanupConfirmed = false;
    try { await context.cleanupFlight; cleanupConfirmed = !this.cleanupFailed; }
    catch { this.cleanupFailed = true; state = 'fault'; }
    if (this.cleanupFailed) state = 'fault';
    try { await this.tick(context.runId, state === 'fault' ? 'FAULT' : ['completed', 'failed'].includes(state) ? 'EXITED' : 'STOPPED'); }
    catch { state = 'fault'; }
    cleanupConfirmed = cleanupConfirmed && !this.cleanupFailed;
    await this.persist(context.runId, { state, cleanupConfirmed, output: context.result?.output.slice(0, 16384) ?? '',
      exitCode: context.result?.exitCode ?? -1, updatedAt: new Date(this.clock()) });
    // Failed cleanup or ambiguous terminal persistence keeps ownership fenced until startup recovery.
    if (cleanupConfirmed && !this.cleanupFailed && this.active === context) this.active = undefined;
  }
  private async stopActive(state: 'cancelled' | 'timed_out' | 'fault', expectedRunId?: string): Promise<void> {
    const context = this.active;
    if (!context || expectedRunId !== undefined && context.runId !== expectedRunId) return;
    this.beginStop(context, state); await this.exclusive(() => this.publishStop(context));
  }
  async control(value: unknown): Promise<ReturnType<HostKitAgent['journal']['identity']['sign']>> {
    this.assertJournalOwner();
    const signed: SignedHostControl = hostControlSchema.parse(value), body = signed.body;
    if (!verifyHostMessage(this.controlKey, 'control', signed) || body.hostKey !== this.journal.identity.publicKey
      || Math.abs(this.clock() - body.issuedAt) > 5000 || (body.action === 'ack') !== (body.ack !== undefined)) {
      throw new Problem(403, 'control_rejected', 'Control signature or timestamp was rejected.');
    }
    await this.exclusive(async () => {
      this.assertJournalOwner();
      const run = await this.requireRun(body.runId);
      if (run.owner !== body.owner) throw new Problem(404, 'lease_not_found', 'Lease not found.');
      await this.journal.db.delete(hostCommands).where(lt(hostCommands.createdAt, new Date(this.clock() - 60_000)));
      const [seen] = await this.journal.db.select().from(hostCommands).where(eq(hostCommands.nonce, body.nonce)).limit(1);
      if (seen) throw new Problem(409, 'control_replay', 'Control nonce was already used.');
      await this.journal.db.insert(hostCommands).values({ nonce: body.nonce, hash: hostMessageHash(signed), createdAt: new Date(this.clock()) });
      if (body.ack) {
        const ack = body.ack, tick = run.ticks[ack.body.sequence], previous = run.acks.at(-1);
        const recorded = run.acks[ack.body.sequence];
        if (recorded && hostMessageHash(recorded) === hostMessageHash(ack)) return;
        if (!verifyHostMessage(this.controlKey, 'ack', ack) || !tick || ack.body.hostKey !== this.journal.identity.publicKey
          || ack.body.runId !== run.runId || ack.body.leaseHash !== hostMessageHash({ body: run.lease.body, signature: '' })
          || ack.body.tickHash !== hostMessageHash(tick) || ack.body.sequence !== run.acks.length
          || Math.abs(this.clock() - ack.body.acceptedAt) > 5000 || ack.body.billableSeconds > run.lease.body.maxSeconds
          || ack.body.billableSeconds !== (previous?.body.billableSeconds ?? 0) + ack.body.billableDelta
          || ack.body.billableDelta !== billableHostInterval(run.ticks[ack.body.sequence - 1], tick,
            previous?.body.billableSeconds ?? 0, run.lease.body.maxSeconds)) throw new Problem(403, 'ack_rejected', 'Countersignature does not match the durable host tick.');
        await this.journal.db.update(hostRuns).set({ acks: [...run.acks, ack], billableSeconds: ack.body.billableSeconds }).where(eq(hostRuns.runId, run.runId));
      }
    });
    if (body.action === 'stop' || body.ack?.body.fault) await this.stopActive(body.ack?.body.fault ? 'fault' : 'cancelled', body.runId);
    return this.journal.identity.sign('control', this.statusBody(await this.requireRun(body.runId)));
  }
  identity() { return { version: 1, hostKey: this.journal.identity.publicKey, isolation: this.runtime.isolation,
    ready: this.ready && !this.closeFlight && !this.cleanupFailed && !this.active?.stopping && (!this.admission || this.admission.available()), tickIntervalMs: HOST_TICK_MS, maxSeconds: 120 }; }
}
export function createHostKitRoutes(agent: HostKitAgent, paidSessions?: PaidHostSessionAgent,
  preemptions?: PaidHostPreemptionService): Hono {
  if (agent.v2AdmissionEnabled() && (paidSessions || preemptions)) {
    throw new Error('Host v2 admission cannot share paid session routes');
  }
  const app = new Hono();
  app.use('*', (context, next) => {
    // Only the authenticated, exact-length streaming input route owns its body.
    if (paidSessions && context.req.method === 'PUT'
      && /^\/v1\/sessions\/cyst-inputs\/0x[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(context.req.path)) return next();
    return bodyLimit({ maxSize: 196_608, onError: limited => limited.json({ title: 'payload_too_large' }, 413) })(context, next);
  });
  app.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); context.header('X-Content-Type-Options', 'nosniff'); await next(); });
  app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_host_request' }, error instanceof Problem ? error.status : 422));
  app.get('/v1/identity', context => context.json(agent.identity()));
  app.post('/v1/capacity', async context => context.json(await agent.capacity(await context.req.json(), paidSessions?.capacityReady() ?? false)));
  app.post('/v1/leases', async context => {
    const result = await agent.admit(await context.req.json()); return context.json(agent.journal.identity.sign('control', result), 201);
  });
  if (agent.v2AdmissionEnabled()) app.post('/v2/leases', async context => {
    const result = await agent.admitV2(await context.req.json());
    return context.json({ status: agent.journal.identity.sign('control', result.status), admission: result.admission }, 201);
  });
  app.post('/v1/control', async context => context.json(await agent.control(await context.req.json())));
  if (paidSessions) app.route('/v1/sessions', createPaidHostSessionRoutes(paidSessions));
  if (preemptions) app.route('/v1/sessions/preemption', createPaidPreemptionRoutes(preemptions));
  return app;
}
