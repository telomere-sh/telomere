import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { PaidSessionStateHandoff } from '../src/agents/paid-session-handoff.js';
import { Auth } from '../src/auth.js';
import { canonical, Problem, randomId } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { CystService } from '../src/cysts/service.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { openHostJournal, hostPaidSessions, hostSessions, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, verifyHostMessage } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { CystClient } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const image = `fixture/session@sha256:${'a'.repeat(64)}`;
const checkpointProgram = `
const fs = require('node:fs');
const [sourceRunId, operationId] = process.argv.slice(1);
const file = 'checkpoint-' + operationId + '.bin';
let state;
try { state = fs.readFileSync(file); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = fs.readFileSync('state.json');
  fs.writeFileSync(file, state, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify({ protocol: 'telomere-paid-app-checkpoint-v1',
  sourceRunId, operationId, stateBase64: state.toString('base64') }));
`;
const restoreProgram = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const [sourceRunId, targetRunId, checkpointOperationId, checkpointId, restoreOperationId, stateSha256] = process.argv.slice(1);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { input += value; });
process.stdin.on('end', () => {
  try {
    const value = JSON.parse(input);
    const receipt = { protocol: 'telomere-paid-app-restore-v1', sourceRunId, targetRunId,
      checkpointOperationId, checkpointId, restoreOperationId, stateSha256 };
    for (const [key, expected] of Object.entries(receipt)) if (value[key] !== expected) throw Error('binding');
    const state = Buffer.from(value.stateBase64, 'base64');
    if (state.toString('base64') !== value.stateBase64 || state.length < 1 || state.length > 4096
      || crypto.createHash('sha256').update(state).digest('hex') !== stateSha256) throw Error('state');
    const saved = JSON.stringify({ receipt, stateBase64: value.stateBase64 });
    try { fs.writeFileSync('handoff.json', saved, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync('handoff.json', 'utf8') !== saved) throw error;
    }
    process.stdout.write(JSON.stringify(receipt));
  } catch { process.stderr.write('restore rejected'); process.exitCode = 1; }
});
`;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('owner handoff between separately funded paid CPU Cells', () => {
  let artifacts: Record<string, ContractArtifact>;
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let journal: HostJournal, hosted: ReturnType<typeof createHostedHostKit>, paid: PaidHostSessionAgent;
  let control: Ed25519Identity;
  let hostServer: Server, apiServer: Server, root: string, origin: string, masterKey: Uint8Array;
  let service: PlatformRuntimeService, executor: PlatformHostExecutor, cysts: CystService;
  let bridge: PlatformBridge, token: string, leashId: Hex;
  let privateVault: CystCheckpointFileVault | undefined;

  beforeAll(() => {
    artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']);
  }, 90_000);

  afterEach(async () => {
    privateVault?.close(); privateVault = undefined;
    await paid?.close().catch(() => undefined); await hosted?.close().catch(() => undefined);
    if (apiServer) { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve())); }
    if (hostServer) await new Promise<void>(resolve => hostServer.close(() => resolve()));
    await journal?.close(); await store?.close(); await local?.close();
    masterKey?.fill(0);
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'telomere-paid-handoff-'));
    const cells = join(root, 'cells'); await mkdir(cells, { mode: 0o700 });
    journal = await openHostJournal(':memory:'); control = new Ed25519Identity();
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'),
      backend, controlKey: control.publicKey, reviewedImages: new Set([image]),
      scope: { version: 1, hostKey: journal.identity.publicKey, controlKey: control.publicKey,
        isolation: 'local_process_fixture', runtime: canonical(['fixture-session-runtime', root]),
        sessionBackend: backend.identity }, inventory: async () => [] });
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => hostServer.listen(0, '127.0.0.1', resolve));
    const hostAddress = hostServer.address(); if (!hostAddress || typeof hostAddress === 'string') throw new Error('Host fixture port missing');
    const client = new HostKitClient(`http://127.0.0.1:${hostAddress.port}`, journal.identity.publicKey, control, true);
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    cysts = new CystService(store.db, join(root, 'server-cysts')); await cysts.initialize();
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey,
      hardwareClass: 'cpu', region: 'local-test', image, imageDigest: `sha256:${'a'.repeat(64)}`,
      sealed: false, lane: 'standard', sessionEnabled: true, pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts); await service.initialize();
    leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n,
        maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`,
        regionAllowRoot: `0x${'0'.repeat(64)}`, expiry: BigInt(await bridge.now() + 86_400) }] }));
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong owner origin');
      await next();
    });
    let auth: Auth;
    const owner = (context: Parameters<Parameters<typeof createCystRoutes>[1]>[0]) => auth.owner(getCookie(context, 'telomere_session'));
    app.get('/api/me', async context => context.json({ address: await owner(context), demo: false }));
    app.route('/api/platform', createPlatformRuntimeRoutes(service, owner));
    app.route('/api/cysts', createCystRoutes(cysts, owner));
    apiServer = createServer(getRequestListener(app.fetch));
    await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const apiAddress = apiServer.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API fixture port missing');
    origin = `http://127.0.0.1:${apiAddress.port}`;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner,
      ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    token = await auth.session(local.accounts.owner.address);
    masterKey = randomBytes(32);
    await mkdir(join(root, 'private-owner-vault'), { mode: 0o700 });
  }

  it('moves bounded application state through Cyst, replays a lost restore response, and settles both runs', async () => {
    await setup();
    const owner = local.accounts.owner.address;
    const sdk = new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: token });
    const ownerCysts = new CystClient(new ApiTransport(origin, { sessionToken: token }));
    const vaultPath = join(root, 'private-owner-vault');
    privateVault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    const makeHandoff = (client: Pick<PlatformRuntimeClient, 'command'>) => new PaidSessionStateHandoff({
      owner, agent: owner, applicationSchema: 'paid-counter.v1', client, cysts: ownerCysts, vault: privateVault!,
      checkpointArgvPrefix: [process.execPath, '-e', checkpointProgram],
      restoreArgvPrefix: [process.execPath, '-e', restoreProgram],
    });
    const open = async (id: string, seconds: number) => {
      const prepared = await sdk.quote({ leashId, task: { kind: 'session', imageDigest: `sha256:${'a'.repeat(64)}`,
        maxCommands: 4 }, maxSeconds: seconds, deadline: await bridge.now() + 300, maxSpend: '10000' }, id);
      const receipt = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await service.admit(owner, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-' + id);
      const running = service.drain();
      for (let attempt = 0; attempt < 80; attempt++) {
        try { await executor.events(prepared.quote.runId, -1, 8); break; }
        catch { await sleep(100); }
      }
      return { prepared, running };
    };
    const stop = async (runId: string, running: Promise<unknown>) => {
      await local.confirmed(local.owner.sendTransaction({ ...(await service.stopPlan(owner, runId)), value: 0n }));
      await running;
      expect((await service.get(owner, runId)).status).toBe('receipt_pending');
    };

    const source = await open('paid-source', 30);
    const sourceRunId = source.prepared.quote.runId;
    const state = { counter: 7, marker: 'handoff-state' };
    expect(await sdk.command(sourceRunId, { commandId: 'write-source', argv: [process.execPath, '-e',
      `require('node:fs').writeFileSync('state.json', ${JSON.stringify(JSON.stringify(state))})`] }))
      .toMatchObject({ state: 'completed' });
    const capture = await makeHandoff(sdk).snapshot(sourceRunId);
    expect(capture.status).toBe('uploaded');
    if (capture.status !== 'uploaded') throw new Error('Source capture did not upload');
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    expect(await sdk.command(sourceRunId, { commandId: 'write-oversize', argv: [process.execPath, '-e',
      "require('node:fs').writeFileSync('state.json','x'.repeat(4097))"] })).toMatchObject({ state: 'completed' });
    await expect(makeHandoff(sdk).snapshot(sourceRunId)).rejects.toThrow('reviewed bound');
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    // Two RUNNING host ticks are required before any elapsed time is billable.
    await sleep(11_000);
    await stop(sourceRunId, source.running);

    const target = await open('paid-target', 60);
    const targetRunId = target.prepared.quote.runId;
    expect(targetRunId).not.toBe(sourceRunId);
    const input = { sourceRunId, targetRunId, checkpointOperationId: capture.operationId,
      checkpointId: capture.checkpoint.id, restoreOperationId: 'restore-counter-v1' };
    let loseResponse = true;
    const lossy = new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: token,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (loseResponse && init?.method === 'POST' && String(url).endsWith('/commands')) {
          loseResponse = false; await response.arrayBuffer(); throw new Error('Lost paid restore command response');
        }
        return response;
      } });
    await expect(makeHandoff(lossy).restore(input)).rejects.toThrow('Lost paid restore command response');
    expect(loseResponse).toBe(false);
    const targetBefore = (await journal.db.select().from(hostSessions))
      .find(row => row.sessionId === targetRunId)?.record;
    expect(targetBefore?.commands).toHaveLength(1);
    expect(Buffer.from(JSON.parse(targetBefore?.commands[0]?.command.stdin ?? '{}').stateBase64, 'base64').toString())
      .toContain('handoff-state');
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    const restored = await makeHandoff(sdk).restore(input);
    expect(restored).toMatchObject({ ...input, protocol: 'telomere-paid-app-restore-v1' });
    expect(restored.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(makeHandoff(sdk).restore({ ...input, targetRunId: sourceRunId })).rejects.toThrow('separate target Cell');
    await expect(makeHandoff(sdk).restore({ ...input, targetRunId: `0x${'b'.repeat(64)}` }))
      .rejects.toThrow('already bound');
    const changedCommand = new PaidSessionStateHandoff({ owner, agent: owner,
      applicationSchema: 'paid-counter.v1', client: sdk, cysts: ownerCysts, vault: privateVault,
      checkpointArgvPrefix: [process.execPath, '-e', checkpointProgram],
      restoreArgvPrefix: [process.execPath, '-e', restoreProgram + '\n'],
    });
    await expect(changedCommand.restore(input)).rejects.toThrow('already bound');
    const read = await sdk.command(targetRunId, { commandId: 'read-restored', argv: [process.execPath, '-e',
      "const fs=require('node:fs');process.stdout.write(Buffer.from(JSON.parse(fs.readFileSync('handoff.json','utf8')).stateBase64,'base64'))"] });
    expect(JSON.parse(read.stdout)).toEqual(state);
    const targetAfter = (await journal.db.select().from(hostSessions))
      .find(row => row.sessionId === targetRunId)?.record;
    expect(targetAfter?.commands).toHaveLength(2);
    const ciphertextFiles = await readdir(join(root, 'server-cysts'));
    for (const name of ciphertextFiles) {
      expect((await readFile(join(root, 'server-cysts', name))).toString()).not.toContain('handoff-state');
    }
    await sleep(11_000);
    await stop(targetRunId, target.running);
    const paidRows = await journal.db.select().from(hostPaidSessions);
    expect(paidRows).toHaveLength(2);
    for (const row of paidRows) {
      expect(row.ticks.length).toBeGreaterThanOrEqual(2);
      expect(row.acks).toHaveLength(row.ticks.length);
      expect(row.billableSeconds).toBeGreaterThan(0);
      expect(row.ticks.every(tick => verifyHostMessage(journal.identity.publicKey, 'tick', tick))).toBe(true);
      expect(row.acks.every(ack => verifyHostMessage(control.publicKey, 'ack', ack))).toBe(true);
    }
    const sourcePending = await service.get(owner, sourceRunId), targetPending = await service.get(owner, targetRunId);
    const closed = BigInt((Math.floor(Math.max(sourcePending.settlement!.endedAt, targetPending.settlement!.endedAt) / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) { await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); }
    await service.drain();
    for (const opened of [source, target]) {
      const final = await service.get(owner, opened.prepared.quote.runId);
      expect(final.status).toBe('completed');
      expect(BigInt(final.charged!), JSON.stringify({ runId: opened.prepared.quote.runId,
        settlement: final.settlement, charged: final.charged, refund: final.refund })).toBeGreaterThan(0n);
      expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(opened.prepared.ceiling));
      expect((await bridge.run(opened.prepared.quote.runId)).hostReleased).toBe(true);
    }
    expect((await bridge.host(local.hostId)).openRuns).toBe(0n);
    expect(await makeHandoff(sdk).restore(input)).toEqual(restored);
    expect((await journal.db.select().from(hostSessions)).find(row => row.sessionId === targetRunId)?.record?.commands)
      .toHaveLength(2);
  }, 100_000);
});
