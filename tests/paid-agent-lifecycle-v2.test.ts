import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { type Hex } from 'viem';
import { beforeAll, expect, it, vi } from 'vitest';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { PaidAgentLifecycleRunnerV2 } from '../src/agents/paid-lifecycle-runner-v2.js';
import { PaidLifecycleClientVault, type PaidLifecycleStopPort } from '../src/agents/paid-lifecycle-runner.js';
import { PaidAgentLifeline, type PaidLifelineIntent } from '../src/agents/paid-lifeline.js';
import { createVaultPaidAgentLifecycle } from '../src/agents/vault-runtime.js';
import { createAgentRoutes } from '../src/agents/routes.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { canonical, Problem } from '../src/common.js';
import { CystService } from '../src/cysts/service.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createDockerHostedHostKit, createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidSessions, hostSessions, openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend, sessionContainerName } from '../src/host-kit/sessions/backends.js';
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
import { validateCpuResult } from '../src/runtime/validation.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const fixtureImage = `fixture/session@sha256:${'a'.repeat(64)}`;
const applicationSchema = 'paid-v2-counter.v1';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const checkpointProgram = `const fs=require('node:fs');const [sourceRunId,operationId]=process.argv.slice(1);
const file='capture-'+operationId+'.bin';let state;try{state=fs.readFileSync(file)}catch(e){if(e.code!=='ENOENT')throw e;
state=fs.readFileSync('state.json');fs.writeFileSync(file,state,{flag:'wx',mode:0o600})}
process.stdout.write(JSON.stringify({protocol:'telomere-paid-app-checkpoint-v1',sourceRunId,operationId,stateBase64:state.toString('base64')}));`;
const restoreProgram = `const fs=require('node:fs'),crypto=require('node:crypto');
const [source,targetRunId,intentId,checkpointId,operationId,stateSha256,resourceProfile]=process.argv.slice(1);
const sourceRunId=source==='none'?null:source;let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);
process.stdin.on('end',()=>{try{const value=JSON.parse(text),receipt={protocol:'telomere-paid-lifecycle-restore-v2',sourceRunId,targetRunId,intentId,checkpointId,operationId,stateSha256,resourceProfile};
for(const [k,v]of Object.entries(receipt))if(value[k]!==v)throw Error('binding');const state=Buffer.from(value.stateBase64,'base64');
if(state.toString('base64')!==value.stateBase64||state.length<1||state.length>4096||crypto.createHash('sha256').update(state).digest('hex')!==stateSha256)throw Error('state');
const saved=JSON.stringify({receipt,stateBase64:value.stateBase64});try{fs.writeFileSync('restore-'+operationId+'.json',saved,{flag:'wx',mode:0o600})}
catch(e){if(e.code!=='EEXIST'||fs.readFileSync('restore-'+operationId+'.json','utf8')!==saved)throw e}
fs.writeFileSync('state.json',state);process.stdout.write(JSON.stringify(receipt))}catch{process.stderr.write('restore rejected');process.exitCode=1}});`;
let artifacts: Record<string, ContractArtifact>;
beforeAll(() => {
  artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
}, 90_000);

it.each([1, 2] as const)('continues a real paid agent full→lean, sleep/wake/torpor and kill with policy %i after response loss and restart', async metabolismVersion => {
  const gvisorSocket = process.env.TELOMERE_ACCEPTANCE_GVISOR_SOCKET, gvisorImage = process.env.TELOMERE_ACCEPTANCE_GVISOR_IMAGE;
  if (gvisorSocket || gvisorImage) {
    if (process.platform !== 'linux' || !gvisorSocket || !gvisorImage
      || !/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(gvisorSocket) || gvisorSocket.includes('..')
      || ['/var/run/docker.sock', '/run/docker.sock'].includes(gvisorSocket)
      || gvisorImage !== '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe') {
      throw new Error('Real paid lifecycle acceptance requires the reviewed immutable image and an isolated Linux Docker socket');
    }
    const socket = await lstat(gvisorSocket); if (!socket.isSocket() || socket.isSymbolicLink()) throw new Error('Invalid isolated Docker socket');
  }
  const image = gvisorImage ?? fixtureImage, digest = image.split('@')[1]!;
  const guestNode = gvisorSocket ? '/usr/local/bin/node' : process.execPath;
  const quotaEvidence: { runId: string; nanoCpus: number; runtime: string; memory: number;
    memorySwap: number; networkMode: string; readonlyRootfs: boolean; pidsLimit: number; running: boolean }[] = [];
  const root = await mkdtemp(join(tmpdir(), 'telomere-paid-lifecycle-v2-')), masterKey = randomBytes(32);
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let journal: Awaited<ReturnType<typeof openHostJournal>> | undefined;
  let hosted: ReturnType<typeof createHostedHostKit> | undefined, paid: PaidHostSessionAgent | undefined;
  let hostServer: Server | undefined, apiServer: Server | undefined, privateVault: CystCheckpointFileVault | undefined;
  const active: Promise<void>[] = [];
  try {
    const controlKey = new Ed25519Identity(); journal = await openHostJournal(':memory:');
    const cells = join(root, 'cells'); await mkdir(cells, { mode: 0o700 });
    hosted = gvisorSocket ? createDockerHostedHostKit({ journal, controlKey: controlKey.publicKey,
      reviewedImages: new Set([image]), isolation: 'gvisor', socketPath: gvisorSocket, clock: () => Date.now() }) : (() => {
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    return createHostedHostKit({ journal: journal!, runtime: new LocalProcessFixtureRuntime('test-fixture-only'), backend,
      controlKey: controlKey.publicKey, reviewedImages: new Set([image]), inventory: async () => [], clock: () => Date.now(),
      scope: { version: 1, hostKey: journal!.identity.publicKey, controlKey: controlKey.publicKey,
        isolation: 'local_process_fixture', runtime: canonical(['v2-paid-fixture', root]), sessionBackend: backend.identity } });
    })();
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, controlKey.publicKey, () => Date.now()); await paid.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => hostServer!.listen(0, '127.0.0.1', resolve));
    const hostAddress = hostServer.address(); if (!hostAddress || typeof hostAddress === 'string') throw new Error('Host port missing');
    const hostClient = new HostKitClient(`http://127.0.0.1:${hostAddress.port}`, journal.identity.publicKey, controlKey, true);
    // REASON: Host journal's identity validates its bytes32 Ed25519 public key.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    const vault = await deployPlatformVault(local); store = await openStore({ DATA_DIR: join(root, 'db') });
    const cysts = new CystService(store.db, join(root, 'cysts')); await cysts.initialize();
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey,
      hardwareClass: 'cpu', region: 'shared-fixture', image, imageDigest: digest, sealed: false, lane: 'standard',
      sessionEnabled: true, pricePerSecond: '100', sessionPrices: { full: '100', lean: '50', torpor: '25' },
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins); let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    const executor = new PlatformHostExecutor(store.db, new Map([[local.hostId, hostClient]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    const vaultService = new PlatformVaultRuntimeService(service, vaults), lifecycle = createVaultPaidAgentLifecycle(store.db, cysts, service);
    await service.initialize(); await lifecycle.initialize();
    const owner = local.accounts.owner.address, agent = vault.account.address;
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_error' },
      error instanceof Problem ? error.status : 503));
    // Authentication is an explicit local role fixture; actual Vault authorization and every payment remain real.
    const principal = async (context: Parameters<Parameters<typeof createPlatformVaultRuntimeRoutes>[1]>[0]) =>
      getCookie(context, 'telomere_session') === '1'.repeat(64) ? owner : agent;
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(vaultService, principal));
    app.route('/api/agents', createAgentRoutes(lifecycle.agents, principal));
    apiServer = createServer(getRequestListener(app.fetch)); await new Promise<void>(resolve => apiServer!.listen(0, '127.0.0.1', resolve));
    const apiAddress = apiServer.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API port missing');
    const origin = `http://127.0.0.1:${apiAddress.port}`;
    let loseRestore = true;
    const sdk = (token: string, lossy = false) => new PlatformVaultRuntimeClient({ baseUrl: origin, pins: local!.pins,
      vaultPins: vault.pins, vault: vault.agent.vault, sessionToken: token,
      ...(lossy ? { fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(url, init);
        if (loseRestore && init?.method === 'POST' && String(url).endsWith('/commands')
          && typeof init.body === 'string' && JSON.parse(init.body).commandId?.startsWith('lv')) {
          loseRestore = false; await response.arrayBuffer(); throw new Error('Lost restore response');
        }
        return response;
      } } : {}) });
    const ownerSdk = sdk('1'.repeat(64)), agentSdk = sdk('2'.repeat(64)), lossyAgentSdk = sdk('2'.repeat(64), true);
    const apiControl = new HttpAgentLifecycleControl(new ApiTransport(origin, { sessionToken: '1'.repeat(64) }),
      metabolismVersion === 2 ? { metabolismVersion: 2 } : {});
    const control = { get: apiControl.get.bind(apiControl), evaluate: apiControl.evaluate.bind(apiControl),
      plan: apiControl.plan.bind(apiControl), acknowledge: apiControl.acknowledge.bind(apiControl),
      validateExecution: apiControl.validateExecution.bind(apiControl),
      upload: (payer: string, envelope: Parameters<CystService['upload']>[1], key: string) => cysts.upload(payer, envelope, key),
      download: cysts.download.bind(cysts) };
    const admit = async (key: string, resourceProfile: 'full' | 'lean' | 'torpor') => {
      const prepared = await agentSdk.quote({ leashId: vault.agent.leashId, task: { kind: 'session', imageDigest: digest,
        maxCommands: 8, resourceProfile }, maxSeconds: 100, deadline: await bridge.now() + 300, maxSpend: '20000' }, key);
      const receipt = await local!.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await agentSdk.admit({ runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-' + key);
      return prepared;
    };
    const live = async (runId: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await agentSdk.sessionLease(runId);
          const events = await agentSdk.sessionEvents(runId, -1, 1);
          if (events.state === 'running' && events.events[0]?.kind === 'ready') return;
        } catch { /* A durable lease can precede actual Docker/guest admission. */ }
        await pause(50);
      }
      throw new Error('Paid fixture did not start');
    };
    const positiveMeter = async (runId: string) => {
      const started = performance.now();
      while (performance.now() - started < 30_000) {
        const rows = await journal!.db.select().from(hostPaidSessions);
        const row = rows.find(value => value.sessionId === runId);
        if ((row?.acks.at(-1)?.body.billableSeconds ?? 0) > 0) return;
        if (row && !['starting', 'running'].includes(row.state)) throw new Error('Warmup stopped before a positive paired signed meter interval');
        await pause(250);
      }
      throw new Error('Warmup failed to produce a positive paired signed meter interval within thirty seconds');
    };
    const quota = async (runId: string, nanoCpus: number) => {
      if (!gvisorSocket) return;
      const result = await promisify(execFile)('docker', ['--host', 'unix://' + gvisorSocket, 'inspect',
        sessionContainerName(journal!.identity.publicKey, runId)], { timeout: 10_000, maxBuffer: 1_048_576 });
      const inspected = JSON.parse(result.stdout) as { HostConfig: { NanoCpus: number; Runtime: string; Memory: number;
        MemorySwap: number; NetworkMode: string; ReadonlyRootfs: boolean; PidsLimit: number }; State: { Running: boolean } }[];
      expect(inspected).toHaveLength(1); expect(inspected[0]).toMatchObject({ State: { Running: true },
        HostConfig: { NanoCpus: nanoCpus, Runtime: 'runsc', Memory: 268_435_456, MemorySwap: 268_435_456,
          NetworkMode: 'none', ReadonlyRootfs: true, PidsLimit: 64 } });
      const observed = inspected[0]!;
      quotaEvidence.push({ runId, nanoCpus: observed.HostConfig.NanoCpus, runtime: observed.HostConfig.Runtime,
        memory: observed.HostConfig.Memory, memorySwap: observed.HostConfig.MemorySwap, networkMode: observed.HostConfig.NetworkMode,
        readonlyRootfs: observed.HostConfig.ReadonlyRootfs, pidsLimit: observed.HostConfig.PidsLimit, running: observed.State.Running });
    };
    const drain = () => { const flight = service.drain(); active.push(flight); return flight; };
    const mineClosedHour = async (end: number) => {
      const closed = BigInt((Math.floor(end / 3600) + 1) * 3600);
      if (BigInt(await bridge.now()) < closed) { await local!.test.setNextBlockTimestamp({ timestamp: closed }); await local!.test.mine({ blocks: 1 }); }
      return closed;
    };
    // Create a genuine settled charge before Metabolism evaluation; no caller-authored burn values.
    const warmup = await admit('warmup', 'full'), warmupFlight = drain(); await live(warmup.quote.runId); await positiveMeter(warmup.quote.runId);
    const warmupStop = await ownerSdk.stopPlan(warmup.quote.runId, 'warmup-stop');
    await local.confirmed(local.owner.sendTransaction({ to: warmupStop.to, data: warmupStop.data as Hex, value: 0n }));
    await warmupFlight; const warmupPending = await ownerSdk.get(warmup.quote.runId);
    const warmupMeter = await journal.db.select().from(hostPaidSessions);
    const warmupResult = warmupPending.result ? validateCpuResult(warmupPending.result, warmup.quote.runId, warmup.quote.maxSeconds) : null;
    const diagnostic = { isolation: gvisorSocket ? 'gvisor' : 'local_process_fixture', status: warmupPending.status,
      errorCode: warmupPending.errorCode, result: warmupResult ? { status: warmupResult.status, billableSeconds: warmupResult.billableSeconds,
        tickStates: warmupResult.ticks.map(tick => tick.state) } : null,
      meter: warmupMeter.map(row => ({ state: row.state, cleanupConfirmed: row.cleanupConfirmed,
        ticks: row.ticks.map(tick => ({ state: tick.body.state, elapsedMs: tick.body.elapsedMs,
          heartbeatElapsedMs: tick.body.heartbeat?.elapsedMs ?? null,
          heartbeatSequence: tick.body.heartbeat?.sequence ?? null,
          heartbeatAgeMs: tick.body.heartbeat ? tick.body.timestamp - tick.body.heartbeat.receivedAt : null })),
        acks: row.acks.map(ack => ({ billableSeconds: ack.body.billableSeconds, delta: ack.body.billableDelta, fault: ack.body.fault })) })) };
    expect(warmupPending.settlement!.billableSeconds, JSON.stringify(diagnostic)).toBeGreaterThan(0);
    const closed = await mineClosedHour(warmupPending.settlement!.endedAt), realNow = Date.now.bind(Date);
    let offset = Number(closed) * 1000 + 2000 - realNow(); vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    await service.drain(); expect((await ownerSdk.get(warmup.quote.runId)).status).toBe('completed');
    if (metabolismVersion === 2) await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress,
      abi: local.artifact('MockToken').abi, functionName: 'faucet', args: [vault.agent.vault, 40_000_000n] }));
    const full = await admit('source-full', 'full'), lean = await admit('target-lean', 'lean'), torpor = await admit('target-torpor', 'torpor');
    expect([full.quote.pricePerSecond, lean.quote.pricePerSecond, torpor.quote.pricePerSecond]).toEqual(['100', '50', '25']);
    await lifecycle.agents.register(owner, { agent, runId: full.quote.runId });
    const observedBurn = BigInt((await control.evaluate(owner, agent)).trailing24hBurn); expect(observedBurn).toBeGreaterThan(0n);
    const withdrawTo = async (remaining: bigint) => {
      const available = BigInt((await agentSdk.balance()).available);
      await local!.confirmed(local!.owner.writeContract({ address: vault.agent.vault, abi: local!.artifact('PlatformAgentVault').abi,
        functionName: 'ownerWithdraw', args: [available - remaining] }));
    };
    if (metabolismVersion === 2) expect(await control.evaluate(owner, agent)).toMatchObject({ mode: 'full', metabolismVersion: 2,
      currentBurnPerHour: '392400', pricing: { current: { cpuPricePerSecond: '100', completeLeaseCost: '10900' } } });
    await withdrawTo(metabolismVersion === 2 ? 12_000_000n : observedBurn * 2n);
    expect((await control.evaluate(owner, agent)).mode).toBe('lean');
    const before = await control.get(owner, agent);
    const migration = await control.plan(owner, agent, { action: 'evaluate', expectedVersion: before.agent.version,
      targetRunId: lean.quote.runId }, 'paid-full-to-lean');
    expect(migration.intent).toMatchObject({ kind: 'migrate', targetMode: 'lean', sourceRunId: full.quote.runId });
    if (metabolismVersion === 2) expect(migration.intent).toMatchObject({ metabolismVersion: 2,
      metabolismEvaluation: { mode: 'lean', balance: '12000000', pricing: { availableBalance: '12000000' } } });
    else expect(migration.intent).not.toHaveProperty('metabolismVersion');
    const fullFlight = drain(); await live(full.quote.runId); await quota(full.quote.runId, 1_000_000_000);
    await agentSdk.command(full.quote.runId, { commandId: 'write-state', argv: [guestNode, '-e',
      "require('node:fs').writeFileSync('state.json',JSON.stringify({counter:7,marker:'continued'}))"] });
    const privateDir = join(root, 'owner-vault'); await mkdir(privateDir, { mode: 0o700 });
    privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey });
    const reopen = () => { privateVault!.close(); privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey }); };
    const submitted = new Map<string, string>(); let stopSubmissions = 0, loseStop = true;
    const stopPort: PaidLifecycleStopPort = { lookup: async operationId => submitted.get(operationId) ?? null,
      submit: async (plan, operationId) => {
        stopSubmissions++; const receipt = await local!.confirmed(local!.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
        submitted.set(operationId, receipt.transactionHash); if (loseStop) { loseStop = false; throw new Error('Lost owner stop response'); }
        return receipt.transactionHash;
      } };
    const loop = (commandSdk = agentSdk) => {
      const vaultAdapter = new PaidLifecycleClientVault(privateVault!, { owner, agent, applicationSchema });
      return new PaidAgentLifeline({ owner, agent, applicationSchema, control, vault: vaultAdapter,
        ...(metabolismVersion === 2 ? { metabolismVersion: 2 } : {}),
        approvedTarget: async () => undefined,
        runner: async (intent: PaidLifelineIntent) => new PaidAgentLifecycleRunnerV2({ owner, agent, applicationSchema,
          intentId: intent.id, kind: intent.kind, targetMode: intent.targetMode, sourceRunId: intent.sourceRunId,
          targetRunId: intent.targetRunId, imageDigest: digest, control, vault: vaultAdapter, chain: bridge.public,
          client: { config: commandSdk.config.bind(commandSdk), get: commandSdk.get.bind(commandSdk),
            sessionLease: commandSdk.sessionLease.bind(commandSdk), sessionEvents: commandSdk.sessionEvents.bind(commandSdk),
            command: commandSdk.command.bind(commandSdk), stopPlan: ownerSdk.stopPlan.bind(ownerSdk) },
          stopPort, minConfirmations: 1, checkpointArgvPrefix: [guestNode, '-e', checkpointProgram],
          restoreArgvPrefix: [guestNode, '-e', restoreProgram] }) });
    };
    await pause(11_000); await expect(loop().tick()).rejects.toThrow('Lost owner stop response'); await fullFlight;
    expect(stopSubmissions).toBe(1); reopen();
    const leanFlight = drain(); await live(lean.quote.runId); await quota(lean.quote.runId, 500_000_000);
    await expect(loop(lossyAgentSdk).tick()).rejects.toThrow('Lost restore response');
    reopen(); expect(await loop().tick()).toMatchObject({ status: 'transition_completed' });
    expect(stopSubmissions).toBe(1); expect((await control.get(owner, agent)).agent).toMatchObject({ mode: 'lean', currentRunId: lean.quote.runId });
    if (metabolismVersion === 2) {
      // Its cheaper actual lean rate must not cause a self-induced promotion back to full.
      expect(await control.evaluate(owner, agent)).toMatchObject({ mode: 'lean', metabolismVersion: 2,
        currentBurnPerHour: '196200', pricing: { current: { cpuPricePerSecond: '50' } } });
      expect((await control.get(owner, agent)).intent).toBeNull();
    }
    expect((await agentSdk.sessionLease(lean.quote.runId)).lease.body.stdin).toContain('"resourceProfile":"lean"');
    const restored = await agentSdk.command(lean.quote.runId, { commandId: 'read-lean', argv: [guestNode, '-e',
      "process.stdout.write(require('node:fs').readFileSync('state.json','utf8'))"] });
    expect(JSON.parse(restored.stdout)).toEqual({ counter: 7, marker: 'continued' });
    const sleeping = await control.get(owner, agent);
    await control.plan(owner, agent, { action: 'sleep', expectedVersion: sleeping.agent.version }, 'sleep-lean');
    await pause(11_000);
    try { await loop().tick(); } catch (error) { expect(String(error)).toContain('cleanup is still uncertain'); }
    await leanFlight; reopen(); await loop().tick();
    const asleep = await control.get(owner, agent); expect(asleep.agent).toMatchObject({ mode: 'cyst', currentRunId: null });
    expect(asleep.agent.checkpointId).not.toBeNull(); expect(stopSubmissions).toBe(2);
    await withdrawTo(metabolismVersion === 2 ? 500_000n : observedBurn / 4n);
    expect((await control.evaluate(owner, agent)).mode).toBe('torpor');
    if (metabolismVersion === 2) expect(await control.evaluate(owner, agent)).toMatchObject({ currentBurnPerHour: null,
      currentRunwaySeconds: null, pricing: { current: null } });
    const wake = await control.plan(owner, agent, { action: 'wake', expectedVersion: asleep.agent.version,
      targetRunId: torpor.quote.runId }, 'wake-torpor');
    expect(wake.intent).toMatchObject({ kind: 'wake', sourceRunId: null, targetMode: 'torpor', checkpointId: asleep.agent.checkpointId });
    const torporFlight = drain(); await live(torpor.quote.runId); await quota(torpor.quote.runId, 250_000_000); reopen(); await loop().tick();
    const awake = await control.get(owner, agent); expect(awake.agent).toMatchObject({ mode: 'torpor', currentRunId: torpor.quote.runId });
    const state = await agentSdk.command(torpor.quote.runId, { commandId: 'read-torpor', argv: [guestNode, '-e',
      "process.stdout.write(require('node:fs').readFileSync('state.json','utf8'))"] });
    expect(JSON.parse(state.stdout)).toEqual({ counter: 7, marker: 'continued' });
    await control.plan(owner, agent, { action: 'kill', expectedVersion: awake.agent.version }, 'kill-torpor'); await pause(11_000);
    try { await loop().tick(); } catch (error) { expect(String(error)).toContain('cleanup is still uncertain'); }
    await torporFlight; reopen(); await loop().tick(); expect(stopSubmissions).toBe(3);
    expect((await control.get(owner, agent)).agent).toMatchObject({ currentRunId: null, mode: 'cyst' });
    expect((await control.get(owner, agent)).agent.killedAt).not.toBeNull(); expect(await loop().tick()).toMatchObject({ status: 'idle' });
    const afterKillAgent = sdk('2'.repeat(64));
    await expect(afterKillAgent.quote(full.input, 'source-full')).rejects.toMatchObject({ code: 'agent_killed' });
    await expect(afterKillAgent.quote({ ...full.input, deadline: await bridge.now() + 300 }, 'after-kill')).rejects.toMatchObject({ code: 'agent_killed' });
    const rows = await journal.db.select().from(hostSessions);
    for (const profile of ['lean', 'torpor']) {
      const row = rows.find(item => item.record?.spec.policy.cpu === (profile === 'lean' ? 0.5 : 0.25));
      expect(row?.record?.cleanupConfirmed).toBe(true);
      expect(row?.record?.commands.filter(command => command.command.commandId.startsWith('lv'))).toHaveLength(1);
    }
    const pending = await Promise.all([full, lean, torpor].map(row => ownerSdk.get(row.quote.runId)));
    const finalClosed = await mineClosedHour(Math.max(...pending.map(row => row.settlement!.endedAt)));
    offset = Number(finalClosed) * 1000 + 2000 - realNow(); await service.drain();
    for (const prepared of [full, lean, torpor]) {
      const final = await ownerSdk.get(prepared.quote.runId); expect(final.status).toBe('completed');
      expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
      expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
    }
    if (gvisorSocket) {
      await mkdir(resolve('.local'), { recursive: true });
      await writeFile(resolve(metabolismVersion === 2 ? '.local/paid-agent-metabolism-v2-gvisor-evidence-20261014.json'
        : '.local/paid-agent-lifecycle-v2-gvisor-evidence-20261014.json'), JSON.stringify({
        protocol: 'telomere-paid-lifecycle-v2-gvisor-acceptance-v1', observedAt: new Date().toISOString(),
        dockerSocket: gvisorSocket, image, guestNode, quotaEvidence, stopSubmissions, restoredStateBytes: Buffer.byteLength(state.stdout),
        sameHostMigration: true, sleepWakeVerified: true, responseLossRecoveryVerified: true,
        financialCeilingsConserved: true, metabolismVersion, gpuCells: false, teeClaim: false }, null, 2));
    }
  } finally {
    vi.restoreAllMocks(); privateVault?.close(); await paid?.close().catch(() => undefined); await hosted?.close().catch(() => undefined);
    for (const flight of active) await flight.catch(() => undefined);
    for (const server of [apiServer, hostServer]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await journal?.close(); await store?.close(); await local?.close(); masterKey.fill(0);
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-paid-lifecycle-v2-')) throw new Error('Unexpected owned fixture path');
    await rm(target, { recursive: true, force: true });
  }
}, 240_000);

it('reconciles concurrent queued kills only after canonical no-dispatch full refund, with one external wallet submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telomere-paid-lifecycle-v2-')), masterKey = randomBytes(32);
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  let server: Server | undefined, privateVault: CystCheckpointFileVault | undefined;
  try {
    const hostKey = new Ed25519Identity().publicKey;
    // No CPU execution occurs in this case. The only placement hint is an explicit fixture.
    local = await deployPlatformRuntime(hostKey as Hex, artifacts); const vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    const cysts = new CystService(store.db, join(root, 'cysts')); await cysts.initialize();
    const image = fixtureImage, digest = image.split('@')[1]!;
    const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins); let runtime: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    const executor = new PlatformHostExecutor(store.db, new Map()); vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(true);
    const dispatched = vi.spyOn(executor, 'run');
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey, hardwareClass: 'cpu', region: 'fixture',
      image, imageDigest: digest, sealed: false, lane: 'standard', sessionEnabled: true, pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    const service = new PlatformVaultRuntimeService(runtime, vaults), lifecycle = createVaultPaidAgentLifecycle(store.db, cysts, runtime);
    await runtime.initialize(); await lifecycle.initialize();
    const owner = local.accounts.owner.address, agent = vault.account.address, app = new Hono();
    const principal = async (context: Parameters<Parameters<typeof createPlatformVaultRuntimeRoutes>[1]>[0]) =>
      getCookie(context, 'telomere_session') === '1'.repeat(64) ? owner : agent;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_error' }, error instanceof Problem ? error.status : 503));
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(service, principal));
    server = createServer(getRequestListener(app.fetch)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
    const sdk = (sessionToken: string) => new PlatformVaultRuntimeClient({ baseUrl: `http://127.0.0.1:${address.port}`,
      pins: local!.pins, vaultPins: vault.pins, vault: vault.agent.vault, sessionToken, nowSeconds: () => chainClock });
    let chainClock = await bridge.now(); const agentSdk = sdk('2'.repeat(64)), ownerSdk = sdk('1'.repeat(64));
    const prepared = await agentSdk.quote({ leashId: vault.agent.leashId, task: { kind: 'session', imageDigest: digest, maxCommands: 2 },
      maxSeconds: 100, deadline: chainClock + 300, maxSpend: '20000' }, 'never-dispatched');
    const admission = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    await agentSdk.admit({ runId: prepared.quote.runId, transactionHash: admission.transactionHash }, 'admit-never-dispatched');
    await lifecycle.agents.register(owner, { agent, runId: prepared.quote.runId });
    const current = await lifecycle.agents.get(owner, agent), killed = await lifecycle.agents.plan(owner, agent,
      { action: 'kill', expectedVersion: current.agent.version }, 'kill-queued');
    const control = { get: lifecycle.agents.get.bind(lifecycle.agents), acknowledge: lifecycle.agents.acknowledge.bind(lifecycle.agents),
      validateExecution: lifecycle.agents.validateExecution.bind(lifecycle.agents),
      upload: (payer: string, envelope: Parameters<CystService['upload']>[1], key: string) => cysts.upload(payer, envelope, key),
      download: cysts.download.bind(cysts) };
    const directory = join(root, 'private'); await mkdir(directory, { mode: 0o700 });
    privateVault = new CystCheckpointFileVault({ directory, masterKey });
    const adapter = new PaidLifecycleClientVault(privateVault, { owner, agent, applicationSchema });
    const submitted = new Map<string, string>(); let submissions = 0;
    const stopPort: PaidLifecycleStopPort = { lookup: async id => submitted.get(id) ?? null, submit: async (plan, id) => {
      submissions++; const receipt = await local!.confirmed(local!.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
      submitted.set(id, receipt.transactionHash); return receipt.transactionHash;
    } };
    const client = { config: agentSdk.config.bind(agentSdk), get: agentSdk.get.bind(agentSdk), sessionLease: agentSdk.sessionLease.bind(agentSdk),
      sessionEvents: agentSdk.sessionEvents.bind(agentSdk), command: agentSdk.command.bind(agentSdk), stopPlan: ownerSdk.stopPlan.bind(ownerSdk) };
    const make = (selected = client) => new PaidAgentLifecycleRunnerV2({ owner, agent, applicationSchema, intentId: killed.intent.id,
      kind: 'kill', targetMode: 'cyst', sourceRunId: prepared.quote.runId, targetRunId: null, imageDigest: digest,
      client: selected, control, vault: adapter, chain: bridge.public, stopPort, minConfirmations: 1,
      checkpointArgvPrefix: [process.execPath, '-e', checkpointProgram], restoreArgvPrefix: [process.execPath, '-e', restoreProgram] });
    const operation = killed.intent.id + ':stop';
    const attempted = await Promise.allSettled([make().stop(prepared.quote.runId, operation), make().stop(prepared.quote.runId, operation)]);
    expect(attempted.map(result => result.status)).toEqual(['rejected', 'rejected']); expect(submissions).toBe(1);
    await runtime.drain(); expect(dispatched).not.toHaveBeenCalled();
    const pending = await ownerSdk.get(prepared.quote.runId); expect(pending.cpuDispatch).toBeUndefined();
    const closed = BigInt((Math.floor(pending.settlement!.endedAt / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); chainClock = Number(closed);
    vi.spyOn(Date, 'now').mockReturnValue(Number(closed) * 1000 + 1000); await runtime.drain();
    const final = await agentSdk.get(prepared.quote.runId);
    expect(final).toMatchObject({ status: 'completed', charged: '0', refund: prepared.ceiling,
      cpuDispatch: { state: 'never_dispatched', confirmed: true, admissionTx: admission.transactionHash } });
    const missingMarker = { ...client, get: async (id: string) => { const { cpuDispatch: _marker, ...value } = await client.get(id); return value; } };
    await expect(make(missingMarker).stop(prepared.quote.runId, operation)).rejects.toThrow();
    await make().stop(prepared.quote.runId, operation); expect(submissions).toBe(1);
    await control.acknowledge(owner, killed.intent.id, killed.intent.version, { phase: 'stop' });
    expect((await control.get(owner, agent)).agent.currentRunId).toBeNull(); expect(dispatched).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); privateVault?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await store?.close(); await local?.close(); masterKey.fill(0); const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-paid-lifecycle-v2-')) throw new Error('Unexpected owned fixture path');
    await rm(target, { recursive: true, force: true });
  }
}, 120_000);
