import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { hostRuns, openHostJournal, type HostJournal, type HostRun } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease, type SignedHostLease } from '../src/host-kit/protocol.js';
import type { HostCell, HostCellRuntime, InitHeartbeat } from '../src/host-kit/runtime.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';

const image = `registry.example/timing@sha256:${'a'.repeat(64)}`;
const owner = '0x1111111111111111111111111111111111111111';
const control = new Ed25519Identity();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= end) throw new Error('Timing condition was not observed'); await pause(5); }
}

class TimingRuntime implements HostCellRuntime {
  readonly isolation = 'local_process_fixture' as const;
  starts = 0; cleanups = 0;
  beforeStart: ReturnType<typeof deferred<void>> | undefined;
  beforeReturn: ReturnType<typeof deferred<void>> | undefined;
  sampleGate: ReturnType<typeof deferred<void>> | undefined;
  stopGate: ReturnType<typeof deferred<void>> | undefined;
  failEarlyInventory = false;
  afterCreate: (() => void) | undefined;
  readonly cells: Array<HostCell & { live: boolean; samples: number; stops: number;
    done: ReturnType<typeof deferred<{ output: string; exitCode: number }>>; heartbeat: (value: InitHeartbeat) => void }> = [];
  async initialize() {}
  cleanupOrphans(): Promise<string[]> {
    this.cleanups++;
    if (this.failEarlyInventory && this.starts) throw new Error('Synchronous inventory failure');
    return (async () => { const live = this.cells.filter(cell => cell.live); await Promise.all(live.map(cell => cell.stop())); return live.map((_, index) => `cell-${index}`); })();
  }
  async start(_lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell> {
    this.starts++; await this.beforeStart?.promise;
    const done = deferred<{ output: string; exitCode: number }>();
    const cell = { live: true, samples: 0, stops: 0, done, heartbeat, wait: done.promise,
      sample: async () => { cell.samples++; await this.sampleGate?.promise; if (!cell.live) throw new Error('Sample after removal'); return { running: true, cpuMs: 100 }; },
      stop: async () => { cell.stops++; cell.live = false; await this.stopGate?.promise; done.resolve({ output: '', exitCode: -1 }); } };
    this.cells.push(cell); heartbeat({ sequence: 0, elapsedMs: 0 }); this.afterCreate?.();
    await this.beforeReturn?.promise; return cell;
  }
  release() { this.beforeStart?.resolve(); this.beforeReturn?.resolve(); this.sampleGate?.resolve(); this.stopGate?.resolve(); }
}

// Delays the actual database operation, rather than substituting a fake journal result.
function delayWrite(journal: HostJournal, kind: 'insert' | 'terminal', gate: ReturnType<typeof deferred<void>>, entered: ReturnType<typeof deferred<void>>, reject = false) {
  if (kind === 'insert') {
    const original = journal.db.insert.bind(journal.db);
    vi.spyOn(journal.db, 'insert').mockImplementation(table => {
      const builder = original(table), values = builder.values.bind(builder);
      builder.values = ((input: Parameters<typeof builder.values>[0]) => {
        const query = values(input), returning = query.returning.bind(query);
        query.returning = (() => { const actual = returning(); entered.resolve();
          return gate.promise.then(() => actual) as unknown as ReturnType<typeof query.returning>;
        }) as typeof query.returning;
        return query;
      }) as typeof builder.values;
      return builder;
    });
  } else {
    const original = journal.db.update.bind(journal.db);
    vi.spyOn(journal.db, 'update').mockImplementation(table => {
      const builder = original(table), set = builder.set.bind(builder);
      builder.set = ((input: Parameters<typeof builder.set>[0]) => {
        const query = set(input);
        if ('state' in input && !['starting', 'running'].includes(String(input.state))) {
          const where = query.where.bind(query);
          query.where = ((condition: Parameters<typeof query.where>[0]) => { const actual = where(condition);
            return { then: (fulfilled: (value: unknown) => unknown, failed: (error: unknown) => unknown) => {
              entered.resolve(); return gate.promise.then(() => { if (reject) throw new Error('Terminal journal unavailable'); return actual; }).then(fulfilled, failed);
            } } as ReturnType<typeof query.where>;
          }) as typeof query.where;
        }
        return query;
      }) as typeof builder.set;
      return builder;
    });
  }
}

describe('Host Kit startup-inclusive deadlines and owned late handles', () => {
  let journal: HostJournal | undefined, agent: HostKitAgent | undefined, runtime: TimingRuntime | undefined, server: Server | undefined;
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  afterEach(async () => {
    gates.splice(0).forEach(value => value.resolve()); runtime?.release(); vi.restoreAllMocks();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await agent?.close(); await journal?.close(); server = undefined; agent = undefined; journal = undefined; runtime = undefined;
  });
  async function setup(clock: () => number = Date.now, selected: HostCellRuntime = new TimingRuntime()) {
    journal = await openHostJournal(':memory:');
    if (selected instanceof TimingRuntime) runtime = selected;
    agent = new HostKitAgent(journal, selected, control.publicKey, new Set([image]), clock); await agent.initialize();
    return agent;
  }
  function lease(overrides: Partial<HostLease> = {}): SignedHostLease {
    const now = Date.now(); return control.sign('lease', { version: 1, hostKey: journal!.identity.publicKey, runId: randomId(), owner, image,
      argv: [process.execPath, '-e', 'setTimeout(()=>{},60000)'], issuedAt: now, expiresAt: now + 20_000,
      maxSeconds: 20, nonce: randomId(), ...overrides });
  }
  async function row(runId: string): Promise<HostRun | undefined> { return (await journal!.db.select().from(hostRuns).where(eq(hostRuns.runId, runId)))[0]; }
  async function terminal(runId: string) { await until(async () => { const found = await row(runId); return !!found && !['starting', 'running'].includes(found.state); }); return (await row(runId))!; }
  async function http() {
    server = createServer(getRequestListener(createHostKitRoutes(agent!).fetch)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture unavailable');
    return (signed: SignedHostLease) => fetch(`http://127.0.0.1:${address.port}/v1/leases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
  }

  it.each(['expiresAt', 'issuedAt'] as const)('revalidates a queued %s before busy/reservation and never dispatches it', async mode => {
    let now = Date.now(); await setup(() => now); runtime!.sampleGate = gate();
    const first = lease({ issuedAt: now, expiresAt: now + 20_000 }); const running = agent!.admit(first);
    await until(() => runtime!.cells[0]?.samples === 1);
    const candidate = lease({ issuedAt: now, expiresAt: now + (mode === 'expiresAt' ? 100 : 20_000) });
    const waiting = agent!.admit(candidate); const rejected = expect(waiting).rejects.toMatchObject({ status: 403, code: 'lease_rejected' });
    now += mode === 'expiresAt' ? 150 : 5001; runtime!.sampleGate!.resolve();
    await running; await rejected; expect(await row(candidate.body.runId)).toBeUndefined(); expect(runtime!.starts).toBe(1);
  });

  it('does not start a lease whose durable reservation completes after expiration', async () => {
    let now = Date.now(); await setup(() => now); const held = gate(), entered = gate(); delayWrite(journal!, 'insert', held, entered);
    const signed = lease({ issuedAt: now, expiresAt: now + 100 }); const admission = agent!.admit(signed);
    await entered.promise; now += 150; held.resolve(); const state = await admission;
    expect(state).toMatchObject({ state: 'timed_out', cleanupConfirmed: true, billableSeconds: 0 });
    expect(runtime!.starts).toBe(0); expect((await row(signed.body.runId))!.ticks.map(tick => tick.body.state)).toEqual(['STOPPED']);
  });

  it.each([false, true])('owns a start held before creation, including synchronous early cleanup failure=%s', async failEarlyInventory => {
    await setup(); runtime!.beforeStart = gate(); runtime!.failEarlyInventory = failEarlyInventory;
    const signed = lease({ expiresAt: Date.now() + 180 }); const admission = agent!.admit(signed);
    await until(() => runtime!.starts === 1); await until(() => runtime!.cleanups >= 2);
    expect(agent!.identity().ready).toBe(false); expect((await row(signed.body.runId))!.cleanupConfirmed).toBe(false);
    const next = lease(), nextAdmission = agent!.admit(next);
    let nextResolved = false; void nextAdmission.then(() => { nextResolved = true; }, () => { nextResolved = true; });
    await pause(25); expect(runtime!.starts).toBe(1); expect(nextResolved).toBe(false);
    runtime!.beforeStart!.resolve(); const state = await admission;
    expect(state).toMatchObject({ state: 'timed_out', cleanupConfirmed: true }); expect(runtime!.cells[0]!.stops).toBeGreaterThan(0);
    expect(runtime!.cells[0]!.live).toBe(false); expect((await nextAdmission).state).toBe('running'); expect(runtime!.starts).toBe(2);
  });

  it('stops a known late handle at expiry and fences the slot until its stop completes', async () => {
    await setup(); runtime!.beforeReturn = gate(); runtime!.stopGate = gate();
    const signed = lease({ expiresAt: Date.now() + 180 }), admission = agent!.admit(signed);
    await until(() => runtime!.cells.length === 1); await until(() => runtime!.cells[0]!.stops > 0);
    expect(runtime!.cells[0]!.live).toBe(false); expect(agent!.identity().ready).toBe(false);
    runtime!.beforeReturn!.resolve(); await until(() => runtime!.cells[0]!.stops >= 2);
    expect((await row(signed.body.runId))!.cleanupConfirmed).toBe(false);
    const next = agent!.admit(lease()); await pause(25); expect(runtime!.starts).toBe(1);
    runtime!.stopGate!.resolve(); expect((await admission).cleanupConfirmed).toBe(true); expect((await next).state).toBe('running');
  });

  it('charges startup time against maxSeconds even when absolute expiry permits five more seconds', async () => {
    await setup(); runtime!.beforeReturn = gate(); const now = Date.now(), signed = lease({ issuedAt: now, expiresAt: now + 6000, maxSeconds: 1 });
    const start = performance.now(), admission = agent!.admit(signed); await until(() => runtime!.cells.length === 1);
    await until(() => runtime!.cells[0]!.stops > 0, 2500); expect(performance.now() - start).toBeLessThan(2500);
    runtime!.beforeReturn!.resolve(); expect((await admission).state).toBe('timed_out'); expect((await row(signed.body.runId))!.billableSeconds).toBe(0);
  });

  it('physically stops at expiry while a RUNNING sample holds the serial queue', async () => {
    await setup(); runtime!.sampleGate = gate(); const signed = lease({ expiresAt: Date.now() + 180 }), admission = agent!.admit(signed);
    await until(() => runtime!.cells[0]?.samples === 1); await until(() => runtime!.cells[0]!.stops > 0);
    expect((await row(signed.body.runId))!.state).toBe('running'); expect(runtime!.cells[0]!.live).toBe(false);
    runtime!.sampleGate!.resolve(); expect((await admission).state).toBe('timed_out');
    expect((await row(signed.body.runId))!.ticks.map(tick => tick.body.state)).toEqual(['STOPPED']);
  });

  it('physically cleans before a blocked terminal write and does not admit a successor early', async () => {
    await setup(); const signed = lease(); await agent!.admit(signed);
    const held = gate(), entered = gate(); delayWrite(journal!, 'terminal', held, entered);
    runtime!.cells[0]!.done.resolve({ output: 'complete', exitCode: 0 }); await entered.promise;
    expect(runtime!.cells[0]!.live).toBe(false); expect(agent!.identity().ready).toBe(false);
    expect((await row(signed.body.runId))!.cleanupConfirmed).toBe(false);
    const next = agent!.admit(lease()); await pause(25); expect(runtime!.starts).toBe(1);
    held.resolve(); expect((await next).state).toBe('running'); expect((await row(signed.body.runId))!).toMatchObject({ state: 'completed', cleanupConfirmed: true, output: 'complete' });
  });

  it('fails closed on terminal persistence failure after physical cleanup', async () => {
    await setup(); const signed = lease(); await agent!.admit(signed);
    const held = gate(), entered = gate(); delayWrite(journal!, 'terminal', held, entered, true);
    runtime!.cells[0]!.done.resolve({ output: 'complete', exitCode: 0 }); await entered.promise; expect(runtime!.cells[0]!.live).toBe(false);
    held.resolve(); await until(() => !agent!.identity().ready); await pause(15); vi.restoreAllMocks();
    await expect(agent!.admit(lease())).rejects.toMatchObject({ status: 503, code: 'host_unavailable' });
    expect(runtime!.starts).toBe(1); expect((await row(signed.body.runId))!.cleanupConfirmed).toBe(false);
  });

  it('closes admission synchronously while an earlier sample keeps its queue occupied', async () => {
    await setup(); runtime!.sampleGate = gate(); const first = agent!.admit(lease()); await until(() => runtime!.cells[0]?.samples === 1);
    const candidate = lease(), waiting = agent!.admit(candidate), rejected = expect(waiting).rejects.toMatchObject({ status: 503, code: 'host_unavailable' });
    const closed = agent!.close(); expect(agent!.identity().ready).toBe(false); await until(() => runtime!.cells[0]!.stops > 0);
    runtime!.sampleGate!.resolve(); expect((await first).state).toBe('cancelled'); await rejected; await closed;
    expect(await row(candidate.body.runId)).toBeUndefined(); expect(runtime!.starts).toBe(1);
  });

  it('uses durable terminal CPU counters when removal makes further sampling impossible', async () => {
    await setup(); const signed = lease(); await agent!.admit(signed); const cell = runtime!.cells[0]!;
    cell.done.resolve({ output: 'done', exitCode: 0 }); const result = await terminal(signed.body.runId);
    expect(result).toMatchObject({ state: 'completed', output: 'done', cleanupConfirmed: true }); expect(cell.live).toBe(false); expect(cell.samples).toBe(1);
    expect(result.ticks.map(tick => [tick.body.state, tick.body.cpuMs])).toEqual([['RUNNING', 100], ['EXITED', 100]]);
  });

  it('classifies an already-resolved late wait as timed out using the same expiry observation', async () => {
    let now = Date.now(); await setup(() => now); const signed = lease({ issuedAt: now, expiresAt: now + 1000 });
    runtime!.afterCreate = () => { now += 1001; runtime!.cells[0]!.done.resolve({ output: 'too late', exitCode: 0 }); };
    const result = await agent!.admit(signed); expect(result).toMatchObject({ state: 'timed_out', output: '', cleanupConfirmed: true });
    expect(runtime!.cells[0]!.live).toBe(false);
  });

  it('returns immutable expired HTTP replay without redispatch and rejects a changed signed lease', async () => {
    let now = Date.now(); await setup(() => now); const call = await http(), signed = lease({ issuedAt: now, expiresAt: now + 1000 });
    expect((await call(signed)).status).toBe(201); runtime!.cells[0]!.done.resolve({ output: 'original', exitCode: 0 }); await terminal(signed.body.runId);
    now += 20_000; const replay = await call(signed); expect(replay.status).toBe(201);
    expect((await replay.json() as { body: unknown }).body).toMatchObject({ state: 'completed', output: 'original', cleanupConfirmed: true });
    expect((await call(control.sign('lease', { ...signed.body, argv: [process.execPath, '-e', 'changed'] }))).status).toBe(409); expect(runtime!.starts).toBe(1);
  });

  it('ignores an old heartbeat after a clean successor claims the host', async () => {
    await setup(); const first = lease(); await agent!.admit(first); const old = runtime!.cells[0]!;
    old.done.resolve({ output: '', exitCode: 0 }); await terminal(first.body.runId); const second = lease(); await agent!.admit(second);
    old.heartbeat({ sequence: 9999, elapsedMs: 999999 });
    runtime!.cells[1]!.done.resolve({ output: 'second', exitCode: 0 }); const result = await terminal(second.body.runId);
    expect(result.state).toBe('completed'); expect(result.ticks.every(tick => tick.body.heartbeat?.sequence === 0)).toBe(true);
  });

  it('enforces a short absolute deadline against an actual local child and cleans before another child executes', async () => {
    const local = new LocalProcessFixtureRuntime('test-fixture-only'); await setup(Date.now, local);
    const first = lease({ expiresAt: Date.now() + 250 }); await agent!.admit(first); const stopped = await terminal(first.body.runId);
    expect(stopped).toMatchObject({ state: 'timed_out', cleanupConfirmed: true, billableSeconds: 0 }); expect(await local.cleanupOrphans(first.body.hostKey)).toEqual([]);
    const next = lease({ argv: [process.execPath, '-e', 'process.stdout.write("actual-next")'] }); await agent!.admit(next);
    expect(await terminal(next.body.runId)).toMatchObject({ state: 'completed', output: 'actual-next', cleanupConfirmed: true });
    expect(await local.cleanupOrphans(first.body.hostKey)).toEqual([]);
  });
});
