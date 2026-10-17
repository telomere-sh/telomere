import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Problem } from '../src/common.js';
import { AgentLifecycleService } from '../src/agents/service.js';
import { createAgentRoutes } from '../src/agents/routes.js';
import { RegisteredAgentCheckpointCadence } from '../src/agents/checkpoint-cadence.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { CystService } from '../src/cysts/service.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { CystClient, encryptCheckpoint } from '../src/sdk/cysts.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { openStore } from '../src/store.js';

const owner = '0x' + '11'.repeat(20), agent = '0x' + '22'.repeat(20), foreign = '0x' + '33'.repeat(20);
const runA = '0x' + 'aa'.repeat(32), runB = '0x' + 'bb'.repeat(32);
const token = 'a'.repeat(64), foreignToken = 'b'.repeat(64);
const interval = 15 * 60_000;
const execute = promisify(execFile);
const counterProgram = `
import { readFile, writeFile } from 'node:fs/promises';
const [path, steps] = process.argv.slice(1);
const state = JSON.parse(await readFile(path, 'utf8'));
state.counter += Number(steps);
await writeFile(path, JSON.stringify(state));
`;

describe('registered agent automatic owner-side Cyst cadence', () => {
  let directory: string, server: Server | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  let cysts: CystService, lifecycle: AgentLifecycleService, origin: string, nowMs: number;
  let statePath: string, statePathB: string, vaultPath: string, masterKey: Uint8Array;
  let checkpointCalls: string[];

  async function boot() {
    store = await openStore({ DATA_DIR: join(directory, 'database') });
    cysts = new CystService(store.db, join(directory, 'server-ciphertext')); await cysts.initialize();
    lifecycle = new AgentLifecycleService(store.db, { cysts, now: () => new Date(nowMs), balance: async () => '1000000',
      reservedRun: async (_owner, _agent, runId) => {
        if (runId !== runA && runId !== runB) throw new Error('Unfunded test reservation');
        return { id: runId, owner, agent, reserved: true, leaseUntil: new Date(nowMs + 12 * 3600_000) };
      } });
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_failed' },
      error instanceof Problem ? error.status : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('Origin') !== origin) {
        throw new Problem(403, 'origin_mismatch', 'Origin differs');
      }
      await next();
    });
    const authenticated = async (context: { req: { header(name: string): string | undefined } }) => {
      const cookie = context.req.header('Cookie');
      if (cookie === 'telomere_session=' + token) return owner;
      if (cookie === 'telomere_session=' + foreignToken) return foreign;
      throw new Problem(401, 'sign_in', 'Session required');
    };
    app.route('/api/agents', createAgentRoutes(lifecycle, authenticated));
    app.route('/api/cysts', createCystRoutes(cysts, authenticated));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
    origin = 'http://127.0.0.1:' + address.port;
  }
  async function shutdown() {
    if (server) { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
    await store?.close(); store = undefined;
  }
  const control = () => new HttpAgentLifecycleControl(new ApiTransport(origin, { sessionToken: token }));
  const cystClient = (fetcher?: typeof fetch) => new CystClient(new ApiTransport(origin,
    { sessionToken: token, ...(fetcher ? { fetch: fetcher } : {}) }));
  const vault = () => new CystCheckpointFileVault({ directory: vaultPath, masterKey });
  const runner = { checkpoint: async (runId: string, operationId: string): Promise<Uint8Array> => {
    if (runId !== runA && runId !== runB) throw new Error('Test runner has no active source');
    const operationFile = join(directory, createHash('sha256').update(operationId).digest('hex') + '.snapshot');
    let data: Buffer;
    try { data = await readFile(operationFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = await readFile(runId === runA ? statePath : statePathB);
      await writeFile(operationFile, data, { mode: 0o600, flag: 'wx' });
      checkpointCalls.push(operationId);
    }
    return new Uint8Array(data);
  } };
  const cadence = (cystsClient = cystClient(), onError?: (error: unknown) => void, intervalMs = interval) =>
    new RegisteredAgentCheckpointCadence({ owner, agent, applicationSchema: 'counter.v1', cysts: cystsClient,
      vault: vault(), control: control(), runner, now: () => nowMs, intervalMs, ...(onError ? { onError } : {}) });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-agent-cadence-'));
    statePath = join(directory, 'state.json'); statePathB = join(directory, 'state-b.json');
    vaultPath = join(directory, 'private-owner-vault');
    await mkdir(vaultPath, { mode: 0o700 }); await writeFile(statePath, JSON.stringify({ counter: 0, secret: 'owner-private-state' }), { mode: 0o600 });
    masterKey = randomBytes(32); nowMs = Date.parse('2026-10-13T12:00:00.000Z'); checkpointCalls = [];
    await boot(); await control().register(owner, agent, runA);
  });
  afterEach(async () => { await shutdown(); masterKey.fill(0); await rm(directory, { recursive: true, force: true }); });

  it('captures actual registered application state at 15 minutes, retries a lost HTTP ACK after DB/vault reopen and restores privately', async () => {
    const first = cadence(); expect(await first.tick()).toMatchObject({ status: 'idle', nextDueAtMs: nowMs + interval });
    await execute(process.execPath, ['--input-type=module', '-e', counterProgram, statePath, '5']);
    nowMs += interval - 1; expect(await first.tick()).toMatchObject({ status: 'idle' });
    nowMs++;
    let loseAck = true;
    const uncertain = cadence(cystClient(async (url, init) => {
      const response = await fetch(url, init);
      if (loseAck && init?.method === 'POST' && String(url).endsWith('/api/cysts')) {
        loseAck = false; await response.arrayBuffer(); throw new Error('Lost actual upload acknowledgement');
      }
      return response;
    }));
    await expect(uncertain.tick()).rejects.toThrow('Lost actual upload acknowledgement');
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    expect(checkpointCalls).toHaveLength(1);
    const ciphertextFiles = await readdir(join(directory, 'server-ciphertext'));
    for (const name of ciphertextFiles) expect((await readFile(join(directory, 'server-ciphertext', name))).toString()).not.toContain('owner-private-state');
    await shutdown(); await boot();
    const reopened = cadence();
    const replay = await reopened.tick(); expect(replay).toMatchObject({ status: 'uploaded', replayed: true, trigger: 'periodic' });
    expect(checkpointCalls).toHaveLength(1);
    const restored = await reopened.restoreLatest(runA);
    expect(JSON.parse(new TextDecoder().decode(restored))).toEqual({ counter: 5, secret: 'owner-private-state' });
    restored.fill(0);
    await expect(reopened.restoreLatest(runB)).rejects.toThrow('no completed checkpoint');
    const metadata = (await cysts.list(owner)).checkpoints[0]!;
    await expect(cysts.download(foreign, metadata.id)).rejects.toMatchObject({ status: 404 });
    nowMs += interval; await execute(process.execPath, ['--input-type=module', '-e', counterProgram, statePath, '3']);
    expect(await reopened.tick()).toMatchObject({ status: 'uploaded', replayed: false });
    expect(JSON.parse(new TextDecoder().decode(await reopened.restoreLatest(runA)))).toEqual({ counter: 8, secret: 'owner-private-state' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(2);
    const migrate = await lifecycle.plan(owner, agent,
      { action: 'migrate', expectedVersion: (await lifecycle.get(owner, agent)).agent.version, targetRunId: runB }, 'migrate-cadence-test');
    expect(await reopened.tick()).toEqual({ status: 'transition_pending' });
    const transitionCheckpoint = await encryptCheckpoint(await readFile(statePath), { owner, agent, applicationSchema: 'counter.v1' });
    try {
      await cysts.upload(owner, transitionCheckpoint.envelope, 'migration-cadence-checkpoint');
      let step = await lifecycle.acknowledge(owner, migrate.intent.id, migrate.intent.version,
        { phase: 'checkpoint', checkpointId: transitionCheckpoint.envelope.id, checkpointSha256: transitionCheckpoint.envelope.sha256 });
      step = await lifecycle.acknowledge(owner, step.intent.id, step.intent.version, { phase: 'stop' });
      step = await lifecycle.acknowledge(owner, step.intent.id, step.intent.version, { phase: 'attach' });
      await lifecycle.acknowledge(owner, step.intent.id, step.intent.version, { phase: 'resume' });
    } finally { transitionCheckpoint.recoveryKey.fill(0); }
    await writeFile(statePathB, await readFile(statePath), { mode: 0o600 });
    expect(await reopened.tick()).toMatchObject({ status: 'idle', nextDueAtMs: nowMs + interval });
    nowMs += interval; await execute(process.execPath, ['--input-type=module', '-e', counterProgram, statePathB, '2']);
    expect(await reopened.tick()).toMatchObject({ status: 'uploaded', replayed: false });
    expect(JSON.parse(new TextDecoder().decode(await reopened.restoreLatest(runB)))).toEqual({ counter: 10, secret: 'owner-private-state' });
    expect(JSON.parse(new TextDecoder().decode(await reopened.restoreLatest(runA)))).toEqual({ counter: 8, secret: 'owner-private-state' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(4);
    await lifecycle.plan(owner, agent, { action: 'kill', expectedVersion: (await lifecycle.get(owner, agent)).agent.version }, 'kill-cadence-test');
    nowMs += interval; expect(await reopened.tick()).toEqual({ status: 'inactive' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(4);
  }, 30_000);

  it('starts a real timer, captures after the configured interval, and stops cleanly', async () => {
    let errors: unknown[] = [];
    const automatic = new RegisteredAgentCheckpointCadence({ owner, agent, applicationSchema: 'counter.v1', cysts: cystClient(),
      vault: vault(), control: control(), runner, intervalMs: 1000, onError: error => { errors.push(error); } });
    await automatic.start();
    await execute(process.execPath, ['--input-type=module', '-e', counterProgram, statePath, '2']);
    const started = Date.now();
    while ((await cysts.list(owner)).usage.checkpoints === 0 && Date.now() - started < 4000) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    expect(errors).toEqual([]);
    await automatic.close(); const count = (await cysts.list(owner)).usage.checkpoints;
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect((await cysts.list(owner)).usage.checkpoints).toBe(count);
  }, 12_000);
});
