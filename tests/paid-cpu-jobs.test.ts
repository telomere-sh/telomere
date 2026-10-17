import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { encodeAbiParameters, createWalletClient, http, keccak256, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { PaidPreemptionHandoff } from '../src/sdk/index.js';
import { PaidSessionStateHandoff } from '../src/agents/paid-session-handoff.js';
import { PaidLifecycleClientVault } from '../src/agents/paid-lifecycle-runner.js';
import { PAID_CPU_JOB_REPLAN_SCHEMA, PaidCpuJobReplanRunner } from '../src/agents/paid-cpu-job-replan-runner.js';
import { PAID_CPU_JOB_FINISH_SCHEMA, PaidCpuJobFinishRunner } from '../src/agents/paid-cpu-job-finish-runner.js';
import { Auth } from '../src/auth.js';
import { localChain } from '../src/chain/chains.js';
import { canonical, hashJson, Problem } from '../src/common.js';
import { PaidCpuJobService } from '../src/scheduling/paid-jobs.js';
import { createPaidCpuJobRoutes } from '../src/scheduling/paid-job-routes.js';
import { paidCpuJobs } from '../src/scheduling/paid-job-schema.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { platformWorkloadHash, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { loadConfig } from '../src/config.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { CystService } from '../src/cysts/service.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createDockerHostedHostKit, createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidSessions, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, imageDigestSchema } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PaidHostPreemptionService } from '../src/host-kit/sessions/paid-preemption.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { PlatformPublicFinancialReader } from '../src/platform-runtime/public-financial.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import type { CystCheckpointVault } from '../src/sdk/cyst-checkpoints.js';
import { CystClient } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { openStore } from '../src/store.js';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const fixtureImage = `fixture/session@sha256:${'a'.repeat(64)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checkpointProgram = `
const fs=require('node:fs');const [sourceRunId,operationId]=process.argv.slice(1);
const path='checkpoint-'+operationId+'.bin';let bytes;
try{bytes=fs.readFileSync(path)}catch(error){if(error.code!=='ENOENT')throw error;
bytes=fs.readFileSync('state.json');fs.writeFileSync(path,bytes,{flag:'wx',mode:0o600})}
process.stdout.write(JSON.stringify({protocol:'telomere-paid-app-checkpoint-v1',sourceRunId,operationId,stateBase64:bytes.toString('base64')}));
`;
const restoreProgram = `
const fs=require('node:fs'),crypto=require('node:crypto');
const [sourceRunId,targetRunId,checkpointOperationId,checkpointId,restoreOperationId,stateSha256]=process.argv.slice(1);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',()=>{try{const value=JSON.parse(input);
const receipt={protocol:'telomere-paid-app-restore-v1',sourceRunId,targetRunId,checkpointOperationId,checkpointId,restoreOperationId,stateSha256};
for(const [key,expected] of Object.entries(receipt))if(value[key]!==expected)throw Error('binding');
const bytes=Buffer.from(value.stateBase64,'base64');
if(bytes.toString('base64')!==value.stateBase64||bytes.length<1||bytes.length>4096
||crypto.createHash('sha256').update(bytes).digest('hex')!==stateSha256)throw Error('state');
const saved=JSON.stringify({receipt,stateBase64:value.stateBase64});
try{fs.writeFileSync('handoff.json',saved,{flag:'wx',mode:0o600})}
catch(error){if(error.code!=='EEXIST'||fs.readFileSync('handoff.json','utf8')!==saved)throw error}
process.stdout.write(JSON.stringify(receipt))}catch{process.stderr.write('restore rejected');process.exitCode=1}});
`;

let artifacts: Record<string, ContractArtifact>;
beforeAll(() => {
  artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
}, 90_000);

it('runs a paid CPU job across two offers on one physical source and a separately funded standard target', async () => {
  // An explicit dedicated socket and immutable image turn this same owner/chain
  // acceptance into an isolated two-host real-gVisor acceptance on Linux.
  const gvisorSocket = process.env.TELOMERE_ACCEPTANCE_GVISOR_SOCKET;
  const gvisorImage = process.env.TELOMERE_ACCEPTANCE_GVISOR_IMAGE;
  const reviewedGvisorImages = new Set([
    '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe',
    '127.0.0.1:15004/telomere-declared-state@sha256:db091765b34bac310fa2fa6284d59abe97f294e5d2a800946c38f46e46f31eea',
  ]);
  if (gvisorSocket || gvisorImage) {
    if (process.platform !== 'linux' || !gvisorSocket || !gvisorImage || !reviewedGvisorImages.has(gvisorImage)
      || !/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(gvisorSocket) || gvisorSocket.includes('..')
      || ['/var/run/docker.sock', '/run/docker.sock'].includes(gvisorSocket)) {
      throw new Error('Real-gVisor acceptance requires a dedicated Linux Docker socket and immutable image');
    }
    const socket = await lstat(gvisorSocket);
    if (!socket.isSocket() || socket.isSymbolicLink()) throw new Error('Dedicated Docker socket is invalid');
    imageDigestSchema.parse(gvisorImage);
  }
  const image = gvisorImage ?? fixtureImage;
  const imageDigest = image.slice(image.lastIndexOf('@') + 1);
  const cellNode = gvisorSocket ? '/usr/local/bin/node' : process.execPath;
  const root = await mkdtemp(join(tmpdir(), 'telomere-vault-preemption-'));
  const hostResources: { journal: HostJournal; hosted: ReturnType<typeof createHostedHostKit>;
    paid: PaidHostSessionAgent; preemption: PaidHostPreemptionService | undefined; server: Server }[] = [];
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let apiServer: Server | undefined, privateVault: CystCheckpointFileVault | undefined;
  const masterKey = randomBytes(32);
  try {
    const control = new Ed25519Identity();
    const hostFixture = async (name: string, preemptible: boolean) => {
      const journal = await openHostJournal(gvisorSocket ? join(root, name + '-journal') : ':memory:');
      const cells = join(root, name); await mkdir(cells, { mode: 0o700 });
      const hosted = gvisorSocket ? createDockerHostedHostKit({ journal, controlKey: control.publicKey,
        reviewedImages: new Set([image]), isolation: 'gvisor', socketPath: gvisorSocket }) : (() => {
        const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
        return createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'),
          backend, controlKey: control.publicKey, reviewedImages: new Set([image]),
          scope: { version: 1, hostKey: journal.identity.publicKey, controlKey: control.publicKey,
            isolation: 'local_process_fixture', runtime: canonical(['fixture-session-runtime', name, root]),
            sessionBackend: backend.identity }, inventory: async () => [] });
      })();
      await hosted.initialize();
      const paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
      const preemption = preemptible ? new PaidHostPreemptionService(journal, paid) : undefined;
      await preemption?.initialize();
      const server = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid, preemption).fetch));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host fixture port missing');
      hostResources.push({ journal, hosted, paid, preemption, server });
      return { client: new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true),
        journal, preemption };
    };
    const sourceHost = await hostFixture('source-cells', true);
    const targetHost = await hostFixture('target-cells', false);
    local = await deployPlatformRuntime(sourceHost.journal.identity.publicKey as Hex, artifacts);
    const secondOperator = privateKeyToAccount(generatePrivateKey());
    await local.test.setBalance({ address: secondOperator.address, value: parseEther('10') });
    const secondWallet = createWalletClient({ account: secondOperator, chain: localChain,
      transport: http(local.local.rpcUrl, { retryCount: 0 }) });
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress,
      abi: local.artifact('MockToken').abi, functionName: 'faucet', args: [secondOperator.address, 300_000_000n] }));
    await local.confirmed(secondWallet.writeContract({ address: local.pins.tokenAddress,
      abi: local.artifact('MockToken').abi, functionName: 'approve',
      args: [local.pins.hostRegistryAddress, 300_000_000n] }));
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
      hostKey, hardwareClass: 'cpu', region: 'shared-fixture', image, imageDigest, sealed: false, lane: 'standard',
      sessionEnabled: true, pricePerSecond, reliabilityBps: 10000, strikes: 0,
      stake: '300000000', availableAt: 0 });
    const sourceOffers = { protocol: 'telomere-cpu-lane-offers-v1' as const, offers: [
      { lane: 'standard' as const, pricePerSecond: '200', sessionPrices: { full: '200', lean: '120', torpor: '60' } },
      { lane: 'interruptible' as const, pricePerSecond: '100', sessionPrices: { full: '100', lean: '80', torpor: '40' },
        interruptible: { protocol: 'telomere-paid-preemption/v1' as const, minimumNoticeSeconds: 30 as const, hostOptInRequired: true as const } },
    ] };
    const hosts = [{ ...host(local.hostId, sourceHost.journal.identity.publicKey, '200'),
      sessionPrices: sourceOffers.offers[0]!.sessionPrices, laneOffers: sourceOffers },
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
    service = new PlatformRuntimeService(store.db, bridge, hosts, executor, receipts, vaults);
    const vaultService = new PlatformVaultRuntimeService(service, vaults);
    await service.initialize();
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
    app.route('/api/platform', createPaidCpuJobRoutes(new PaidCpuJobService(service), principal));
    app.route('/api/cysts', createCystRoutes(cysts, principal));
    apiServer = createServer(getRequestListener(app.fetch));
    await new Promise<void>(resolve => apiServer!.listen(0, '127.0.0.1', resolve));
    const apiAddress = apiServer.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API fixture port missing');
    origin = `http://127.0.0.1:${apiAddress.port}`;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin,
      RPC_URL: local.local.rpcUrl, SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner,
      ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const ownerToken = await auth.session(local.accounts.owner.address), agentToken = await auth.session(vault.account.address);
    let quoteClock = Math.floor(Date.now() / 1000);
    const sdk = (sessionToken: string, fetcher?: typeof fetch) => new PlatformVaultRuntimeClient({ baseUrl: origin,
      pins: local!.pins, vaultPins: vault.pins, vault: vault.agent.vault, sessionToken,
      nowSeconds: () => quoteClock, ...(fetcher ? { fetch: fetcher } : {}) });
    const ownerSdk = sdk(ownerToken), agentSdk = sdk(agentToken);
    const binding = (await ownerSdk.config()).binding;
    const published = await ownerSdk.config();
    expect(published.capacity).toHaveLength(2);
    expect(published.capacity.find(row => row.hostId === local!.hostId)).toMatchObject({
      lane: 'standard', pricePerSecond: '200', laneOffers: sourceOffers });
    const privateDir = join(root, 'private-owner-vault'); await mkdir(privateDir, { mode: 0o700 });
    privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey });
    const ownerCysts = new CystClient(new ApiTransport(origin, { sessionToken: ownerToken }));
    const handoff = (client: PlatformVaultRuntimeClient, journalVault: CystCheckpointVault = privateVault!) => new PaidSessionStateHandoff({
      owner: local!.accounts.owner.address, agent: vault.account.address, applicationSchema: 'paid-counter.v1',
      client, cysts: ownerCysts, vault: journalVault, checkpointArgvPrefix: [cellNode, '-e', checkpointProgram],
      restoreArgvPrefix: [cellNode, '-e', restoreProgram] });
    const preemptionHandoff = (client: PlatformVaultRuntimeClient, journalVault?: CystCheckpointVault,
      ownerClient: Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'sessionLease' | 'preemptionNotice'> = ownerSdk) => new PaidPreemptionHandoff({ binding,
      applicationSchema: 'paid-counter.v1', controllerKey: control.publicKey,
      hostKeys: new Map([[local!.hostId, sourceHost.journal.identity.publicKey],
        [targetHostId, targetHost.journal.identity.publicKey]]),
      client: ownerClient, handoff: handoff(client, journalVault), vault: privateVault! });
    const admit = async (id: string, maxSeconds: number, excludedHostIds?: string[], quoted?: PlatformPrepared) => {
      quoteClock = await bridge.now();
      const prepared = quoted ?? await agentSdk.quote({ leashId: vault.agent.leashId,
        task: { kind: 'session', imageDigest, maxCommands: 4 }, regions: ['shared-fixture'],
        ...(excludedHostIds ? { excludedHostIds } : {}),
        maxSeconds, deadline: await bridge.now() + 300, maxSpend: '20000' }, id);
      const receipt = await local!.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await vaultService.admit(vault.account.address, vault.agent.vault,
        { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-' + id);
      const running = service.drain();
      // Cold gVisor creation on a shared acceptance VPS can exceed the local
      // process fixture's eight-second wait; keep the same readiness assertion.
      for (let attempt = 0; attempt < (gvisorSocket ? 300 : 80); attempt++) {
        try { await executor.events(prepared.quote.runId, -1, 8); return { prepared, running }; }
        catch { await sleep(100); }
      }
      const pending = (await store!.db.select().from(platformRuns)).find(row => row.id === prepared.quote.runId);
      throw new Error(`Vault paid session did not start (${pending?.status ?? 'missing'}/${pending?.errorCode ?? 'no-error'})`);
    };
    const jobInput = { protocol: 'telomere-paid-cpu-job-v1' as const, leashId: vault.agent.leashId,
      task: { kind: 'session' as const, imageDigest, maxCommands: 4 }, workSeconds: 100,
      deadline: await bridge.now() + 7200, maxSpend: '20000', regions: ['shared-fixture'],
      lanes: ['standard' as const, 'interruptible' as const], interruptibleConsent: { minimumNoticeSeconds: 30 as const } };
    await expect(agentSdk.createCpuJob(jobInput, 'agent-cannot-create-job')).rejects.toThrow('not authorized');
    let lostCreate = true;
    const lossyOwner = sdk(ownerToken, async (url, init) => {
      const response = await fetch(url, init);
      if (lostCreate && init?.method === 'POST' && String(url).endsWith('/cpu-jobs')) {
        lostCreate = false; await response.arrayBuffer(); throw new Error('lost owner job response');
      }
      return response;
    });
    await expect(lossyOwner.createCpuJob(jobInput, 'owner-cpu-job-1')).rejects.toThrow('lost owner job response');
    const job = await ownerSdk.createCpuJob(jobInput, 'owner-cpu-job-1');
    expect(job.prepared!.input.cpuScheduling?.lane).toBe('interruptible');
    expect(job.prepared!.quote.pricePerSecond).toBe('100');
    expect(job.prepared!.quote.workloadHash).toBe(platformWorkloadHash(job.prepared!.input));
    expect(job.prepared!.quote.workloadHash).not.toBe(platformWorkloadHash({ task: jobInput.task }));
    expect(job.runIds).toHaveLength(1);
    expect((await store.db.select().from(platformRuns))).toHaveLength(1);
    expect(job.fundsReserved).toBe(false);
    const source = await admit('paid-preempt-source', 100, undefined, job.prepared!);
    const sourceRunId = source.prepared.quote.runId;
    expect(source.prepared.quote.hostId).toBe(local.hostId);
    // Both offers use this exact HostKit client and its single signed admission slot.
    expect(await executor.capacityAvailable(hosts[0]!, 'session')).toBe(false);
    await expect(agentSdk.quote({ leashId: vault.agent.leashId, task: jobInput.task, maxSeconds: 40,
      deadline: jobInput.deadline, maxSpend: '20000', regions: ['shared-fixture'], excludedHostIds: [targetHostId] },
    'occupied-physical-source-standard-offer')).rejects.toMatchObject({ code: 'platform_host_unavailable' });
    expect((await agentSdk.command(sourceRunId, { commandId: 'write-source', argv: [cellNode, '-e',
      "require('node:fs').writeFileSync('state.json',JSON.stringify({counter:7,marker:'preempted'}))"] })).state)
      .toBe('completed');
    const originalLease = await ownerSdk.sessionLease(sourceRunId);
    const replanRunner = (client: PlatformVaultRuntimeClient = ownerSdk) => new PaidCpuJobReplanRunner({
      job, remainingSeconds: 40, restoreSeconds: 20, client, handoff: preemptionHandoff(agentSdk),
      journal: new PaidLifecycleClientVault(privateVault!, { owner: binding.owner, agent: binding.agentWallet,
        applicationSchema: PAID_CPU_JOB_REPLAN_SCHEMA }) });
    expect((await replanRunner().runOnce()).state).toBe('waiting_notice');
    const autoOptInKey = 'cpu-lane-v1:' + hashJson(source.prepared.quote);
    const optIn = await ownerSdk.preemptionOptIn(sourceRunId, autoOptInKey);
    expect(optIn.leaseHash).toBe(hostMessageHash(originalLease.lease));
    expect((await ownerSdk.preemptionOptIn(sourceRunId, autoOptInKey)).optIn).toEqual(optIn.optIn);
    expect((await sourceHost.client.preemptionOptInEvidence(originalLease.lease))).toEqual(optIn.optIn);
    await expect(agentSdk.preemptionOptIn(sourceRunId, 'agent-cannot-opt-in')).rejects.toThrow();
    const issued = await sourceHost.client.requestPreemptionNotice(originalLease.lease, 30_000,
      'maintenance', 'host-maintenance-1');
    expect(issued.notice).toEqual((await ownerSdk.preemptionNotice(sourceRunId)).notice);
    let failMarker = true;
    const interruptedVault: CystCheckpointVault = { exclusive: (scope, operation) => privateVault!.exclusive(scope, journal =>
      operation(scope.applicationSchema.startsWith('paid.preempt.lock.') ? { ...journal,
        saveCheckpoint: async (id, record) => {
          if (failMarker) { failMarker = false; throw new Error('interrupted after Cyst upload before marker'); }
          return journal.saveCheckpoint(id, record);
        } } : journal)) };
    const handoffDeadline = job.input.deadline;
    await expect(preemptionHandoff(agentSdk, interruptedVault).capture(sourceRunId, '20000', handoffDeadline))
      .rejects.toThrow('interrupted after Cyst upload before marker');
    const capturedCycle = await replanRunner().runOnce();
    expect(capturedCycle.state).toBe('waiting_source');
    const capture = await preemptionHandoff(agentSdk).capture(sourceRunId, '20000', handoffDeadline);
    expect(capturedCycle.checkpointId).toBe(capture.checkpointId);
    expect(capture.checkpointCompletedAtMs).toBeLessThan(issued.notice.body.interruptAt);
    expect((await preemptionHandoff(agentSdk).capture(sourceRunId, '20000', capture.deadline)).checkpointId)
      .toBe(capture.checkpointId);
    await expect(preemptionHandoff(agentSdk).capture(sourceRunId, '30000', capture.deadline))
      .rejects.toThrow('original owner budget');
    expect((await sourceHost.journal.db.select().from(hostSessions))
      .find(row => row.sessionId === sourceRunId)?.record?.commands).toHaveLength(2);
    await sleep(Math.max(0, issued.notice.body.interruptAt - Date.now() + (gvisorSocket ? 2_500 : 500)));
    if (gvisorSocket) {
      const state = await sourceHost.client.sessionControl(originalLease.lease, { action: 'status' });
      expect(state.state).toBe('stopped');
      expect(state.cleanupConfirmed).toBe(true);
      expect((await sourceHost.preemption!.enforceDue()).enforced).toHaveLength(0);
    } else await sourceHost.preemption!.enforceDue();
    await source.running;
    const pending = await ownerSdk.get(sourceRunId);
    expect(pending.status).toBe('receipt_pending');
    expect(pending.result).toMatchObject({ status: 'cancelled' });
    const replanInput = { checkpointHash: hashJson({ checkpointId: capture.checkpointId }), remainingSeconds: 40, restoreSeconds: 20 };
    await expect(ownerSdk.replanCpuJob(job.id, replanInput, 'owner-cpu-replan-1')).rejects.toThrow();
    expect((await replanRunner().runOnce()).state).toBe('waiting_source');
    expect((await ownerSdk.cpuJob(job.id)).outstandingLiability).toBe(source.prepared.ceiling);
    expect((await store.db.select().from(platformRuns))).toHaveLength(1);
    const closed = BigInt((Math.floor(pending.settlement!.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) {
      await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 });
    }
    await service.drain();
    expect((await ownerSdk.get(sourceRunId)).status).toBe('completed');
    expect((await ownerSdk.preemptionOptIn(sourceRunId, autoOptInKey)).optIn).toEqual(optIn.optIn);
    expect((await preemptionHandoff(agentSdk).capture(sourceRunId, '20000', capture.deadline)).checkpointId)
      .toBe(capture.checkpointId);
    quoteClock = await bridge.now();
    let lostReplan = true;
    const lossyReplanOwner = sdk(ownerToken, async (url, init) => {
      const response = await fetch(url, init);
      if (lostReplan && init?.method === 'POST' && String(url).endsWith('/replan')) {
        lostReplan = false; await response.arrayBuffer(); throw new Error('lost owner replan response');
      }
      return response;
    });
    await expect(replanRunner(lossyReplanOwner).runOnce()).rejects.toThrow('lost owner replan response');
    privateVault.close();
    privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey });
    const proposedCycle = await replanRunner().runOnce();
    expect(proposedCycle.state).toBe('awaiting_owner');
    const proposed = proposedCycle.job!;
    expect((await replanRunner().runOnce()).decisionHash).toBe(proposed.proposal!.decisionHash);
    expect(proposed.phase).toBe('awaiting_owner');
    expect(proposed.proposal!.target.lane).toBe('standard');
    expect(proposed.proposal!.sourceQuoteHash).toBe(hashJson(source.prepared.quote));
    expect(BigInt(proposed.proposal!.charged) + BigInt(proposed.proposal!.remainingBudget)).toBe(BigInt(job.input.maxSpend));
    expect(proposed.outstandingLiability).toBe('0');
    expect((await store.db.select().from(platformRuns))).toHaveLength(1);
    await expect(agentSdk.approveCpuJob(job.id, proposed.proposal!.decisionHash)).rejects.toThrow('not authorized');
    await expect(ownerSdk.approveCpuJob(job.id, `0x${'f'.repeat(64)}`)).rejects.toThrow();
    let lostApproval = true;
    const approvingOwner = sdk(ownerToken, async (url, init) => {
      const response = await fetch(url, init);
      if (lostApproval && init?.method === 'POST' && String(url).endsWith('/approve')) {
        lostApproval = false; await response.arrayBuffer(); throw new Error('lost approved quote response');
      }
      return response;
    });
    await expect(approvingOwner.approveCpuJob(job.id, proposed.proposal!.decisionHash)).rejects.toThrow('lost approved quote response');
    const approved = await sdk(ownerToken).approveCpuJob(job.id, proposed.proposal!.decisionHash);
    expect((await replanRunner().runOnce()).state).toBe('superseded');
    await expect(ownerSdk.replanCpuJob(job.id, { ...replanInput, expectedSourceRunId: sourceRunId },
      'stale-source-after-owner-approval')).rejects.toMatchObject({ code: 'paid_cpu_job_source_changed' });
    await expect(ownerSdk.finishCpuJob(job.id, { expectedSourceRunId: sourceRunId }))
      .rejects.toMatchObject({ code: 'paid_cpu_job_source_changed' });
    expect((await ownerSdk.cpuJob(job.id)).currentRunId).toBe(approved.currentRunId);
    expect(approved.runIds).toHaveLength(2);
    expect(approved.prepared!.input.cpuScheduling?.job).toMatchObject({ jobId: job.id,
      intentHash: job.intentHash, decisionHash: proposed.proposal!.decisionHash,
      sourceRunId, sourceQuoteHash: hashJson(source.prepared.quote), targetHostId });
    expect((await new PaidCpuJobService(service).get(local.accounts.owner.address, vault.agent.vault, job.id)).currentRunId)
      .toBe(approved.currentRunId);
    expect((await store.db.select().from(platformRuns))).toHaveLength(2);
    const reliability = await ownerSdk.cpuReliability(local.hostId, 'interruptible');
    expect(reliability).toMatchObject({ eligible: 1, completed: 1, reliabilityBps: 10000, marketWide: false });
    expect((await ownerSdk.cpuReliability(local.hostId, 'standard')).eligible).toBe(0);
    const target = await admit('paid-preempt-target', 60, [local.hostId], approved.prepared!);
    const targetRunId = target.prepared.quote.runId;
    expect(target.prepared.quote.hostId).toBe(targetHostId);
    expect(target.prepared.input.excludedHostIds).toEqual([local.hostId]);
    let lost = true;
    const lossyAgent = sdk(agentToken, async (url, init) => {
      const response = await fetch(url, init);
      if (lost && init?.method === 'POST' && String(url).endsWith('/commands')) {
        lost = false; await response.arrayBuffer(); throw new Error('lost paid target response');
      }
      return response;
    });
    const input = { capture, targetRunId, restoreOperationId: 'preempt-restore-1' };
    const lateEvidenceClient = { config: ownerSdk.config.bind(ownerSdk), get: ownerSdk.get.bind(ownerSdk),
      sessionLease: ownerSdk.sessionLease.bind(ownerSdk), preemptionNotice: async (runId: string) => {
        const evidence = await ownerSdk.preemptionNotice(runId);
        if (!evidence.terminalTick) throw new Error('Source terminal tick missing');
        return { ...evidence, terminalTick: sourceHost.journal.identity.sign('tick', {
          ...evidence.terminalTick.body, timestamp: evidence.notice.body.interruptAt + 6_000 }) };
      } };
    await expect(preemptionHandoff(agentSdk, undefined, lateEvidenceClient).restore(input))
      .rejects.toThrow('Signed source cleanup missed');
    expect((await targetHost.journal.db.select().from(hostSessions))
      .find(row => row.sessionId === targetRunId)?.record?.commands).toHaveLength(0);
    await expect(preemptionHandoff(agentSdk).restore({ ...input,
      capture: { ...capture, maxSpend: '30000' } })).rejects.toThrow('original owner budget');
    await expect(preemptionHandoff(agentSdk).restore({ ...input,
      capture: { ...capture, deadline: capture.deadline + 1000 } })).rejects.toThrow('original owner budget');
    await expect(preemptionHandoff(lossyAgent).restore(input)).rejects.toThrow('lost paid target response');
    expect(lost).toBe(false);
    const first = (await targetHost.journal.db.select().from(hostSessions))
      .find(row => row.sessionId === targetRunId)?.record;
    expect(first?.commands).toHaveLength(1);
    const restored = await preemptionHandoff(agentSdk).restore(input);
    expect(restored).toMatchObject({ targetRunId, noticeId: issued.notice.body.noticeId,
      sourceSettlementTx: (await ownerSdk.get(sourceRunId)).settlementTx });
    expect((await targetHost.journal.db.select().from(hostSessions))
      .find(row => row.sessionId === targetRunId)?.record?.commands).toHaveLength(1);
    await expect(preemptionHandoff(agentSdk).restore({ ...input,
      restoreOperationId: 'preempt-restore-2' })).rejects.toThrow('already claimed');
    const read = await agentSdk.command(targetRunId, { commandId: 'read-restored', argv: [cellNode, '-e',
      "process.stdout.write(Buffer.from(JSON.parse(require('node:fs').readFileSync('handoff.json','utf8')).stateBase64,'base64'))"] });
    expect(JSON.parse(read.stdout)).toEqual({ counter: 7, marker: 'preempted' });
    await expect(preemptionHandoff(agentSdk).restore({ ...input, capture: { ...capture,
      checkpointId: '00000000-0000-4000-8000-000000000001' } })).rejects.toThrow();
    await expect(preemptionHandoff(agentSdk).restore({ ...input,
      targetRunId: sourceRunId })).rejects.toThrow();
    for (const name of await readdir(join(root, 'server-cysts'))) {
      expect((await readFile(join(root, 'server-cysts', name))).toString()).not.toContain('preempted');
    }
    for (let attempt = 0; attempt < 80; attempt++) {
      const row = (await targetHost.journal.db.select().from(hostPaidSessions)).find(row => row.sessionId === targetRunId);
      if (row && row.billableSeconds > 0) break;
      await sleep(250);
    }
    expect((await targetHost.journal.db.select().from(hostPaidSessions)).find(row => row.sessionId === targetRunId)!.billableSeconds).toBeGreaterThan(0);
    const completionJob = await ownerSdk.cpuJob(job.id);
    const finishRunner = (client: PlatformVaultRuntimeClient = ownerSdk) => new PaidCpuJobFinishRunner({
      job: completionJob, applicationCompletionHash: hashJson({ application: 'counter-fixture', result: read.stdout }), client,
      journal: new PaidLifecycleClientVault(privateVault!, { owner: binding.owner, agent: binding.agentWallet,
        applicationSchema: PAID_CPU_JOB_FINISH_SCHEMA }) });
    expect((await finishRunner().runOnce()).state).toBe('waiting_source');
    await local.confirmed(local.owner.sendTransaction({ ...(await vaultService.stopPlan(local.accounts.owner.address,
      vault.agent.vault, targetRunId)), value: 0n }));
    await target.running;
    const stoppedTarget = await ownerSdk.get(targetRunId);
    const finalHour = BigInt((Math.floor(stoppedTarget.settlement!.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < finalHour) {
      await local.test.setNextBlockTimestamp({ timestamp: finalHour }); await local.test.mine({ blocks: 1 });
    }
    await service.drain();
    for (const prepared of [source.prepared, target.prepared]) {
      const final = await ownerSdk.get(prepared.quote.runId);
      expect(final.status).toBe('completed');
      expect(final.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
    }
    let lostFinish = true;
    const lossyFinishOwner = sdk(ownerToken, async (url, init) => {
      const response = await fetch(url, init);
      if (lostFinish && init?.method === 'POST' && String(url).endsWith('/finish')) {
        lostFinish = false; await response.arrayBuffer(); throw new Error('lost owner finish response');
      }
      return response;
    });
    await expect(finishRunner(lossyFinishOwner).runOnce()).rejects.toThrow('lost owner finish response');
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey });
    const completed = await finishRunner().runOnce();
    expect(completed.state).toBe('finished');
    const finished = completed.job!;
    expect(finished.phase).toBe('finished'); expect(finished.outstandingLiability).toBe('0');
    await expect(ownerSdk.finishCpuJob(job.id, { expectedSourceRunId: sourceRunId }))
      .rejects.toMatchObject({ code: 'paid_cpu_job_source_changed' });
    expect((await ownerSdk.finishCpuJob(job.id)).phase).toBe('finished'); // Legacy omission remains compatible.
    expect(BigInt(finished.charged)).toBe(BigInt((await ownerSdk.get(sourceRunId)).charged!) + BigInt((await ownerSdk.get(targetRunId)).charged!));
    expect(BigInt(finished.charged)).toBeLessThanOrEqual(BigInt(finished.input.maxSpend));
    const priceBoard = await new PlatformPublicFinancialReader(bridge, 1, id => service.cpuLaneAttribution(id)).cpuPriceBoard();
    expect(priceBoard.marketWide).toBe(false);
    expect(priceBoard.lanes.standard!['7d']).toMatchObject({ count: 1, medianMicroUsdcPerSecond: '101' });
    expect(priceBoard.lanes.interruptible!['7d']).toMatchObject({ count: 1, medianMicroUsdcPerSecond: '100' });
    expect(priceBoard.lanes.unattributed!['7d']).toMatchObject({ count: 0 });
    quoteClock = await bridge.now();
    // Source cleanup exposes BOTH prices again through the same physical host.
    for (const [profile, expectedPrice] of [['full', '200'], ['lean', '120'], ['torpor', '60']] as const) {
      const separate = await agentSdk.quote({ leashId: vault.agent.leashId,
        task: { ...jobInput.task, resourceProfile: profile }, maxSeconds: 40, deadline: quoteClock + 300,
        maxSpend: '20000', regions: ['shared-fixture'], excludedHostIds: [targetHostId] }, 'source-standard-profile-' + profile);
      expect(separate.quote.hostId).toBe(local.hostId);
      expect(separate.quote.pricePerSecond).toBe(expectedPrice);
      expect(separate.input.cpuScheduling).toBeUndefined();
      expect((await bridge.run(separate.quote.runId)).status).toBe(0);
    }
    const deadlineJob = await ownerSdk.createCpuJob({ ...jobInput, deadline: quoteClock + 150 }, 'owner-deadline-job-2');
    await local.test.setNextBlockTimestamp({ timestamp: BigInt(quoteClock + 40) }); await local.test.mine({ blocks: 1 });
    await expect(ownerSdk.replanCpuJob(deadlineJob.id,
      { checkpointHash: `0x${'2'.repeat(64)}`, expectedSourceRunId: sourceRunId,
        remainingSeconds: 100, restoreSeconds: 20 }, 'stale-source-before-deadline-cancel'))
      .rejects.toMatchObject({ code: 'paid_cpu_job_source_changed' });
    expect(await ownerSdk.cpuJob(deadlineJob.id)).toMatchObject({ phase: 'active',
      currentRunId: deadlineJob.currentRunId, outstandingLiability: deadlineJob.prepared!.ceiling });
    const cancelled = await ownerSdk.replanCpuJob(deadlineJob.id,
      { checkpointHash: `0x${'2'.repeat(64)}`, remainingSeconds: 100, restoreSeconds: 20 }, 'owner-deadline-replan-2');
    expect(cancelled).toMatchObject({ phase: 'cancelled', cancellationReason: 'deadline_infeasible',
      outstandingLiability: deadlineJob.prepared!.ceiling, charged: '0', stopAndRefundRequired: true });
    await expect(ownerSdk.quote(deadlineJob.prepared!.input, (await store.db.select().from(platformRuns))
      .find(row => row.id === deadlineJob.currentRunId)!.idemKey)).rejects.toThrow();
    // A previously signed, still-valid quote can be paid directly at the
    // contract. Cancellation must still prevent application dispatch and keep
    // its full ceiling unavailable until the canonical zero-work settlement.
    const latePayment = await local.confirmed(vault.wallet.sendTransaction({ to: deadlineJob.prepared!.transaction.to,
      data: deadlineJob.prepared!.transaction.data as Hex, value: 0n }));
    await vaultService.admit(vault.account.address, vault.agent.vault,
      { runId: deadlineJob.currentRunId!, transactionHash: latePayment.transactionHash }, 'admit-cancelled-job');
    await service.drain();
    const noDispatch = await ownerSdk.get(deadlineJob.currentRunId!);
    expect(noDispatch).toMatchObject({ status: 'receipt_pending', result: { billableSeconds: 0 } });
    expect((await ownerSdk.cpuJob(deadlineJob.id)).outstandingLiability).toBe(deadlineJob.prepared!.ceiling);
    const zeroHour = BigInt((Math.floor(noDispatch.settlement!.endedAt / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: zeroHour }); await local.test.mine({ blocks: 1 }); await service.drain();
    expect(await ownerSdk.get(deadlineJob.currentRunId!)).toMatchObject({ status: 'completed', charged: '0',
      refund: deadlineJob.prepared!.ceiling, cpuDispatch: { state: 'never_dispatched', confirmed: true } });
    expect(await ownerSdk.cpuJob(deadlineJob.id)).toMatchObject({ outstandingLiability: '0', stopAndRefundRequired: false });
    expect((await store.db.select().from(paidCpuJobs))).toHaveLength(2);
  } finally {
    privateVault?.close(); masterKey.fill(0);
    if (apiServer) { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer!.close(() => resolve())); }
    for (const resource of [...hostResources].reverse()) {
      await resource.preemption?.close().catch(() => undefined);
      await resource.paid.close().catch(() => undefined);
      await resource.hosted.close().catch(() => undefined);
      resource.server.closeAllConnections(); await new Promise<void>(resolve => resource.server.close(() => resolve()));
      await resource.journal.close();
    }
    await store?.close(); await local?.close(); await rm(root, { recursive: true, force: true });
  }
}, 240_000);
