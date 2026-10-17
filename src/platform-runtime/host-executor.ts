import { and, eq } from 'drizzle-orm';
import type { Database } from '../store.js';
import { HostKitClient, HostKitCommandExecutor, HostKitCpuExecutor, type HostKitObserver } from '../host-kit/client.js';
import { Problem, hashJson, randomId } from '../common.js';
import { admissionHash } from '../host-kit/admission.js';
import { hostMessageHash, leaseSchema, signedAckSchema, signedLeaseSchema, signedTickSchema, verifyHostMessage,
  type SignedHostLease, type SignedHostTick } from '../host-kit/protocol.js';
import { HostMeterVerifier } from '../host-kit/meter.js';
import { PAID_SESSION_ARGV, paidSessionPolicy, parsePaidSessionLease, type PaidSessionStatus } from '../host-kit/sessions/paid-protocol.js';
import { sessionCommandSchema, sessionEventSchema, type SessionEvent } from '../host-kit/sessions/types.js';
import { RunMeter } from '../runtime/meter.js';
import type { CpuRunResult, TickHandler } from '../runtime/types.js';
import { platformRunInputSchema, type PlatformHost, type PlatformRunInput } from './types.js';
import { platformHostLeases, platformRuns } from './schema.js';
import type { PlatformV2AdmissionHook } from '../receipts/platform-v2-admission.js';
import type { HostV2AdmissionEnvelope } from '../host-kit/v2-admission.js';
import { cystInputDescriptorHash, type CystInputDescriptor } from '../host-kit/sessions/cyst-input-protocol.js';
import { verifyDuplicateCystInput } from '../host-kit/sessions/cyst-input-stream.js';

/** Original signed lease and evidence are durable before a host receives admission/ACK. */
export class PlatformHostExecutor {
  private readonly activeSessions = new Map<string, { client: HostKitClient; lease: SignedHostLease }>();
  constructor(private readonly db: Database, private readonly clients: ReadonlyMap<string, HostKitClient>,
    private readonly v2Admission?: PlatformV2AdmissionHook) {}
  private client(host: PlatformHost) {
    const client = this.clients.get(host.hostId);
    if (!client || client.hostKey !== host.hostKey) throw new Error('Reviewed platform host transport is missing');
    return client;
  }
  capacityAvailable(host: PlatformHost, kind: 'one_shot' | 'session', cystInputBytes?: number): Promise<boolean> {
    return this.client(host).capacity(host.image, kind, cystInputBytes);
  }
  /** Return only the original fixed-policy paid-session lease. The caller must
   * independently authorize the Vault principal and check the onchain run. */
  async originalSessionLease(owner: string, host: PlatformHost, runId: string,
    expected: { quoteHash: `0x${string}`; admissionTx: `0x${string}`; maxCommands: number }) {
    const [row] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId));
    if (!row || row.owner !== owner.toLowerCase() || row.hostId !== host.hostId) {
      throw new Problem(404, 'platform_session_lease_missing', 'Original paid session lease is unavailable.');
    }
    const client = this.client(host);
    const { lease, payload } = parsePaidSessionLease(row.lease);
    if (!verifyHostMessage(client.control.publicKey, 'lease', lease) || row.leaseHash !== hostMessageHash(lease)
      || lease.body.owner !== row.owner || lease.body.runId !== runId || lease.body.hostKey !== host.hostKey
      || lease.body.image !== host.image || payload.quoteHash !== expected.quoteHash
      || payload.admissionTx !== expected.admissionTx
      || payload.spec.policy.maxCommands !== expected.maxCommands) {
      throw new Problem(409, 'platform_session_lease_changed', 'Original paid session lease differs from its admitted financial scope.');
    }
    return { hostId: host.hostId, controllerKey: client.control.publicKey,
      leaseHash: row.leaseHash, lease };
  }
  async optInPreemption(owner: string, host: PlatformHost, runId: string,
    expected: { quoteHash: `0x${string}`; admissionTx: `0x${string}`; maxCommands: number }, key: string) {
    const evidence = await this.originalSessionLease(owner, host, runId, expected);
    const accepted = await this.client(host).preemptionOptIn(evidence.lease, key);
    return { ...evidence, ...accepted };
  }
  async preemptionNotice(owner: string, host: PlatformHost, runId: string,
    expected: { quoteHash: `0x${string}`; admissionTx: `0x${string}`; maxCommands: number }) {
    const evidence = await this.originalSessionLease(owner, host, runId, expected);
    const meterLeaseHash = hostMessageHash({ body: evidence.lease.body, signature: '' });
    const [row] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId));
    let terminalTick: SignedHostTick | null = null;
    if (row?.cleanupConfirmed) {
      if (!row.ticks.length || row.ticks.length !== row.acknowledgments.length || row.ticks.length > 100) {
        throw new Error('Paid source terminal signed meter history is incomplete');
      }
      for (let index = 0; index < row.ticks.length; index++) {
        const tick = signedTickSchema.parse(row.ticks[index]), ack = signedAckSchema.parse(row.acknowledgments[index]);
        if (!verifyHostMessage(host.hostKey, 'tick', tick)
          || !verifyHostMessage(evidence.controllerKey, 'ack', ack)
          || tick.body.hostKey !== host.hostKey || tick.body.owner !== row.owner
          || tick.body.runId !== runId || tick.body.leaseHash !== meterLeaseHash
          || tick.body.sequence !== index
          || tick.body.previousHash !== (index ? hostMessageHash(row.ticks[index - 1]!) : null)
          || ack.body.hostKey !== host.hostKey || ack.body.runId !== runId
          || ack.body.leaseHash !== meterLeaseHash || ack.body.sequence !== index
          || ack.body.tickHash !== hostMessageHash(tick)
          || Math.abs(ack.body.acceptedAt - tick.body.timestamp) > 5000) {
          throw new Error('Paid source signed terminal meter history changed');
        }
        if (index === row.ticks.length - 1) terminalTick = tick;
      }
    }
    const [notice, optIn] = await Promise.all([this.client(host).preemptionNotice(evidence.lease),
      this.client(host).preemptionOptInEvidence(evidence.lease)]);
    if (notice.body.optInHash !== hostMessageHash(optIn)) {
      throw new Error('Host notice differs from the stored controller-signed owner opt-in');
    }
    return { ...evidence, notice, optIn, terminalTick };
  }
  async run(owner: string, host: PlatformHost, rawInput: PlatformRunInput, signal: AbortSignal, onTick: TickHandler,
    financial?: { quoteHash: `0x${string}`; admissionTx: `0x${string}` }): Promise<CpuRunResult> {
    const input = platformRunInputSchema.parse(rawInput);
    if (input.task.kind === 'exec' && (host.execEnabled !== true || host.imageDigest !== input.task.imageDigest)) throw new Error('Reviewed platform host does not allow this command image');
    if (input.task.kind === 'session' && (host.sessionEnabled !== true || host.imageDigest !== input.task.imageDigest || !financial)) {
      throw new Error('Reviewed platform host does not allow this paid session image or admission');
    }
    const client = this.client(host);
    let v2Envelope: HostV2AdmissionEnvelope | undefined;
    const discardUnadmittedLease = async (lease: SignedHostLease) => {
      await this.db.delete(platformHostLeases).where(and(
        eq(platformHostLeases.runId, input.runId),
        eq(platformHostLeases.leaseHash, hostMessageHash(lease)),
        eq(platformHostLeases.cleanupConfirmed, 0)));
    };
    const observer: HostKitObserver = {
      onLease: async raw => {
        const lease = signedLeaseSchema.parse(raw);
        if (!verifyHostMessage(client.control.publicKey, 'lease', lease) || lease.body.owner !== owner.toLowerCase()
          || lease.body.hostKey !== host.hostKey || lease.body.runId !== input.runId || lease.body.image !== host.image
          || lease.body.maxSeconds !== input.maxSeconds
          || input.task.kind === 'exec' && (hashJson(lease.body.argv) !== hashJson(input.task.argv)
            || (lease.body.stdin ?? '') !== (input.task.stdin ?? ''))) throw new Error('Platform host lease scope changed');
        if (input.task.kind === 'session') {
          const { payload } = parsePaidSessionLease(lease);
          if (!financial || payload.quoteHash !== financial.quoteHash || payload.admissionTx !== financial.admissionTx
            || payload.spec.policy.maxCommands !== input.task.maxCommands
            || (payload.resourceProfile ?? 'full') !== (input.task.resourceProfile ?? 'full')
            || hashJson(payload.spec.cystInput ?? null) !== hashJson(input.task.cystInput ?? null)
            || hashJson(payload.cpuScheduling ?? null) !== hashJson(input.cpuScheduling ?? null)) throw new Error('Platform paid session lease changed');
        }
        const rows = await this.db.insert(platformHostLeases).values({ runId: input.runId, hostId: host.hostId,
          owner: owner.toLowerCase(), lease, leaseHash: hostMessageHash(lease) }).onConflictDoNothing().returning();
        if (!rows.length) throw new Error('Platform host already has a durable lease; recover it instead of redispatching');
        // Optional v2 authority must be signed and durably read back before
        // HostKit receives its first admission. The v1 path remains unchanged.
        if (this.v2Admission) {
          try {
            const request = { owner, hostId: host.hostId, controllerKey: client.control.publicKey, lease };
            if (this.v2Admission.prepareHostAdmission) {
              v2Envelope = await this.v2Admission.prepareHostAdmission(request);
              if (v2Envelope && (!this.v2Admission.recordHostAdmission || !this.v2Admission.originalHostAdmission)) {
                throw new Error('Platform v2 host admission requires durable response and recovery journals');
              }
            } else await this.v2Admission.issueBeforeHostAdmission(request);
          } catch (error) {
            // No HostKit admission has happened yet. Remove only this exact
            // unadmitted lease so recovery does not try to stop an unknown run.
            await discardUnadmittedLease(lease);
            throw error;
          }
        }
        if (signal.aborted) {
          await discardUnadmittedLease(lease);
          signal.throwIfAborted();
        }
      },
      admit: async lease => {
        if (!v2Envelope) return client.admit(lease);
        if (hashJson(v2Envelope.lease) !== hashJson(lease)) throw new Error('Platform v2 original admission lease changed');
        const accepted = await client.admitV2(v2Envelope);
        await this.v2Admission!.recordHostAdmission!(v2Envelope, accepted.admission);
        return accepted.status;
      },
      onAdmissionSkipped: discardUnadmittedLease,
      onEvidence: async (rawTick, rawAck) => {
        const tick = signedTickSchema.parse(rawTick), ack = signedAckSchema.parse(rawAck);
        await this.db.transaction(async tx => {
          const [row] = await tx.select().from(platformHostLeases).where(eq(platformHostLeases.runId, input.runId)).for('update');
          if (!row || row.cleanupConfirmed || row.hostId !== host.hostId || row.owner !== owner.toLowerCase()
            || !verifyHostMessage(client.hostKey, 'tick', tick) || !verifyHostMessage(client.control.publicKey, 'ack', ack)
            || tick.body.sequence !== row.ticks.length || ack.body.sequence !== row.acknowledgments.length
            || tick.body.runId !== input.runId || ack.body.runId !== input.runId || tick.body.owner !== row.owner
            || tick.body.leaseHash !== hostMessageHash({ body: row.lease.body, signature: '' })
            || ack.body.leaseHash !== tick.body.leaseHash || ack.body.tickHash !== hostMessageHash(tick)) throw new Error('Platform host evidence changed');
          await tx.update(platformHostLeases).set({ ticks: [...row.ticks, tick], acknowledgments: [...row.acknowledgments, ack] })
            .where(eq(platformHostLeases.runId, input.runId));
        });
      },
    };
    const result = input.task.kind === 'session'
      ? await this.runSession(owner, host, input, client, observer, signal, onTick, financial!)
      : input.task.kind === 'exec'
      ? await new HostKitCommandExecutor(client, owner, host.image, observer).run({ runId: input.runId, maxSeconds: input.maxSeconds,
        argv: input.task.argv, ...(input.task.stdin === undefined ? {} : { stdin: input.task.stdin }) }, signal, onTick)
      : await new HostKitCpuExecutor(client, owner, host.image, observer).run({ runId: input.runId, maxSeconds: input.maxSeconds,
        task: input.task }, signal, onTick);
    const [row] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, input.runId));
    if (row && input.task.kind !== 'session') {
      const state = await client.command(row.lease, 'status');
      if (!state.cleanupConfirmed || ['starting', 'running'].includes(state.state)) throw new Error('Platform host cleanup is unconfirmed');
      await this.db.update(platformHostLeases).set({ cleanupConfirmed: 1 }).where(eq(platformHostLeases.runId, input.runId));
    }
    return result;
  }
  async recover(owner: string, host: PlatformHost, runId: string, maxSeconds: number): Promise<CpuRunResult | undefined> {
    const [row] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId));
    if (!row) return undefined;
    const client = this.client(host), lease = signedLeaseSchema.parse(row.lease);
    if (row.hostId !== host.hostId || row.owner !== owner.toLowerCase() || lease.body.owner !== row.owner
      || lease.body.runId !== runId || lease.body.hostKey !== host.hostKey || lease.body.image !== host.image
      || !verifyHostMessage(client.control.publicKey, 'lease', lease) || hostMessageHash(lease) !== row.leaseHash) throw new Error('Original platform host lease cannot be verified');
    const [run] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
    const v2 = run?.receiptVersion === 2 ? await this.v2Admission?.originalHostAdmission?.(runId) : undefined;
    if (run?.receiptVersion === 2 && (!v2 || !this.v2Admission?.recordHostAdmission
      || hashJson(v2.envelope.lease) !== hashJson(lease))) {
      throw new Error('Original Platform v2 host admission journal is required for recovery');
    }
    if (lease.body.argv.length === PAID_SESSION_ARGV.length
      && lease.body.argv.every((value, index) => value === PAID_SESSION_ARGV[index])) {
      parsePaidSessionLease(lease);
      const state = await client.sessionControl(lease, { action: 'stop' });
      return this.recoverSession(row, client, lease, state, maxSeconds);
    }
    const state = await client.command(lease, 'stop');
    if (!state.cleanupConfirmed || ['starting', 'running'].includes(state.state)) throw new Error('Original platform cell cleanup remains uncertain');
    if (v2 && !v2.admission) {
      // Stop must confirm that the original host run exists before retrying its
      // exact envelope. Otherwise a crash before the first POST could dispatch
      // never-started work during recovery. An admitted HostKit row returns its
      // immutable receipt without restarting the original bounded task.
      const accepted = await client.admitV2(v2.envelope);
      if (!accepted.status.cleanupConfirmed || ['starting', 'running'].includes(accepted.status.state)) {
        throw new Error('Recovered Platform v2 admission did not preserve confirmed cleanup');
      }
      await this.v2Admission!.recordHostAdmission!(v2.envelope, accepted.admission);
    }
    let replayTime = lease.body.issuedAt;
    const meter = new HostMeterVerifier(lease.body, client.control, () => replayTime);
    for (let index = 0; index < row.ticks.length; index++) {
      const tick = row.ticks[index], ack = row.acknowledgments[index];
      if (!tick || !ack || !verifyHostMessage(client.control.publicKey, 'ack', ack)) throw new Error('Persisted platform acknowledgement is invalid');
      replayTime = ack.body.acceptedAt;
      if (hostMessageHash(meter.accept(tick)) !== hostMessageHash(ack)
        || !state.ticks.some(value => hostMessageHash(value) === hostMessageHash(tick))) throw new Error('Persisted platform host evidence cannot be replayed');
    }
    const standard = new RunMeter(runId, maxSeconds);
    // Recovery never executes the task again. Charge only the controller's already persisted paired evidence.
    const status = state.state === 'completed' ? 'completed' : state.state === 'timed_out' ? 'timed_out' : 'cancelled';
    await standard.emit(status, meter.billableSeconds * 1000, state.output); await standard.flush();
    await this.db.update(platformHostLeases).set({ cleanupConfirmed: 1 }).where(eq(platformHostLeases.runId, runId));
    return { status, billableSeconds: meter.billableSeconds, output: state.output, exitCode: state.exitCode, ticks: standard.ticks };
  }

  private async sessionEvents(client: HostKitClient, lease: SignedHostLease, initial: PaidSessionStatus): Promise<SessionEvent[]> {
    if (['starting', 'running'].includes(initial.state) || !initial.cleanupConfirmed) throw new Error('Paid session cleanup is unconfirmed');
    const events: SessionEvent[] = [];
    let state = initial;
    while (events.length < initial.eventCount) {
      state = await client.sessionControl(lease, { action: 'status', afterSequence: events.length - 1, limit: 8 });
      if (state.eventCount !== initial.eventCount || state.eventsHash !== initial.eventsHash
        || !state.cleanupConfirmed || ['starting', 'running'].includes(state.state) || !state.events.length) {
        throw new Error('Paid session event history changed');
      }
      for (const event of state.events) {
        if (event.sequence !== events.length || events.length >= initial.eventCount) throw new Error('Paid session event sequence changed');
        events.push(event);
      }
    }
    if (hashJson({ protocol: 'telomere-paid-session-events-v1', events }) !== initial.eventsHash) {
      throw new Error('Paid session event history hash changed');
    }
    return events;
  }

  private async storeSessionTerminal(runId: string, client: HostKitClient, lease: SignedHostLease,
    state: PaidSessionStatus): Promise<string> {
    const events = await this.sessionEvents(client, lease, state);
    await this.db.update(platformHostLeases).set({ sessionEvents: events, cleanupConfirmed: 1 })
      .where(eq(platformHostLeases.runId, runId));
    return hashJson({ protocol: 'telomere-paid-session-events-v1', events });
  }

  private sessionOutcome(state: PaidSessionStatus): CpuRunResult['status'] {
    return state.state === 'stopped' ? 'cancelled' : state.state === 'expired' ? 'timed_out'
      : state.state === 'completed' ? 'completed' : 'failed';
  }

  private async runSession(owner: string, host: PlatformHost, input: PlatformRunInput, client: HostKitClient,
    observer: HostKitObserver, signal: AbortSignal, onTick: TickHandler,
    financial: { quoteHash: `0x${string}`; admissionTx: `0x${string}` }): Promise<CpuRunResult> {
    if (input.task.kind !== 'session') throw new Error('Expected a paid session task');
    const standard = new RunMeter(input.runId, input.maxSeconds, onTick);
    if (signal.aborted) {
      await standard.emit('cancelled', 0, ''); await standard.flush();
      return { status: 'cancelled', billableSeconds: 0, output: '', exitCode: -1, ticks: standard.ticks };
    }
    const now = Date.now(), spec = { version: 1 as const, sessionId: input.runId, image: host.image,
      lifetimeSeconds: input.maxSeconds, policy: paidSessionPolicy(input.task.maxCommands, input.task.resourceProfile),
      ...(input.task.cystInput ? { cystInput: input.task.cystInput } : {}) };
    const body = leaseSchema.parse({ version: 1, hostKey: client.hostKey, runId: input.runId, owner: owner.toLowerCase(), image: host.image,
      argv: [...PAID_SESSION_ARGV], stdin: JSON.stringify({ spec, quoteHash: financial.quoteHash, admissionTx: financial.admissionTx,
        ...(input.task.resourceProfile === undefined ? {} : { resourceProfile: input.task.resourceProfile }),
        ...(input.cpuScheduling ? { cpuScheduling: input.cpuScheduling } : {}) }),
      issuedAt: now, expiresAt: now + input.maxSeconds * 1000, maxSeconds: input.maxSeconds, nonce: randomId() });
    const lease = client.control.sign('lease', body), meter = new HostMeterVerifier(body, client.control);
    await observer.onLease(lease);
    if (signal.aborted) {
      await observer.onAdmissionSkipped?.(lease);
      signal.throwIfAborted();
    }
    let state: PaidSessionStatus, sequence = 0;
    try {
      state = await client.sessionAdmit(lease);
      // The init process may start, but no application command or billable ACK
      // is enabled until the host durably accepts this signed owner consent.
      if (input.cpuScheduling?.lane === 'interruptible') {
        if (!host.interruptible || !input.cpuScheduling.interruptibleConsent) throw new Error('Reviewed interruptible capability is required');
        await client.preemptionOptIn(lease, 'cpu-lane-v1:' + financial.quoteHash);
      }
    }
    catch (error) { try { await client.sessionControl(lease, { action: 'stop' }); } catch { /* Startup uncertainty is recovered by the original lease. */ } throw error; }
    this.activeSessions.set(input.runId, { client, lease });
    try {
      for (;;) {
        if (signal.aborted && ['starting', 'running'].includes(state.state)) state = await client.sessionControl(lease, { action: 'stop' });
        for (const tick of state.ticks.slice(sequence)) {
          const ack = meter.accept(tick);
          await observer.onEvidence(tick, ack);
          if (tick.body.state === 'RUNNING') await standard.emit('running', meter.billableSeconds * 1000);
          try { state = await client.sessionControl(lease, { action: 'ack', ack }); }
          catch (error) {
            state = await client.sessionControl(lease, { action: 'status' });
            if (!state.acks.some(recorded => hostMessageHash(recorded) === hostMessageHash(ack))) throw error;
          }
          sequence++;
        }
        if (state.ticks.length > sequence) continue;
        if (!['starting', 'running'].includes(state.state)) break;
        if (meter.missing()) { await client.sessionControl(lease, { action: 'stop' }); throw new Error('Paid session missed three meter ticks'); }
        await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 250); signal.addEventListener('abort', done, { once: true }); });
        state = await client.sessionControl(lease, { action: 'status' });
      }
      if (!state.cleanupConfirmed) throw new Error('Paid session resource cleanup is unconfirmed');
      const output = await this.storeSessionTerminal(input.runId, client, lease, state);
      const status = this.sessionOutcome(state);
      await standard.emit(status, meter.billableSeconds * 1000, output); await standard.flush();
      return { status, billableSeconds: meter.billableSeconds, output, exitCode: status === 'completed' ? 0 : -1, ticks: standard.ticks };
    } catch (error) {
      try { await client.sessionControl(lease, { action: 'stop' }); } catch { /* Original-lease recovery remains mandatory. */ }
      throw error;
    } finally { this.activeSessions.delete(input.runId); }
  }

  async cystInputStatus(owner: string, host: PlatformHost, runId: string,
    expected: { quoteHash: `0x${string}`; admissionTx: `0x${string}`; maxCommands: number }, descriptor: CystInputDescriptor) {
    const evidence = await this.originalSessionLease(owner, host, runId, expected);
    const { payload } = parsePaidSessionLease(evidence.lease);
    if (!payload.spec.cystInput || cystInputDescriptorHash(payload.spec.cystInput) !== cystInputDescriptorHash(descriptor)) {
      throw new Error('The paid Cyst input differs from its original signed lease');
    }
    return this.client(host).cystInputControl(evidence.lease, 'status');
  }
  /** Staging and final visibility are separate signed operations. The caller
   * rechecks current registry/payment authority after the network upload.
   */
  async transferCystInput(runId: string, descriptor: CystInputDescriptor, input: ReadableStream<Uint8Array>,
    signal: AbortSignal, beforeCommit: () => Promise<void>) {
    const active = this.activeSessions.get(runId);
    if (!active) { await input.cancel(); throw new Error('The original paid CPU session is not active'); }
    const { payload } = parsePaidSessionLease(active.lease);
    if (!payload.spec.cystInput || cystInputDescriptorHash(payload.spec.cystInput) !== cystInputDescriptorHash(descriptor)) {
      await input.cancel(); throw new Error('The paid file differs from its original signed lease');
    }
    let result = await active.client.cystInputControl(active.lease, 'status');
    const assertActive = () => {
      if (this.activeSessions.get(runId) !== active || Date.now() >= active.lease.body.expiresAt) {
        throw new Error('The original paid file lease changed during its duplicate transfer');
      }
    };
    const remaining = active.lease.body.expiresAt - Date.now();
    if (remaining <= 0) { await input.cancel(); throw new Error('The original paid file lease expired'); }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    if (result.body.state === 'waiting') result = await active.client.cystInputUpload(active.lease, input, bounded);
    else if (result.body.state === 'staged' || result.body.state === 'ready') await verifyDuplicateCystInput(input, descriptor, bounded, assertActive);
    else { await input.cancel(); throw new Error('The original paid file spool is no longer active'); }
    if (result.body.state !== 'staged' && result.body.state !== 'ready') throw new Error('The paid file did not reach verified staging');
    await beforeCommit(); signal.throwIfAborted();
    bounded.throwIfAborted(); assertActive();
    if (result.body.state === 'ready' && result.body.committed) return result;
    result = await active.client.cystInputControl(active.lease, 'commit');
    if (result.body.state !== 'ready' || !result.body.committed) throw new Error('The paid file was not atomically published');
    return result;
  }
  async command(runId: string, raw: unknown) {
    const active = this.activeSessions.get(runId);
    if (!active) throw new Error('Paid session is not active on its original controller');
    const command = sessionCommandSchema.parse(raw);
    const state = await active.client.sessionControl(active.lease, { action: 'execute', command });
    if (!state.command || hashJson(state.command.command) !== hashJson(command)
      || state.command.inputHash !== admissionHash(command)) throw new Error('Paid session command response changed');
    return state.command;
  }

  /** A terminal retry reads only the original signed host lease and retained command journal. */
  async replayCommand(owner: string, host: PlatformHost, runId: string, raw: unknown,
    expected: { eventHash: string; quoteHash: string; admissionTx: string }) {
    const command = sessionCommandSchema.parse(raw);
    const [row] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId));
    if (!row?.cleanupConfirmed || !row.sessionEvents) {
      throw new Problem(409, 'platform_session_unavailable', 'Paid session terminal history is unavailable.');
    }
    const client = this.client(host), lease = signedLeaseSchema.parse(row.lease);
    const { payload } = parsePaidSessionLease(lease);
    if (row.hostId !== host.hostId || row.owner !== owner.toLowerCase() || lease.body.owner !== row.owner
      || lease.body.runId !== runId || lease.body.hostKey !== host.hostKey || lease.body.image !== host.image
      || !verifyHostMessage(client.control.publicKey, 'lease', lease) || hostMessageHash(lease) !== row.leaseHash
      || payload.quoteHash !== expected.quoteHash || payload.admissionTx !== expected.admissionTx) {
      throw new Problem(409, 'platform_session_history_changed', 'The original paid session lease changed.');
    }
    const history = sessionEventSchema.array().max(4096).parse(row.sessionEvents);
    if (history.some((event, index) => event.sequence !== index) || history.at(-1)?.kind !== 'session_exit'
      || hashJson({ protocol: 'telomere-paid-session-events-v1', events: history }) !== expected.eventHash) {
      throw new Problem(409, 'platform_session_history_changed', 'Paid session events differ from their receipt.');
    }
    if (!history.some(event => event.kind === 'command_exit' && event.commandId === command.commandId)) {
      throw new Problem(409, 'platform_session_inactive', 'The command was not accepted before session expiry.');
    }
    const signed = await client.sessionControl(lease, { action: 'execute', command });
    const result = signed.command;
    if (!signed.cleanupConfirmed || ['starting', 'running'].includes(signed.state)
      || signed.eventCount !== history.length || signed.eventsHash !== expected.eventHash
      || !result || hashJson(result.command) !== hashJson(command) || result.inputHash !== admissionHash(command)) {
      throw new Problem(409, 'platform_session_history_changed', 'Signed command replay differs from terminal history.');
    }
    const related = history.filter(event => event.commandId === command.commandId);
    const exits = related.filter(event => event.kind === 'command_exit');
    if (exits.length !== 1 || exits[0]?.exitCode !== result.exitCode || exits[0]?.reason !== result.reason
      || related.filter(event => event.kind === 'output' && event.stream === 'stdout').map(event => event.text ?? '').join('') !== result.stdout
      || related.filter(event => event.kind === 'output' && event.stream === 'stderr').map(event => event.text ?? '').join('') !== result.stderr) {
      throw new Problem(409, 'platform_session_history_changed', 'Command result differs from receipt-bound events.');
    }
    return result;
  }

  async events(runId: string, afterSequence: number, limit: number) {
    const active = this.activeSessions.get(runId);
    if (!active) throw new Error('Paid session is not active on its original controller');
    const state = await active.client.sessionControl(active.lease, { action: 'status', afterSequence, limit });
    return { events: state.events, nextSequence: state.nextSequence, eventCount: state.eventCount, state: state.state };
  }

  private async recoverSession(row: typeof platformHostLeases.$inferSelect, client: HostKitClient,
    lease: SignedHostLease, state: PaidSessionStatus, maxSeconds: number): Promise<CpuRunResult> {
    if (!state.cleanupConfirmed || ['starting', 'running'].includes(state.state)) throw new Error('Original paid session cleanup remains uncertain');
    let replayTime = lease.body.issuedAt;
    const meter = new HostMeterVerifier(lease.body, client.control, () => replayTime);
    if (row.ticks.length !== row.acknowledgments.length) throw new Error('Original paid session has unpaired signed evidence');
    for (let index = 0; index < row.ticks.length; index++) {
      const tick = row.ticks[index], ack = row.acknowledgments[index];
      if (!tick || !ack || !verifyHostMessage(client.control.publicKey, 'ack', ack)) throw new Error('Persisted paid session acknowledgement is invalid');
      replayTime = ack.body.acceptedAt;
      if (hostMessageHash(meter.accept(tick)) !== hostMessageHash(ack)
        || !state.ticks.some(value => hostMessageHash(value) === hostMessageHash(tick))) throw new Error('Paid session evidence cannot be replayed');
    }
    const output = await this.storeSessionTerminal(row.runId, client, lease, state), status = this.sessionOutcome(state);
    const standard = new RunMeter(row.runId, maxSeconds);
    await standard.emit(status, meter.billableSeconds * 1000, output); await standard.flush();
    return { status, billableSeconds: meter.billableSeconds, output, exitCode: status === 'completed' ? 0 : -1, ticks: standard.ticks };
  }
}
