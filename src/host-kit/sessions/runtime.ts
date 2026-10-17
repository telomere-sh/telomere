import { createHash } from 'node:crypto';
import { canonical } from '../../common.js';
import { sessionCommandSchema, sessionFrameSchema, sessionRecordSchema, sessionSpecSchema, SessionRuntimeError,
  type SessionBackend, type SessionCommand, type SessionCommandResult, type SessionEvent, type SessionFrame,
  type SessionJournal, type SessionProcess, type SessionRecord, type SessionSpec } from './types.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const active = (value: SessionCommandResult) => ['queued', 'starting', 'running'].includes(value.state);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A durable command may outlive a disconnected caller.
  void promise.catch(() => undefined); return { promise, resolve, reject };
}
type Waiter = ReturnType<typeof deferred<SessionCommandResult>>;
type Output = { stdout: TextDecoder; stderr: TextDecoder; invalid: boolean };

/** Bounded persistent CPU-session primitive. No HTTP authority, metering,
 * receipt settlement, migration or owner-key release is supplied here. */
export class SessionRuntime {
  private record!: SessionRecord;
  private process: SessionProcess | undefined;
  private startFlight: Promise<SessionProcess> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly ready = deferred<void>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly output = new Map<string, Output>();
  private readonly consumers = new Set<() => void>();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private stopFlight: Promise<void> | undefined;
  private pendingFrames = 0;
  private receivedOutputFrames = 0;
  private receivedOutputBytes = 0;
  private receivedFrames = 0;
  private inputFault = false;
  private journalFailure: SessionRuntimeError | undefined;
  private durableEvents: SessionEvent[] = [];
  private durableState: SessionRecord['state'] = 'starting';
  private heartbeat: { sequence: number; elapsedMs: number; receivedAtMs: number } | undefined;
  private constructor(readonly spec: SessionSpec, private readonly backend: SessionBackend, private readonly journal: SessionJournal) {}
  static async open(options: { spec: SessionSpec; backend: SessionBackend; journal: SessionJournal; reviewedImages: ReadonlySet<string> }): Promise<SessionRuntime> {
    let spec: SessionSpec;
    try { spec = sessionSpecSchema.parse(options.spec); } catch { throw new SessionRuntimeError('invalid_session'); }
    if (!options.reviewedImages.has(spec.image)) throw new SessionRuntimeError('invalid_session');
    const runtime = new SessionRuntime(spec, options.backend, options.journal), stored = await options.journal.load();
    if (stored) {
      runtime.record = runtime.checked(stored);
      runtime.durableEvents = structuredClone(runtime.record.events);
      runtime.durableState = runtime.record.state;
      if (!runtime.record.cleanupConfirmed) {
        try {
          await options.backend.cleanup(spec);
          for (const command of runtime.record.commands) if (active(command)) { command.state = 'uncertain'; command.reason = 'recovered'; command.exitCode = -1; }
          runtime.record.state = 'fault'; runtime.record.reason = 'recovered'; runtime.record.cleanupConfirmed = true;
          runtime.event({ kind: 'session_exit', reason: 'recovered' }); await runtime.persist();
        } catch { throw new SessionRuntimeError('session_cleanup_uncertain'); }
      }
      return runtime;
    }
    runtime.record = { version: 1, spec, backend: { isolation: options.backend.isolation, identity: options.backend.identity }, specHash: digest(spec), state: 'starting', reason: '', initPid: null,
      commands: [], events: [], outputBytes: 0, outputFrames: 0, cleanupConfirmed: false };
    await runtime.persist();
    // The host budget includes startup. A late backend handle remains owned
    // even if a fault or expiry arrives before start() returns it.
    runtime.deadline = setTimeout(() => runtime.fail('expired'), spec.lifetimeSeconds * 1000);
    runtime.startFlight = Promise.resolve().then(() => options.backend.start(spec, value => runtime.receive(value), reason => runtime.fail(reason ?? 'transport_fault')))
      .then(handle => { runtime.process = handle;
        void handle.closed.then(() => { if (!runtime.stopping) runtime.fail('transport_fault'); }); return handle; });
    try {
      await runtime.startFlight;
      if (runtime.stopping) { await runtime.stop(); throw new SessionRuntimeError('session_unavailable'); }
      const watchStarted = performance.now();
      runtime.watchdog = setInterval(() => {
        if (performance.now() - (runtime.heartbeat?.receivedAtMs ?? watchStarted) > 5000) runtime.fail('transport_fault');
      }, 1000);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([runtime.ready.promise, new Promise<never>((_yes, no) => { timeout = setTimeout(() => no(new SessionRuntimeError('session_unavailable')), 5000); })]); }
      finally { clearTimeout(timeout); }
      return runtime;
    } catch {
      await runtime.stop('transport_fault').catch(() => undefined); throw new SessionRuntimeError('session_unavailable');
    }
  }
  private checked(raw: SessionRecord): SessionRecord {
    try {
      const value = sessionRecordSchema.parse(raw);
      if (value.specHash !== digest(this.spec) || digest(value.spec) !== value.specHash) throw new SessionRuntimeError('session_conflict');
      if (value.backend.identity !== this.backend.identity || value.backend.isolation !== this.backend.isolation) throw new SessionRuntimeError('session_conflict');
      if (value.commands.length > this.spec.policy.maxCommands || value.outputBytes > this.spec.policy.maxSessionOutputBytes
        || value.outputFrames > this.spec.policy.maxOutputFrames || value.events.some((event, index) => event.sequence !== index)
        || new Set(value.commands.map(command => command.command.commandId)).size !== value.commands.length
        || value.commands.some(command => command.inputHash !== digest(command.command) || command.outputBytes > this.spec.policy.maxOutputBytesPerCommand)
        || value.cleanupConfirmed && ['starting', 'running'].includes(value.state)) throw new SessionRuntimeError('session_journal_invalid');
      return value;
    } catch (error) { throw error instanceof SessionRuntimeError ? error : new SessionRuntimeError('session_journal_invalid'); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.then(() => undefined, () => undefined); return next;
  }
  private event(value: Omit<SessionEvent, 'sequence'>): void {
    if (this.record.events.length >= 4096) throw new SessionRuntimeError('session_unavailable');
    this.record.events.push({ ...value, sequence: this.record.events.length });
  }
  private async persist(): Promise<void> {
    const snapshot = this.checked(this.record);
    try { await this.journal.save(snapshot); }
    catch {
      this.journalFailure = new SessionRuntimeError('session_journal_invalid');
      for (const wake of this.consumers) wake();
      throw this.journalFailure;
    }
    this.durableEvents = structuredClone(snapshot.events);
    this.durableState = snapshot.state;
    for (const wake of this.consumers) wake();
  }
  private fail(reason: 'transport_fault' | 'expired' | 'journal_fault' | 'output_limit'): void {
    void this.stop(reason).catch(error => { this.ready.reject(error); for (const waiter of this.waiters.values()) waiter.reject(error); });
  }
  private receive(value: unknown): void {
    if (this.stopping || this.inputFault) return;
    let frame: SessionFrame;
    try {
      frame = sessionFrameSchema.parse(value);
      if (++this.receivedFrames > this.spec.policy.maxOutputFrames + this.spec.policy.maxCommands * 2 + 256 || this.pendingFrames >= 128) throw new SessionRuntimeError('session_unavailable');
      if (frame.kind === 'output') {
        const bytes = Buffer.from(frame.data, 'base64');
        if (bytes.toString('base64') !== frame.data || bytes.length > 4096
          || ++this.receivedOutputFrames > this.spec.policy.maxOutputFrames
          || (this.receivedOutputBytes += bytes.length) > this.spec.policy.maxSessionOutputBytes) throw new SessionRuntimeError('session_unavailable');
      }
    } catch { this.inputFault = true; this.fail('transport_fault'); return; }
    this.pendingFrames++;
    void this.serial(async () => {
      if (this.stopping || !['starting', 'running'].includes(this.record.state)) return;
      await this.frame(frame);
    }).catch(() => this.fail('transport_fault')).finally(() => { this.pendingFrames--; });
  }
  private async frame(frame: SessionFrame): Promise<void> {
    if (frame.kind === 'ready') {
      if (this.record.state !== 'starting' || this.record.initPid !== null) throw new SessionRuntimeError('session_unavailable');
      this.record.initPid = frame.pid; this.record.state = 'running'; this.event({ kind: 'ready' }); await this.persist(); this.ready.resolve(); return;
    }
    if (frame.kind === 'heartbeat') {
      if (this.record.state !== 'running' || frame.sequence !== (this.heartbeat?.sequence ?? -1) + 1
        || frame.elapsedMs < (this.heartbeat?.elapsedMs ?? 0) || frame.elapsedMs > this.spec.lifetimeSeconds * 1000 + 2000) throw new SessionRuntimeError('session_unavailable');
      this.heartbeat = { ...frame, receivedAtMs: performance.now() }; return;
    }
    if (frame.kind === 'stopped') throw new SessionRuntimeError('session_unavailable');
    const command = this.record.commands.find(value => value.command.commandId === frame.commandId);
    if (!command || !['starting', 'running'].includes(command.state)) throw new SessionRuntimeError('session_unavailable');
    if (frame.kind === 'started') {
      if (command.state !== 'starting') throw new SessionRuntimeError('session_unavailable');
      command.state = 'running'; this.event({ kind: 'started', commandId: frame.commandId }); await this.persist(); return;
    }
    const output = this.output.get(frame.commandId);
    if (!output) throw new SessionRuntimeError('session_unavailable');
    if (frame.kind === 'output') {
      if (command.state !== 'running') throw new SessionRuntimeError('session_unavailable');
      const bytes = Buffer.from(frame.data, 'base64');
      if (bytes.toString('base64') !== frame.data || bytes.length > 4096 || command.outputBytes + bytes.length > this.spec.policy.maxOutputBytesPerCommand
        || this.record.outputBytes + bytes.length > this.spec.policy.maxSessionOutputBytes || this.record.outputFrames >= this.spec.policy.maxOutputFrames) throw new SessionRuntimeError('session_unavailable');
      command.outputBytes += bytes.length; this.record.outputBytes += bytes.length; this.record.outputFrames++;
      if (!output.invalid) {
        try {
          const text = output[frame.stream].decode(bytes, { stream: true });
          if (text.includes('\0')) throw new Error('invalid_output');
          command[frame.stream] += text; this.event({ kind: 'output', commandId: frame.commandId, stream: frame.stream, text });
        } catch { output.invalid = true; command.reason = 'invalid_output'; await this.process?.send({ kind: 'cancel', commandId: frame.commandId }); }
      }
      await this.persist(); return;
    }
    try { for (const stream of ['stdout', 'stderr'] as const) {
      const text = output[stream].decode(); if (text.includes('\0')) throw new Error('invalid_output');
      if (text) { command[stream] += text; this.event({ kind: 'output', commandId: frame.commandId, stream, text }); }
    } } catch { output.invalid = true; }
    command.exitCode = output.invalid ? -1 : frame.exitCode;
    command.state = !output.invalid && frame.reason === 'exited' && frame.exitCode === 0 ? 'completed'
      : frame.reason === 'cancelled' && !output.invalid ? 'cancelled' : 'failed';
    command.reason = output.invalid ? 'invalid_output' : frame.reason;
    this.event({ kind: 'command_exit', commandId: frame.commandId, exitCode: command.exitCode, reason: command.reason });
    await this.persist(); this.output.delete(frame.commandId); this.waiters.get(frame.commandId)?.resolve(structuredClone(command));
    await this.dispatch();
  }
  private async dispatch(): Promise<void> {
    if (!this.process || this.stopping || this.record.state !== 'running'
      || this.record.commands.some(command => ['starting', 'running'].includes(command.state))) return;
    const command = this.record.commands.find(value => value.state === 'queued'); if (!command) return;
    command.state = 'starting'; await this.persist();
    this.output.set(command.command.commandId, { stdout: new TextDecoder('utf-8', { fatal: true }), stderr: new TextDecoder('utf-8', { fatal: true }), invalid: false });
    await this.process.send({ kind: 'execute', command: command.command });
  }
  async execute(raw: SessionCommand): Promise<SessionCommandResult> {
    if (this.journalFailure) throw this.journalFailure;
    let command: SessionCommand;
    try { command = sessionCommandSchema.parse(raw); } catch { throw new SessionRuntimeError('invalid_session'); }
    const scheduled = await this.serial(async () => {
      if (this.journalFailure) throw this.journalFailure;
      const current = this.record.commands.find(value => value.command.commandId === command.commandId);
      if (current) {
        if (current.inputHash !== digest(command)) throw new SessionRuntimeError('command_conflict');
        if (!active(current)) return { result: structuredClone(current) };
        const waiter = this.waiters.get(command.commandId); if (!waiter) throw new SessionRuntimeError('session_unavailable'); return { pending: waiter.promise };
      }
      if (this.stopping || this.record.state !== 'running') throw new SessionRuntimeError('session_unavailable');
      if (this.record.commands.length >= this.spec.policy.maxCommands) throw new SessionRuntimeError('command_limit');
      const waiter = deferred<SessionCommandResult>(); this.waiters.set(command.commandId, waiter);
      this.record.commands.push({ command, inputHash: digest(command), state: 'queued', stdout: '', stderr: '', exitCode: -1, reason: '', outputBytes: 0 });
      try { await this.persist(); await this.dispatch(); }
      catch { this.fail('journal_fault'); waiter.reject(new SessionRuntimeError('session_unavailable')); throw new SessionRuntimeError('session_unavailable'); }
      return { pending: waiter.promise };
    });
    if (scheduled.result) return scheduled.result;
    if (!scheduled.pending) throw new SessionRuntimeError('session_unavailable'); return scheduled.pending;
  }
  status() { return { isolation: this.backend.isolation, ...structuredClone(this.record), journalAvailable: !this.journalFailure,
    heartbeat: this.heartbeat ? { ...this.heartbeat } : null }; }
  /** Only these events survived the journal save boundary. Signed host responses must use this snapshot. */
  durableHistory(): SessionEvent[] {
    if (this.journalFailure) throw this.journalFailure;
    return structuredClone(this.durableEvents);
  }
  async sample() {
    if (!this.process || this.record.state !== 'running') return { running: false, cpuMs: 0 };
    const value = await this.process.sample();
    if (!Number.isSafeInteger(value.cpuMs) || value.cpuMs < 0 || typeof value.running !== 'boolean') throw new SessionRuntimeError('session_unavailable'); return value;
  }
  readEvents(afterSequence = -1, limit = 128): SessionEvent[] {
    if (this.journalFailure) throw this.journalFailure;
    if (!Number.isInteger(afterSequence) || afterSequence < -1 || afterSequence >= this.durableEvents.length
      || !Number.isInteger(limit) || limit < 1 || limit > 128) throw new SessionRuntimeError('invalid_session');
    return structuredClone(this.durableEvents.slice(afterSequence + 1, afterSequence + 1 + limit));
  }
  async *events(afterSequence = -1, signal?: AbortSignal): AsyncGenerator<SessionEvent> {
    this.readEvents(afterSequence); let cursor = afterSequence;
    while (!signal?.aborted) {
      const values = this.readEvents(cursor);
      for (const value of values) { cursor = value.sequence; yield value; }
      if (!['starting', 'running'].includes(this.durableState) && cursor === this.durableEvents.length - 1) return;
      if (this.durableEvents.length - 1 > cursor) continue;
      await new Promise<void>(resolve => {
        const wake = () => { this.consumers.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
        this.consumers.add(wake); signal?.addEventListener('abort', wake, { once: true }); if (signal?.aborted) wake();
      });
    }
  }
  async stop(reason: 'requested' | 'expired' | 'transport_fault' | 'journal_fault' | 'output_limit' = 'requested'): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    if (this.record.cleanupConfirmed) return;
    this.stopping = true; clearTimeout(this.deadline); clearInterval(this.watchdog);
    // Resource termination starts immediately, independently from a blocked
    // journal/consumer queue. Durable terminal publication follows cleanup.
    const cleanupOperation = this.process ? this.process.stop() : this.startFlight
      ? (async () => {
        // Best-effort removal starts now. Definitive cleanup must also cover a
        // resource which is only returned after that first removal completed.
        const early = this.backend.cleanup(this.spec).catch(() => undefined);
        const final = this.startFlight!.then(handle => handle.stop(), () => this.backend.cleanup(this.spec));
        await Promise.all([early, final]);
      })() : this.backend.cleanup(this.spec);
    void cleanupOperation.catch(() => undefined);
    this.stopFlight = this.serial(async () => {
      let cleanup = false;
      try { await cleanupOperation; cleanup = true; }
      finally {
        this.record.cleanupConfirmed = cleanup; this.record.state = reason === 'expired' ? 'expired' : reason === 'requested' ? 'stopped' : 'fault';
        this.record.reason = reason;
        for (const command of this.record.commands) if (active(command)) { command.state = cleanup ? 'cancelled' : 'uncertain'; command.reason = reason; command.exitCode = -1;
          this.event({ kind: 'command_exit', commandId: command.command.commandId, exitCode: -1, reason }); }
        this.event({ kind: 'session_exit', reason });
        try { await this.persist(); for (const command of this.record.commands) this.waiters.get(command.command.commandId)?.resolve(structuredClone(command)); }
        catch { for (const waiter of this.waiters.values()) waiter.reject(new SessionRuntimeError('session_journal_invalid')); throw new SessionRuntimeError('session_journal_invalid'); }
        this.ready.reject(new SessionRuntimeError('session_unavailable')); if (!cleanup) throw new SessionRuntimeError('session_cleanup_uncertain');
      }
    });
    return this.stopFlight;
  }
}
