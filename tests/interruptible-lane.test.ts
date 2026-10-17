import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { openStore, jobs } from '../src/store.js';
import { hashJson, Problem, randomId, typedQuote, type StoredQuote } from '../src/common.js';
import { CystService } from '../src/cysts/service.js';
import type { CystEnvelope } from '../src/cysts/types.js';
import { exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';
import { AgentLifecycleService } from '../src/agents/service.js';
import { agentIntents } from '../src/agents/schema.js';
import type { ClientAgentRunner, ClientLifecycleControl, ClientLifecycleVault } from '../src/agents/client.js';
import type { AgentMode } from '../src/agents/types.js';
import { createAgentRoutes } from '../src/agents/routes.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { Ed25519Identity, hostMessageHash, type SignedHostLease } from '../src/host-kit/protocol.js';
import { InterruptibleService, HostPreemptionService, InterruptibleClientCoordinator, createInterruptibleRoutes,
  createHostPreemptionRoutes, HttpInterruptibleControl, interruptibleMigrationSQL, interruptibleRuns, hostPreemptionNotices,
  createControllerInterruptibleSettlementReader, canonicalSettlementConfirmation,
  type ApprovedInterruptibleRun, type CompletedInterruptibleSettlement, type InterruptibleAdmission } from '../src/scheduling/interruptible/index.js';
import type { Capacity } from '../src/scheduling/planner.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge } from '../src/bridge.js';
import { Service, signedReceiptSchema } from '../src/service.js';
import { Worker } from '../src/worker.js';
import { RunMeter } from '../src/runtime/meter.js';
import type { CpuExecutor, CpuRunInput, CpuRunResult, TickHandler } from '../src/runtime/types.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import { escrowAbi, tokenAbi, localChain } from '../src/chain/index.js';
import { startLocalChain, deployLocalContracts } from '../scripts/local-chain.js';

const owner = '0x1111111111111111111111111111111111111111', foreign = '0x2222222222222222222222222222222222222222';
const agentAddress = '0x3333333333333333333333333333333333333333';
const runA: Hex = `0x${'aa'.repeat(32)}`, runB: Hex = `0x${'bb'.repeat(32)}`, runC: Hex = `0x${'cc'.repeat(32)}`;
const imageDigest = `sha256:${'a'.repeat(64)}`, image = 'registry.example/counter@' + imageDigest;
const controlKey = new Ed25519Identity(), hostA = new Ed25519Identity(), hostB = new Ed25519Identity();
function capacity(id: number, now: number, overrides: Partial<Capacity> = {}): Capacity {
  return { hostId: `0x${id.toString(16).padStart(64, '0')}`, hardwareClass: 'cpu', region: 'local-fixture', imageDigest,
    sealed: false, lane: 'interruptible', pricePerSecond: '5', reliabilityBps: 10000, strikes: 0, stake: '0',
    availableAt: Math.floor(now / 1000), ...overrides };
}
function sourceLease(runId: Hex, payer: string, hostKey: string, now: number, maxSeconds = 120): SignedHostLease {
  return controlKey.sign('lease', { version: 1, runId, owner: payer.toLowerCase(), hostKey, image,
    argv: ['/usr/local/bin/node', '/opt/telomere/counter.mjs'], issuedAt: now, expiresAt: now + maxSeconds * 1000,
    maxSeconds, nonce: randomId() });
}
class FileVault implements ClientLifecycleVault {
  constructor(readonly directory: string) {}
  async getCheckpoint(id: string) {
    try { const row = JSON.parse(await readFile(join(this.directory, id + '.json'), 'utf8')) as { envelope: CystEnvelope; key: string };
      return { envelope: row.envelope, recoveryKey: importCystRecoveryKey(row.key) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async putCheckpoint(id: string, envelope: CystEnvelope, key: Uint8Array) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, id + '.json'), JSON.stringify({ envelope, key: exportCystRecoveryKey(key) }), { mode: 0o600, flag: 'wx' });
  }
  async recoveryKey(checkpointId: string) {
    for (const file of await readdir(this.directory)) {
      const value = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as { envelope: CystEnvelope; key: string };
      if (value.envelope.id === checkpointId) return importCystRecoveryKey(value.key);
    }
    throw new Error('Owner recovery key unavailable');
  }
}
class UnitRunner implements ClientAgentRunner {
  readonly calls: string[] = []; readonly attachedRuns: string[] = []; readonly completed = new Set<string>();
  constructor(private readonly onStop: (runId: string) => void) {}
  private once(id: string) { if (this.completed.has(id)) return false; this.completed.add(id); this.calls.push(id); return true; }
  async checkpoint(_runId: string, operation: string) { this.once(operation); return new TextEncoder().encode('{"counter":7}'); }
  async stop(runId: string, operation: string) { if (this.once(operation)) this.onStop(runId); }
  async attach(runId: string, operation: string) { if (this.once(operation)) this.attachedRuns.push(runId); }
  async resume(_runId: string, state: Uint8Array, _mode: Exclude<AgentMode, 'cyst'>, operation: string) {
    expect(new TextDecoder().decode(state)).toBe('{"counter":7}'); this.once(operation);
  }
  async profile(_runId: string, _mode: Exclude<AgentMode, 'cyst'>, operation: string) { this.once(operation); }
}

describe('durable opt-in interruptible CPU orchestration with explicit unit runner', () => {
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, cysts: CystService;
  let lifecycle: AgentLifecycleService, scheduling: InterruptibleService, host: HostPreemptionService;
  let now: number, runs: Map<string, ApprovedInterruptibleRun>, catalogue: Capacity[], settlement: CompletedInterruptibleSettlement | null;
  let stoppedTargets: Map<string, CompletedInterruptibleSettlement>;
  let runner: UnitRunner, automaticSettlement: boolean, targetSettlementReady: boolean;
  let hostCleanupConfirmed: boolean, hostStops: string[];
  const control = (): ClientLifecycleControl => ({ get: (...args) => lifecycle.get(...args), acknowledge: (...args) => lifecycle.acknowledge(...args),
    validateExecution: (...args) => lifecycle.validateExecution(...args), upload: (...args) => cysts.upload(...args), download: (...args) => cysts.download(...args) });
  const coordinator = (overrides: Partial<ClientLifecycleControl> = {}) => new InterruptibleClientCoordinator(scheduling,
    { ...control(), ...overrides }, new FileVault(join(directory, 'owner-vault')), runner, 'counter.hash.v1');
  const input = (overrides: Partial<InterruptibleAdmission> = {}): InterruptibleAdmission => ({ agent: agentAddress, runId: runA,
    optIn: true, allowTerminalAgentKill: true, resumeSeconds: 8, maxSpend: '650', deadline: Math.floor(now / 1000) + 90,
    placement: { hardwareClasses: ['cpu'], regions: ['local-fixture'], images: [imageDigest], sealedOnly: false,
      lanes: ['standard', 'interruptible'] }, ...overrides });
  const confirmed = (): CompletedInterruptibleSettlement => ({ runId: runA, owner, agent: agentAddress, receiptId: randomId(),
    billableSeconds: 3, pricePerSecond: '5', ceiling: '600', charged: '15', refund: '585', confirmed: true, cleanupConfirmed: true });
  async function connect(persistent = false) {
    store = await openStore({ DATA_DIR: persistent ? join(directory, 'database') : ':memory:' });
    for (const statement of interruptibleMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    cysts = new CystService(store.db, join(directory, 'ciphertext')); await cysts.initialize();
    lifecycle = new AgentLifecycleService(store.db, { cysts, now: () => new Date(now), balance: async () => '1000000',
      reservedRun: async (payer, agent, runId) => { const row = runs.get(runId); if (!row || row.owner !== payer || row.agent !== agent) throw new Problem(409, 'not_reserved', 'Not reserved');
        return { id: row.runId, owner: row.owner, agent: row.agent, reserved: true, leaseUntil: new Date(row.leaseUntil) }; } });
    scheduling = new InterruptibleService(store.db, { lifecycle, controlKey: controlKey.publicKey, now: () => now,
      approvedRun: async (payer, agent, runId) => { const row = runs.get(runId); if (!row || row.owner !== payer || row.agent !== agent) throw new Problem(409, 'not_reserved', 'Not reserved'); return row; },
      capacities: async () => catalogue, settlement: async (_owner, _agent, runId) => runId === runA ? settlement : targetSettlementReady ? stoppedTargets.get(runId) ?? null : null });
    host = new HostPreemptionService(store.db, hostA, { now: () => now, activeOptedInRun: async (payer, runId) => {
      const rows = await store.db.select().from(interruptibleRuns).where(and(eq(interruptibleRuns.owner, payer), eq(interruptibleRuns.runId, runId)));
      if (!rows[0]) throw new Problem(409, 'not_opted_in', 'No durable opt-in'); return rows[0].source;
    }, stopNoticedRun: async (_owner, runId, noticeId) => { hostStops.push(runId + ':' + noticeId); return { cleanupConfirmed: hostCleanupConfirmed }; } });
  }
  async function admission(overrides: Partial<InterruptibleAdmission> = {}, approve = true) {
    await lifecycle.register(owner, { agent: agentAddress, runId: runA });
    const { run } = await scheduling.admit(owner, input(overrides), 'interruptible-admission');
    if (approve) await scheduling.approveTarget(owner, run.id, runB);
    return run.id;
  }
  async function notice(id: string) {
    const issued = await host.issue(owner, runA, { noticeMilliseconds: 35000, reason: 'maintenance' }, 'host-notice-key');
    await scheduling.acceptNotice(owner, id, issued.notice); return issued.notice;
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-interruptible-')); now = Date.parse('2026-10-09T10:00:00Z');
    catalogue = [capacity(1, now), capacity(2, now), capacity(3, now)];
    runs = new Map([
      [runA, { runId: runA, owner, agent: agentAddress, reserved: true, active: true, hostKey: hostA.publicKey,
        capacity: catalogue[0]!, maxSeconds: 120, ceiling: '600', leaseUntil: now + 120000, sourceLease: sourceLease(runA, owner, hostA.publicKey, now) }],
      [runB, { runId: runB, owner, agent: agentAddress, reserved: true, active: false, hostKey: hostB.publicKey,
        capacity: catalogue[1]!, maxSeconds: 8, ceiling: '40', leaseUntil: now + 120000 }],
      [runC, { runId: runC, owner, agent: agentAddress, reserved: true, active: false, hostKey: hostB.publicKey,
        capacity: catalogue[2]!, maxSeconds: 8, ceiling: '40', leaseUntil: now + 120000 }],
    ]);
    settlement = null; automaticSettlement = true; targetSettlementReady = true; stoppedTargets = new Map(); hostCleanupConfirmed = true; hostStops = [];
    runner = new UnitRunner(runId => { if (runId === runA && automaticSettlement) settlement = confirmed();
      if (runId !== runA) stoppedTargets.set(runId, { ...confirmed(), runId: runId as Hex, receiptId: randomId(), billableSeconds: 0,
        ceiling: '40', charged: '0', refund: '40' }); });
    await connect();
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); await rm(directory, { recursive: true, force: true }); });

  it('requires explicit opt-in, CPU lane, original signed source lease and an already active agent', async () => {
    await lifecycle.register(owner, { agent: agentAddress, runId: runA });
    await expect(scheduling.admit(owner, { ...input(), optIn: false }, 'missing-opt-in')).rejects.toThrow();
    const source = runs.get(runA)!; runs.set(runA, { ...source, capacity: { ...source.capacity, lane: 'standard' } });
    await expect(scheduling.admit(owner, input(), 'wrong-lane')).rejects.toMatchObject({ code: 'interruptible_admission_rejected' });
    runs.set(runA, { ...source, sourceLease: { ...source.sourceLease!, signature: Buffer.alloc(64).toString('base64') } });
    await expect(scheduling.admit(owner, input(), 'wrong-signature')).rejects.toMatchObject({ code: 'interruptible_lease_invalid' });
    expect(await store.db.select().from(interruptibleRuns)).toHaveLength(0);
  });
  it('stores a host-signed immutable >=30s notice and recovers exact issuer/admission retries after expiry', async () => {
    const id = await admission(), signed = await notice(id);
    expect(signed.body.interruptAt - signed.body.issuedAt).toBe(35000);
    expect(signed.body.leaseHash).toBe(hostMessageHash(runs.get(runA)!.sourceLease!));
    now += 40000;
    expect((await host.issue(owner, runA, { noticeMilliseconds: 35000, reason: 'maintenance' }, 'host-notice-key')).notice).toEqual(signed);
    expect((await scheduling.acceptNotice(owner, id, signed)).replayed).toBe(true);
    expect((await scheduling.admit(owner, input({ deadline: Math.floor((now - 40000) / 1000) + 90 }), 'interruptible-admission')).replayed).toBe(true);
    await expect(host.issue(owner, runA, { noticeMilliseconds: 35001, reason: 'maintenance' }, 'host-notice-key')).rejects.toMatchObject({ code: 'preemption_idempotency_conflict' });
    expect(await store.db.select().from(hostPreemptionNotices)).toHaveLength(1);
  });
  it('enforces the signed host deadline without a client, retries uncertain cleanup after journal reopen and targets only the noticed run', async () => {
    await store.close(); await connect(true); const id = await admission(); await notice(id);
    expect(await host.enforceDue()).toEqual({ enforced: [] }); expect(hostStops).toHaveLength(0);
    now += 35000; hostCleanupConfirmed = false;
    await expect(host.enforceDue()).rejects.toMatchObject({ code: 'preemption_cleanup_unconfirmed' });
    expect((await store.db.select().from(hostPreemptionNotices))[0]?.cleanupConfirmed).toBe(0);
    await store.close(); await connect(true); hostCleanupConfirmed = true;
    expect(await host.enforceDue()).toEqual({ enforced: [runA] });
    expect((await store.db.select().from(hostPreemptionNotices))[0]?.cleanupConfirmed).toBe(1);
    expect(await host.enforceDue()).toEqual({ enforced: [] }); expect(hostStops.every(call => call.startsWith(runA + ':'))).toBe(true);
  });
  it.each(['short', 'late', 'signature', 'host', 'run', 'owner', 'lease'] as const)('rejects a %s signed preemption notice before execution', async mode => {
    const id = await admission(), original = (await host.issue(owner, runA, { noticeMilliseconds: 35000, reason: 'maintenance' }, 'host-notice-key')).notice;
    let body = { ...original.body };
    if (mode === 'short') body.interruptAt = now + 29999;
    if (mode === 'late') body.issuedAt = now - 6000;
    if (mode === 'host') body.hostKey = hostB.publicKey;
    if (mode === 'run') body.runId = runB;
    if (mode === 'owner') body.owner = foreign;
    if (mode === 'lease') body.leaseHash = randomId();
    const signed = hostA.sign('control', body); if (mode === 'signature') signed.signature = Buffer.alloc(64).toString('base64');
    await expect(scheduling.acceptNotice(owner, id, signed)).rejects.toMatchObject({ code: 'interruptible_notice_rejected' });
    expect(runner.calls).toEqual([]); expect((await scheduling.get(owner, id)).state).toBe('admitted');
  });
  it('checkpoints and stops before waiting for confirmed completed-seconds settlement, then resumes only its approved next host', async () => {
    const id = await admission(); await notice(id); automaticSettlement = false;
    expect(await coordinator().finish(owner, id)).toMatchObject({ action: 'wait', phase: 'source_settlement', run: { state: 'settling', refundConfirmed: false } });
    expect(runner.calls.map(call => call.split(':')[1])).toEqual(['checkpoint', 'stop']);
    expect((await lifecycle.get(owner, agentAddress)).agent.currentRunId).toBeNull();
    settlement = confirmed(); const result = await coordinator().finish(owner, id);
    expect(result).toMatchObject({ action: 'done', run: { state: 'resumed', targetRunId: runB, spent: '15', remainingBudget: '635', confirmedSourceRefund: '585', completedSeconds: 3 } });
    expect(runner.calls.map(call => call.split(':')[1])).toEqual(['checkpoint', 'stop', 'attach', 'resume']);
    expect((await lifecycle.get(owner, agentAddress)).agent.currentRunId).toBe(runB);
    runs.set(runB, { ...runs.get(runB)!, active: true }); now += 200000;
    expect(await scheduling.advance(owner, id)).toMatchObject({ action: 'done', run: { state: 'resumed' } });
  });
  it('resumes a separately approved standard lane when the target host also posts an interruptible offer', async () => {
    const target = runs.get(runB)!;
    const standard = { ...target.capacity, lane: 'standard' as const };
    runs.set(runB, { ...target, capacity: standard });
    catalogue.push(standard);
    const id = await admission(); await notice(id);
    expect(await coordinator().finish(owner, id)).toMatchObject({ action: 'done', run: { state: 'resumed', targetRunId: runB,
      spent: '15', confirmedSourceRefund: '585' } });
    expect(runner.attachedRuns).toEqual([runB]);
    expect((await lifecycle.get(owner, agentAddress)).agent.currentRunId).toBe(runB);
  });
  it('recovers a lifecycle plan committed before a lost scheduling response and a PGlite reopen', async () => {
    await store.close(); await connect(true); const id = await admission(); await notice(id);
    const original = lifecycle.plan.bind(lifecycle), planned = vi.spyOn(lifecycle, 'plan');
    planned.mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Scheduling response lost'); });
    await expect(scheduling.advance(owner, id)).rejects.toThrow('Scheduling response lost');
    expect((await scheduling.get(owner, id)).state).toBe('noticed');
    await store.close(); await connect(true);
    expect((await coordinator().finish(owner, id)).run.state).toBe('resumed');
    expect(runner.calls.map(call => call.split(':')[1])).toEqual(['checkpoint', 'stop', 'attach', 'resume']);
    expect(await store.db.select().from(agentIntents)).toHaveLength(2);
  });
  it('recovers a lost resume acknowledgment without creating another target or replaying client effects', async () => {
    const id = await admission(); await notice(id); let dropped = false;
    const client = coordinator({ acknowledge: async (...args) => { const result = await lifecycle.acknowledge(...args);
      if ((args[3] as { phase: string }).phase === 'resume' && !dropped) { dropped = true; throw new Error('Resume acknowledgment lost'); } return result; } });
    await expect(client.finish(owner, id)).rejects.toThrow('Resume acknowledgment lost');
    runs.set(runB, { ...runs.get(runB)!, active: true });
    expect((await coordinator().finish(owner, id)).run.state).toBe('resumed');
    expect(runner.calls.filter(call => call.endsWith(':resume'))).toHaveLength(1);
    expect(await store.db.select().from(agentIntents)).toHaveLength(2);
  });
  it('replans to a second already funded CPU host when the selected target disappears before wake, including after restart', async () => {
    await store.close(); await connect(true);
    const id = await admission(); await scheduling.approveTarget(owner, id, runC); await notice(id);
    const client = coordinator();
    await client.step(owner, id);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'wake') throw new Error('Restart before wake intent');
      return originalPlan(...args);
    });
    await expect(client.step(owner, id)).rejects.toThrow('Restart before wake intent');
    expect(await scheduling.get(owner, id)).toMatchObject({ state: 'waking', targetRunId: runB, spent: '15' });
    expect(await store.db.select().from(agentIntents)).toHaveLength(1); // source sleep only
    await store.close(); await connect(true);
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    const result = await coordinator().finish(owner, id);
    expect(result).toMatchObject({ action: 'done', run: { state: 'resumed', targetRunId: runC,
      spent: '15', remainingBudget: '635', confirmedSourceRefund: '585', walletActionRequired: false } });
    expect(runner.attachedRuns).toEqual([runC]);
    expect((await lifecycle.get(owner, agentAddress)).agent.currentRunId).toBe(runC);
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'wake').map(row => row.targetRunId)).toEqual([runC]);
  });
  it('never changes to another approved host after the original target has a durable wake intent', async () => {
    const id = await admission(); await scheduling.approveTarget(owner, id, runC); await notice(id);
    const client = coordinator(); await client.step(owner, id); await client.step(owner, id); await client.step(owner, id);
    expect(runner.attachedRuns).toEqual([runB]);
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    expect(await client.finish(owner, id)).toMatchObject({ action: 'done', run: { state: 'cancelled', targetRunId: runB,
      confirmedSourceRefund: '585', confirmedTargetRefund: '40', spent: '15' } });
    expect(runner.attachedRuns).toEqual([runB]);
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'wake').map(row => row.targetRunId)).toEqual([runB]);
  });
  it('refreshes a stale cancel version when a wake acknowledgment races the terminal stop', async () => {
    const id = await admission(); await notice(id);
    const client = coordinator(); await client.step(owner, id); await client.step(owner, id); await client.step(owner, id);
    expect((await lifecycle.get(owner, agentAddress)).intent?.phase).toBe('resume');
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    let raced = false;
    vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'kill' && !raced) {
        raced = true;
        const wake = (await lifecycle.get(owner, agentAddress)).intent!;
        expect(wake.phase).toBe('resume');
        await lifecycle.acknowledge(owner, wake.id, wake.version, { phase: 'resume' });
      }
      return originalPlan(...args);
    });
    expect(await client.finish(owner, id)).toMatchObject({ action: 'done', run: { state: 'cancelled',
      targetRunId: runB, confirmedTargetRefund: '40' } });
    expect(raced).toBe(true);
    expect((await lifecycle.get(owner, agentAddress)).agent).toMatchObject({ currentRunId: null,
      killedAt: expect.any(String) });
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'kill')).toHaveLength(1);
  });
  it('does not enter cancellation after the owner starts a different wake transition', async () => {
    const id = await admission(); await notice(id);
    const client = coordinator(); await client.step(owner, id);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    const paused = vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'wake') throw new Error('Pause before handoff wake');
      return originalPlan(...args);
    });
    await expect(client.step(owner, id)).rejects.toThrow('Pause before handoff wake');
    paused.mockRestore();
    expect((await scheduling.get(owner, id)).state).toBe('waking');
    const current = await lifecycle.get(owner, agentAddress);
    const ownerWake = await lifecycle.plan(owner, agentAddress,
      { action: 'wake', expectedVersion: current.agent.version, targetRunId: runC }, 'owner-independent-wake');
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    await expect(scheduling.advance(owner, id)).rejects.toMatchObject({ code: 'interruptible_agent_changed' });
    expect((await lifecycle.get(owner, agentAddress)).intent?.id).toBe(ownerWake.intent.id);
    expect((await lifecycle.get(owner, agentAddress)).agent.killedAt).toBeNull();
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'kill')).toHaveLength(0);
  });
  it('does not retry terminal kill over a new owner transition after a version race', async () => {
    const id = await admission(); await notice(id);
    const client = coordinator(); await client.step(owner, id); await client.step(owner, id); await client.step(owner, id);
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    let ownerSleepId: string | undefined;
    let raced = false;
    vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'kill' && !raced) {
        raced = true;
        const wake = (await lifecycle.get(owner, agentAddress)).intent!;
        await lifecycle.acknowledge(owner, wake.id, wake.version, { phase: 'resume' });
        const latest = await lifecycle.get(owner, agentAddress);
        const ownerSleep = await originalPlan(owner, agentAddress,
          { action: 'sleep', expectedVersion: latest.agent.version }, 'owner-independent-sleep');
        ownerSleepId = ownerSleep.intent.id;
      }
      return originalPlan(...args);
    });
    await expect(scheduling.advance(owner, id)).rejects.toMatchObject({ code: 'interruptible_agent_changed' });
    expect(raced).toBe(true);
    expect((await lifecycle.get(owner, agentAddress)).intent?.id).toBe(ownerSleepId);
    expect((await lifecycle.get(owner, agentAddress)).agent).toMatchObject({ currentRunId: runB, killedAt: null });
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'kill')).toHaveLength(0);
  });
  it('waits for the original target receipt after the owner stops it during a cancel race', async () => {
    const id = await admission(); await notice(id);
    const client = coordinator(); await client.step(owner, id); await client.step(owner, id); await client.step(owner, id);
    catalogue = catalogue.filter(item => item.hostId !== runs.get(runB)!.capacity.hostId);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    let raced = false;
    vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'kill' && !raced) {
        raced = true;
        const wake = (await lifecycle.get(owner, agentAddress)).intent!;
        await lifecycle.acknowledge(owner, wake.id, wake.version, { phase: 'resume' });
        const resumed = await lifecycle.get(owner, agentAddress);
        const ownerSleep = await originalPlan(owner, agentAddress,
          { action: 'sleep', expectedVersion: resumed.agent.version }, 'owner-stop-target');
        const checkpoint = await cysts.metadata(owner, resumed.agent.checkpointId!);
        const saved = await lifecycle.acknowledge(owner, ownerSleep.intent.id, ownerSleep.intent.version,
          { phase: 'checkpoint', checkpointId: checkpoint.id, checkpointSha256: checkpoint.sha256 });
        await runner.stop(runB, 'owner-stop-target');
        await lifecycle.acknowledge(owner, saved.intent.id, saved.intent.version, { phase: 'stop' });
        targetSettlementReady = false;
      }
      return originalPlan(...args);
    });
    expect(await scheduling.advance(owner, id)).toMatchObject({ action: 'wait', phase: 'target_settlement',
      run: { state: 'cancelling', confirmedTargetRefund: null } });
    expect(raced).toBe(true);
    expect((await lifecycle.get(owner, agentAddress)).agent.killedAt).toBeNull();
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'kill')).toHaveLength(0);
    targetSettlementReady = true;
    expect(await scheduling.advance(owner, id)).toMatchObject({ action: 'done', run: { state: 'cancelled',
      confirmedTargetRefund: '40', spent: '15' } });
  });
  it('stops and accounts for the original host if its wake plan races a different target selection', async () => {
    const id = await admission(); await scheduling.approveTarget(owner, id, runC); await notice(id);
    const client = coordinator(); await client.step(owner, id);
    const originalPlan = lifecycle.plan.bind(lifecycle);
    const spy = vi.spyOn(lifecycle, 'plan').mockImplementation(async (...args) => {
      if ((args[2] as { action: string }).action === 'wake') throw new Error('Pause before wake intent');
      return originalPlan(...args);
    });
    await expect(client.step(owner, id)).rejects.toThrow('Pause before wake intent');
    spy.mockRestore();
    const [scheduled] = await store.db.select().from(interruptibleRuns).where(eq(interruptibleRuns.id, id));
    expect(scheduled?.targetRunId).toBe(runB);
    await lifecycle.plan(owner, agentAddress, { action: 'wake', expectedVersion: scheduled!.wakeVersion!, targetRunId: runB },
      'interrupt_wake_' + id.slice(2));
    // Model a concurrent scheduler that read before the wake commit and then selected C.
    await store.db.update(interruptibleRuns).set({ targetRunId: runC }).where(eq(interruptibleRuns.id, id));
    const result = await coordinator().finish(owner, id);
    expect(result).toMatchObject({ action: 'done', run: { state: 'cancelled', targetRunId: runB,
      reason: 'wake_intent_target_race', confirmedTargetRefund: '40', spent: '15' } });
    expect(runner.attachedRuns).toEqual([]);
    expect((await store.db.select().from(agentIntents)).filter(row => row.kind === 'wake').map(row => row.targetRunId)).toEqual([runB]);
  });
  it.each(['deadline', 'budget', 'capacity', 'approval'] as const)('cancels after confirmed source stop when %s is infeasible and reports the original refund', async reason => {
    const id = await admission(reason === 'budget' ? { maxSpend: '600' } : {}, reason !== 'approval'); await notice(id); automaticSettlement = false;
    await coordinator().finish(owner, id); settlement = confirmed();
    if (reason === 'deadline') now += 85000;
    if (reason === 'budget') settlement = { ...confirmed(), billableSeconds: 120, charged: '600', refund: '0' };
    if (reason === 'capacity') catalogue = [catalogue[0]!];
    const result = await coordinator().finish(owner, id);
    expect(result).toMatchObject({ action: 'done', run: { state: 'cancelled', targetRunId: null, walletActionRequired: false, confirmedSourceRefund: settlement.refund } });
    expect(runner.calls.map(call => call.split(':')[1])).toEqual(['checkpoint', 'stop']);
    expect((await lifecycle.get(owner, agentAddress)).agent.killedAt).toBeNull();
  });
  it('rechecks after attach; a missed deadline supersedes pending wake with terminal stop and forbids stale resume', async () => {
    const id = await admission(); await notice(id); const client = coordinator();
    await client.step(owner, id); await client.step(owner, id); // checkpoint, stop; source settles and approved wake is prepared
    expect((await scheduling.get(owner, id)).state).toBe('waking');
    await client.step(owner, id); // attach
    const stale = (await lifecycle.get(owner, agentAddress)).intent!; expect(stale.phase).toBe('resume');
    now += 85000;
    expect((await client.finish(owner, id)).run.state).toBe('cancelled');
    expect(runner.calls.filter(call => call.endsWith(':resume'))).toHaveLength(0);
    expect((await lifecycle.get(owner, agentAddress)).agent.killedAt).not.toBeNull();
    await expect(lifecycle.validateExecution(owner, stale.id, stale.version, 'resume')).rejects.toThrow();
  });
  it('waits for the stopped target receipt before claiming cancellation accounting or its refund', async () => {
    const id = await admission(); await notice(id); const client = coordinator();
    await client.step(owner, id); await client.step(owner, id); await client.step(owner, id);
    now += 85000; targetSettlementReady = false;
    expect(await client.finish(owner, id)).toMatchObject({ action: 'wait', phase: 'target_settlement',
      run: { state: 'cancelling', confirmedSourceRefund: '585', confirmedTargetRefund: null } });
    expect(runner.calls.filter(call => call.endsWith(':resume'))).toHaveLength(0);
    targetSettlementReady = true;
    expect(await client.finish(owner, id)).toMatchObject({ action: 'done', run: { state: 'cancelled', spent: '15',
      confirmedSourceRefund: '585', confirmedTargetRefund: '40', remainingBudget: '635' } });
  });
  it('cannot bill incomplete seconds, invent an unconfirmed refund or switch receipt owner/agent', async () => {
    const id = await admission(); await notice(id); automaticSettlement = false; await coordinator().finish(owner, id);
    for (const altered of [{ ...confirmed(), charged: '16', refund: '584' }, { ...confirmed(), owner: foreign },
      { ...confirmed(), agent: foreign }, { ...confirmed(), confirmed: false }, { ...confirmed(), billableSeconds: 3.5 }]) {
      settlement = altered as CompletedInterruptibleSettlement;
      await expect(scheduling.advance(owner, id)).rejects.toThrow();
      expect((await scheduling.get(owner, id)).refundConfirmed).toBe(false);
    }
  });
  it('expires a missed checkpoint notice into source stop and never attaches the reserved target', async () => {
    const id = await admission(); await notice(id); now += 35000;
    const progress = await coordinator().finish(owner, id);
    expect(progress.run).toMatchObject({ state: 'cancelled', reason: 'checkpoint_notice_expired', confirmedSourceRefund: '585' });
    expect(runner.calls.map(call => call.split(':')[1])).toEqual(['stop']);
    expect((await lifecycle.get(owner, agentAddress)).agent.killedAt).not.toBeNull();
  });
  it('removes a withdrawn reserved target from consideration and preserves owner cancellation without a replacement payment', async () => {
    const id = await admission(); await notice(id); automaticSettlement = false; await coordinator().finish(owner, id);
    runs.delete(runB); settlement = confirmed();
    const result = await coordinator().finish(owner, id);
    expect(result.run).toMatchObject({ state: 'cancelled', unconfirmedTargetReservations: [{ runId: runB, ceiling: '40', refundStatus: 'unconfirmed' }] });
    expect(runner.calls.filter(call => call.endsWith(':attach'))).toHaveLength(0);
  });
  it('drives checkpoint, stop and guarded next-host resume through the bounded owner REST clients', async () => {
    await lifecycle.register(owner, { agent: agentAddress, runId: runA }); const app = new Hono(), sent: string[] = [];
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    app.route('/api/interruptible', createInterruptibleRoutes(scheduling, async () => owner));
    app.route('/api/agents', createAgentRoutes(lifecycle, async () => owner)); app.route('/api/cysts', createCystRoutes(cysts, async () => owner));
    const transport = new ApiTransport('http://127.0.0.1:3280', { fetch: async (url, init) => {
      if (typeof init.body === 'string') sent.push(init.body); return app.request(new URL(url).pathname, init);
    } });
    const scheduler = new HttpInterruptibleControl(transport), admitted = await scheduler.admit(owner, input(), 'rest-interruptible-admission');
    await scheduler.approveTarget(owner, admitted.run.id, runB);
    await scheduler.acceptNotice(owner, admitted.run.id, (await host.issue(owner, runA, { noticeMilliseconds: 35000, reason: 'capacity' }, 'rest-host-notice-key')).notice);
    const client = new InterruptibleClientCoordinator(scheduler, new HttpAgentLifecycleControl(transport), new FileVault(join(directory, 'owner-vault')), runner, 'counter.hash.v1');
    expect((await client.finish(owner, admitted.run.id)).run.state).toBe('resumed');
    await expect(scheduler.get(foreign, admitted.run.id)).rejects.toThrow('changed owner');
    for (const body of sent) { expect(body).not.toContain('recoveryKey'); expect(body).not.toContain('{"counter":7}'); }
  });
  it('uses authenticated owner scope for all routes and exposes no wallet, plaintext or arbitrary notice-signing endpoint', async () => {
    const id = await admission(); let authenticated = owner; const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    const auth = async () => { if (!authenticated) throw new Problem(401, 'unauthorized', 'Sign in'); return authenticated; };
    app.route('/api/interruptible', createInterruptibleRoutes(scheduling, auth));
    app.route('/api/host-preemption', createHostPreemptionRoutes(host, auth));
    expect((await app.request('/api/interruptible/' + id)).headers.get('Cache-Control')).toBe('no-store');
    authenticated = foreign;
    expect((await app.request('/api/interruptible/' + id)).status).toBe(404);
    expect(await (await app.request('/api/interruptible')).json()).toEqual({ runs: [] });
    expect((await app.request(`/api/host-preemption/${runA}/notices`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'foreign-host-notice' },
      body: JSON.stringify({ noticeMilliseconds: 35000, reason: 'maintenance' }) })).status).toBe(409);
    authenticated = ''; expect((await app.request('/api/interruptible')).status).toBe(401);
    for (const path of ['sign', 'pay', 'plaintext', 'private-key']) expect((await app.request('/api/interruptible/' + path, { method: 'POST' })).status).toBe(404);
    const stored = JSON.stringify(await store.db.select().from(interruptibleRuns)); expect(stored).not.toContain('recoveryKey'); expect(stored).not.toContain('{"counter":7}');
  });
});

interface CounterState { counter: number; hash: string }
function expectedCounter(steps: number): CounterState {
  const state = { counter: 0, hash: '00'.repeat(32) };
  for (let index = 0; index < steps; index++) { state.counter++; state.hash = createHash('sha256').update(state.hash + ':' + state.counter).digest('hex'); }
  return state;
}
// Explicit local child-process application fixture. This does not provide a container or gVisor boundary.
const liveCounterProgram = `
import { readFile, writeFile } from 'node:fs/promises'; import { createHash } from 'node:crypto';
const [file, limit] = process.argv.slice(1); let state = JSON.parse(await readFile(file,'utf8')), paused=false, busy=false;
const save=()=>writeFile(file,JSON.stringify(state),{mode:0o600});
const timer=setInterval(async()=>{if(paused||busy)return;busy=true;state.counter++;state.hash=createHash('sha256').update(state.hash+':'+state.counter).digest('hex');
 await save();process.send({type:'state',state});busy=false;if(state.counter>=Number(limit)){clearInterval(timer);process.send({type:'done',state});process.disconnect();}},100);
process.on('message',async message=>{if(message==='checkpoint'){paused=true;while(busy)await new Promise(r=>setTimeout(r,5));await save();process.send({type:'checkpoint',state});}
 if(message==='stop'){paused=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,5));await save();process.send({type:'done',state});process.disconnect();}});
process.send({type:'ready',state});
`;
class LiveCounterFixture implements ClientAgentRunner, CpuExecutor {
  readonly calls: string[] = []; readonly processes = new Map<string, ChildProcess>(); readonly completed = new Set<string>();
  readonly observations = new Map<string, CounterState>(); readonly cleanup = new Set<string>(); readonly exit = new Map<string, Promise<void>>();
  readonly requested = new Set<string>(); private total = 40;
  constructor(readonly directory: string, private readonly onResume: (runId: string) => Promise<void>) {}
  private file(run: string) { return join(this.directory, run.slice(2) + '.state.json'); }
  private operation(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.operation'); }
  async initialize(run: string) { await writeFile(this.file(run), JSON.stringify(expectedCounter(0)), { mode: 0o600 }); }
  async state(run: string): Promise<CounterState> { return JSON.parse(await readFile(this.file(run), 'utf8')) as CounterState; }
  private async once(id: string, action: () => Promise<void>) {
    try { await readFile(this.operation(id)); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await action(); await writeFile(this.operation(id), 'done', { flag: 'wx', mode: 0o600 }); this.calls.push(id);
  }
  async checkpoint(run: string, operation: string) {
    try { return new Uint8Array(await readFile(this.operation(operation))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const child = this.processes.get(run); if (!child || !child.connected) throw new Error('Source child is unavailable');
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Checkpoint response timeout')), 3000);
      const listener = (message: { type: string }) => { if (message.type === 'checkpoint') { clearTimeout(timer); child.off('message', listener); resolve(); } };
      child.on('message', listener); child.send('checkpoint'); });
    const bytes = await readFile(this.file(run)); await writeFile(this.operation(operation), bytes, { mode: 0o600, flag: 'wx' }); this.calls.push(operation); return new Uint8Array(bytes);
  }
  async stop(run: string, operation: string) {
    await this.once(operation, async () => { this.requested.add(run); const child = this.processes.get(run);
      if (child?.connected) child.send('stop'); await this.exit.get(run); this.cleanup.add(run); });
  }
  async attach(_run: string, operation: string) { await this.once(operation, async () => undefined); }
  async resume(run: string, bytes: Uint8Array, _mode: Exclude<AgentMode, 'cyst'>, operation: string) {
    await this.once(operation, async () => { await writeFile(this.file(run), bytes, { mode: 0o600 }); await this.onResume(run); });
  }
  async profile(_run: string, _mode: Exclude<AgentMode, 'cyst'>, operation: string) { await this.once(operation, async () => undefined); }
  async run(input: CpuRunInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult> {
    const child = spawn(process.execPath, ['--input-type=module', '-e', liveCounterProgram, this.file(input.runId), String(this.total)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    this.processes.set(input.runId, child); const start = performance.now(), meter = new RunMeter(input.runId, input.maxSeconds, onTick);
    const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(new Error('Counter child failed')); else resolve(); }); });
    this.exit.set(input.runId, done);
    child.on('message', (message: { type: string; state: CounterState }) => { if (message.state) this.observations.set(input.runId, message.state); });
    await meter.emit('running', 0); const ticker = setInterval(() => { void meter.emit('running', performance.now() - start); }, 500);
    const abort = () => { this.requested.add(input.runId); if (child.connected) child.send('stop'); }; signal.addEventListener('abort', abort, { once: true });
    try { await done; } finally { clearInterval(ticker); signal.removeEventListener('abort', abort); }
    this.cleanup.add(input.runId); const output = JSON.stringify(await this.state(input.runId)), status = this.requested.has(input.runId) ? 'cancelled' : 'completed';
    await meter.emit(status, performance.now() - start, output); await meter.flush();
    return validateCpuResult({ output, status, billableSeconds: meter.ticks.at(-1)!.billableSeconds, ticks: meter.ticks,
      exitCode: status === 'completed' ? 0 : -1 }, input.runId, input.maxSeconds);
  }
  async close() { for (const [run, child] of this.processes) { if (child.connected) child.send('stop'); await this.exit.get(run); } }
}

describe('interruptible acceptance on two real local child processes and disposable Anvil escrow', () => {
  it('restores encrypted portable state after a real PGlite reopen and settles controller receipts for completed seconds only with no new payment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-preempt-acceptance-')), local = await startLocalChain();
    let store = await openStore({ DATA_DIR: join(directory, 'database') }); let fixture: LiveCounterFixture | undefined;
    try {
      const deployment = await deployLocalContracts(local), payer = deployment.accounts.owner.address.toLowerCase(), payerAddress = deployment.accounts.owner.address;
      const wallet = createWalletClient({ chain: localChain, transport: http(local.rpcUrl), account: deployment.accounts.owner });
      async function confirmed(transaction: Promise<Hex>) { const result = await local.publicClient.waitForTransactionReceipt({ hash: await transaction }); expect(result.status).toBe('success'); return result; }
      await confirmed(wallet.writeContract({ address: deployment.tokenAddress, abi: tokenAbi, functionName: 'faucet', args: [payerAddress, 10000n] }));
      await confirmed(wallet.writeContract({ address: deployment.tokenAddress, abi: tokenAbi, functionName: 'approve', args: [deployment.escrowAddress, 10000n] }));
      await confirmed(wallet.writeContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [10000n] }));
      const leashId = randomId(), expiry = (await local.publicClient.getBlock()).timestamp + 3600n;
      await confirmed(wallet.writeContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: 'createLeash', args: [leashId, agentAddress as Address, 10000n, 10000n, expiry] }));
      const config = loadConfig({ MODE: 'demo', DATA_DIR: join(directory, 'database'), RPC_URL: local.rpcUrl,
        SIGNER_PRIVATE_KEY: deployment.keys.signer, DEMO_PRIVATE_KEY: deployment.keys.owner, ESCROW_ADDRESS: deployment.escrowAddress,
        TOKEN_ADDRESS: deployment.tokenAddress, CPU_MODE: 'demo', CPU_PRICE_PER_SECOND: '5' });
      const bridge = new ChainBridge(config); await bridge.check(); const now = Date.now();
      const a = capacity(1, now), b = capacity(2, now), actualRuns = new Map<string, ApprovedInterruptibleRun>();
      const quoteA: StoredQuote = { runId: runA, leashId, payer: payerAddress, workloadHash: randomId(), maxSeconds: 60,
        pricePerSecond: '5', inferencePrice: '0', quoteExpiry: Number((await local.publicClient.getBlock()).timestamp) + 300 };
      const quoteB: StoredQuote = { ...quoteA, runId: runB, maxSeconds: 10, workloadHash: randomId() };
      for (const quote of [quoteA, quoteB]) {
        const signature = await bridge.signQuote(typedQuote(quote));
        const opened = await confirmed(wallet.writeContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: 'openRun', args: [typedQuote(quote), signature] }));
        await store.db.insert(jobs).values({ id: quote.runId, owner: payer, agentAddress, leashId, idemKey: quote.runId, inputHash: hashJson(quote),
          input: { leashId, task: { kind: 'sha256', text: 'explicit-live-counter-process-fixture' }, maxSeconds: quote.maxSeconds },
          quote, signature, ceiling: (BigInt(quote.maxSeconds) * 5n).toString(), status: quote.runId === runA ? 'queued' : 'prepared', txHash: opened.transactionHash });
      }
      const ownerNonceAfterApprovals = await local.publicClient.getTransactionCount({ address: payerAddress });
      const originalLease = sourceLease(runA, payer, hostA.publicKey, now, 60);
      actualRuns.set(runA, { runId: runA, owner: payer, agent: agentAddress, reserved: true, active: true,
        hostKey: hostA.publicKey, capacity: a, maxSeconds: 60, ceiling: '300', leaseUntil: now + 60000, sourceLease: originalLease });
      actualRuns.set(runB, { runId: runB, owner: payer, agent: agentAddress, reserved: true, active: false,
        hostKey: hostB.publicKey, capacity: b, maxSeconds: 10, ceiling: '50', leaseUntil: now + 120000 });
      let cysts: CystService, lifecycle: AgentLifecycleService, scheduling: InterruptibleService;
      async function connect() {
        for (const statement of interruptibleMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
        cysts = new CystService(store.db, join(directory, 'ciphertext')); await cysts.initialize();
        lifecycle = new AgentLifecycleService(store.db, { cysts, balance: async () => (await bridge.balance(payerAddress)).available,
          reservedRun: async (authenticated, agent, id) => { const reserved = actualRuns.get(id), chainRun = await bridge.run(id as Hex), leash = await bridge.leash(leashId);
            if (!reserved || reserved.owner !== authenticated || reserved.agent !== agent || chainRun.status !== 1 || leash.agent.toLowerCase() !== agent) throw new Problem(409, 'not_reserved', 'Not reserved');
            return { id, owner: authenticated, agent, reserved: true, leaseUntil: new Date(reserved.leaseUntil) }; } });
        const settlement = createControllerInterruptibleSettlementReader(store.db, { chainId: 31337, escrowAddress: deployment.escrowAddress,
          tokenAddress: deployment.tokenAddress, receiptSigner: deployment.accounts.signer.address }, {
          confirmSettlement: canonicalSettlementConfirmation(bridge), cleanupConfirmed: async (_owner, id) => fixture!.cleanup.has(id) });
        scheduling = new InterruptibleService(store.db, { lifecycle, controlKey: controlKey.publicKey,
          approvedRun: async (authenticated, agent, id) => { const reserved = actualRuns.get(id), chainRun = await bridge.run(id as Hex);
            if (!reserved || reserved.owner !== authenticated || reserved.agent !== agent || chainRun.status !== 1) throw new Problem(409, 'not_reserved', 'Not reserved'); return reserved; },
          capacities: async () => [a, b], settlement });
      }
      await connect();
      fixture = new LiveCounterFixture(directory, async id => { await store.db.update(jobs).set({ status: 'queued' }).where(eq(jobs.id, id)); });
      await fixture.initialize(runA); const sourceWorker = new Worker(store.db, bridge, fixture, undefined, pino({ enabled: false }));
      const sourceExecution = sourceWorker.drainOnce();
      const started = Date.now(); while ((fixture.observations.get(runA)?.counter ?? 0) < 13) {
        if (Date.now() - started > 10000) throw new Error('Source actual child did not advance'); await new Promise(resolve => setTimeout(resolve, 25));
      }
      await lifecycle!.register(payer, { agent: agentAddress, runId: runA });
      const admitted = await scheduling!.admit(payer, { agent: agentAddress, runId: runA, optIn: true, allowTerminalAgentKill: true,
        resumeSeconds: 10, maxSpend: '350', deadline: Math.floor(Date.now() / 1000) + 55,
        placement: { hardwareClasses: ['cpu'], regions: ['local-fixture'], images: [imageDigest], sealedOnly: false, lanes: ['interruptible'] } }, 'actual-child-preemption');
      const id = admitted.run.id; await scheduling!.approveTarget(payer, id, runB);
      const issuer = new HostPreemptionService(store.db, hostA, { activeOptedInRun: async () => actualRuns.get(runA)!,
        stopNoticedRun: async (_owner, runId, noticeId) => { await fixture!.stop(runId, noticeId + ':host-preempt'); return { cleanupConfirmed: fixture!.cleanup.has(runId) }; } });
      const signedNotice = (await issuer.issue(payer, runA, { noticeMilliseconds: 35000, reason: 'capacity' }, 'real-counter-notice')).notice;
      await scheduling!.acceptNotice(payer, id, signedNotice);
      const lifecycleControl = (): ClientLifecycleControl => ({ get: (...args) => lifecycle!.get(...args), acknowledge: (...args) => lifecycle!.acknowledge(...args),
        validateExecution: (...args) => lifecycle!.validateExecution(...args), upload: (...args) => cysts!.upload(...args), download: (...args) => cysts!.download(...args) });
      const client = () => new InterruptibleClientCoordinator(scheduling!, lifecycleControl(), new FileVault(join(directory, 'owner-vault')), fixture!, 'counter.hash.v1');
      await client().step(payer, id); const saved = await fixture.state(runA);
      await client().step(payer, id); await sourceExecution;
      const [settledA] = await store.db.select().from(jobs).where(eq(jobs.id, runA));
      expect(settledA?.status).toBe('cancelled'); expect(settledA!.billableSeconds).toBeGreaterThanOrEqual(1);
      expect(BigInt(settledA!.charged!)).toBe(BigInt(settledA!.billableSeconds) * 5n);
      expect(BigInt(settledA!.charged!) + BigInt(settledA!.refund!)).toBe(300n);
      await store.close(); store = await openStore({ DATA_DIR: join(directory, 'database') }); await connect();
      expect((await client().finish(payer, id)).run.state).toBe('resumed');
      expect(await fixture.state(runB)).toEqual(saved); expect(fixture.processes.size).toBe(1);
      await new Worker(store.db, bridge, fixture, undefined, pino({ enabled: false })).drainOnce();
      expect(fixture.processes.size).toBe(2); expect(fixture.processes.get(runA)!.pid).not.toBe(fixture.processes.get(runB)!.pid);
      expect(await fixture.state(runB)).toEqual(expectedCounter(40));
      const [settledB] = await store.db.select().from(jobs).where(eq(jobs.id, runB));
      expect(settledB?.status).toBe('completed');
      for (const job of [settledA!, settledB!]) {
        const receipt = signedReceiptSchema.parse(job.receipt); await bridge.confirmedSettlement({ ...receipt.settlement,
          billableSeconds: BigInt(receipt.settlement.billableSeconds), inferenceCharge: BigInt(receipt.settlement.inferenceCharge) }, job.settlementTxHash as Hex);
        expect(BigInt(job.charged!)).toBe(BigInt(job.billableSeconds) * 5n); expect(BigInt(job.charged!) + BigInt(job.refund!)).toBe(BigInt(job.ceiling));
      }
      expect(await local.publicClient.getTransactionCount({ address: payerAddress })).toBe(ownerNonceAfterApprovals);
      expect(fixture.calls.map(call => call.split(':')[1])).toEqual(['checkpoint', 'stop', 'attach', 'resume']);
      expect((await store.db.select().from(interruptibleRuns))[0]?.checkpointId).not.toBeNull();
      expect(await new Service(store.db, bridge, config, false).balance(payerAddress)).toMatchObject({ reserved: '0' });
    } finally { await fixture?.close(); await store.close(); await local.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60000);
});
