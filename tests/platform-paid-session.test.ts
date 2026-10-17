import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { keccak256, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { AgentCurrentCystPaidRestore } from '../src/agents/agent-current-cyst-restore.js';
import { canonical, hashJson, Problem, randomId } from '../src/common.js';
import { generateLargeCystId, LargeCystPrivateStore, saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { largeCystRegistryDescriptor, largeCystRegistryMatches } from '../src/cysts/large-registry.js';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { cystRegistryPinsSchema } from '../src/cysts/registry-types.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash } from '../src/host-kit/protocol.js';
import { parsePaidSessionLease } from '../src/host-kit/sessions/paid-protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';
import type { LargeCystAgentManifestStore } from '../src/sdk/large-cyst-agent-manifest.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { platformHostSchema, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { PlatformV2AdmissionJournal } from '../src/receipts/platform-v2-admission.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const image = `fixture/session@sha256:${'a'.repeat(64)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('paid interactive CPU session through canonical escrow and receipt', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let vault: Awaited<ReturnType<typeof deployPlatformVault>>, vaults: PlatformVaultBridge, vaultService: PlatformVaultRuntimeService;
  let store: Awaited<ReturnType<typeof openStore>>, journal: HostJournal, hosted: ReturnType<typeof createHostedHostKit>;
  let paid: PaidHostSessionAgent, server: Server, apiServer: Server, root: string, bridge: PlatformBridge;
  let service: PlatformRuntimeService, executor: PlatformHostExecutor, receipts: PlatformReceiptService;
  let host: ReturnType<typeof platformHostSchema.parse>, client: HostKitClient, leashId: Hex;
  let origin: string, auth: Auth, tokens: { owner: string; agent: string; outsider: string };
  beforeAll(() => {
    artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol', 'CystRegistry.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  }, 90_000);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-platform-session-'));
    const cells = join(root, 'cells'); await mkdir(cells, { mode: 0o700 });
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime, backend, controlKey: control.publicKey,
      reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
        controlKey: control.publicKey, isolation: 'local_process_fixture',
        runtime: canonical(['fixture-session-runtime', root]), sessionBackend: backend.identity }, inventory: async () => [] });
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host fixture has no address');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'local-test',
      image, imageDigest: `sha256:${'a'.repeat(64)}`, sealed: false, lane: 'standard', sessionEnabled: true,
      pricePerSecond: '100', sessionPrices: { full: '100', lean: '50', torpor: '25' },
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    vaults = new PlatformVaultBridge(bridge, vault.pins);
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    vaultService = new PlatformVaultRuntimeService(service, vaults);
    await service.initialize(); leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
        expiry: BigInt(await bridge.now() + 86_400) }] }));
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong owner origin');
      await next();
    });
    app.get('/api/me', async context => context.json({ address: await auth.owner(getCookie(context, 'telomere_session')), demo: false }));
    app.route('/api/platform', createPlatformRuntimeRoutes(service, context => auth.owner(getCookie(context, 'telomere_session'))));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(vaultService, context => auth.owner(getCookie(context, 'telomere_session'))));
    apiServer = createServer(getRequestListener(app.fetch));
    await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const apiAddress = apiServer.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API fixture has no address');
    origin = `http://127.0.0.1:${apiAddress.port}`;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner,
      ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    tokens = { owner: await auth.session(local.accounts.owner.address), agent: await auth.session(vault.account.address),
      outsider: await auth.session(local.accounts.outsider.address) };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await paid?.close().catch(() => undefined); await hosted?.close().catch(() => undefined);
    if (apiServer) { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve())); }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await journal?.close(); await store?.close(); await local?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ownerClient = () => new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: tokens.owner });
  const vaultClient = (role: keyof typeof tokens) => new PlatformVaultRuntimeClient({ baseUrl: origin,
    pins: local.pins, vaultPins: vault.pins, vault: vault.agent.vault, sessionToken: tokens[role] });
  async function open(prepared: PlatformPrepared) {
    const receipt = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    await service.admit(local.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-paid-session');
    return receipt;
  }
  async function waitForAdmission(runId: string) {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await executor.events(runId, -1, 8); return; } catch { await sleep(100); }
    }
    throw new Error('Paid session did not start');
  }
  it.each([{ profile: 'lean' as const, price: 50n, quota: 0.5 }, { profile: 'torpor' as const, price: 25n, quota: 0.25 }])
   ('binds paid $profile CPU policy and price to the original signed workload', async ({ profile, price, quota }) => {
      const sdk = vaultClient('agent');
      const prepared = await sdk.quote({ leashId: vault.agent.leashId,
        task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 2, resourceProfile: profile },
        maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'paid-profile-' + profile);
      expect(prepared.quote.pricePerSecond).toBe(price.toString());
      expect(prepared.ceiling).toBe((25n * price + (25n * price * 900n + 9999n) / 10000n).toString());
      const opened = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await sdk.admit({ runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'admit-profile-' + profile);
      const running = service.drain(); await waitForAdmission(prepared.quote.runId);
      const signed = await sdk.sessionLease(prepared.quote.runId);
      const lease = parsePaidSessionLease(signed.lease);
      expect(lease.payload.resourceProfile).toBe(profile); expect(lease.payload.spec.policy.cpu).toBe(quota);
      expect((await sdk.command(prepared.quote.runId, { commandId: 'profile-output',
        argv: [process.execPath, '-e', "process.stdout.write('profile-state')"] })).stdout).toBe('profile-state');
      await sleep(11_000);
      const plan = await vaultClient('owner').stopPlan(prepared.quote.runId, 'stop-profile-' + profile);
      await local.confirmed(local.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
      await running;
      const pending = await sdk.get(prepared.quote.runId);
      expect(pending.settlement!.billableSeconds).toBeGreaterThan(0);
      const closed = BigInt((Math.floor(pending.settlement!.endedAt / 3600) + 1) * 3600);
      await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); await service.drain();
      const final = await sdk.get(prepared.quote.runId), base = BigInt(final.settlement!.billableSeconds) * price;
      expect(final.status).toBe('completed'); expect(final.charged).toBe((base + (base * 900n + 9999n) / 10000n).toString());
      expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
      expect(final.cpuDispatch).toBeUndefined();
    }, 60_000);
  it('drops an unadmitted paid-session lease if cancellation arrives during the optional v2 gate', async () => {
    const owner = local.accounts.owner.address;
    const prepared = await service.quote(owner,
      { leashId, task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 2 },
        maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' },
      'abort-v2-session-gate');
    const opened = await open(prepared);
    const abort = new AbortController(), runId = prepared.quote.runId;
    let enteredGate!: () => void, releaseGate!: () => void;
    const gateEntered = new Promise<void>(resolve => { enteredGate = resolve; });
    const gateRelease = new Promise<void>(resolve => { releaseGate = resolve; });
    const optIn = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]), {
      issueBeforeHostAdmission: async () => {
        enteredGate();
        await gateRelease;
        return undefined as never;
      },
    });
    const sessionAdmit = vi.spyOn(client, 'sessionAdmit');
    const running = optIn.run(owner, host,
      { runId, task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 2 },
        maxSeconds: prepared.input.maxSeconds },
      abort.signal, async () => undefined,
      { quoteHash: hashJson(prepared.quote), admissionTx: opened.transactionHash });
    let earlyFailure: unknown;
    const phase = await Promise.race([gateEntered.then(() => 'entered' as const),
      running.then(() => 'finished' as const, error => { earlyFailure = error; return 'failed' as const; })]);
    if (phase !== 'entered') throw earlyFailure ?? new Error('Paid session finished before the optional gate');
    abort.abort(new Error('cancelled during pre-admission authority check'));
    releaseGate();
    await expect(running).rejects.toThrow('cancelled during pre-admission authority check');
    expect(sessionAdmit).not.toHaveBeenCalled();
    expect(await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId))).toEqual([]);
  }, 60_000);
  it('runs two owner commands in one Cell, settles signed seconds and exposes durable events', async () => {
    const sdk = ownerClient(), prepared = await sdk.quote({ leashId, task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 4 },
      maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'paid-session');
    const runId = prepared.quote.runId, owner = local.accounts.owner.address;
    expect(prepared.quote.workloadHash).toBe(hashJson({ task: prepared.input.task }));
    await expect(service.command(owner, runId, { commandId: 'early', argv: [process.execPath, '-e', 'process.exit(0)'] }))
      .rejects.toMatchObject({ code: 'platform_session_inactive' });
    await open(prepared);
    const running = service.drain(); await waitForAdmission(runId);
    const [admittedLease] = await store.db.select().from(platformHostLeases)
      .where(eq(platformHostLeases.runId, runId));
    const optInV2 = new PlatformV2AdmissionJournal(store.db, bridge);
    await expect(optInV2.issueBeforeHostAdmission({ owner, hostId: host.hostId,
      controllerKey: client.control.publicKey, lease: admittedLease!.lease }))
      .rejects.toThrow('one-shot CPU runs, not paid sessions');
    const first = await sdk.command(runId, { commandId: 'write', argv: [process.execPath, '-e',
      "require('node:fs').writeFileSync('shared.txt','paid-cell');process.stdout.write('ok')"] });
    expect(first).toMatchObject({ state: 'completed', stdout: 'ok' });
    expect(await sdk.command(runId, first.command)).toEqual(first);
    const second = await sdk.command(runId, { commandId: 'read', argv: [process.execPath, '-e',
      "process.stdout.write(require('node:fs').readFileSync('shared.txt','utf8'))" ] });
    expect(second).toMatchObject({ state: 'completed', stdout: 'paid-cell' });
    await expect(service.command(local.accounts.outsider.address, runId, second.command)).rejects.toMatchObject({ status: 404 });
    expect((await sdk.sessionEvents(runId)).events.some(event => event.kind === 'ready')).toBe(true);
    await sleep(11_000);
    await local.confirmed(local.owner.sendTransaction({ ...(await service.stopPlan(owner, runId)), value: 0n }));
    await running;
    const pending = await service.get(owner, runId);
    expect(pending.status).toBe('receipt_pending');
    expect(pending.settlement!.billableSeconds).toBeGreaterThan(0);
    const [lease] = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId));
    expect(lease?.cleanupConfirmed).toBe(1);
    expect(lease?.sessionEvents?.some(event => event.kind === 'session_exit')).toBe(true);
    expect(pending.result?.output).toBe(hashJson({ protocol: 'telomere-paid-session-events-v1', events: lease?.sessionEvents }));
    expect((await sdk.sessionEvents(runId, -1, 8)).events).toEqual(lease?.sessionEvents?.slice(0, 8));
    expect(await sdk.command(runId, first.command)).toEqual(first);
    await expect(service.command(owner, runId, { ...first.command,
      argv: [process.execPath, '-e', "process.stdout.write('changed')"] })).rejects.toMatchObject({
      code: 'platform_command_conflict', status: 409 });
    await expect(service.command(owner, runId, { commandId: 'late', argv: [process.execPath, '-e', 'process.exit(0)'] }))
      .rejects.toMatchObject({ code: 'platform_session_inactive', status: 409 });
    await store.db.update(platformRuns).set({ settlement: { ...pending.settlement!, receiptHash: randomId() } })
      .where(eq(platformRuns.id, runId));
    await expect(service.command(owner, runId, first.command)).rejects.toMatchObject({
      code: 'platform_session_history_changed', status: 409 });
    await store.db.update(platformRuns).set({ settlement: pending.settlement }).where(eq(platformRuns.id, runId));
    const ended = pending.settlement!.endedAt, closed = BigInt((Math.floor(ended / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) { await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); }
    await service.drain();
    const final = await service.get(owner, runId);
    expect(final.status).toBe('completed');
    const base = BigInt(final.settlement!.billableSeconds) * 100n, fee = (base * 900n + 9999n) / 10000n;
    expect(final.charged).toBe((base + fee).toString());
    expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
    expect((await bridge.run(runId)).hostReleased).toBe(true);
    expect((await bridge.host(host.hostId)).openRuns).toBe(0n);
    expect(await sdk.command(runId, second.command)).toEqual(second);
    await store.db.update(platformHostLeases).set({ sessionEvents: [] }).where(eq(platformHostLeases.runId, runId));
    await expect(service.sessionEvents(owner, runId)).rejects.toMatchObject({ code: 'platform_session_history_changed' });
    await expect(service.command(owner, runId, first.command)).rejects.toMatchObject({ code: 'platform_session_history_changed' });
    await store.db.update(platformRuns).set({ result: { ...final.result!,
      output: hashJson({ protocol: 'telomere-paid-session-events-v1', events: [] }) } }).where(eq(platformRuns.id, runId));
    await expect(service.sessionEvents(owner, runId)).rejects.toMatchObject({ code: 'platform_session_history_changed' });
  }, 60_000);
  it('runs a funded Vault Cell for its agent, grants owner reads, denies owner commands and burns settled cost', async () => {
    const agent = vault.account.address, payer = vault.agent.vault, owner = local.accounts.owner.address;
    const agentSdk = vaultClient('agent'), ownerSdk = vaultClient('owner'), outsiderSdk = vaultClient('outsider');
    const prepared = await agentSdk.quote({ leashId: vault.agent.leashId,
      task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 4 },
      maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'vault-paid-session');
    expect(prepared.quote.payer.toLowerCase()).toBe(payer.toLowerCase());
    const receipt = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    await vaultService.admit(agent, payer, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-vault-session');
    const running = service.drain(); await waitForAdmission(prepared.quote.runId);
    const ownerLease = await ownerSdk.sessionLease(prepared.quote.runId);
    expect(ownerLease.lease.body.owner).toBe(payer.toLowerCase());
    expect(ownerLease.lease.body.runId).toBe(prepared.quote.runId);
    expect(ownerLease.leaseHash).toBe(hostMessageHash(ownerLease.lease));
    expect(await agentSdk.sessionLease(prepared.quote.runId)).toEqual(ownerLease);
    await expect(outsiderSdk.sessionLease(prepared.quote.runId)).rejects.toThrow();
    expect((await fetch(`${origin}/api/platform/vaults/${payer}/runs/${prepared.quote.runId}/lease`)).status).toBe(401);
    const command = { commandId: 'agentwrite', argv: [process.execPath, '-e', "process.stdout.write('vault-paid')"] };
    await expect(ownerSdk.command(prepared.quote.runId, command)).rejects.toThrow();
    await expect(outsiderSdk.command(prepared.quote.runId, command)).rejects.toThrow();
    await expect(vaultService.command(owner, payer, prepared.quote.runId, command)).rejects.toMatchObject({ status: 404 });
    await expect(vaultService.command(local.accounts.outsider.address, payer, prepared.quote.runId, command)).rejects.toMatchObject({ status: 404 });
    const wrongIdem = await fetch(`${origin}/api/platform/vaults/${payer}/runs/${prepared.quote.runId}/commands`, {
      method: 'POST', headers: { Cookie: `telomere_session=${tokens.agent}`, Origin: origin,
        'Content-Type': 'application/json', 'Idempotency-Key': 'different' }, body: JSON.stringify(command) });
    expect(wrongIdem.status).toBe(409);
    const result = await agentSdk.command(prepared.quote.runId, command);
    expect(result).toMatchObject({ state: 'completed', stdout: 'vault-paid' });
    expect((await ownerSdk.sessionEvents(prepared.quote.runId)).events.some(event => event.kind === 'ready')).toBe(true);
    expect((await agentSdk.sessionEvents(prepared.quote.runId)).events.some(event => event.kind === 'ready')).toBe(true);
    await expect(outsiderSdk.sessionEvents(prepared.quote.runId)).rejects.toThrow();
    await expect(vaultService.sessionEvents(local.accounts.outsider.address, payer, prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    await sleep(11_000);
    await local.confirmed(local.owner.sendTransaction({ ...(await vaultService.stopPlan(owner, payer, prepared.quote.runId)), value: 0n }));
    await running;
    const pending = await vaultService.get(owner, payer, prepared.quote.runId);
    expect(pending.status).toBe('receipt_pending'); expect(pending.settlement!.billableSeconds).toBeGreaterThan(0);
    const closed = BigInt((Math.floor(pending.settlement!.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) { await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); }
    await service.drain();
    const done = await vaultService.get(owner, payer, prepared.quote.runId);
    expect(done.status).toBe('completed'); expect(BigInt(done.charged!)).toBeGreaterThan(0n);
    expect(await agentSdk.command(prepared.quote.runId, command)).toEqual(result);
    await local.confirmed(vault.guardianWallet.writeContract({ address: vault.registryAddress,
      abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'setFrozen',
      args: [vault.agentId, true, 'terminal replay test', randomId()] }));
    expect(await agentSdk.command(prepared.quote.runId, command)).toEqual(result);
    await expect(vaultService.command(owner, payer, prepared.quote.runId, command)).rejects.toMatchObject({ status: 404 });
    const agentRecord = await local.local.publicClient.readContract({ address: vault.registryAddress,
      abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'getAgent', args: [vault.agentId] }) as { lifetimeBurn: bigint };
    expect(agentRecord.lifetimeBurn).toBe(BigInt(done.charged!));
    expect((await service.sessionEvents(payer, prepared.quote.runId)).events.length).toBeGreaterThan(0);
  }, 60_000);
  it('replays current small Cyst state into a real Vault-funded Host Kit Cell after losing command response', async () => {
    const owner = local.accounts.owner.address, agent = vault.account.address, agentId = vault.agentId as Hex;
    const largeDir = join(root, 'agent-cyst'), privateDir = join(root, 'agent-private');
    await Promise.all([mkdir(largeDir, { mode: 0o700 }), mkdir(privateDir, { mode: 0o700 })]);
    const large = new LargeCystPrivateStore(largeDir, { globalMaxBytes: 8 * 1024 * 1024,
      ownerMaxBytes: 8 * 1024 * 1024 });
    await large.initialize();
    const cystArtifact = local.artifact('CystRegistry');
    const deployment = await local.confirmed(local.owner.deployContract({ abi: cystArtifact.abi,
      bytecode: cystArtifact.bytecode, args: [vault.registryAddress] }));
    if (!deployment.contractAddress) throw new Error('CystRegistry fixture deployment failed');
    const code = await local.local.publicClient.getCode({ address: deployment.contractAddress });
    if (!code) throw new Error('CystRegistry fixture runtime missing');
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: deployment.contractAddress,
      registryCodeHash: keccak256(code), selectionRegistryAddress: vault.registryAddress,
      selectionRegistryCodeHash: vault.pins.registryCodeHash, confirmations: 0 });
    const reader = new RpcCystRegistryReader({ rpcUrl: local.local.rpcUrl, pins });
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32), journalKey = randomBytes(32);
    const state = Buffer.from(JSON.stringify({ counter: 71, marker: 'real-vault-paid-cell' }));
    const sourcePath = join(root, 'agent-current-state.bin');
    await writeFile(sourcePath, state, { mode: 0o600 });
    const scope = { owner, agent, applicationSchema: 'agent-counter.v1' };
    const ownerIdentity = await generateCystWrappingIdentity(), agentIdentity = await generateCystWrappingIdentity();
    const privateVault = new CystCheckpointFileVault({ directory: privateDir, masterKey: journalKey });
    try {
      const wrapped = await wrapCystRecoveryKey(recoveryKey, { owner, agent, checkpointId },
        { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
      const manifest = await saveLargeCystFile({ store: large, sourcePath, id: checkpointId, scope,
        recoveryKey, wrappedKey: { bundle: wrapped, ownerIdentity,
          agentPublicKey: agentIdentity.publicKey } });
      const descriptor = largeCystRegistryDescriptor(manifest);
      await local.confirmed(vault.wallet.writeContract({ address: deployment.contractAddress,
        abi: cystArtifact.abi, functionName: 'commitChecked',
        args: [agentId, descriptor.cystHash, BigInt(descriptor.sizeBytes), descriptor.storageRef, 0n] }));
      const agentStore = { resolveCurrent: async () => {
        await reader.check();
        const snapshot = await reader.snapshot(agentId);
        if (!largeCystRegistryMatches(snapshot.current, descriptor)) throw new Error('current Cyst changed');
        return { checkpointId, checkpoint: descriptor, manifest, binding: snapshot.binding,
          current: snapshot.current, pins };
      }, manifest: (id: string) => large.manifest(id), header: (id: string) => large.header(id),
      part: (id: string, index: number) => large.part(id, index) } as unknown as LargeCystAgentManifestStore;

      const agentSdk = vaultClient('agent');
      const prepared = await agentSdk.quote({ leashId: vault.agent.leashId,
        task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 4, resourceProfile: 'lean' },
        cpuScheduling: { version: 1, lane: 'standard' },
        maxSeconds: 60, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'agent-cyst-paid-cell');
      const receipt = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await vaultService.admit(agent, vault.agent.vault,
        { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-agent-cyst-cell');
      const running = service.drain(); await waitForAdmission(prepared.quote.runId);
      const program = `
const fs=require('node:fs'),crypto=require('node:crypto');
const [agentId,targetRunId,checkpointId,revision,restoreOperationId,stateSha256]=process.argv.slice(1);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x});
process.stdin.on('end',()=>{try{
const value=JSON.parse(input),receipt={protocol:'telomere-agent-current-cyst-restore-v1',agentId,
targetRunId,checkpointId,revision,restoreOperationId,stateSha256};
if(Object.keys(value).length!==Object.keys(receipt).length+1||Object.entries(receipt).some(([k,v])=>value[k]!==v))throw Error('binding');
const bytes=Buffer.from(value.stateBase64,'base64');
if(bytes.toString('base64')!==value.stateBase64||bytes.length<1||bytes.length>4096
||crypto.createHash('sha256').update(bytes).digest('hex')!==stateSha256)throw Error('state');
fs.writeFileSync('agent-applied.bin',bytes,{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify(receipt));
}catch{process.stderr.write('restore rejected');process.exitCode=1}});
`;
      let loseResponse = true;
      const lossy = new PlatformVaultRuntimeClient({ baseUrl: origin, pins: local.pins,
        vaultPins: vault.pins, vault: vault.agent.vault, sessionToken: tokens.agent,
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (loseResponse && init?.method === 'POST' && String(url).endsWith('/commands')) {
            loseResponse = false; await response.arrayBuffer(); throw new Error('lost real Vault paid command response');
          }
          return response;
        } });
      const restore = (paidClient: PlatformVaultRuntimeClient) => new AgentCurrentCystPaidRestore({
        owner, agent, agentId, applicationSchema: scope.applicationSchema,
        imageDigest: host.imageDigest, maxCommands: 4,
        restoreArgvPrefix: [process.execPath, '-e', program],
        reader, store: agentStore, identity: agentIdentity, client: paidClient,
        journal: privateVault, temporaryDirectory: privateDir,
      }).restore({ targetRunId: prepared.quote.runId, restoreOperationId: 'agent-real-paid-restore' });
      await expect(restore(lossy)).rejects.toThrow('lost real Vault paid command response');
      const originalSession = (await journal.db.select().from(hostSessions))
        .find(row => row.sessionId === prepared.quote.runId)?.record;
      expect(originalSession?.commands).toHaveLength(1);
      expect(Buffer.from(JSON.parse(originalSession?.commands[0]?.command.stdin ?? '{}').stateBase64, 'base64'))
        .toEqual(state);
      const restored = await restore(agentSdk);
      expect(restored).toMatchObject({ targetRunId: prepared.quote.runId, checkpointId,
        restoreOperationId: 'agent-real-paid-restore' });
      const read = await agentSdk.command(prepared.quote.runId, { commandId: 'read-agent-applied',
        argv: [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync('agent-applied.bin'))"] });
      expect(Buffer.from(read.stdout)).toEqual(state);
      expect((await journal.db.select().from(hostSessions))
        .find(row => row.sessionId === prepared.quote.runId)?.record?.commands).toHaveLength(2);
      await local.confirmed(local.owner.sendTransaction({ ...(await vaultService.stopPlan(owner,
        vault.agent.vault, prepared.quote.runId)), value: 0n }));
      await running;
      expect((await vaultService.get(agent, vault.agent.vault, prepared.quote.runId)).status).toBe('receipt_pending');
    } finally { privateVault.close(); recoveryKey.fill(0); journalKey.fill(0); }
  }, 120_000);
  it('recovers the original paid Cell after controller interruption without redispatching commands', async () => {
    const owner = local.accounts.owner.address, prepared = await ownerClient().quote({ leashId,
      task: { kind: 'session', imageDigest: host.imageDigest, maxCommands: 2 },
      maxSeconds: 20, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'paid-recovery');
    await open(prepared);
    const original = executor.run.bind(executor);
    vi.spyOn(executor, 'run').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('Controller stopped after host cleanup, before outcome write');
    });
    const running = service.drain(); await waitForAdmission(prepared.quote.runId);
    expect(await ownerClient().command(prepared.quote.runId, { commandId: 'once', argv: [process.execPath, '-e',
      "process.stdout.write('one-dispatch')"] })).toMatchObject({ state: 'completed', stdout: 'one-dispatch' });
    await local.confirmed(local.owner.sendTransaction({ ...(await service.stopPlan(owner, prepared.quote.runId)), value: 0n }));
    await expect(running).rejects.toThrow('original-lease recovery');
    expect((await service.get(owner, prepared.quote.runId)).settlement).toBeNull();
    const before = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId));
    expect(before).toHaveLength(1); expect(before[0]?.cleanupConfirmed).toBe(1);
    executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    await service.initialize();
    const recovered = await service.get(owner, prepared.quote.runId);
    expect(recovered.status).toBe('receipt_pending');
    expect(recovered.result?.output).toBe(hashJson({ protocol: 'telomere-paid-session-events-v1', events: before[0]?.sessionEvents }));
    expect((await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId))).length).toBe(1);
    const closed = BigInt((Math.floor(recovered.settlement!.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < closed) { await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 }); }
    await service.drain();
    expect((await service.get(owner, prepared.quote.runId)).status).toBe('completed');
  }, 45_000);
});
