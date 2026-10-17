import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import { CystService } from '../src/cysts/service.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import type { CystEnvelope } from '../src/cysts/types.js';
import { decryptCheckpoint, encryptCheckpoint, exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';
import { agentBilling, agentIntents, agentMigrationSQL, agents } from '../src/agents/schema.js';
import { AgentLifecycleService } from '../src/agents/service.js';
import { ClientAgentCoordinator, lifecycleCheckpointEnvelope, type ClientAgentRunner, type ClientLifecycleControl, type ClientLifecycleVault } from '../src/agents/client.js';
import { createAgentRoutes } from '../src/agents/routes.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ClientLifeline } from '../src/agents/lifeline.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { evaluateMetabolism, type AgentMode, type ReservedAgentRun } from '../src/agents/types.js';

const owner = '0x1111111111111111111111111111111111111111', foreign = '0x2222222222222222222222222222222222222222';
const agent = '0x3333333333333333333333333333333333333333', otherAgent = '0x4444444444444444444444444444444444444444';
const runA = '0x' + 'aa'.repeat(32), runB = '0x' + 'bb'.repeat(32), runC = '0x' + 'cc'.repeat(32);
const receipt = (index: number) => '0x' + index.toString(16).padStart(64, '0');
const execute = promisify(execFile);
const counterProgram = `
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [file, steps] = process.argv.slice(1); let state = JSON.parse(await readFile(file, 'utf8'));
for (let i=0;i<Number(steps);i++) { state.counter++; state.hash=createHash('sha256').update(state.hash+':'+state.counter).digest('hex'); }
await writeFile(file, JSON.stringify(state), { mode: 0o600 }); process.stdout.write(JSON.stringify(state));
`;
interface CounterState { counter: number; hash: string }
function expectedCounter(steps: number): CounterState {
  const state = { counter: 0, hash: '00'.repeat(32) };
  for (let index = 0; index < steps; index++) { state.counter++; state.hash = createHash('sha256').update(state.hash + ':' + state.counter).digest('hex'); }
  return state;
}

/** Separate process executors with durable operation journals, not lifecycle-state mocks. */
class CounterExecutors implements ClientAgentRunner {
  readonly calls: string[] = [];
  constructor(readonly root: string) {}
  private path(run: string) { return join(this.root, run === runA ? 'executor-a' : run === runB ? 'executor-b' : 'executor-c'); }
  async initialize(run: string) {
    await mkdir(this.path(run), { recursive: true, mode: 0o700 });
    await writeFile(join(this.path(run), 'state.json'), JSON.stringify(expectedCounter(0)), { mode: 0o600 });
  }
  async run(run: string, steps: number) {
    const result = await execute(process.execPath, ['--input-type=module', '-e', counterProgram, join(this.path(run), 'state.json'), String(steps)], { maxBuffer: 4096 });
    return JSON.parse(result.stdout) as CounterState;
  }
  async state(run: string): Promise<CounterState> { return JSON.parse(await readFile(join(this.path(run), 'state.json'), 'utf8')) as CounterState; }
  private journal(operation: string) { return join(this.root, createHash('sha256').update(operation).digest('hex') + '.operation'); }
  private async once(operation: string, action: () => Promise<void>) {
    try { await readFile(this.journal(operation)); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await action(); await writeFile(this.journal(operation), 'done', { mode: 0o600 }); this.calls.push(operation);
  }
  async checkpoint(run: string, operation: string): Promise<Uint8Array> {
    const file = this.journal(operation);
    try { return new Uint8Array(await readFile(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const state = await readFile(join(this.path(run), 'state.json')); await writeFile(file, state, { mode: 0o600 });
    this.calls.push(operation); return new Uint8Array(state);
  }
  async stop(run: string, operation: string) { await this.once(operation, async () => { await mkdir(this.path(run), { recursive: true }); await writeFile(join(this.path(run), 'stopped'), 'yes'); }); }
  async attach(run: string, operation: string) { await this.once(operation, async () => { await mkdir(this.path(run), { recursive: true, mode: 0o700 }); await writeFile(join(this.path(run), 'attached'), run); }); }
  async resume(run: string, state: Uint8Array, mode: Exclude<AgentMode, 'cyst'>, operation: string) {
    await this.once(operation, async () => { await writeFile(join(this.path(run), 'state.json'), state, { mode: 0o600 }); await writeFile(join(this.path(run), 'profile'), mode); });
  }
  async profile(run: string, mode: Exclude<AgentMode, 'cyst'>, operation: string) {
    await this.once(operation, async () => { await writeFile(join(this.path(run), 'profile'), mode); });
  }
}
class FileClientVault implements ClientLifecycleVault {
  constructor(readonly root: string) {}
  async getCheckpoint(id: string) {
    try { const value = JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')) as { envelope: CystEnvelope; recoveryKey: string };
      return { envelope: value.envelope, recoveryKey: importCystRecoveryKey(value.recoveryKey) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async putCheckpoint(id: string, envelope: CystEnvelope, recoveryKey: Uint8Array) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, id + '.json'), JSON.stringify({ envelope, recoveryKey: exportCystRecoveryKey(recoveryKey) }), { mode: 0o600, flag: 'wx' });
  }
  async recoveryKey(checkpointId: string) {
    for (const file of await readdir(this.root)) { const value = JSON.parse(await readFile(join(this.root, file), 'utf8')) as { envelope: CystEnvelope; recoveryKey: string };
      if (value.envelope.id === checkpointId) return importCystRecoveryKey(value.recoveryKey); }
    throw new Error('Recovery key unavailable on this client');
  }
}

describe('durable owner Lifeline and Metabolism with encrypted application migration', () => {
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, cysts: CystService, service: AgentLifecycleService;
  let now: Date, balance: string, reservations: Map<string, ReservedAgentRun>, reservedCalls: number;
  async function connect(persistent = false) {
    store = await openStore({ DATA_DIR: persistent ? join(directory, 'database') : ':memory:' });
    for (const statement of agentMigrationSQL.split(';').map(value => value.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    cysts = new CystService(store.db, join(directory, 'server-ciphertext')); await cysts.initialize();
    service = new AgentLifecycleService(store.db, { cysts, now: () => now, balance: async () => balance,
      reservedRun: async (_owner, _agent, runId) => { reservedCalls++; const run = reservations.get(runId); if (!run) throw new Problem(409, 'not_reserved', 'Run is not reserved.'); return run; } });
  }
  const control = (): ClientLifecycleControl => ({ get: (...args) => service.get(...args), acknowledge: (...args) => service.acknowledge(...args),
    validateExecution: (...args) => service.validateExecution(...args), upload: (...args) => cysts.upload(...args), download: (...args) => cysts.download(...args) });
  const currentVersion = async () => (await service.get(owner, agent)).agent.version;
  const plan = async (action: 'evaluate' | 'migrate' | 'sleep' | 'wake' | 'kill', key: string, targetRunId?: string, wakeAt?: string) => service.plan(owner, agent,
    { action, expectedVersion: await currentVersion(), ...(targetRunId ? { targetRunId } : {}), ...(wakeAt ? { wakeAt } : {}) }, key);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-lifecycle-')); now = new Date('2026-10-09T10:00:00Z'); balance = '1000000'; reservedCalls = 0;
    reservations = new Map([runA, runB, runC].map(id => [id, { id, owner, agent, reserved: true, leaseUntil: new Date(now.getTime() + 12 * 3600_000) }]));
    await connect();
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); await rm(directory, { recursive: true, force: true }); });

  it.each([
    ['0', '0', 'cyst'], ['1', '0', 'full'], ['3001', '1000', 'full'], ['3000', '1000', 'lean'],
    ['1000', '1000', 'lean'], ['999', '1000', 'torpor'], ['250', '3000', 'torpor'], ['249', '3000', 'cyst'],
  ])('calculates exact threshold balance=%s burn=%s → %s', (available, burn, mode) => {
    expect(evaluateMetabolism(available, burn).mode).toBe(mode);
  });
  it('keeps uint256 arithmetic exact above JavaScript safe integer range', () => {
    const n = 10n ** 70n;
    expect(evaluateMetabolism((n * 3n).toString(), n.toString()).mode).toBe('lean');
    expect(evaluateMetabolism((n * 3n + 1n).toString(), n.toString()).mode).toBe('full');
    expect(() => evaluateMetabolism('01', '1')).toThrow(); expect(() => evaluateMetabolism((2n ** 256n).toString(), '1')).toThrow();
  });
  it('uses confirmed trailing 24-hour burn once and rejects changed billing facts', async () => {
    await service.register(owner, { agent, runId: runA }); balance = '1000';
    expect(await service.appendSettledCharge(owner, agent, receipt(1), '1000', now)).toEqual({ replayed: false });
    expect(await service.appendSettledCharge(owner, agent, receipt(1), '1000', now)).toEqual({ replayed: true });
    await service.appendSettledCharge(owner, agent, receipt(2), '999999', new Date(now.getTime() - 86400_000));
    expect((await service.evaluate(owner, agent)).trailing24hBurn).toBe('1000');
    expect((await service.evaluate(owner, agent)).mode).toBe('lean');
    await expect(service.appendSettledCharge(owner, agent, receipt(1), '1001', now)).rejects.toThrow('different billing facts');
    await expect(service.appendSettledCharge(owner, agent, receipt(3), '100', new Date(now.getTime() + 1))).rejects.toThrow('not in the future');
    now = new Date(now.getTime() + 86400_001); expect((await service.evaluate(owner, agent)).trailing24hBurn).toBe('0');
    expect((await store.db.select().from(agentBilling)).length).toBe(2);
  });
  it('registers and transitions only owned approved reservations with bounded leases', async () => {
    await expect(service.register(owner, { agent, runId: receipt(98) })).rejects.toThrow('not reserved');
    reservations.set(runB, { ...reservations.get(runB)!, owner: foreign });
    await expect(service.register(owner, { agent, runId: runB })).rejects.toThrow('approved reserved run');
    reservations.set(runB, { ...reservations.get(runA)!, id: runB, leaseUntil: new Date(now.getTime() + 86400_001) });
    await expect(service.register(owner, { agent, runId: runB })).rejects.toThrow('at most 24 hours');
    expect((await service.register(owner, { agent, runId: runA })).replayed).toBe(false);
    expect((await service.register(owner, { agent, runId: runA })).replayed).toBe(true);
    await expect(service.get(foreign, agent)).rejects.toThrow('not found'); expect((await service.list(foreign)).agents).toEqual([]);
  });
  it('persists checkpoint→stop→attach→resume across a database close and restores the actual counter on a second executor', async () => {
    await store.close(); await connect(true);
    await service.register(owner, { agent, runId: runA });
    const executors = new CounterExecutors(directory), vault = new FileClientVault(join(directory, 'owner-client-vault'));
    await executors.initialize(runA); expect(await executors.run(runA, 7)).toEqual(expectedCounter(7));
    const transition = await plan('migrate', 'real-counter-migration', runB);
    let coordinator = new ClientAgentCoordinator(control(), vault, executors, 'counter.hash.v1');
    expect((await coordinator.step(owner, agent)).phase).toBe('stop');
    const saved = await service.get(owner, agent); expect(saved.intent?.checkpointId).toMatch(/^0x/);
    const privateState = JSON.stringify(expectedCounter(7));
    for (const file of await readdir(cysts.privateDirectory)) expect((await readFile(join(cysts.privateDirectory, file))).toString()).not.toContain(privateState);
    expect(JSON.stringify(await store.db.select().from(agentIntents))).not.toContain('recoveryKey');
    await store.close(); await connect(true);
    coordinator = new ClientAgentCoordinator(control(), new FileClientVault(join(directory, 'owner-client-vault')), executors, 'counter.hash.v1');
    await coordinator.finish(owner, agent);
    expect(await executors.state(runB)).toEqual(expectedCounter(7)); expect(await executors.run(runB, 9)).toEqual(expectedCounter(16));
    expect(await readFile(join(directory, 'executor-a', 'stopped'), 'utf8')).toBe('yes');
    const finished = await service.get(owner, agent); expect(finished.intent).toBeNull(); expect(finished.agent.currentRunId).toBe(runB);
    const [journal] = await store.db.select().from(agentIntents).where(eq(agentIntents.id, transition.intent.id)); expect(journal?.phase).toBe('done'); expect(journal?.version).toBe(4);
    expect(executors.calls.map(value => value.split(':').at(-1))).toEqual(['checkpoint', 'stop', 'attach', 'resume']);
  });
  it('replays lost upload and external-operation responses without a second checkpoint or double resume', async () => {
    await service.register(owner, { agent, runId: runA }); const executors = new CounterExecutors(directory);
    await executors.initialize(runA); await executors.run(runA, 4); const vault = new FileClientVault(join(directory, 'client-vault'));
    await plan('migrate', 'lost-operation-response', runB);
    const transport = control(); const originalUpload = transport.upload; let loseUpload = true;
    transport.upload = async (...args) => { const result = await originalUpload(...args); if (loseUpload) { loseUpload = false; throw new Error('lost upload response'); } return result; };
    let coordinator = new ClientAgentCoordinator(transport, vault, executors, 'counter.hash.v1');
    await expect(coordinator.step(owner, agent)).rejects.toThrow('lost upload response');
    coordinator = new ClientAgentCoordinator(control(), new FileClientVault(join(directory, 'client-vault')), executors, 'counter.hash.v1');
    await coordinator.step(owner, agent); await coordinator.step(owner, agent); await coordinator.step(owner, agent);
    const failAck = control(), originalAck = failAck.acknowledge; let loseResumeAck = true;
    failAck.acknowledge = async (...args) => { if (loseResumeAck) { loseResumeAck = false; throw new Error('ack unavailable after resume'); } return originalAck(...args); };
    await expect(new ClientAgentCoordinator(failAck, vault, executors, 'counter.hash.v1').step(owner, agent)).rejects.toThrow('ack unavailable');
    await executors.run(runB, 3); await coordinator.finish(owner, agent);
    expect(await executors.state(runB)).toEqual(expectedCounter(7));
    expect(executors.calls.filter(value => value.endsWith(':checkpoint'))).toHaveLength(1);
    expect(executors.calls.filter(value => value.endsWith(':resume'))).toHaveLength(1);
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
  });
  it('sleeps below two hours and wakes after top-up using the saved encrypted state and a separately approved run', async () => {
    await service.register(owner, { agent, runId: runA }); await service.appendSettledCharge(owner, agent, receipt(10), '2400', now); balance = '199';
    const executors = new CounterExecutors(directory); await executors.initialize(runA); await executors.run(runA, 11);
    const vault = new FileClientVault(join(directory, 'client-vault')), coordinator = new ClientAgentCoordinator(control(), vault, executors, 'counter.hash.v1');
    const sleep = await plan('evaluate', 'automatic-low-balance-sleep'); expect(sleep.intent.kind).toBe('sleep');
    await coordinator.finish(owner, agent); expect((await service.get(owner, agent)).agent.mode).toBe('cyst');
    balance = '10000'; await expect(plan('evaluate', 'topup-needs-separate-reservation')).rejects.toThrow('separately approved');
    expect((await plan('evaluate', 'topup-wakes-after-reservation', runB)).intent.kind).toBe('wake');
    await coordinator.finish(owner, agent); expect(await executors.state(runB)).toEqual(expectedCounter(11));
    expect((await service.get(owner, agent)).agent.mode).toBe('full');
  });
  it('records scheduled wake and safely rolls before the 24-hour lease without signing a renewal', async () => {
    reservations.set(runA, { ...reservations.get(runA)!, leaseUntil: new Date(now.getTime() + 29 * 60_000) });
    await service.register(owner, { agent, runId: runA });
    expect((await service.evaluate(owner, agent)).rollDue).toBe(true);
    const wakeAt = new Date(now.getTime() + 3600_000).toISOString();
    const sleep = await plan('evaluate', 'lease-expiry-safety-sleep', undefined, wakeAt); expect(sleep.intent.kind).toBe('sleep');
    const executors = new CounterExecutors(directory); await executors.initialize(runA);
    const coordinator = new ClientAgentCoordinator(control(), new FileClientVault(join(directory, 'vault')), executors, 'counter.hash.v1');
    await coordinator.finish(owner, agent);
    expect((await plan('evaluate', 'scheduled-wake-stays-asleep-before-due')).intent.phase).toBe('done');
    now = new Date(now.getTime() + 3600_001);
    expect((await service.evaluate(owner, agent)).scheduledWakeDue).toBe(true);
    const wake = await plan('evaluate', 'scheduled-wake-reserved', runB); expect(wake.intent.kind).toBe('wake');
    await coordinator.finish(owner, agent); expect((await service.get(owner, agent)).agent.wakeAt).toBeNull();
  });
  it('changes live resource profiles at the exact Lean and Torpor thresholds through the runner', async () => {
    await service.register(owner, { agent, runId: runA }); await service.appendSettledCharge(owner, agent, receipt(11), '2400', now);
    const executors = new CounterExecutors(directory); await executors.initialize(runA);
    const coordinator = new ClientAgentCoordinator(control(), new FileClientVault(join(directory, 'vault')), executors, 'counter.hash.v1');
    balance = '2400'; expect((await plan('evaluate', 'profile-lean-threshold')).intent.targetMode).toBe('lean'); await coordinator.finish(owner, agent);
    expect(await readFile(join(directory, 'executor-a', 'profile'), 'utf8')).toBe('lean');
    balance = '200'; expect((await plan('evaluate', 'profile-torpor-threshold')).intent.targetMode).toBe('torpor'); await coordinator.finish(owner, agent);
    expect(await readFile(join(directory, 'executor-a', 'profile'), 'utf8')).toBe('torpor');
  });
  it('permanently owner-kills an in-progress migration and rejects stale execution and all later wake attempts', async () => {
    await service.register(owner, { agent, runId: runA }); const migrate = await plan('migrate', 'migration-before-owner-kill', runB);
    const kill = await plan('kill', 'permanent-owner-kill'); expect(kill.intent.phase).toBe('stop');
    await expect(service.validateExecution(owner, migrate.intent.id, 0, 'checkpoint')).rejects.toThrow('phase or version changed');
    const executors = new CounterExecutors(directory); await executors.initialize(runA);
    await new ClientAgentCoordinator(control(), new FileClientVault(join(directory, 'vault')), executors, 'counter.hash.v1').finish(owner, agent);
    expect((await service.get(owner, agent)).agent.killedAt).not.toBeNull(); expect((await service.get(owner, agent)).agent.currentRunId).toBeNull();
    await expect(plan('wake', 'owner-kill-cannot-revive', runC)).rejects.toThrow('permanently killed');
    expect(await readFile(join(directory, 'executor-b', 'stopped'), 'utf8')).toBe('yes');
  });
  it('rejects stale CAS, changed idempotency bodies and phase skipping', async () => {
    await service.register(owner, { agent, runId: runA }); const body = { action: 'migrate', expectedVersion: 0, targetRunId: runB };
    const planned = await service.plan(owner, agent, body, 'stable-transition-key');
    expect((await service.plan(owner, agent, body, 'stable-transition-key')).intent.id).toBe(planned.intent.id);
    await expect(service.plan(owner, agent, { ...body, targetRunId: runC }, 'stable-transition-key')).rejects.toThrow('original lifecycle request');
    await expect(service.plan(owner, agent, body, 'different-stale-version')).rejects.toThrow('Refresh the agent');
    await expect(service.acknowledge(owner, planned.intent.id, 0, { phase: 'resume' })).rejects.toThrow('phase or version changed');
    await expect(service.acknowledge(foreign, planned.intent.id, 0, { phase: 'stop' })).rejects.toThrow('not found');
  });
  it('rejects another agent checkpoint, changed ciphertext metadata and a target reservation revoked before attach', async () => {
    await service.register(owner, { agent, runId: runA }); const transition = await plan('migrate', 'checkpoint-scope-migration', runB);
    const wrong = await encryptCheckpoint(new TextEncoder().encode('private counter'), { owner, agent: otherAgent, applicationSchema: 'counter.hash.v1' });
    await cysts.upload(owner, wrong.envelope, 'wrong-agent-checkpoint');
    await expect(service.acknowledge(owner, transition.intent.id, 0, { phase: 'checkpoint', checkpointId: wrong.envelope.id, checkpointSha256: wrong.envelope.sha256 })).rejects.toThrow('owner and agent');
    const good = await encryptCheckpoint(new TextEncoder().encode('private counter'), { owner, agent, applicationSchema: 'counter.hash.v1' });
    await cysts.upload(owner, good.envelope, 'right-agent-checkpoint');
    await expect(service.acknowledge(owner, transition.intent.id, 0, { phase: 'checkpoint', checkpointId: good.envelope.id, checkpointSha256: '00'.repeat(32) })).rejects.toThrow('owner and agent');
    await service.acknowledge(owner, transition.intent.id, 0, { phase: 'checkpoint', checkpointId: good.envelope.id, checkpointSha256: good.envelope.sha256 });
    await service.acknowledge(owner, transition.intent.id, 1, { phase: 'stop' }); reservations.delete(runB);
    await expect(service.validateExecution(owner, transition.intent.id, 2, 'attach')).rejects.toThrow('not reserved');
    expect(reservedCalls).toBeGreaterThan(2); good.recoveryKey.fill(0); wrong.recoveryKey.fill(0);
  });
  it('exposes owner-isolated REST routes and no billing, plaintext, key or wallet action endpoints', async () => {
    let authenticatedOwner = owner; const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    app.route('/api/agents', createAgentRoutes(service, async () => { if (!authenticatedOwner) throw new Problem(401, 'unauthorized', 'Sign in'); return authenticatedOwner; }));
    const create = await app.request('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, runId: runA }) }); expect(create.status).toBe(201);
    expect((await app.request('/api/agents/' + agent + '/evaluation')).status).toBe(200);
    for (const path of ['billing', 'private-key', 'sign', 'plaintext']) expect((await app.request('/api/agents/' + path, { method: 'POST' })).status).toBe(404);
    authenticatedOwner = foreign; expect((await app.request('/api/agents/' + agent)).status).toBe(404);
    expect((await (await app.request('/api/agents')).json()).agents).toEqual([]);
    authenticatedOwner = ''; expect((await app.request('/api/agents')).status).toBe(401);
    expect(JSON.stringify(await store.db.select().from(agents))).not.toContain('recoveryKey');
    expect((await store.db.select().from(agentIntents).where(and(eq(agentIntents.owner, owner), eq(agentIntents.agent, agent))))).toEqual([]);
  });
  it('keeps ciphertext restore independent of the controller and rejects the wrong client recovery key', async () => {
    const state = new TextEncoder().encode(JSON.stringify(expectedCounter(8)));
    const checkpoint = await encryptCheckpoint(state, { owner, agent, applicationSchema: 'counter.hash.v1' });
    await cysts.upload(owner, checkpoint.envelope, 'portable-independent-counter');
    const downloaded = await cysts.download(owner, checkpoint.envelope.id);
    expect(JSON.parse(new TextDecoder().decode(await decryptCheckpoint(lifecycleCheckpointEnvelope(downloaded), checkpoint.recoveryKey)))).toEqual(expectedCounter(8));
    await expect(decryptCheckpoint(lifecycleCheckpointEnvelope(downloaded), new Uint8Array(32))).rejects.toThrow('authentication failed');
    state.fill(0); checkpoint.recoveryKey.fill(0);
  });
  it('runs the owner Lifeline through Torpor, Cyst and funded wake without purchasing or signing a target run', async () => {
    await service.register(owner, { agent, runId: runA }); await service.appendSettledCharge(owner, agent, receipt(21), '2400', now);
    const executors = new CounterExecutors(directory); await executors.initialize(runA); await executors.run(runA, 6);
    const transport = { ...control(), evaluate: (...args: Parameters<AgentLifecycleService['evaluate']>) => service.evaluate(...args),
      plan: (...args: Parameters<AgentLifecycleService['plan']>) => service.plan(...args) };
    const coordinator = new ClientAgentCoordinator(transport, new FileClientVault(join(directory, 'client-vault')), executors, 'counter.hash.v1');
    let target: string | undefined;
    const lifeline = new ClientLifeline(transport, coordinator, async () => target);
    balance = '200'; expect((await lifeline.tick(owner, agent)).status).toBe('transition_completed');
    expect((await service.get(owner, agent)).agent.mode).toBe('torpor');
    balance = '199'; expect((await lifeline.tick(owner, agent)).status).toBe('transition_completed');
    expect((await service.get(owner, agent)).agent.mode).toBe('cyst');
    balance = '10000'; expect((await lifeline.tick(owner, agent)).status).toBe('reservation_required');
    expect((await service.get(owner, agent)).agent.currentRunId).toBeNull();
    target = runB; expect((await lifeline.tick(owner, agent)).status).toBe('transition_completed');
    expect(await executors.state(runB)).toEqual(expectedCounter(6));
    expect((await lifeline.tick(owner, agent)).status).toBe('idle');
    expect(await store.db.select().from(agentIntents)).toHaveLength(3);
  });
  it('executes the real encrypted migration entirely through bounded owner REST clients', async () => {
    await service.register(owner, { agent, runId: runA });
    const app = new Hono(), bodies: string[] = [];
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    app.route('/api/agents', createAgentRoutes(service, async () => owner)); app.route('/api/cysts', createCystRoutes(cysts, async () => owner));
    const transport = new ApiTransport('http://127.0.0.1:3280', { fetch: async (url, init) => {
      if (typeof init.body === 'string') bodies.push(init.body);
      return app.request(new URL(url).pathname, init);
    } });
    const http = new HttpAgentLifecycleControl(transport), executors = new CounterExecutors(directory);
    await executors.initialize(runA); await executors.run(runA, 13);
    await http.plan(owner, agent, { action: 'migrate', expectedVersion: 0, targetRunId: runB }, 'http-counter-migration');
    await new ClientAgentCoordinator(http, new FileClientVault(join(directory, 'owner-only-vault')), executors, 'counter.hash.v1').finish(owner, agent);
    expect(await executors.run(runB, 4)).toEqual(expectedCounter(17));
    expect((await http.get(owner, agent)).intent).toBeNull(); expect((await http.evaluate(owner, agent)).mode).toBe('full');
    for (const body of bodies) { expect(body).not.toContain('recoveryKey'); expect(body).not.toContain(JSON.stringify(expectedCounter(13))); }
    await expect(http.get(foreign, agent)).rejects.toThrow('changed owner or agent scope');
  });
  it('rolls a live application to a preapproved second executor before its source lease expires', async () => {
    reservations.set(runA, { ...reservations.get(runA)!, leaseUntil: new Date(now.getTime() + 1800_000) });
    await service.register(owner, { agent, runId: runA });
    const executors = new CounterExecutors(directory); await executors.initialize(runA); await executors.run(runA, 9);
    const transport = { ...control(), evaluate: (...args: Parameters<AgentLifecycleService['evaluate']>) => service.evaluate(...args),
      plan: (...args: Parameters<AgentLifecycleService['plan']>) => service.plan(...args) };
    const coordinator = new ClientAgentCoordinator(transport, new FileClientVault(join(directory, 'owner-vault')), executors, 'counter.hash.v1');
    const lifeline = new ClientLifeline(transport, coordinator, async () => runB);
    expect((await lifeline.tick(owner, agent)).status).toBe('transition_completed');
    expect(await executors.state(runB)).toEqual(expectedCounter(9));
    const [intent] = await store.db.select().from(agentIntents); expect(intent?.kind).toBe('rollover'); expect(intent?.phase).toBe('done');
    expect((await service.get(owner, agent)).agent.currentRunId).toBe(runB);
  });
});
