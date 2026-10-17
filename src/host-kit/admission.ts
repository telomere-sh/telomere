import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canonical, Problem } from '../common.js';
import { hostBinding, hostClaims, hostRuns, hostSessions, type HostJournal, type HostRun } from './journal.js';
import { hostKeySchema, hostMessageHash, signedLeaseSchema, verifyHostMessage, type SignedHostLease } from './protocol.js';
import type { HostCellRuntime } from './runtime.js';
import { sessionRecordSchema, sessionSpecSchema, type SessionBackend, type SessionJournal, type SessionRecord, type SessionSpec } from './sessions/types.js';

const slot = 'cpu1', maximumSessions = 256, maximumRecordBytes = 1_048_576;
export const admissionHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const hostScopeSchema = z.object({ version: z.literal(1), hostKey: hostKeySchema, controlKey: hostKeySchema,
  isolation: z.enum(['gvisor', 'kata', 'docker_development', 'local_process_fixture']),
  runtime: z.string().min(1).max(4096), sessionBackend: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
export type HostScope = z.infer<typeof hostScopeSchema>;
export type HostInventory = Array<{ kind: 'oneshot' | 'session'; resourceId: string; image: string; name: string }>;
type Claim = typeof hostClaims.$inferSelect;
type SessionRow = typeof hostSessions.$inferSelect;
const unavailable = () => new Problem(503, 'host_unavailable', 'Shared host admission or cleanup is incomplete.');
const conflict = () => new Problem(409, 'host_busy', 'The host already owns its CPU slot.');
const activeCommand = (state: string) => ['queued', 'starting', 'running'].includes(state);

/** One process owns the HostJournal lock. All claim mutations share this queue
 * and a database transaction; resource cleanup never waits for this queue. */
export class HostAdmissionCoordinator {
  readonly scope: HostScope;
  readonly scopeHash: string;
  private lifecycle: 'new' | 'initializing' | 'ready' | 'closed' | 'failed' = 'new';
  private prepared = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly journal: HostJournal, readonly runtime: HostCellRuntime, readonly backend: SessionBackend | undefined,
    scope: HostScope, private readonly inventory: () => Promise<HostInventory>) {
    this.scope = hostScopeSchema.parse(scope); this.scopeHash = admissionHash(this.scope);
    if (scope.hostKey !== journal.identity.publicKey || scope.isolation !== runtime.isolation
      || (backend ? backend.identity !== scope.sessionBackend || backend.isolation !== runtime.isolation : scope.sessionBackend !== null)) throw unavailable();
  }
  available() { return this.lifecycle === 'ready'; }
  /** A read-only placement hint. ReserveRun/session still owns the authoritative CPU1 fence. */
  async capacityAvailable(): Promise<boolean> {
    return this.serial(() => this.guarded(async () => {
      if (!this.available()) return false;
      await this.binding();
      const claims = await this.journal.db.select({ slot: hostClaims.slot }).from(hostClaims).limit(2);
      if (claims.length > 1 || claims.some(claim => claim.slot !== slot)) throw unavailable();
      return claims.length === 0;
    }));
  }
  assertReady() { if (!this.available()) throw unavailable(); }
  activate() { if (!this.prepared || this.lifecycle !== 'initializing') throw unavailable(); this.lifecycle = 'ready'; }
  fail() { this.lifecycle = 'failed'; }
  closeAdmission() { if (this.lifecycle !== 'failed') this.lifecycle = 'closed'; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { if (!(error instanceof Problem) || error.code === 'host_unavailable') this.fail(); throw error; }
  }
  private async binding() {
    const rows = await this.journal.db.select().from(hostBinding).limit(2);
    if (rows.length !== 1 || rows[0]!.slot !== slot || rows[0]!.scopeHash !== this.scopeHash
      || admissionHash(rows[0]!.scope) !== this.scopeHash) { this.fail(); throw unavailable(); }
  }
  private checkedSession(row: SessionRow): SessionRecord | undefined {
    const spec = sessionSpecSchema.parse(row.spec);
    sessionRecordSchema.shape.backend.parse(row.backend);
    if (!this.backend || row.specHash !== admissionHash(spec) || row.backend.identity !== this.backend.identity
      || row.backend.isolation !== this.backend.isolation || spec.sessionId !== row.sessionId || !/^[a-f0-9]{64}$/.test(row.claimToken)) throw unavailable();
    if (!row.record) return undefined;
    const value = sessionRecordSchema.parse(row.record);
    if (Buffer.byteLength(JSON.stringify(value)) > maximumRecordBytes || value.specHash !== row.specHash
      || admissionHash(value.spec) !== row.specHash || admissionHash(value.backend) !== admissionHash(row.backend)
      || value.commands.length > spec.policy.maxCommands || value.outputBytes > spec.policy.maxSessionOutputBytes
      || value.outputFrames > spec.policy.maxOutputFrames || value.events.some((event, index) => event.sequence !== index)
      || new Set(value.commands.map(command => command.command.commandId)).size !== value.commands.length
      || value.commands.some(command => command.inputHash !== admissionHash(command.command) || command.outputBytes > spec.policy.maxOutputBytesPerCommand)
      || value.cleanupConfirmed && ['starting', 'running'].includes(value.state)) throw unavailable();
    return value;
  }
  private checkedRun(run: HostRun) {
    const signed = signedLeaseSchema.parse(run.lease);
    if (signed.body.hostKey !== this.scope.hostKey || signed.body.runId !== run.runId || signed.body.owner !== run.owner
      || hostMessageHash(signed) !== run.leaseHash || !verifyHostMessage(this.scope.controlKey, 'lease', signed)) throw unavailable();
  }
  private checkedClaim(claim: Claim, runs: HostRun[], sessions: SessionRow[]) {
    if (claim.slot !== slot || claim.scopeHash !== this.scopeHash || !/^[a-f0-9]{64}$/.test(claim.token)
      || claim.inputHash !== admissionHash(claim.original) || typeof claim.dispatchStarted !== 'boolean') throw unavailable();
    if (claim.kind === 'oneshot') {
      const run = runs.find(value => value.runId === claim.resourceId);
      if (!run || run.cleanupConfirmed || admissionHash(run.lease) !== claim.inputHash || run.state === 'running' && !claim.dispatchStarted) throw unavailable();
    } else if (claim.kind === 'session') {
      const session = sessions.find(value => value.sessionId === claim.resourceId);
      if (!session || session.claimToken !== claim.token || session.record?.cleanupConfirmed || session.specHash !== claim.inputHash
        || (!session.record || session.record.state === 'running') && claim.dispatchStarted !== !!session.record) throw unavailable();
    } else throw unavailable();
  }
  async initialize(): Promise<{ orphanedCells: string[]; faultedRuns: string[]; recoveredSessions: string[] }> {
    if (this.lifecycle !== 'new') throw unavailable(); this.lifecycle = 'initializing';
    try {
      const bindings = await this.journal.db.select().from(hostBinding).limit(2);
      const runs = await this.journal.db.select().from(hostRuns).limit(4097);
      const sessions = await this.journal.db.select().from(hostSessions).limit(maximumSessions + 1);
      const claims = await this.journal.db.select().from(hostClaims).limit(2);
      if (runs.length > 4096 || sessions.length > maximumSessions || claims.length > 1) throw unavailable();
      // No implicit migration can establish where historical resources lived.
      if (!bindings.length) {
        if (runs.length || sessions.length || claims.length) throw unavailable();
        await this.journal.db.insert(hostBinding).values({ slot, scopeHash: this.scopeHash, scope: this.scope });
      }
      await this.binding();
      for (const run of runs) this.checkedRun(run);
      for (const session of sessions) this.checkedSession(session);
      const claim = claims[0]; if (claim) this.checkedClaim(claim, runs, sessions);
      if (runs.some(run => !run.cleanupConfirmed && (!claim || claim.kind !== 'oneshot' || claim.resourceId !== run.runId))
        || sessions.some(session => !session.record?.cleanupConfirmed && (!claim || claim.kind !== 'session' || claim.resourceId !== session.sessionId))) throw unavailable();
      const owned = await this.inventory();
      for (const item of owned) {
        if (item.kind === 'oneshot') {
          const run = runs.find(value => value.runId === item.resourceId);
          if (!run || run.lease.body.image !== item.image || run.cleanupConfirmed) throw unavailable();
        } else {
          const session = sessions.find(value => value.sessionId === item.resourceId);
          if (!session || session.spec.image !== item.image || session.record?.cleanupConfirmed) throw unavailable();
        }
      }
      if (claim) {
        const observed = owned.some(item => item.kind === claim.kind && item.resourceId === claim.resourceId);
        const run = runs.find(value => value.runId === claim.resourceId), session = sessions.find(value => value.sessionId === claim.resourceId);
        const acknowledged = claim.kind === 'oneshot' ? run!.state === 'running' || run!.ticks.some(tick => tick.body.state === 'RUNNING')
          : session!.record?.initPid !== null && session!.record?.initPid !== undefined;
        // A killed client may leave an in-flight create request. Absence does
        // not prove it can never complete. Pre-dispatch gaps are distinct.
        if (observed && !claim.dispatchStarted || claim.dispatchStarted && !acknowledged && !observed) throw unavailable();
      }
      await this.runtime.initialize(this.scope.hostKey);
      const orphanedCells = await this.runtime.cleanupOrphans(this.scope.hostKey);
      const recoveredSessions: string[] = [];
      for (const session of sessions) if (!session.record?.cleanupConfirmed) {
        await this.backend!.cleanup(session.spec); recoveredSessions.push(session.sessionId);
      }
      if ((await this.inventory()).length) throw unavailable();
      const faultedRuns = runs.filter(run => ['starting', 'running'].includes(run.state)).map(run => run.runId);
      await this.journal.db.transaction(async tx => {
        for (const run of runs) if (!run.cleanupConfirmed || faultedRuns.includes(run.runId)) await tx.update(hostRuns)
          .set({ state: 'fault', cleanupConfirmed: true, updatedAt: new Date() }).where(eq(hostRuns.runId, run.runId));
        for (const session of sessions) if (!session.record?.cleanupConfirmed) {
          const record: SessionRecord = session.record ? structuredClone(session.record) : { version: 1, spec: session.spec, backend: session.backend,
            specHash: session.specHash, state: 'starting', reason: '', initPid: null, commands: [], events: [], outputBytes: 0, outputFrames: 0, cleanupConfirmed: false };
          for (const command of record.commands) if (activeCommand(command.state)) { command.state = 'uncertain'; command.reason = 'recovered'; command.exitCode = -1; }
          record.state = 'fault'; record.reason = 'recovered'; record.cleanupConfirmed = true;
          if (record.events.length < 4096) record.events.push({ sequence: record.events.length, kind: 'session_exit', reason: 'recovered' });
          await tx.update(hostSessions).set({ record, updatedAt: new Date() }).where(eq(hostSessions.sessionId, session.sessionId));
        }
        if (claim) { const removed = await tx.delete(hostClaims).where(and(eq(hostClaims.slot, slot), eq(hostClaims.token, claim.token))).returning(); if (removed.length !== 1) throw unavailable(); }
      });
      if (this.lifecycle !== 'initializing') throw unavailable();
      this.prepared = true; return { orphanedCells, faultedRuns, recoveredSessions };
    } catch { this.fail(); throw unavailable(); }
  }
  async reserveRun(signed: SignedHostLease): Promise<{ record: HostRun; token: string }> {
    return this.serial(() => this.guarded(async () => {
      this.assertReady(); await this.binding(); const token = randomBytes(32).toString('hex');
      return this.journal.db.transaction(async tx => {
        this.assertReady();
        if ((await tx.select().from(hostClaims).limit(1)).length) throw conflict();
        await tx.insert(hostClaims).values({ slot, kind: 'oneshot', resourceId: signed.body.runId, token, scopeHash: this.scopeHash,
          inputHash: admissionHash(signed), original: signed });
        const [record] = await tx.insert(hostRuns).values({ runId: signed.body.runId, owner: signed.body.owner, leaseHash: hostMessageHash(signed), lease: signed, state: 'starting' }).returning();
        if (!record) throw new Error('Missing durable reservation'); return { record, token };
      });
    }));
  }
  async markDispatch(kind: 'oneshot' | 'session', resourceId: string, token: string): Promise<void> {
    await this.serial(() => this.guarded(async () => {
      this.assertReady(); await this.binding();
      await this.journal.db.transaction(async tx => {
        this.assertReady(); const [claim] = await tx.select().from(hostClaims).where(eq(hostClaims.slot, slot)).limit(1);
        if (!claim || claim.kind !== kind || claim.resourceId !== resourceId || claim.token !== token || claim.scopeHash !== this.scopeHash
          || claim.dispatchStarted || claim.inputHash !== admissionHash(claim.original)) { this.fail(); throw unavailable(); }
        if (kind === 'oneshot') {
          const [run] = await tx.select().from(hostRuns).where(eq(hostRuns.runId, resourceId)).limit(1);
          if (!run || run.state !== 'starting' || admissionHash(run.lease) !== claim.inputHash) throw unavailable(); this.checkedRun(run);
        } else {
          const [row] = await tx.select().from(hostSessions).where(eq(hostSessions.sessionId, resourceId)).limit(1);
          if (!row || row.claimToken !== token || row.specHash !== claim.inputHash || row.record?.state !== 'starting') throw unavailable(); this.checkedSession(row);
        }
        const updated = await tx.update(hostClaims).set({ dispatchStarted: true }).where(and(eq(hostClaims.slot, slot), eq(hostClaims.token, token), eq(hostClaims.dispatchStarted, false))).returning();
        if (updated.length !== 1) throw new Error('Dispatch marker was not persisted');
      });
    }));
  }
  async saveRun(token: string, runId: string, values: Partial<HostRun>): Promise<void> {
    await this.serial(() => this.guarded(async () => {
      const terminalTick = !values.state && !!values.ticks?.length && values.ticks.at(-1)!.body.state !== 'RUNNING'
        && Object.keys(values).every(key => ['ticks', 'updatedAt'].includes(key));
      if (!this.available() && (!values.state || ['starting', 'running'].includes(values.state)) && !terminalTick) throw unavailable();
      if (Object.keys(values).some(key => ['runId', 'owner', 'leaseHash', 'lease'].includes(key))) { this.fail(); throw unavailable(); }
      await this.binding(); await this.journal.db.transaction(async tx => {
        const [run] = await tx.select().from(hostRuns).where(eq(hostRuns.runId, runId)).limit(1);
        if (run?.cleanupConfirmed) {
          if (Object.entries(values).every(([key, value]) => admissionHash(value) === admissionHash(run[key as keyof HostRun]))) return;
          throw new Problem(409, 'lease_conflict', 'Terminal run evidence is immutable.');
        }
        const [claim] = await tx.select().from(hostClaims).where(eq(hostClaims.slot, slot)).limit(1);
        if (!claim || claim.kind !== 'oneshot' || claim.resourceId !== runId || claim.token !== token || claim.scopeHash !== this.scopeHash) { this.fail(); throw unavailable(); }
        if (!run || admissionHash(run.lease) !== claim.inputHash || admissionHash(claim.original) !== claim.inputHash) { this.fail(); throw unavailable(); }
        this.checkedRun(run);
        await tx.update(hostRuns).set(values).where(eq(hostRuns.runId, runId));
        if (values.cleanupConfirmed === true && values.state && !['starting', 'running'].includes(values.state)) {
          const removed = await tx.delete(hostClaims).where(and(eq(hostClaims.slot, slot), eq(hostClaims.token, token))).returning(); if (removed.length !== 1) throw new Error('Claim release failed');
        }
      });
      if (values.state && !['starting', 'running'].includes(values.state) && values.cleanupConfirmed !== true) this.fail();
    }));
  }
  async session(spec: SessionSpec): Promise<{ journal: SessionJournal; replay: boolean; dispatch(): Promise<void> }> {
    return this.serial(() => this.guarded(async () => {
      this.assertReady(); if (!this.backend) throw unavailable(); await this.binding();
      const parsed = sessionSpecSchema.parse(spec), specHash = admissionHash(parsed);
      const [existing] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, parsed.sessionId)).limit(1);
      if (existing) {
        this.checkedSession(existing); if (existing.specHash !== specHash) throw new Problem(409, 'session_conflict', 'Session input is immutable.');
        if (!existing.record?.cleanupConfirmed) throw conflict();
        return { journal: this.sessionJournal(existing.sessionId, existing.claimToken), replay: true,
          dispatch: () => this.markDispatch('session', existing.sessionId, existing.claimToken) };
      }
      const rows = await this.journal.db.select({ sessionId: hostSessions.sessionId }).from(hostSessions).limit(maximumSessions + 1);
      if (rows.length >= maximumSessions) throw new Problem(503, 'host_journal_full', 'Session history requires operator archival.');
      const token = randomBytes(32).toString('hex');
      await this.journal.db.transaction(async tx => {
        this.assertReady();
        if ((await tx.select().from(hostClaims).limit(1)).length) throw conflict();
        await tx.insert(hostClaims).values({ slot, kind: 'session', resourceId: parsed.sessionId, token, scopeHash: this.scopeHash, inputHash: specHash, original: parsed });
        await tx.insert(hostSessions).values({ sessionId: parsed.sessionId, spec: parsed, specHash, backend: { isolation: this.backend!.isolation, identity: this.backend!.identity }, claimToken: token, record: null });
      });
      return { journal: this.sessionJournal(parsed.sessionId, token), replay: false, dispatch: () => this.markDispatch('session', parsed.sessionId, token) };
    }));
  }
  private sessionJournal(sessionId: string, token: string): SessionJournal {
    return { load: () => this.serial(() => this.guarded(async () => {
      await this.binding();
      const [row] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, sessionId)).limit(1);
      if (!row || row.claimToken !== token) { this.fail(); throw unavailable(); } return this.checkedSession(row);
    })), save: raw => this.serial(() => this.guarded(async () => {
      const value = sessionRecordSchema.parse(raw);
      if (!this.available() && ['starting', 'running'].includes(value.state)) throw unavailable();
      await this.binding(); await this.journal.db.transaction(async tx => {
        const [row] = await tx.select().from(hostSessions).where(eq(hostSessions.sessionId, sessionId)).limit(1);
        if (row?.claimToken === token && row.record?.cleanupConfirmed) {
          this.checkedSession(row);
          if (admissionHash(row.record) === admissionHash(value)) return;
          throw new Problem(409, 'session_conflict', 'Terminal session evidence is immutable.');
        }
        const [claim] = await tx.select().from(hostClaims).where(eq(hostClaims.slot, slot)).limit(1);
        if (!row || row.claimToken !== token || !claim || claim.token !== token || claim.kind !== 'session' || claim.resourceId !== sessionId
          || claim.scopeHash !== this.scopeHash || claim.inputHash !== row.specHash || admissionHash(claim.original) !== claim.inputHash) { this.fail(); throw unavailable(); }
        this.checkedSession({ ...row, record: value });
        await tx.update(hostSessions).set({ record: value, updatedAt: new Date() }).where(eq(hostSessions.sessionId, sessionId));
        if (value.cleanupConfirmed && !['starting', 'running'].includes(value.state)) {
          const removed = await tx.delete(hostClaims).where(and(eq(hostClaims.slot, slot), eq(hostClaims.token, token))).returning(); if (removed.length !== 1) throw new Error('Claim release failed');
        }
      });
      if (!['starting', 'running'].includes(value.state) && !value.cleanupConfirmed) this.fail();
    })) };
  }
}
