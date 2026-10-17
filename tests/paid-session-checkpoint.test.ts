import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { Auth } from '../src/auth.js';
import { canonical, Problem, randomId, secretHash } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { CystService } from '../src/cysts/service.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { openHostJournal, hostSessions, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { sessionCommandSchema } from '../src/host-kit/sessions/types.js';
import { PaidSessionCheckpointRunner } from '../src/agents/paid-session-checkpoint.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { CystCheckpointCoordinator } from '../src/sdk/cyst-checkpoints.js';
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('owner checkpoint from the same admitted paid CPU Cell', () => {
  let artifacts: Record<string, ContractArtifact>;
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let journal: HostJournal, hosted: ReturnType<typeof createHostedHostKit>, paid: PaidHostSessionAgent;
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
    root = await mkdtemp(join(tmpdir(), 'telomere-paid-checkpoint-'));
    const cells = join(root, 'cells'); await mkdir(cells, { mode: 0o700 });
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime, backend, controlKey: control.publicKey,
      reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
        controlKey: control.publicKey, isolation: 'local_process_fixture',
        runtime: canonical(['fixture-session-runtime', root]), sessionBackend: backend.identity }, inventory: async () => [] });
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => hostServer.listen(0, '127.0.0.1', resolve));
    const hostAddress = hostServer.address(); if (!hostAddress || typeof hostAddress === 'string') throw new Error('Host fixture port missing');
    const client = new HostKitClient(`http://127.0.0.1:${hostAddress.port}`, journal.identity.publicKey, control, true);
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    cysts = new CystService(store.db, join(root, 'server-cysts')); await cysts.initialize();
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu',
      region: 'local-test', image, imageDigest: `sha256:${'a'.repeat(64)}`, sealed: false, lane: 'standard',
      sessionEnabled: true, pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
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
    masterKey = randomBytes(32); await mkdir(join(root, 'private-owner-vault'), { mode: 0o700 });
  }

  it('replays the exact paid command after a lost HTTP response and owner vault restart, then uploads encrypted Cyst', async () => {
    await setup();
    const owner = local.accounts.owner.address;
    const sdk = new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: token });
    const prepared = await sdk.quote({ leashId, task: { kind: 'session', imageDigest: `sha256:${'a'.repeat(64)}`, maxCommands: 4 },
      maxSeconds: 30, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'paid-checkpoint');
    const receipt = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    await service.admit(owner, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-checkpoint');
    const running = service.drain();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await executor.events(prepared.quote.runId, -1, 8); break; }
      catch { await sleep(100); }
    }
    expect(await sdk.command(prepared.quote.runId, { commandId: 'write-state', argv: [process.execPath, '-e',
      "require('node:fs').writeFileSync('state.json',JSON.stringify({counter:7,secret:'paid-cell-state'}))"] }))
      .toMatchObject({ state: 'completed' });
    let loseResponse = true;
    const lossy = new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: token,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (loseResponse && init?.method === 'POST' && String(url).endsWith('/commands')) {
          loseResponse = false; await response.arrayBuffer(); throw new Error('Lost paid checkpoint command response');
        }
        return response;
      } });
    const vaultPath = join(root, 'private-owner-vault');
    privateVault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    const makeCoordinator = (runner: PaidSessionCheckpointRunner) => new CystCheckpointCoordinator({
      owner, agent: owner, applicationSchema: 'paid-counter.v1',
      cysts: new CystClient(new ApiTransport(origin, { sessionToken: token })), vault: privateVault!,
      onCyst: ({ operationId }) => runner.checkpoint(prepared.quote.runId, operationId),
    });
    const first = makeCoordinator(new PaidSessionCheckpointRunner({ client: lossy, argvPrefix: [process.execPath, '-e', checkpointProgram] }));
    await expect(first.snapshot()).rejects.toThrow('Lost paid checkpoint command response');
    expect(loseResponse).toBe(false);
    expect((await cysts.list(owner)).usage.checkpoints).toBe(0);
    const [hostRecord] = await journal.db.select().from(hostSessions);
    const original = hostRecord?.record?.commands.find(command => command.command.commandId.startsWith('cp'));
    expect(JSON.parse(Buffer.from(JSON.parse(original?.stdout ?? '{}').stateBase64, 'base64').toString('utf8')))
      .toEqual({ counter: 7, secret: 'paid-cell-state' });
    expect(hostRecord?.record?.commands).toHaveLength(2);
    const operationId = original?.command.argv.at(-1);
    expect(operationId).toMatch(/^cyst-hook-[a-f0-9]{64}$/);

    // Change the live Cell's state before retry. The original command ID must
    // replay its durable output rather than execute a fresh capture.
    await sdk.command(prepared.quote.runId, { commandId: 'mutate-state', argv: [process.execPath, '-e',
      "require('node:fs').writeFileSync('state.json',JSON.stringify({counter:99,secret:'changed'}))"] });
    await local.confirmed(local.owner.sendTransaction({ ...(await service.stopPlan(owner, prepared.quote.runId)), value: 0n }));
    await running;
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    const reopened = makeCoordinator(new PaidSessionCheckpointRunner({ client: sdk, argvPrefix: [process.execPath, '-e', checkpointProgram] }));
    expect(await reopened.retryPending()).toMatchObject({ status: 'uploaded', replayed: false, operationId });
    const restored = await reopened.restoreLatest();
    expect(JSON.parse(new TextDecoder().decode(restored))).toEqual({ counter: 7, secret: 'paid-cell-state' });
    restored.fill(0);
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    const [after] = await journal.db.select().from(hostSessions);
    expect(after?.record?.commands).toHaveLength(3);
    const ciphertextFiles = await readdir(join(root, 'server-cysts'));
    expect(ciphertextFiles.length).toBeGreaterThan(0);
    for (const name of ciphertextFiles) {
      expect((await readFile(join(root, 'server-cysts', name))).toString()).not.toContain('paid-cell-state');
    }
    // The pre-encryption paid stdout remains in host/controller history under
    // the existing session-output contract; this adapter cannot hide it.
    expect(after?.record?.events.some(event => event.kind === 'output' && event.text?.includes(original!.stdout))).toBe(true);
  }, 60_000);

});

it('rejects output larger than the owner-reviewed application-state bound', async () => {
  const runner = new PaidSessionCheckpointRunner({ client: { command: async (_runId, raw) => {
    const command = sessionCommandSchema.parse(raw);
    const stdout = JSON.stringify({ protocol: 'telomere-paid-app-checkpoint-v1',
      sourceRunId: '0x' + 'a'.repeat(64), operationId: 'op1', stateBase64: Buffer.from('123').toString('base64') });
    return { command, inputHash: secretHash(canonical(command)), state: 'completed' as const,
      stdout, stderr: '', exitCode: 0, reason: 'exited', outputBytes: Buffer.byteLength(stdout) };
  } }, argvPrefix: ['/app/checkpoint'], maxBytes: 2 });
  await expect(runner.checkpoint('0x' + 'a'.repeat(64), 'op1')).rejects.toThrow('reviewed bound');
});
