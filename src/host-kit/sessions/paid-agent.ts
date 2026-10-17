import { eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { Problem, hashJson, canonical } from '../../common.js';
import { admissionHash } from '../admission.js';
import { hostCommands, hostPaidSessions, hostSessions, type HostJournal } from '../journal.js';
import { HOST_TICK_MS, hostMessageHash, hostTickSchema, signedAckSchema, signedTickSchema, verifyHostMessage,
  type SignedHostAck, type SignedHostLease } from '../protocol.js';
import { billableHostInterval } from '../meter.js';
import type { HostedSessionManager } from '../hosted-sessions.js';
import type { SessionRuntime } from './runtime.js';
import { paidSessionControlSchema, parsePaidSessionLease, type PaidSessionControl,
  paidSessionStatusSchema, type PaidSessionStatus } from './paid-protocol.js';
import { sessionRecordSchema, type SessionCommand, type SessionCommandResult } from './types.js';
import { cystInputBindingSchema, cystInputDescriptorHash, cystInputRequestSchema, cystInputResultSchema,
  CYST_INPUT_PATH, type CystInputBinding } from './cyst-input-protocol.js';

type Row = typeof hostPaidSessions.$inferSelect;
type Active = { lease: SignedHostLease; runtime: SessionRuntime; started: number; ticker: ReturnType<typeof setInterval>;
  deadline: ReturnType<typeof setTimeout> };
const terminal = (state: Row['state']) => !['starting', 'running'].includes(state);
const rejected = () => new Problem(403, 'session_control_rejected', 'Signed session control was rejected.');

/** Signed HostKit authority around the shared, durable SessionRuntime CPU slot.
 * It trusts only the configured controller key and never decides chain payment.
 */
export class PaidHostSessionAgent {
  private queue: Promise<unknown> = Promise.resolve();
  private active: Active | undefined;
  private ready = false;
  capacityReady(): boolean { return this.ready && this.sessions.admission.available(); }
  controllerKey(): string { return this.controlKey; }
  constructor(readonly journal: HostJournal, private readonly sessions: HostedSessionManager,
    private readonly controlKey: string, private readonly clock: () => number = Date.now) {
    if (sessions.admission.journal !== journal || sessions.admission.scope.controlKey !== controlKey) throw new Error('Paid session host scope changed');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private async row(runId: string): Promise<Row> {
    const [row] = await this.journal.db.select().from(hostPaidSessions).where(eq(hostPaidSessions.sessionId, runId)).limit(1);
    if (!row) throw new Problem(404, 'session_not_found', 'Session was not found');
    return row;
  }
  private verifyEvidence(row: Row): void {
    if (row.ticks.length > 100 || row.acks.length > row.ticks.length || row.acks.length > 100) throw new Error('Paid host evidence inventory changed');
    const leaseHash = hostMessageHash({ body: row.lease.body, signature: '' });
    for (let index = 0; index < row.ticks.length; index++) {
      const tick = signedTickSchema.parse(row.ticks[index]), previous = row.ticks[index - 1];
      if (!verifyHostMessage(this.journal.identity.publicKey, 'tick', tick) || tick.body.hostKey !== row.lease.body.hostKey
        || tick.body.owner !== row.owner || tick.body.runId !== row.sessionId || tick.body.leaseHash !== leaseHash
        || tick.body.sequence !== index || tick.body.previousHash !== (previous ? hostMessageHash(previous) : null)
        || tick.body.timestamp < row.lease.body.issuedAt - 5_000 || tick.body.timestamp > row.lease.body.expiresAt + 5_000
        || tick.body.elapsedMs > row.lease.body.maxSeconds * 1000
        || previous && (previous.body.state !== 'RUNNING' || tick.body.timestamp <= previous.body.timestamp
          || tick.body.elapsedMs < previous.body.elapsedMs || tick.body.cpuMs < previous.body.cpuMs)) {
        throw new Error('Paid host signed tick history changed');
      }
    }
    let total = 0;
    for (let index = 0; index < row.acks.length; index++) {
      const ack = signedAckSchema.parse(row.acks[index]), tick = row.ticks[index]!;
      const delta = billableHostInterval(row.ticks[index - 1], tick, total, row.lease.body.maxSeconds);
      if (!verifyHostMessage(this.controlKey, 'ack', ack) || ack.body.hostKey !== row.lease.body.hostKey
        || ack.body.runId !== row.sessionId || ack.body.leaseHash !== leaseHash || ack.body.sequence !== index
        || ack.body.tickHash !== hostMessageHash(tick) || ack.body.billableDelta !== delta
        || ack.body.billableSeconds !== total + delta || ack.body.acceptedAt < tick.body.timestamp - 5_000
        || ack.body.acceptedAt > tick.body.timestamp + 5_000) throw new Error('Paid host signed acknowledgement history changed');
      total += delta;
    }
    if (row.billableSeconds !== total || row.cleanupConfirmed && !terminal(row.state)
      || row.cleanupConfirmed && ['stopped', 'expired'].includes(row.state)
        && row.ticks.at(-1)?.body.state === 'RUNNING') {
      throw new Error('Paid host meter or terminal state changed');
    }
  }
  async initialize(): Promise<void> {
    this.sessions.admission.assertReady();
    const rows = await this.journal.db.select().from(hostPaidSessions).limit(257);
    if (rows.length > 256) throw new Error('Paid host session recovery inventory is full');
    const spool = this.sessions.admission.backend?.cystInputs;
    const inventory = spool ? await spool.inventory() : [];
    for (const record of inventory) {
      const row = rows.find(value => value.sessionId === record.binding.runId);
      if (!row) throw new Error('Paid input spool has no retained signed session authority');
      const { lease, payload } = parsePaidSessionLease(row.lease);
      if (!payload.spec.cystInput || !verifyHostMessage(this.controlKey, 'lease', lease)
        || record.specHash !== admissionHash(payload.spec)
        || canonical(record.binding) !== canonical(this.inputBinding(lease))) {
        throw new Error('Paid input spool differs from retained signed session authority');
      }
    }
    for (const row of rows) {
      const { lease, payload } = parsePaidSessionLease(row.lease);
      if (!verifyHostMessage(this.controlKey, 'lease', lease) || row.leaseHash !== hostMessageHash(lease)
        || lease.body.hostKey !== this.journal.identity.publicKey
        || lease.body.runId !== row.sessionId || lease.body.owner !== row.owner || payload.spec.sessionId !== row.sessionId) {
        throw new Error('Paid session authority changed during recovery');
      }
      this.verifyEvidence(row);
      const [session] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, row.sessionId)).limit(1);
      if (session && session.specHash !== admissionHash(payload.spec)) throw new Error('Paid session spec differs from durable host reservation');
      if (payload.spec.cystInput) {
        if (!spool || session && !session.record?.cleanupConfirmed) throw rejected();
        // Admission.initialize has already proven the original owned resource absent.
        if (inventory.some(value => value.binding.runId === row.sessionId)) await spool.cleanup(row.sessionId);
        // A clean stopped-state backup deliberately contains no plaintext spool.
        // Preserve its already verified terminal fact; never create one from absence.
        else if (!terminal(row.state) || !row.cleanupConfirmed) throw new Error('Unfinished paid input reservation is missing');
      }
      if (!terminal(row.state)) {
        if (session && !session.record?.cleanupConfirmed) throw new Error('Paid session resource cleanup is unconfirmed');
        await this.journal.db.update(hostPaidSessions).set({ state: 'fault', cleanupConfirmed: true, updatedAt: new Date(this.clock()) })
          .where(eq(hostPaidSessions.sessionId, row.sessionId));
      } else if (!row.cleanupConfirmed) {
        if (!session?.record?.cleanupConfirmed) throw new Error('Paid session terminal cleanup is unconfirmed');
        await this.journal.db.update(hostPaidSessions).set({ state: 'fault', cleanupConfirmed: true, updatedAt: new Date(this.clock()) })
          .where(eq(hostPaidSessions.sessionId, row.sessionId));
      } else if (session && !session.record?.cleanupConfirmed) throw new Error('Paid session terminal cleanup is unconfirmed');
    }
    this.ready = true;
  }
  private fresh(lease: SignedHostLease): void {
    const now = this.clock(), body = lease.body;
    if (Math.abs(body.issuedAt - now) > 5_000 || body.expiresAt <= now + 5_000
      || body.expiresAt > body.issuedAt + body.maxSeconds * 1000 + 5_000
      || body.hostKey !== this.journal.identity.publicKey || !verifyHostMessage(this.controlKey, 'lease', lease)) throw rejected();
  }
  async admit(raw: unknown): Promise<PaidSessionStatus> {
    const { lease, payload } = parsePaidSessionLease(raw);
    this.fresh(lease);
    if (!this.ready || !this.sessions.admission.available()) throw new Problem(503, 'host_unavailable', 'Host session recovery is incomplete');
    return this.serial(async () => {
      const prior = await this.journal.db.select().from(hostPaidSessions).where(eq(hostPaidSessions.sessionId, lease.body.runId)).limit(1);
      if (prior.length) {
        if (prior[0]!.leaseHash !== hostMessageHash(lease)) throw new Problem(409, 'session_conflict', 'Session lease changed');
        return this.statusBody(prior[0]!, -1, 8, null, lease.body.nonce);
      }
      if ((await this.journal.db.select({ id: hostPaidSessions.sessionId }).from(hostPaidSessions).limit(256)).length >= 256) {
        throw new Problem(503, 'host_journal_full', 'Paid session history requires operator archival.');
      }
      this.fresh(lease);
      await this.journal.db.insert(hostPaidSessions).values({ sessionId: lease.body.runId, owner: lease.body.owner,
        leaseHash: hostMessageHash(lease), lease, state: 'starting' });
      try {
        if (payload.spec.cystInput) {
          const spool = this.sessions.admission.backend?.cystInputs;
          if (!spool) throw rejected();
          await spool.reserve(this.inputBinding(lease), admissionHash(payload.spec));
        }
        const runtime = await this.sessions.open(payload.spec);
        if (this.clock() >= lease.body.expiresAt || runtime.status().state !== 'running') {
          await runtime.stop('expired'); throw new Error('Session expired before paid admission');
        }
        const started = performance.now();
        const active: Active = { lease, runtime, started,
          ticker: setInterval(() => { void this.serial(() => this.tick()).catch(() => {
            void this.serial(() => this.stop('fault')).catch(() => { this.ready = false; });
          }); }, HOST_TICK_MS),
          deadline: setTimeout(() => { void this.serial(() => this.stop('expired')).catch(() => { this.ready = false; }); },
            Math.max(1, lease.body.expiresAt - this.clock())) };
        active.ticker.unref(); active.deadline.unref(); this.active = active;
        await this.journal.db.update(hostPaidSessions).set({ state: 'running', updatedAt: new Date(this.clock()) })
          .where(eq(hostPaidSessions.sessionId, lease.body.runId));
        await this.tick();
        return this.statusBody(await this.row(lease.body.runId), -1, 8, null, lease.body.nonce);
      } catch (error) {
        // A resource which may have started remains owned by the shared host claim.
        // Startup recovery verifies physical cleanup before another admission.
        let cleanupConfirmed = false;
        if (this.active?.lease.body.runId === lease.body.runId) {
          await this.stop('fault').catch(() => undefined);
          cleanupConfirmed = (await this.row(lease.body.runId)).cleanupConfirmed;
        } else {
          const [session] = await this.journal.db.select().from(hostSessions)
            .where(eq(hostSessions.sessionId, lease.body.runId)).limit(1);
          // SessionRuntime cannot start a resource before HostAdmission persists its session row.
          cleanupConfirmed = !session || session.record?.cleanupConfirmed === true;
        }
        if (cleanupConfirmed && payload.spec.cystInput) {
          try {
            const spool = this.sessions.admission.backend?.cystInputs;
            if (!spool) throw rejected();
            const retained = await spool.inventory();
            if (retained.some(value => value.binding.runId === lease.body.runId)) await spool.cleanup(lease.body.runId);
            // No session record means the resource was never started. This is an
            // explicit failed-admission path, never startup recovery by absence.
            else if ((await this.journal.db.select().from(hostSessions)
              .where(eq(hostSessions.sessionId, lease.body.runId)).limit(1)).length) throw rejected();
          }
          catch { cleanupConfirmed = false; }
        }
        this.ready = cleanupConfirmed && this.sessions.admission.available();
        await this.journal.db.update(hostPaidSessions).set({ state: 'fault', cleanupConfirmed, updatedAt: new Date(this.clock()) })
          .where(eq(hostPaidSessions.sessionId, lease.body.runId));
        throw error;
      }
    });
  }
  private async tick(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const row = await this.row(active.lease.body.runId), state = active.runtime.status();
    if (!state.journalAvailable) { await this.stop('fault'); return; }
    if (state.state !== 'running') { await this.stop(state.state === 'expired' ? 'expired' : state.state === 'fault' ? 'fault' : 'stopped'); return; }
    if (this.clock() >= active.lease.body.expiresAt || this.clock() - (row.acks.at(-1)?.body.acceptedAt ?? row.lease.body.issuedAt) >= 15_000) {
      await this.stop(this.clock() >= active.lease.body.expiresAt ? 'expired' : 'fault'); return;
    }
    const sample = await active.runtime.sample();
    if (!sample.running) { await this.stop('fault'); return; }
    if (this.active !== active) return;
    const previous = row.ticks.at(-1), timestamp = this.clock();
    const heartbeat = state.heartbeat && state.heartbeat.receivedAtMs <= performance.now()
      ? { sequence: state.heartbeat.sequence, elapsedMs: state.heartbeat.elapsedMs,
          receivedAt: Math.max(0, Math.floor(timestamp - (performance.now() - state.heartbeat.receivedAtMs))) } : null;
    const tick = this.journal.identity.sign('tick', hostTickSchema.parse({ version: 1, hostKey: this.journal.identity.publicKey,
      runId: row.sessionId, owner: row.owner, leaseHash: hostMessageHash({ body: row.lease.body, signature: '' }),
      sequence: row.ticks.length, timestamp, elapsedMs: Math.min(row.lease.body.maxSeconds * 1000,
        Math.max(previous?.body.elapsedMs ?? 0, Math.floor(performance.now() - active.started))),
      cpuMs: Math.max(previous?.body.cpuMs ?? 0, sample.cpuMs), state: 'RUNNING',
      previousHash: previous ? hostMessageHash(previous) : null, heartbeat,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    await this.journal.db.update(hostPaidSessions).set({ ticks: [...row.ticks, tick], updatedAt: new Date(timestamp) })
      .where(eq(hostPaidSessions.sessionId, row.sessionId));
  }
  private async stop(reason: 'stopped' | 'expired' | 'fault'): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearInterval(active.ticker); clearTimeout(active.deadline);
    let cleanup = false;
    try { await active.runtime.stop(reason === 'expired' ? 'expired' : reason === 'fault' ? 'transport_fault' : 'requested');
      cleanup = active.runtime.status().cleanupConfirmed; }
    catch { cleanup = false; }
    const row = await this.row(active.lease.body.runId), previous = row.ticks.at(-1);
    const timestamp = Math.max(this.clock(), (previous?.body.timestamp ?? -1) + 1);
    const state = cleanup ? reason : 'fault';
    const tick = this.journal.identity.sign('tick', hostTickSchema.parse({ version: 1, hostKey: this.journal.identity.publicKey,
      runId: row.sessionId, owner: row.owner, leaseHash: hostMessageHash({ body: row.lease.body, signature: '' }),
      sequence: row.ticks.length, timestamp, elapsedMs: Math.min(row.lease.body.maxSeconds * 1000,
        Math.max(previous?.body.elapsedMs ?? 0, Math.floor(performance.now() - active.started))),
      cpuMs: previous?.body.cpuMs ?? 0, state: state === 'fault' ? 'FAULT' : 'STOPPED',
      previousHash: previous ? hostMessageHash(previous) : null, heartbeat: null,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    await this.journal.db.update(hostPaidSessions).set({ ticks: [...row.ticks, tick], state,
      cleanupConfirmed: cleanup, updatedAt: new Date(timestamp) }).where(eq(hostPaidSessions.sessionId, row.sessionId));
    if (!cleanup) this.ready = false;
  }
  private async statusBody(row: Row, afterSequence: number, limit: number, command: SessionCommandResult | null,
    requestNonce: string): Promise<PaidSessionStatus> {
    const active = this.active?.lease.body.runId === row.sessionId ? this.active.runtime : undefined;
    const [session] = active ? [] : await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, row.sessionId)).limit(1);
    const all = active ? active.durableHistory() : session?.record?.events ?? [];
    const events = all.slice(afterSequence + 1, afterSequence + 1 + limit);
    return paidSessionStatusSchema.shape.body.parse({ version: 1, hostKey: this.journal.identity.publicKey, runId: row.sessionId, owner: row.owner,
      leaseHash: row.leaseHash, requestNonce, isolation: this.sessions.admission.backend!.isolation,
      state: row.state, ticks: row.ticks, acks: row.acks, billableSeconds: row.billableSeconds,
      cleanupConfirmed: row.cleanupConfirmed, eventCount: all.length,
      eventsHash: hashJson({ protocol: 'telomere-paid-session-events-v1', events: all }), events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence, command });
  }
  private async replayCommand(row: Row, command: SessionCommand): Promise<SessionCommandResult> {
    if (!terminal(row.state) || !row.cleanupConfirmed) throw rejected();
    if (row.leaseHash !== hostMessageHash(row.lease) || !verifyHostMessage(this.controlKey, 'lease', row.lease)) throw rejected();
    const { payload } = parsePaidSessionLease(row.lease);
    const [session] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, row.sessionId)).limit(1);
    if (!session?.record || session.specHash !== admissionHash(payload.spec)) throw rejected();
    const record = sessionRecordSchema.parse(session.record);
    if (!record.cleanupConfirmed || ['starting', 'running'].includes(record.state)
      || record.specHash !== session.specHash || admissionHash(record.spec) !== session.specHash
      || record.backend.identity !== this.sessions.admission.backend?.identity
      || record.backend.isolation !== this.sessions.admission.backend.isolation
      || record.events.some((event, index) => event.sequence !== index)
      || record.events.at(-1)?.kind !== 'session_exit'
      || new Set(record.commands.map(value => value.command.commandId)).size !== record.commands.length) throw rejected();
    const result = record.commands.find(value => value.command.commandId === command.commandId);
    if (!result) throw rejected();
    if (result.inputHash !== admissionHash(command)) {
      throw new Problem(409, 'session_command_conflict', 'The command ID was used with different input.');
    }
    if (!['completed', 'failed', 'cancelled'].includes(result.state)) throw rejected();
    const related = record.events.filter(event => event.commandId === command.commandId);
    const exits = related.filter(event => event.kind === 'command_exit');
    if (exits.length !== 1 || exits[0]?.exitCode !== result.exitCode || exits[0]?.reason !== result.reason
      || related.filter(event => event.kind === 'output' && event.stream === 'stdout').map(event => event.text ?? '').join('') !== result.stdout
      || related.filter(event => event.kind === 'output' && event.stream === 'stderr').map(event => event.text ?? '').join('') !== result.stderr) {
      throw rejected();
    }
    return result;
  }
  async control(raw: unknown) {
    const signed: PaidSessionControl = paidSessionControlSchema.parse(raw), body = signed.body;
    if (!verifyHostMessage(this.controlKey, 'session-control', signed) || body.hostKey !== this.journal.identity.publicKey) throw rejected();
    const prepared = await this.serial(async () => {
      if (!this.ready || Math.abs(this.clock() - body.issuedAt) > 5_000) throw rejected();
      const row = await this.row(body.runId);
      if (row.owner !== body.owner || row.leaseHash !== body.leaseHash) throw rejected();
      await this.journal.db.delete(hostCommands).where(lt(hostCommands.createdAt, new Date(this.clock() - 60_000)));
      try { await this.journal.db.insert(hostCommands).values({ nonce: body.nonce,
        hash: hostMessageHash(signed), createdAt: new Date(this.clock()) }); }
      catch { throw new Problem(409, 'session_control_replay', 'Session control nonce was already used'); }
      if (body.action === 'ack') {
        const ack: SignedHostAck = body.ack, tick = row.ticks[ack.body.sequence], prior = row.acks.at(-1);
        if (!tick || !verifyHostMessage(this.controlKey, 'ack', ack) || ack.body.hostKey !== row.lease.body.hostKey
          || ack.body.runId !== row.sessionId || ack.body.leaseHash !== hostMessageHash({ body: row.lease.body, signature: '' })
          || ack.body.tickHash !== hostMessageHash(tick) || ack.body.sequence !== row.acks.length
          || Math.abs(this.clock() - ack.body.acceptedAt) > 5_000 || ack.body.billableSeconds > row.lease.body.maxSeconds
          || ack.body.billableSeconds !== (prior?.body.billableSeconds ?? 0) + ack.body.billableDelta
          || ack.body.billableDelta !== billableHostInterval(row.ticks[ack.body.sequence - 1], tick,
            prior?.body.billableSeconds ?? 0, row.lease.body.maxSeconds)) throw rejected();
        await this.journal.db.update(hostPaidSessions).set({ acks: [...row.acks, ack], billableSeconds: ack.body.billableSeconds })
          .where(eq(hostPaidSessions.sessionId, row.sessionId));
        if (ack.body.fault) await this.stop('fault');
      } else if (body.action === 'stop') await this.stop('stopped');
      else if (body.action === 'execute') {
        const active = this.active;
        if (!active || active.lease.body.runId !== row.sessionId || this.clock() >= active.lease.body.expiresAt) {
          // Terminal replay reads the durable command result. It never reopens a Cell.
          return { command: this.replayCommand(row, body.command) };
        }
        // Keep the host journal queue free while a command runs; runtime owns its durable command journal.
        return { command: active.runtime.execute(body.command) };
      }
      const refreshed = await this.row(body.runId);
      const status = await this.statusBody(refreshed, body.action === 'status' ? body.afterSequence : -1,
        body.action === 'status' ? body.limit : 1, null, body.nonce);
      return { status };
    });
    if ('status' in prepared) return this.journal.identity.sign('session-status', prepared.status);
    const command: SessionCommandResult = await prepared.command;
    return this.serial(async () => this.journal.identity.sign('session-status',
      await this.statusBody(await this.row(body.runId), -1, 1, command, body.nonce)));
  }
  /** Host-local preemption stop. It never selects the current CPU slot by
   * itself: both the durable run and exact signed lease must still match.
   * This confirms resource cleanup only; billing remains the controller's job.
   */
  async preemptExact(runId: string, leaseHash: string): Promise<{ state: Row['state']; cleanupConfirmed: true }> {
    return this.serial(async () => {
      if (!this.ready) throw new Problem(503, 'preemption_host_unavailable', 'Paid host recovery is incomplete.');
      const row = await this.row(runId);
      if (row.leaseHash !== leaseHash || hostMessageHash(row.lease) !== leaseHash
        || !verifyHostMessage(this.controlKey, 'lease', row.lease)) throw rejected();
      if (!terminal(row.state)) {
        const active = this.active;
        if (!active || active.lease.body.runId !== runId || hostMessageHash(active.lease) !== leaseHash) {
          throw new Problem(503, 'preemption_cleanup_uncertain', 'The original paid session is not owned by this live host slot.');
        }
        await this.stop('stopped');
      }
      const final = await this.row(runId);
      const [session] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, runId)).limit(1);
      const { payload } = parsePaidSessionLease(final.lease);
      if (!terminal(final.state) || !final.cleanupConfirmed || !session?.record?.cleanupConfirmed
        || ['starting', 'running'].includes(session.record.state)
        || session.specHash !== admissionHash(payload.spec) || session.record.specHash !== session.specHash
        || this.active?.lease.body.runId === runId) {
        throw new Problem(503, 'preemption_cleanup_uncertain', 'Original paid session cleanup is unconfirmed.');
      }
      this.verifyEvidence(final);
      return { state: final.state, cleanupConfirmed: true };
    });
  }
  async close(): Promise<void> { this.ready = false; await this.serial(() => this.stop('stopped')); await this.queue; }

  private inputBinding(lease: SignedHostLease): CystInputBinding {
    const { payload } = parsePaidSessionLease(lease);
    if (!payload.spec.cystInput) throw rejected();
    return cystInputBindingSchema.parse({ version: 1, hostKey: lease.body.hostKey, runId: lease.body.runId,
      owner: lease.body.owner, leaseHash: hostMessageHash(lease), expiresAt: lease.body.expiresAt,
      descriptor: payload.spec.cystInput });
  }
  /** The upload never holds the meter/ACK queue while reading network bytes. */
  async cystInput(raw: unknown, input?: ReadableStream<Uint8Array>, signal: AbortSignal = new AbortController().signal) {
    const signed = cystInputRequestSchema.parse(raw), body = signed.body;
    if (!verifyHostMessage(this.controlKey, 'cyst-input-request', signed) || body.hostKey !== this.journal.identity.publicKey) throw rejected();
    const prepared = await this.serial(async () => {
      if (!this.ready || Math.abs(this.clock() - body.issuedAt) > 5_000) throw rejected();
      const row = await this.row(body.runId), binding = this.inputBinding(row.lease);
      const { action: _action, nonce: _nonce, issuedAt: _issuedAt, ...requested } = body;
      if (row.leaseHash !== binding.leaseHash || !verifyHostMessage(this.controlKey, 'lease', row.lease)
        || hashJson(requested) !== hashJson(binding)) throw rejected();
      const spool = this.sessions.admission.backend?.cystInputs;
      if (!spool) throw rejected();
      await this.journal.db.delete(hostCommands).where(lt(hostCommands.createdAt, new Date(this.clock() - 60_000)));
      try { await this.journal.db.insert(hostCommands).values({ nonce: body.nonce,
        hash: hostMessageHash(signed), createdAt: new Date(this.clock()) }); }
      catch { throw new Problem(409, 'session_control_replay', 'Session control nonce was already used'); }
      const active = this.active;
      const assertActive = () => {
        if (!this.ready || !active || active !== this.active || active.lease.body.runId !== row.sessionId
          || hostMessageHash(active.lease) !== binding.leaseHash || this.clock() >= active.lease.body.expiresAt
          || active.runtime.status().state !== 'running' || !this.sessions.admission.available()) throw rejected();
      };
      if (body.action !== 'status') assertActive();
      else if ((!active || active.lease.body.runId !== row.sessionId) && !row.cleanupConfirmed) throw rejected();
      return { spool, binding, assertActive };
    });
    if (body.action === 'upload') {
      if (!input) throw rejected();
      await prepared.spool.stage(prepared.binding, input, signal, prepared.assertActive);
    } else if (body.action === 'commit') await prepared.spool.commit(prepared.binding, prepared.assertActive);
    const status = await prepared.spool.status(prepared.binding);
    return this.journal.identity.sign('cyst-input-result', cystInputResultSchema.parse({ version: 1,
      hostKey: body.hostKey, runId: body.runId, owner: body.owner, leaseHash: body.leaseHash,
      descriptorHash: cystInputDescriptorHash(body.descriptor), operationId: body.descriptor.operationId,
      ...status, plaintextBytes: body.descriptor.plaintextBytes, plaintextSha256: body.descriptor.plaintextSha256,
      path: CYST_INPUT_PATH, requestNonce: body.nonce }));
  }
}

export function createPaidHostSessionRoutes(agent: PaidHostSessionAgent): Hono {
  const routes = new Hono();
  routes.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_session_request' },
    error instanceof Problem ? error.status : 422));
  routes.post('/leases', async context => context.json(agent.journal.identity.sign('session-status', await agent.admit(await context.req.json())), 201));
  routes.post('/control', async context => context.json(await agent.control(await context.req.json())));
  routes.post('/cyst-inputs/control', async context => context.json(await agent.cystInput(await context.req.json())));
  routes.put('/cyst-inputs/:runId/:operationId', async context => {
    const encoded = context.req.header('x-telomere-cyst-input');
    if (!encoded || encoded.length > 12_288 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw rejected();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw rejected();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw rejected(); }
    const request = cystInputRequestSchema.parse(value);
    if (request.body.action !== 'upload' || request.body.runId !== context.req.param('runId')
      || request.body.descriptor.operationId !== context.req.param('operationId')
      || context.req.header('content-type') !== 'application/octet-stream'
      || context.req.header('content-encoding') && context.req.header('content-encoding') !== 'identity'
      || context.req.header('content-length') !== String(request.body.descriptor.plaintextBytes)
      || !context.req.raw.body) throw rejected();
    return context.json(await agent.cystInput(request, context.req.raw.body, context.req.raw.signal));
  });
  return routes;
}
