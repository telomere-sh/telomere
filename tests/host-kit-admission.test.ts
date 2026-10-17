import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../src/common.js';
import { admissionHash, type HostInventory, type HostScope } from '../src/host-kit/admission.js';
import { createHostKitRoutes, HostKitAgent } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { createHostedHostKit, createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { hostClaims, hostRuns, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage, type HostLease } from '../src/host-kit/protocol.js';
import type { HostCellRuntime, HostCell, InitHeartbeat } from '../src/host-kit/runtime.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import type { SessionBackend, SessionProcess, SessionSpec } from '../src/host-kit/sessions/types.js';

const control = new Ed25519Identity(), image = `fixture/admission@sha256:${'a'.repeat(64)}`;
const owner = '0x1111111111111111111111111111111111111111';
const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function until(predicate: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms; while (!await predicate()) { if (Date.now() >= end) throw new Error('Shared admission fixture timed out'); await pause(10); }
}
type Hosted = ReturnType<typeof createHostedHostKit>;
class OneShotFixture implements HostCellRuntime {
  readonly isolation = 'local_process_fixture' as const;
  readonly leases = new Map<string, HostLease>();
  readonly base = new LocalProcessFixtureRuntime('test-fixture-only');
  starts = 0; cleanups = 0;
  async initialize(key: string) { await this.base.initialize(key); }
  async cleanupOrphans(key: string) { this.cleanups++; const removed = await this.base.cleanupOrphans(key); this.leases.clear(); return removed; }
  async start(lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell> {
    this.starts++; this.leases.set(lease.runId, lease); const handle = await this.base.start(lease, heartbeat);
    return { ...handle, stop: async () => { await handle.stop(); this.leases.delete(lease.runId); } };
  }
}
class SessionFixture implements SessionBackend {
  readonly isolation = 'local_process_fixture' as const; readonly identity: string;
  readonly specs = new Map<string, SessionSpec>(); readonly base: LocalSessionFixtureBackend;
  starts = 0; cleanups = 0; held: ReturnType<typeof gate> | undefined; uncertainStop = false;
  constructor(directory: string) { this.base = new LocalSessionFixtureBackend(directory, 'test-fixture-only'); this.identity = this.base.identity; }
  async start(spec: SessionSpec, frame: (value: unknown) => void, fault: (reason?: 'output_limit') => void): Promise<SessionProcess> {
    this.starts++; await this.held?.promise; this.specs.set(spec.sessionId, spec); const handle = await this.base.start(spec, frame, fault);
    return { ...handle, stop: async () => { await handle.stop(); this.specs.delete(spec.sessionId); if (this.uncertainStop) throw new Error('uncertain cleanup fixture'); } };
  }
  async cleanup(spec: SessionSpec) {
    this.cleanups++;
    // This explicit local fixture inventory knows whether it created a process.
    // Production Docker cleanup independently verifies the exact resource.
    if (this.specs.has(spec.sessionId)) { await this.base.cleanup(spec); this.specs.delete(spec.sessionId); }
  }
}

describe('integrated durable shared CPU1 Host Kit admission', () => {
  let directory: string, journal: HostJournal, one: OneShotFixture, backend: SessionFixture, hosted: Hosted;
  const journals: HostJournal[] = [], hosts: Hosted[] = [], servers: Server[] = [], gates: Array<ReturnType<typeof gate>> = [];
  let extraInventory: HostInventory = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-host-admission-')); await mkdir(join(directory, 'cells'), { mode: 0o700 });
    one = new OneShotFixture(); backend = new SessionFixture(join(directory, 'cells')); extraInventory = [];
    journal = await openHostJournal(':memory:'); journals.push(journal); hosted = make(journal); hosts.push(hosted);
  });
  afterEach(async () => {
    gates.splice(0).forEach(value => value.release()); backend.held?.release(); vi.restoreAllMocks();
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    for (const value of journals.splice(0)) await value.close().catch(() => undefined);
    const owned = resolve(directory); if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-host-admission-')) throw new Error('Unexpected fixture directory');
    await rm(owned, { recursive: true, force: true });
  });
  function scope(value: HostJournal): HostScope { return { version: 1, hostKey: value.identity.publicKey, controlKey: control.publicKey,
    isolation: 'local_process_fixture', runtime: admissionHash(['actual-local-process-fixture', directory]), sessionBackend: backend.identity }; }
  function inventory(): Promise<HostInventory> { return Promise.resolve([
    ...[...one.leases.values()].map(value => ({ kind: 'oneshot' as const, resourceId: value.runId, image: value.image, name: 'local-run' })),
    ...[...backend.specs.values()].map(value => ({ kind: 'session' as const, resourceId: value.sessionId, image: value.image, name: 'local-session' })), ...extraInventory]); }
  function make(value: HostJournal, changed?: Partial<HostScope>, customInventory = inventory) { return createHostedHostKit({ journal: value, runtime: one, backend,
    controlKey: control.publicKey, reviewedImages: new Set([image]), scope: { ...scope(value), ...changed }, inventory: customInventory }); }
  function spec(sessionId = randomId()): SessionSpec { return { version: 1, sessionId, image, lifetimeSeconds: 20,
    policy: { version: 1, cpu: 1, memoryBytes: 268_435_456, pids: 64, temporaryBytes: 16_777_216, network: 'none', readOnlyRoot: true,
      maxCommands: 8, maxOutputBytesPerCommand: 16384, maxSessionOutputBytes: 65536, maxOutputFrames: 1024 } }; }
  function lease(runId: string = randomId()) { const now = Date.now(); return control.sign('lease', { version: 1 as const, hostKey: journal.identity.publicKey, runId,
    owner, image, issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId(), argv: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] }); }
  const command = (commandId: string, source: string) => ({ commandId, argv: [process.execPath, '-e', source] });
  async function http() {
    const server = createServer(getRequestListener(createHostKitRoutes(hosted.agent).fetch)); servers.push(server);
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP unavailable');
    const url = `http://127.0.0.1:${address.port}`;
    return { url, admit: (value = lease()) => fetch(url + '/v1/leases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) };
  }
  async function claims() { return journal.db.select().from(hostClaims); }
  async function stopRun(signed: ReturnType<typeof lease>) { await hosted.agent.control(control.sign('control', { version: 1, hostKey: journal.identity.publicKey,
    runId: signed.body.runId, owner, issuedAt: Date.now(), action: 'stop', nonce: randomId() })); }

  it('signs a fresh exact-image capacity hint from the durable CPU claim and rejects replay or tampering', async () => {
    const beforeNow = Date.now();
    const before = await hosted.agent.capacity(control.sign('capacity-challenge', { version: 1 as const,
      hostKey: journal.identity.publicKey, image, kind: 'one_shot' as const, nonce: randomId(),
      issuedAt: beforeNow, expiresAt: beforeNow + 5000 }));
    expect(before.body.available).toBe(false);
    await hosted.initialize(); const api = await http();
    const client = new HostKitClient(api.url, journal.identity.publicKey, control, true);
    expect(await client.capacity(image, 'one_shot')).toBe(true);
    await expect(new HostKitClient(api.url, journal.identity.publicKey, control).capacity(image, 'one_shot'))
      .rejects.toThrow('isolation');
    expect(await client.capacity(image, 'session')).toBe(false);
    expect(await client.capacity(`fixture/other@sha256:${'b'.repeat(64)}`, 'one_shot')).toBe(false);

    const now = Date.now(), challenge = control.sign('capacity-challenge', { version: 1 as const,
      hostKey: journal.identity.publicKey, image, kind: 'one_shot' as const, nonce: randomId(),
      issuedAt: now, expiresAt: now + 5000 });
    const signed = await hosted.agent.capacity(challenge);
    expect(verifyHostMessage(journal.identity.publicKey, 'capacity', signed)).toBe(true);
    expect(signed.body).toMatchObject({ hostKey: journal.identity.publicKey, image,
      nonce: challenge.body.nonce, available: true });
    await expect(hosted.agent.capacity({ ...challenge, body: { ...challenge.body, image: `fixture/other@sha256:${'b'.repeat(64)}` } }))
      .rejects.toMatchObject({ code: 'capacity_rejected' });
    await expect(hosted.agent.capacity(control.sign('capacity-challenge', { ...challenge.body,
      hostKey: new Ed25519Identity().publicKey }))).rejects.toMatchObject({ code: 'capacity_rejected' });
    await expect(hosted.agent.capacity(control.sign('capacity-challenge', { ...challenge.body,
      issuedAt: now - 10_000, expiresAt: now - 5000 }))).rejects.toMatchObject({ code: 'capacity_rejected' });
    const replay = new HostKitClient(api.url, journal.identity.publicKey, control, true,
      (async () => new Response(JSON.stringify(signed), { status: 200 })) as typeof fetch);
    await expect(replay.capacity(image, 'one_shot')).rejects.toThrow('binding');
    const tampered = new HostKitClient(api.url, journal.identity.publicKey, control, true,
      (async () => new Response(JSON.stringify({ ...signed, body: { ...signed.body, available: false } }), { status: 200 })) as typeof fetch);
    await expect(tampered.capacity(image, 'one_shot')).rejects.toThrow('signature');
    const stale = new HostKitClient(api.url, journal.identity.publicKey, control, true,
      (async (_url, init) => {
        const fresh = JSON.parse(String(init?.body)) as typeof challenge;
        const expiredAt = Date.now() - 1000;
        const expired = journal.identity.sign('capacity', { ...signed.body, nonce: fresh.body.nonce,
          challengeHash: hostMessageHash(fresh), issuedAt: expiredAt - 1000, expiresAt: expiredAt });
        return new Response(JSON.stringify(expired), { status: 200 });
      }) as typeof fetch);
    await expect(stale.capacity(image, 'one_shot')).rejects.toThrow('freshness');

    const running = lease(); expect((await api.admit(running)).status).toBe(201);
    expect((await claims()).length).toBe(1);
    expect(await client.capacity(image, 'one_shot')).toBe(false);
    await stopRun(running); await until(async () => (await claims()).length === 0);
    expect(await client.capacity(image, 'one_shot')).toBe(true);
    const session = await hosted.sessions.open(spec());
    const sessionNow = Date.now(), sessionStatus = await hosted.agent.capacity(control.sign('capacity-challenge', {
      version: 1 as const, hostKey: journal.identity.publicKey, image, kind: 'session' as const,
      nonce: randomId(), issuedAt: sessionNow, expiresAt: sessionNow + 5000 }), true);
    expect(sessionStatus.body.available).toBe(false);
    expect(await client.capacity(image, 'one_shot')).toBe(false);
    await session.stop(); await until(async () => (await claims()).length === 0);
    const releasedAt = Date.now(), released = await hosted.agent.capacity(control.sign('capacity-challenge', {
      version: 1 as const, hostKey: journal.identity.publicKey, image, kind: 'session' as const,
      nonce: randomId(), issuedAt: releasedAt, expiresAt: releasedAt + 5000 }), true);
    expect(released.body.available).toBe(true);
    await hosted.close(); expect(await client.capacity(image, 'one_shot')).toBe(false);
  });

  it('keeps both paths unavailable until both inventory passes and agent initialization finish', async () => {
    const held = gate(); gates.push(held); let inventories = 0;
    hosted = make(journal, undefined, async () => { inventories++; await held.promise; return []; }); hosts.push(hosted);
    const initializing = hosted.initialize(); await until(() => inventories === 1);
    expect(hosted.agent.identity().ready).toBe(false); expect(() => hosted.sessions.open(spec())).toThrow('host');
    const recoveringAt = Date.now(), recovering = await hosted.agent.capacity(control.sign('capacity-challenge', {
      version: 1 as const, hostKey: journal.identity.publicKey, image, kind: 'one_shot' as const,
      nonce: randomId(), issuedAt: recoveringAt, expiresAt: recoveringAt + 5000 }));
    expect(recovering.body.available).toBe(false);
    const api = await http(); expect((await api.admit()).status).toBe(503); expect(await claims()).toEqual([]);
    held.release(); await initializing; expect(inventories).toBe(2); expect(hosted.agent.identity().ready).toBe(true);
    const session = await hosted.sessions.open(spec()); await session.stop();
  });

  it('atomically persists the original signed HTTP lease before dispatch and excludes real sessions', async () => {
    await hosted.initialize(); const api = await http(), signed = lease(); let observed = false;
    const start = one.start.bind(one); vi.spyOn(one, 'start').mockImplementation(async (value, heartbeat) => {
      const [claim] = await claims(), [run] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, value.runId));
      expect(claim).toMatchObject({ kind: 'oneshot', original: signed, inputHash: admissionHash(signed), dispatchStarted: true });
      expect(run).toMatchObject({ state: 'starting', lease: signed, cleanupConfirmed: false }); observed = true; return start(value, heartbeat);
    });
    expect((await api.admit(signed)).status).toBe(201); expect(observed).toBe(true);
    const [claim] = await claims(); expect(claim).toMatchObject({ kind: 'oneshot', resourceId: signed.body.runId, inputHash: admissionHash(signed), original: signed });
    const requested = spec(); await expect(hosted.sessions.open(requested)).rejects.toMatchObject({ code: 'host_busy' }); expect(backend.starts).toBe(0);
    expect(await journal.db.select().from(hostSessions)).toEqual([]); await stopRun(signed); expect(await claims()).toEqual([]);
    const session = await hosted.sessions.open(requested); expect((await session.execute(command('actual', 'process.stdout.write("session-after-http")'))).stdout).toBe('session-after-http'); await session.stop();
  });

  it('holds a real session slot through idle, repeated commands and nonzero exit, blocking HTTP until full stop', async () => {
    await hosted.initialize(); const requested = spec(); let observed = false; const start = backend.start.bind(backend);
    vi.spyOn(backend, 'start').mockImplementation(async (value, frame, fault) => {
      const [claim] = await claims(), [row] = await journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, value.sessionId));
      expect(claim).toMatchObject({ kind: 'session', original: requested, inputHash: admissionHash(requested), dispatchStarted: true });
      expect(row!.record).toMatchObject({ state: 'starting', spec: requested, cleanupConfirmed: false }); observed = true; return start(value, frame, fault);
    });
    const session = await hosted.sessions.open(requested), api = await http(); expect(observed).toBe(true);
    expect((await claims())[0]).toMatchObject({ kind: 'session', original: requested, inputHash: admissionHash(requested) });
    expect((await session.execute(command('write', 'require("node:fs").writeFileSync("state","kept");process.exit(7)'))).exitCode).toBe(7);
    await pause(30); expect((await api.admit()).status).toBe(409);
    expect((await session.execute(command('read', 'process.stdout.write(require("node:fs").readFileSync("state","utf8"))'))).stdout).toBe('kept');
    expect(session.status().state).toBe('running'); await session.stop(); expect(await claims()).toEqual([]);
    const signed = lease(); expect((await api.admit(signed)).status).toBe(201); await stopRun(signed);
    expect((await fetch(api.url + '/v1/sessions')).status).toBe(404);
  });

  it.each(['oneshot', 'session'] as const)('serializes simultaneous actual HTTP and session entry when %s claims first', async first => {
    await hosted.initialize(); const api = await http(), requested = spec(), signed = lease();
    if (first === 'oneshot') {
      const entering = api.admit(signed); await until(() => one.starts === 1);
      await expect(hosted.sessions.open(requested)).rejects.toMatchObject({ code: 'host_busy' }); expect((await entering).status).toBe(201); await stopRun(signed);
    } else {
      backend.held = gate(); gates.push(backend.held); const opening = hosted.sessions.open(requested); await until(() => backend.starts === 1);
      expect((await api.admit(signed)).status).toBe(409); backend.held.release(); const session = await opening;
      expect((await session.execute(command('proof', 'process.stdout.write("real")'))).stdout).toBe('real'); await session.stop();
    }
    expect(await claims()).toEqual([]); expect(one.starts + backend.starts).toBe(1);
  });

  it('single-flights identical open IDs and rejects changed full policy before a second init', async () => {
    await hosted.initialize(); const requested = spec(); const a = hosted.sessions.open(requested), b = hosted.sessions.open(structuredClone(requested));
    expect(a).toBe(b); const session = await a; expect(backend.starts).toBe(1);
    expect(() => hosted.sessions.open({ ...requested, lifetimeSeconds: 19 })).toThrow('immutable'); await session.stop();
    expect(await hosted.sessions.open(requested)).toBe(session); expect(backend.starts).toBe(1);
  });

  it('does not let an old exact terminal save or changed callback release/fault a new HTTP tenant', async () => {
    await hosted.initialize(); const requested = spec(), session = await hosted.sessions.open(requested); await session.stop();
    const replay = await hosted.admission.session(requested), saved = (await replay.journal.load())!;
    const api = await http(), signed = lease(requested.sessionId); expect((await api.admit(signed)).status).toBe(201); const before = await claims();
    await replay.journal.save(structuredClone(saved)); await expect(replay.journal.save({ ...saved, reason: 'altered' })).rejects.toMatchObject({ code: 'session_conflict' });
    expect(await claims()).toEqual(before); expect(hosted.admission.available()).toBe(true); await stopRun(signed);
  });

  it('fences both paths when actual session cleanup is uncertain and retains its original claim', async () => {
    await hosted.initialize(); const session = await hosted.sessions.open(spec()), before = await claims(), pid = session.status().initPid!;
    backend.uncertainStop = true; await expect(session.stop()).rejects.toThrow('uncertain');
    expect(() => process.kill(pid, 0)).toThrow(); expect(await claims()).toEqual(before); expect(hosted.admission.available()).toBe(false);
    const api = await http(); expect((await api.admit()).status).toBe(503); expect(() => hosted.sessions.open(spec())).toThrow();
    expect(session.status().cleanupConfirmed).toBe(false);
  });

  it('holds capacity on a real database terminal-save failure after the session process is stopped', async () => {
    await hosted.initialize(); const session = await hosted.sessions.open(spec()), pid = session.status().initPid!;
    await journal.db.execute(sql.raw(`CREATE FUNCTION reject_session_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record->>'cleanupConfirmed' = 'true' THEN RAISE EXCEPTION 'fixture terminal unavailable'; END IF; RETURN NEW; END $$;`));
    await journal.db.execute(sql.raw('CREATE TRIGGER reject_session_terminal BEFORE UPDATE ON host_sessions FOR EACH ROW EXECUTE FUNCTION reject_session_terminal();'));
    await expect(session.stop()).rejects.toMatchObject({ code: 'session_journal_invalid' }); expect(() => process.kill(pid, 0)).toThrow();
    expect(await claims()).toHaveLength(1); expect(hosted.admission.available()).toBe(false);
    const api = await http(); expect((await api.admit()).status).toBe(503); expect(() => hosted.sessions.open(spec())).toThrow();
    await journal.db.execute(sql.raw('DROP TRIGGER reject_session_terminal ON host_sessions;')); await journal.db.execute(sql.raw('DROP FUNCTION reject_session_terminal();'));
  });

  it('synchronously closes both modes during a held actual session start and cleans the late returned process', async () => {
    await hosted.initialize(); backend.held = gate(); gates.push(backend.held); const requested = spec(), opening = hosted.sessions.open(requested);
    const failed = expect(opening).rejects.toBeDefined(); await until(() => backend.starts === 1); const closing = hosted.close();
    expect(hosted.agent.identity().ready).toBe(false); expect(() => hosted.sessions.open(spec())).toThrow();
    expect(await claims()).toHaveLength(1); backend.held.release(); await failed; await closing;
    expect(backend.specs.size).toBe(0); expect(await claims()).toEqual([]); expect((await journal.db.select().from(hostSessions))[0]!.record?.cleanupConfirmed).toBe(true);
  });

  it('durably publishes STOPPED and releases the exact claim when closing an active signed HTTP lease', async () => {
    await hosted.initialize(); const api = await http(), signed = lease(); expect((await api.admit(signed)).status).toBe(201);
    await hosted.close(); const [run] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, signed.body.runId));
    expect(run).toMatchObject({ state: 'cancelled', cleanupConfirmed: true }); expect(run!.ticks.at(-1)!.body.state).toBe('STOPPED');
    expect(await claims()).toEqual([]); expect(one.leases.size).toBe(0);
  });

  it('does not dispatch after a common close races the durable reservation response', async () => {
    await hosted.initialize(); const held = gate(), entered = gate(); gates.push(held, entered);
    const reserve = hosted.admission.reserveRun.bind(hosted.admission);
    vi.spyOn(hosted.admission, 'reserveRun').mockImplementation(async value => { const result = await reserve(value); entered.release(); await held.promise; return result; });
    const signed = lease(), admitting = hosted.agent.admit(signed); await entered.promise; expect(await claims()).toHaveLength(1);
    await hosted.sessions.close(); held.release(); expect(await admitting).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    expect(one.starts).toBe(0); expect(await claims()).toEqual([]); expect(hosted.agent.identity().ready).toBe(false);
  });

  it('does not dispatch a pending session when close arrives before its first durable record', async () => {
    await hosted.initialize(); const held = gate(), entered = gate(); gates.push(held, entered);
    const reserve = hosted.admission.session.bind(hosted.admission);
    vi.spyOn(hosted.admission, 'session').mockImplementation(async value => {
      const result = await reserve(value); return { ...result, journal: { load: () => result.journal.load(), save: async record => {
        if (record.state === 'starting') { entered.release(); await held.promise; } await result.journal.save(record);
      } } };
    });
    const opening = hosted.sessions.open(spec()), failed = expect(opening).rejects.toBeDefined(); await entered.promise;
    const closing = hosted.close(); expect(hosted.agent.identity().ready).toBe(false); held.release(); await failed; await closing;
    expect(backend.starts).toBe(0); expect(await claims()).toHaveLength(1); expect((await journal.db.select().from(hostSessions))[0]!.record).toBeNull();
  });

  it('recovers the durable reservation-to-first-record gap without dispatch', async () => {
    await journal.close(); journals.splice(journals.indexOf(journal), 1); journal = await openHostJournal(join(directory, 'disk')); journals.push(journal);
    hosted = make(journal); hosts.push(hosted); await hosted.initialize(); const requested = spec(); await hosted.admission.session(requested);
    expect((await journal.db.select().from(hostSessions))[0]!.record).toBeNull(); expect((await claims())[0]!.dispatchStarted).toBe(false); await journal.close(); journals.splice(journals.indexOf(journal), 1);
    journal = await openHostJournal(join(directory, 'disk')); journals.push(journal); hosted = make(journal); hosts.push(hosted); await hosted.initialize();
    expect(await claims()).toEqual([]); expect(backend.starts).toBe(0);
    const replay = await hosted.sessions.open(requested); expect(replay.status()).toMatchObject({ state: 'fault', reason: 'recovered', cleanupConfirmed: true }); expect(backend.starts).toBe(0);
  });

  it.each(['oneshot', 'session'] as const)('retains an ambiguous %s dispatched claim with no acknowledged start or observed resource', async kind => {
    await hosted.initialize(); let resourceId: string;
    if (kind === 'oneshot') {
      const signed = lease(), parsed = (await import('../src/host-kit/protocol.js')).signedLeaseSchema.parse(signed);
      const reserved = await hosted.admission.reserveRun(parsed); resourceId = signed.body.runId;
      await hosted.admission.markDispatch('oneshot', resourceId, reserved.token);
      await journal.db.update(hostRuns).set({ state: 'fault', cleanupConfirmed: false }).where(eq(hostRuns.runId, resourceId));
    } else {
      const requested = spec(), reserved = await hosted.admission.session(requested); resourceId = requested.sessionId;
      await reserved.journal.save({ version: 1, spec: requested, backend: { isolation: backend.isolation, identity: backend.identity }, specHash: admissionHash(requested),
        state: 'starting', reason: '', initPid: null, commands: [], events: [], outputBytes: 0, outputFrames: 0, cleanupConfirmed: false });
      await reserved.dispatch();
    }
    const before = await claims(), cleanups = one.cleanups + backend.cleanups; hosted.admission.closeAdmission();
    const replacement = make(journal); hosts.push(replacement); await expect(replacement.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
    expect(await claims()).toEqual(before); expect(before[0]).toMatchObject({ resourceId, dispatchStarted: true });
    expect(one.cleanups + backend.cleanups).toBe(cleanups); expect(one.starts + backend.starts).toBe(0);
  });

  it.each(['oneshot', 'session'] as const)('does not dispatch %s if its actual durable dispatch marker write fails', async kind => {
    await hosted.initialize();
    await journal.db.execute(sql.raw(`CREATE FUNCTION reject_dispatch_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.dispatch_started THEN RAISE EXCEPTION 'fixture marker unavailable'; END IF; RETURN NEW; END $$;`));
    await journal.db.execute(sql.raw('CREATE TRIGGER reject_dispatch_marker BEFORE UPDATE ON host_claims FOR EACH ROW EXECUTE FUNCTION reject_dispatch_marker();'));
    if (kind === 'oneshot') expect((await hosted.agent.admit(lease())).state).toBe('fault');
    else await expect(hosted.sessions.open(spec())).rejects.toBeDefined();
    expect(one.starts + backend.starts).toBe(0); expect(hosted.admission.available()).toBe(false);
    expect(one.cleanups).toBe(1); expect(backend.cleanups).toBe(0);
    await journal.db.execute(sql.raw('DROP TRIGGER reject_dispatch_marker ON host_claims;')); await journal.db.execute(sql.raw('DROP FUNCTION reject_dispatch_marker();'));
  });

  it('detects a changed live session original envelope before terminal save and keeps its claim', async () => {
    await hosted.initialize(); const requested = spec(), session = await hosted.sessions.open(requested), before = await claims();
    await journal.db.update(hostClaims).set({ original: { ...requested, lifetimeSeconds: 19 } }).where(eq(hostClaims.slot, 'cpu1'));
    await expect(session.stop()).rejects.toMatchObject({ code: 'session_journal_invalid' }); expect(await claims()).toHaveLength(1);
    expect(hosted.admission.available()).toBe(false); expect((await claims())[0]!.token).toBe(before[0]!.token);
  });

  it('reopens an actual disk journal, removes a live interrupted session and never reexecutes its command', async () => {
    await journal.close(); journals.splice(journals.indexOf(journal), 1); journal = await openHostJournal(join(directory, 'disk')); journals.push(journal);
    hosted = make(journal); hosts.push(hosted); await hosted.initialize(); const requested = spec(), session = await hosted.sessions.open(requested);
    const input = command('once', 'require("node:fs").appendFileSync("once","x");process.stdout.write("done")'); const result = await session.execute(input), pid = session.status().initPid!;
    await journal.close(); journals.splice(journals.indexOf(journal), 1); journal = await openHostJournal(join(directory, 'disk')); journals.push(journal);
    hosted = make(journal); hosts.push(hosted); const recovery = await hosted.initialize(); expect(recovery).toHaveProperty('recoveredSessions', [requested.sessionId]);
    expect(() => process.kill(pid, 0)).toThrow(); expect(await claims()).toEqual([]); const reopened = await hosted.sessions.open(requested);
    expect(await reopened.execute(input)).toEqual(result); expect(backend.starts).toBe(1); expect(reopened.status().state).toBe('fault');
  });

  it('recovers an interrupted actual one-shot from disk, retains signed evidence, and allows a new session', async () => {
    await journal.close(); journals.splice(journals.indexOf(journal), 1); journal = await openHostJournal(join(directory, 'disk')); journals.push(journal);
    hosted = make(journal); hosts.push(hosted); await hosted.initialize(); const signed = lease(); await hosted.agent.admit(signed);
    const [prior] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, signed.body.runId));
    await journal.close(); journals.splice(journals.indexOf(journal), 1); journal = await openHostJournal(join(directory, 'disk')); journals.push(journal);
    hosted = make(journal); hosts.push(hosted); const recovery = await hosted.initialize(); expect(recovery.faultedRuns).toEqual([signed.body.runId]);
    const [recovered] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, signed.body.runId));
    expect(recovered).toMatchObject({ state: 'fault', cleanupConfirmed: true, lease: signed, ticks: prior!.ticks, acks: prior!.acks, billableSeconds: prior!.billableSeconds });
    expect((await hosted.agent.admit(signed)).state).toBe('fault'); expect(one.starts).toBe(1); expect(await claims()).toEqual([]);
    const session = await hosted.sessions.open(spec()); expect((await session.execute(command('next', 'process.stdout.write("recovered-next")'))).stdout).toBe('recovered-next'); await session.stop();
  });

  it('refuses a tampered original claim before inventory cleanup can remove its live resource', async () => {
    await hosted.initialize(); const signed = lease(); await hosted.agent.admit(signed); const [original] = await claims(), before = one.cleanups;
    await journal.db.update(hostClaims).set({ original: { ...signed, body: { ...signed.body, nonce: randomId() } } }).where(eq(hostClaims.slot, 'cpu1'));
    const replacement = make(journal); hosts.push(replacement); await expect(replacement.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
    expect(one.cleanups).toBe(before); expect(one.leases.size).toBe(1);
    await journal.db.update(hostClaims).set({ original: original!.original }).where(eq(hostClaims.slot, 'cpu1')); await stopRun(signed);
  });

  it.each(['scope', 'unknown-one', 'unknown-session'] as const)('fails closed before any removal for %s startup contradiction', async mode => {
    await hosted.initialize(); hosted.admission.closeAdmission(); const before = one.cleanups;
    if (mode !== 'scope') extraInventory = [{ kind: mode === 'unknown-one' ? 'oneshot' : 'session', resourceId: randomId(), image, name: 'unknown' }];
    const replacement = make(journal, mode === 'scope' ? { runtime: 'changed-resource-scope' } : undefined); hosts.push(replacement);
    await expect(replacement.initialize()).rejects.toMatchObject({ code: 'host_unavailable' }); expect(one.cleanups).toBe(before); expect(replacement.agent.identity().ready).toBe(false);
  });

  it('does not implicitly bind a nonempty legacy one-shot journal to an unproven new scope', async () => {
    const legacy = new HostKitAgent(journal, one, control.publicKey, new Set([image])); await legacy.initialize(); const signed = lease(); await legacy.admit(signed);
    await legacy.control(control.sign('control', { version: 1, hostKey: journal.identity.publicKey, runId: signed.body.runId, owner,
      action: 'stop', nonce: randomId(), issuedAt: Date.now() })); await legacy.close(); const before = one.cleanups;
    await expect(hosted.initialize()).rejects.toMatchObject({ code: 'host_unavailable' }); expect(one.cleanups).toBe(before);
  });

  it('derives production scope from concrete Docker configuration and keeps development sessions disabled', () => {
    const actual = createDockerHostedHostKit({ journal, controlKey: control.publicKey, reviewedImages: new Set([image]), isolation: 'gvisor', socketPath: '/var/run/docker.sock', dockerBinary: '/usr/bin/docker' });
    expect(actual.admission.scope).toMatchObject({ hostKey: journal.identity.publicKey, isolation: 'gvisor', sessionBackend: actual.admission.backend!.identity });
    expect(actual.admission.scope.runtime).toContain('/usr/bin/docker'); expect(actual.admission.scope.runtime).toContain('/var/run/docker.sock');
    const dev = createDockerHostedHostKit({ journal, controlKey: control.publicKey, reviewedImages: new Set([image]), isolation: 'docker_development', socketPath: '/var/run/docker.sock' });
    expect(dev.admission.backend).toBeUndefined(); expect(dev.admission.scope.sessionBackend).toBeNull(); expect(() => dev.sessions.open(spec())).toThrow();
  });

  it('bounds retained session rows while leaving exact historical reads and independent one-shot capacity usable', async () => {
    await hosted.initialize(); const rows = Array.from({ length: 256 }, () => {
      const requested = spec(), hash = admissionHash(requested), binding = { isolation: backend.isolation, identity: backend.identity };
      return { sessionId: requested.sessionId, spec: requested, specHash: hash, backend: binding, claimToken: randomId().slice(2), record: {
        version: 1 as const, spec: requested, specHash: hash, backend: binding, state: 'stopped' as const, reason: 'requested', initPid: null,
        commands: [], events: [], outputBytes: 0, outputFrames: 0, cleanupConfirmed: true } };
    });
    await journal.db.insert(hostSessions).values(rows);
    await expect(hosted.sessions.open(spec())).rejects.toMatchObject({ code: 'host_journal_full' }); expect(await claims()).toEqual([]);
    const old = await hosted.sessions.open(rows[0]!.spec); expect(old.status().cleanupConfirmed).toBe(true); expect(backend.starts).toBe(0);
    const signed = lease(); expect((await hosted.agent.admit(signed)).state).toBe('running'); await stopRun(signed);
  });

  it('rejects an oversized durable session record before storage or dispatch and fences both modes', async () => {
    await hosted.initialize(); const requested = spec(); requested.policy.maxCommands = 32; const reserved = await hosted.admission.session(requested);
    const commands = Array.from({ length: 32 }, (_, index) => { const input = command('c' + index, 'process.exit(0)'); return {
      command: input, inputHash: admissionHash(input), state: 'completed' as const, stdout: 'x'.repeat(16_384), stderr: 'x'.repeat(16_384),
      exitCode: 0, reason: 'exited', outputBytes: 0 }; });
    await expect(reserved.journal.save({ version: 1, spec: requested, specHash: admissionHash(requested), backend: { isolation: backend.isolation, identity: backend.identity },
      state: 'starting', reason: '', initPid: null, commands, events: [], outputBytes: 0, outputFrames: 0, cleanupConfirmed: false })).rejects.toMatchObject({ code: 'host_unavailable' });
    expect((await journal.db.select().from(hostSessions))[0]!.record).toBeNull(); expect(await claims()).toHaveLength(1);
    expect(hosted.admission.available()).toBe(false); expect(one.starts + backend.starts).toBe(0);
  });
});
