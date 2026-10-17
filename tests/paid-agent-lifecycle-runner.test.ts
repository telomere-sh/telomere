import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createWalletClient, encodeAbiParameters, http, keccak256, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { ClientAgentCoordinator } from '../src/agents/client.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { PaidAgentLifecycleRunner, PaidLifecycleClientVault, type PaidLifecycleStopPort } from '../src/agents/paid-lifecycle-runner.js';
import { createAgentRoutes } from '../src/agents/routes.js';
import { createVaultPaidAgentLifecycle } from '../src/agents/vault-runtime.js';
import { Auth } from '../src/auth.js';
import { localChain } from '../src/chain/chains.js';
import { canonical, Problem } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { CystService } from '../src/cysts/service.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const image = `fixture/session@sha256:${'a'.repeat(64)}`;
const digest = `sha256:${'a'.repeat(64)}`;
const appSchema = 'paid-lifecycle-counter.v1';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const checkpointProgram = `
const fs=require('node:fs');const [sourceRunId,operationId]=process.argv.slice(1);
const file='checkpoint-'+operationId+'.bin';let state;
try{state=fs.readFileSync(file)}catch(error){if(error.code!=='ENOENT')throw error;
state=fs.readFileSync('state.json');fs.writeFileSync(file,state,{flag:'wx',mode:0o600})}
process.stdout.write(JSON.stringify({protocol:'telomere-paid-app-checkpoint-v1',sourceRunId,operationId,stateBase64:state.toString('base64')}));
`;
const restoreProgram = `
const fs=require('node:fs'),crypto=require('node:crypto');
const [sourceRunId,targetRunId,intentId,checkpointId,operationId,stateSha256]=process.argv.slice(1);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);
process.stdin.on('end',()=>{try{const value=JSON.parse(input);
const receipt={protocol:'telomere-paid-lifecycle-restore-v1',sourceRunId,targetRunId,intentId,checkpointId,operationId,stateSha256};
for(const [key,expected] of Object.entries(receipt))if(value[key]!==expected)throw Error('binding');
const state=Buffer.from(value.stateBase64,'base64');
if(state.toString('base64')!==value.stateBase64||state.length<1||state.length>4096
||crypto.createHash('sha256').update(state).digest('hex')!==stateSha256)throw Error('state');
const saved=JSON.stringify({receipt,stateBase64:value.stateBase64});
try{fs.writeFileSync('continuation.json',saved,{flag:'wx',mode:0o600})}
catch(error){if(error.code!=='EEXIST'||fs.readFileSync('continuation.json','utf8')!==saved)throw error}
fs.writeFileSync('state.json',state);process.stdout.write(JSON.stringify(receipt))
}catch{process.stderr.write('restore rejected');process.exitCode=1}});
`;

let artifacts: Record<string, ContractArtifact>;
beforeAll(() => {
  artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
}, 90_000);

  it('continues one full CPU agent through two original paid-session hops and settles all three reservations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telomere-paid-lifecycle-runner-'));
  const masterKey = randomBytes(32);
  const hosts: { journal: HostJournal; hosted: ReturnType<typeof createHostedHostKit>;
    paid: PaidHostSessionAgent; server: Server }[] = [];
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let apiServer: Server | undefined, privateVault: CystCheckpointFileVault | undefined;
  try {
    const controlKey = new Ed25519Identity();
    const hostFixture = async (name: string) => {
      const journal = await openHostJournal(':memory:');
      const cells = join(root, name); await mkdir(cells, { mode: 0o700 });
      const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
      const hosted = createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'),
        backend, controlKey: controlKey.publicKey, reviewedImages: new Set([image]),
        scope: { version: 1, hostKey: journal.identity.publicKey, controlKey: controlKey.publicKey,
          isolation: 'local_process_fixture', runtime: canonical(['fixture-session-runtime', name, root]),
          sessionBackend: backend.identity }, inventory: async () => [] });
      await hosted.initialize();
      const paid = new PaidHostSessionAgent(journal, hosted.sessions, controlKey.publicKey); await paid.initialize();
      const server = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host port missing');
      hosts.push({ journal, hosted, paid, server });
      return { journal, client: new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, controlKey, true) };
    };
    const sourceHost = await hostFixture('source'), targetHost = await hostFixture('target');
    local = await deployPlatformRuntime(sourceHost.journal.identity.publicKey as Hex, artifacts);
    const secondOperator = privateKeyToAccount(generatePrivateKey());
    await local.test.setBalance({ address: secondOperator.address, value: parseEther('10') });
    const secondWallet = createWalletClient({ account: secondOperator, chain: localChain,
      transport: http(local.local.rpcUrl, { retryCount: 0 }) });
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress,
      abi: local.artifact('MockToken').abi, functionName: 'faucet', args: [secondOperator.address, 300_000_000n] }));
    await local.confirmed(secondWallet.writeContract({ address: local.pins.tokenAddress,
      abi: local.artifact('MockToken').abi, functionName: 'approve', args: [local.pins.hostRegistryAddress, 300_000_000n] }));
    await local.confirmed(secondWallet.writeContract({ address: local.pins.hostRegistryAddress,
      abi: local.artifact('HostRegistry').abi, functionName: 'register',
      args: [targetHost.journal.identity.publicKey as Hex, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false] }));
    const targetHostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' },
      { type: 'address' }, { type: 'bytes32' }], [31337n, local.pins.hostRegistryAddress,
      secondOperator.address, targetHost.journal.identity.publicKey as Hex]));
    const vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    const cysts = new CystService(store.db, join(root, 'server-cysts')); await cysts.initialize();
    const host = (hostId: string, hostKey: string, pricePerSecond: string) => platformHostSchema.parse({ hostId,
      hostKey, hardwareClass: 'cpu', region: 'shared-fixture', image, imageDigest: digest,
      sealed: false, lane: 'standard', sessionEnabled: true, pricePerSecond, reliabilityBps: 10000,
      strikes: 0, stake: '300000000', availableAt: 0 });
    const capacity = [host(local.hostId, sourceHost.journal.identity.publicKey, '100'),
      host(targetHostId, targetHost.journal.identity.publicKey, '101')];
    const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl,
      signerPrivateKey: local.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins);
    let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337,
      escrowAddress: local.pins.escrowAddress, receiptRootAddress: local.pins.receiptRootAddress,
      publicClient: bridge.public, submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data),
      canSeal: hour => service.canSeal(hour) });
    const executor = new PlatformHostExecutor(store.db,
      new Map([[local.hostId, sourceHost.client], [targetHostId, targetHost.client]]));
    service = new PlatformRuntimeService(store.db, bridge, capacity, executor, receipts, vaults);
    const vaultService = new PlatformVaultRuntimeService(service, vaults);
    const lifecycle = createVaultPaidAgentLifecycle(store.db, cysts, service);
    await service.initialize(); await lifecycle.initialize();
    const app = new Hono(); let origin = '', auth: Auth;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) {
        throw new Problem(403, 'origin_mismatch', 'Wrong owner origin');
      }
      await next();
    });
    const principal = (context: Parameters<Parameters<typeof createCystRoutes>[1]>[0]) =>
      auth.owner(getCookie(context, 'telomere_session'));
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(vaultService, principal));
    app.route('/api/cysts', createCystRoutes(cysts, principal));
    app.route('/api/agents', createAgentRoutes(lifecycle.agents, principal));
    apiServer = createServer(getRequestListener(app.fetch));
    await new Promise<void>(resolve => apiServer!.listen(0, '127.0.0.1', resolve));
    const apiAddress = apiServer.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API port missing');
    origin = `http://127.0.0.1:${apiAddress.port}`;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin,
      RPC_URL: local.local.rpcUrl, SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner,
      ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const ownerToken = await auth.session(local.accounts.owner.address), agentToken = await auth.session(vault.account.address);
    let quoteClock = Math.floor(Date.now() / 1000);
    const sdk = (token: string, fetcher?: typeof fetch) => new PlatformVaultRuntimeClient({ baseUrl: origin,
      pins: local!.pins, vaultPins: vault.pins, vault: vault.agent.vault, sessionToken: token,
      nowSeconds: () => quoteClock, ...(fetcher ? { fetch: fetcher } : {}) });
    const ownerSdk = sdk(ownerToken), agentSdk = sdk(agentToken);
    const control = new HttpAgentLifecycleControl(new ApiTransport(origin, { sessionToken: ownerToken }));
    const owner = local.accounts.owner.address, agent = vault.account.address;
    const admit = async (key: string, excludedHostIds?: string[]) => {
      quoteClock = await bridge.now();
      const prepared = await agentSdk.quote({ leashId: vault.agent.leashId,
        task: { kind: 'session', imageDigest: digest, maxCommands: 4 }, regions: ['shared-fixture'],
        ...(excludedHostIds ? { excludedHostIds } : {}), maxSeconds: 100,
        deadline: await bridge.now() + 300, maxSpend: '20000' }, key);
      const receipt = await local!.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await vaultService.admit(agent, vault.agent.vault,
        { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-' + key);
      expect((await vaultService.get(agent, vault.agent.vault, prepared.quote.runId)).status).toBe('queued');
      return { prepared };
    };
    const source = await admit('lifecycle-source');
    expect(source.prepared.quote.hostId).toBe(local.hostId);
    const sourceRunId = source.prepared.quote.runId;
    await control.register(owner, agent, sourceRunId);
    const target = await admit('lifecycle-target', [local.hostId]);
    const targetRunId = target.prepared.quote.runId;
    expect(target.prepared.quote.hostId).toBe(targetHostId);
    const current = await control.get(owner, agent);
    const planned = await control.plan(owner, agent, { action: 'migrate', expectedVersion: current.agent.version,
      targetRunId }, 'full-cpu-migration');
    expect(planned.intent).toMatchObject({ phase: 'checkpoint', sourceRunId, targetRunId, targetMode: 'full' });
    const sourceRunning = service.drain();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await executor.events(sourceRunId, -1, 8); break; }
      catch { if (attempt === 79) throw new Error('Source paid Cell did not start'); await sleep(100); }
    }
    expect((await agentSdk.command(sourceRunId, { commandId: 'write-source-state', argv: [process.execPath, '-e',
      "require('node:fs').writeFileSync('state.json',JSON.stringify({counter:7,marker:'continued'}))"] })).state)
      .toBe('completed');
    const dir = join(root, 'private-owner-vault'); await mkdir(dir, { mode: 0o700 });
    privateVault = new CystCheckpointFileVault({ directory: dir, masterKey });
    const clientVault = () => new PaidLifecycleClientVault(privateVault!, { owner, agent, applicationSchema: appSchema });
    const submitted = new Map<string, string>(); let loseStop = true, stopSubmissions = 0;
    const stopPort: PaidLifecycleStopPort = {
      lookup: async id => submitted.get(id) ?? null,
      submit: async (plan, id) => {
        stopSubmissions++;
        const receipt = await local!.confirmed(local!.owner.sendTransaction({ to: plan.to,
          data: plan.data as Hex, value: 0n }));
        submitted.set(id, receipt.transactionHash);
        if (loseStop) { loseStop = false; throw new Error('Lost external owner stop response'); }
        return receipt.transactionHash;
      },
    };
    const commandClient = (agentClient: PlatformVaultRuntimeClient) => ({
      config: agentClient.config.bind(agentClient), get: agentClient.get.bind(agentClient),
      sessionLease: agentClient.sessionLease.bind(agentClient), command: agentClient.command.bind(agentClient),
      sessionEvents: agentClient.sessionEvents.bind(agentClient), stopPlan: ownerSdk.stopPlan.bind(ownerSdk),
    });
    const makeCoordinator = (agentClient = agentSdk, now?: () => number,
      overrides: { owner?: string; imageDigest?: string; intentId?: string;
        sourceRunId?: string; targetRunId?: string } = {}) => {
      const vaultAdapter = clientVault();
      const runner = new PaidAgentLifecycleRunner({ owner: overrides.owner ?? owner, agent, applicationSchema: appSchema,
        intentId: overrides.intentId ?? planned.intent.id,
        sourceRunId: overrides.sourceRunId ?? sourceRunId, targetRunId: overrides.targetRunId ?? targetRunId,
        imageDigest: overrides.imageDigest ?? digest,
        client: commandClient(agentClient), control, vault: vaultAdapter, chain: bridge.public, stopPort,
        checkpointArgvPrefix: [process.execPath, '-e', checkpointProgram],
        restoreArgvPrefix: [process.execPath, '-e', restoreProgram], ...(now ? { now } : {}) });
      return { coordinator: new ClientAgentCoordinator(control, vaultAdapter, runner, appSchema), runner };
    };
    const first = makeCoordinator();
    expect(await first.coordinator.step(owner, agent)).toMatchObject({ phase: 'stop' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    expect((await sourceHost.journal.db.select().from(hostSessions))[0]?.record?.commands).toHaveLength(2);
    await sleep(11_000);
    await expect(first.coordinator.step(owner, agent)).rejects.toThrow('Lost external owner stop response');
    expect(submitted.size).toBe(1);
    expect(stopSubmissions).toBe(1);
    await sourceRunning;
    expect((await ownerSdk.get(sourceRunId)).status).toBe('receipt_pending');
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: dir, masterKey });
    expect(await makeCoordinator().coordinator.step(owner, agent)).toMatchObject({ phase: 'attach' });
    expect(submitted.size).toBe(1);
    expect(stopSubmissions).toBe(1);
    const next = await admit('lifecycle-next', [targetHostId]);
    const nextRunId = next.prepared.quote.runId;
    expect(next.prepared.quote.hostId).toBe(local.hostId);
    expect(() => makeCoordinator(agentSdk, undefined, { owner: local!.accounts.outsider.address }))
      .toThrow('scope');
    await expect(makeCoordinator(agentSdk, undefined, { imageDigest: `sha256:${'b'.repeat(64)}` })
      .coordinator.step(owner, agent)).rejects.toThrow('image');
    const stoppedHash = [...submitted.values()][0] as Hex;
    const stoppedReceipt = await bridge.public.getTransactionReceipt({ hash: stoppedHash });
    const trueGetBlock = bridge.public.getBlock.bind(bridge.public);
    let orphanHits = 0;
    const orphanedBlock = vi.spyOn(bridge.public, 'getBlock').mockImplementation(async (...args) => {
      const block = await trueGetBlock(...args);
      if (args[0]?.blockNumber !== stoppedReceipt.blockNumber) return block;
      orphanHits++;
      return { ...block, hash: `0x${'e'.repeat(64)}` };
    });
    await expect(makeCoordinator().coordinator.step(owner, agent)).rejects.toThrow('Canonical owner stop transaction');
    expect(orphanHits).toBeGreaterThan(0);
    orphanedBlock.mockRestore();
    const targetRunning = service.drain();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await executor.events(targetRunId, -1, 8); break; }
      catch { if (attempt === 79) throw new Error('Target paid Cell did not start'); await sleep(100); }
    }
    // A changed master key, image or insufficient target lifetime cannot move
    // the server phase or invoke the restore guest command.
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: dir, masterKey: randomBytes(32) });
    await expect(makeCoordinator().coordinator.step(owner, agent)).rejects.toThrow();
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: dir, masterKey });
    const targetLease = await ownerSdk.sessionLease(targetRunId);
    await expect(makeCoordinator(agentSdk, () => targetLease.lease.body.expiresAt - 3000).coordinator.step(owner, agent))
      .rejects.toThrow('lease time');
    expect((await targetHost.journal.db.select().from(hostSessions))[0]?.record?.commands).toHaveLength(0);
    expect(await makeCoordinator().coordinator.step(owner, agent)).toMatchObject({ phase: 'resume' });
    const originalValidate = control.validateExecution.bind(control);
    let resumeValidations = 0;
    const cancelledBeforeGuest = vi.spyOn(control, 'validateExecution').mockImplementation(async (...args) => {
      if (args[3] === 'resume' && ++resumeValidations === 3) throw new Error('Owner superseded the intent');
      return originalValidate(...args);
    });
    await expect(makeCoordinator().coordinator.step(owner, agent)).rejects.toThrow('Owner superseded the intent');
    cancelledBeforeGuest.mockRestore();
    expect((await targetHost.journal.db.select().from(hostSessions))[0]?.record?.commands).toHaveLength(0);
    let loseRestore = true;
    const lossyAgent = sdk(agentToken, async (url, init) => {
      const response = await fetch(url, init);
      if (loseRestore && init?.method === 'POST' && String(url).endsWith('/commands')) {
        loseRestore = false; await response.arrayBuffer(); throw new Error('Lost paid restore response');
      }
      return response;
    });
    await expect(makeCoordinator(lossyAgent).coordinator.step(owner, agent)).rejects.toThrow('Lost paid restore response');
    expect((await targetHost.journal.db.select().from(hostSessions))[0]?.record?.commands).toHaveLength(1);
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: dir, masterKey });
    await makeCoordinator().coordinator.finish(owner, agent);
    expect((await control.get(owner, agent)).agent).toMatchObject({ currentRunId: targetRunId, mode: 'full' });
    expect((await targetHost.journal.db.select().from(hostSessions))[0]?.record?.commands).toHaveLength(1);
    const read = await agentSdk.command(targetRunId, { commandId: 'read-continuation', argv: [process.execPath, '-e',
      "process.stdout.write(require('node:fs').readFileSync('state.json','utf8'))"] });
    expect(JSON.parse(read.stdout)).toEqual({ counter: 7, marker: 'continued' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    const afterFirst = await control.get(owner, agent);
    const nextPlan = await control.plan(owner, agent, { action: 'migrate',
      expectedVersion: afterFirst.agent.version, targetRunId: nextRunId }, 'second-full-cpu-migration');
    const nextRunner = () => makeCoordinator(agentSdk, undefined, { intentId: nextPlan.intent.id,
      sourceRunId: targetRunId, targetRunId: nextRunId });
    expect(await nextRunner().coordinator.step(owner, agent)).toMatchObject({ phase: 'stop' });
    expect((await cysts.list(owner)).usage.checkpoints).toBe(2);
    await sleep(11_000);
    let afterSecondStop;
    try { afterSecondStop = await nextRunner().coordinator.step(owner, agent); }
    catch (error) { expect(String(error)).toContain('Signed original source cleanup is still uncertain'); }
    await targetRunning;
    afterSecondStop ??= await nextRunner().coordinator.step(owner, agent);
    expect(afterSecondStop).toMatchObject({ phase: 'attach' });
    expect(stopSubmissions).toBe(2);
    const nextRunning = service.drain();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await executor.events(nextRunId, -1, 8); break; }
      catch { if (attempt === 79) throw new Error('Next paid Cell did not start'); await sleep(100); }
    }
    expect(await nextRunner().coordinator.step(owner, agent)).toMatchObject({ phase: 'resume' });
    await nextRunner().coordinator.finish(owner, agent);
    expect((await control.get(owner, agent)).agent).toMatchObject({ currentRunId: nextRunId, mode: 'full' });
    const nextRead = await agentSdk.command(nextRunId, { commandId: 'read-second-continuation', argv: [process.execPath, '-e',
      "process.stdout.write(require('node:fs').readFileSync('state.json','utf8'))"] });
    expect(JSON.parse(nextRead.stdout)).toEqual({ counter: 7, marker: 'continued' });
    await sleep(11_000);
    const lastPlan = await ownerSdk.stopPlan(nextRunId, 'last-fixture-stop');
    await local.confirmed(local.owner.sendTransaction({ to: lastPlan.to, data: lastPlan.data as Hex, value: 0n }));
    await nextRunning;
    const firstPending = await ownerSdk.get(sourceRunId), secondPending = await ownerSdk.get(targetRunId),
      thirdPending = await ownerSdk.get(nextRunId);
    expect(['receipt_pending', 'completed']).toContain(firstPending.status);
    expect(['receipt_pending', 'completed']).toContain(secondPending.status);
    expect(thirdPending.status).toBe('receipt_pending');
    const closed = BigInt((Math.floor(Math.max(firstPending.settlement!.endedAt,
      secondPending.settlement!.endedAt, thirdPending.settlement!.endedAt) / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) {
      await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 });
    }
    vi.spyOn(Date, 'now').mockReturnValue((Number(closed) + 60) * 1000);
    await service.drain();
    for (const opened of [source, target, next]) {
      const final = await ownerSdk.get(opened.prepared.quote.runId);
      expect(final.status).toBe('completed');
      expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(opened.prepared.ceiling));
      expect((await bridge.run(opened.prepared.quote.runId)).hostReleased).toBe(true);
    }
  } finally {
    vi.restoreAllMocks(); privateVault?.close();
    if (apiServer) { const server = apiServer; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const host of hosts.reverse()) {
      await host.paid.close().catch(() => undefined); await host.hosted.close().catch(() => undefined);
      host.server.closeAllConnections(); await new Promise<void>(resolve => host.server.close(() => resolve()));
      await host.journal.close();
    }
    await store?.close(); await local?.close(); masterKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}, 140_000);
