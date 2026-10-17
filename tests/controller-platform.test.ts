import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, http, type Hex } from 'viem';
import { deployLocalContracts, startLocalChain, unusedLocalPort } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/index.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge, type WalletTransaction } from '../src/bridge.js';
import { Service } from '../src/service.js';
import { jobs, openStore } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { createControllerPlatform } from '../src/platform.js';
import { CystService } from '../src/cysts/service.js';
import { agentBilling } from '../src/agents/schema.js';
import { Worker } from '../src/worker.js';
import { createDemoCpuExecutor } from '../src/runtime/index.js';
import { TelomereClient, type QuotedRun, type RunView, type WalletActionPlan } from '../src/sdk/index.js';
import { startPilot } from '../src/main.js';
import { controllerHostRuns } from '../src/host-kit/controller-schema.js';
import { Ed25519Identity, hostMessageHash } from '../src/host-kit/protocol.js';
import { receiptHourBatches } from '../src/receipts/schema.js';

describe('controller platform authoritative runtime integration', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge, service: Service, platform: ReturnType<typeof createControllerPlatform>;
  let wallet: ReturnType<typeof createWalletClient>, snapshot: Hex, leashId: Hex, root: string, session: string;
  let app: ReturnType<typeof createApp>, sdk: TelomereClient;
  const origin = 'http://127.0.0.1:3291', logger = pino({ enabled: false });
  beforeAll(async () => {
    local = await startLocalChain(); deployed = await deployLocalContracts(local);
    wallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain, transport: http(local.rpcUrl, { retryCount: 0 }) });
    snapshot = await deployed.testClient.snapshot();
  });
  async function confirmed(hash: Promise<Hex>) {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash }); expect(receipt.status).toBe('success'); return receipt;
  }
  const send = (tx: WalletTransaction) => confirmed(wallet.sendTransaction({ account: deployed.accounts.owner, chain: localChain, to: tx.to, data: tx.data, value: 0n }));
  beforeEach(async () => {
    await deployed.testClient.revert({ id: snapshot }); snapshot = await deployed.testClient.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-platform-'));
    const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: origin,
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress });
    store = await openStore(config); bridge = new ChainBridge(config); service = new Service(store.db, bridge, config, false);
    const cysts = new CystService(store.db, join(root, 'ciphertexts')); await cysts.initialize();
    platform = createControllerPlatform(service, cysts); const auth = new Auth(store.db, config); session = await auth.session(deployed.accounts.owner.address);
    app = createApp(service, auth, logger, './dist/public', undefined, cysts, platform);
    sdk = new TelomereClient({ baseUrl: origin, sessionToken: session,
      pins: { chainId: 31337, escrowAddress: deployed.escrowAddress, tokenAddress: deployed.tokenAddress, receiptSigner: bridge.account.address },
      fetch: async (url, init) => app.request(new URL(url).pathname + new URL(url).search, init) });
    const token = deployed.artifacts.MockToken; if (!token) throw new Error('Missing disposable token artifact');
    await confirmed(wallet.writeContract({ account: deployed.accounts.owner, chain: localChain, address: deployed.tokenAddress,
      abi: token.abi, functionName: 'faucet', args: [deployed.accounts.owner.address, 10000000n] }));
    for (const tx of bridge.depositTransactions(1000000n)) await send(tx);
    const leash = await service.createLeash(deployed.accounts.owner.address, deployed.accounts.owner.address, 1000000n, 1000000n, BigInt(Math.floor(Date.now() / 1000) + 86400));
    leashId = leash.leashId; await send(leash.transaction);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('telomere-platform-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => { await local.close(); });
  async function reserved() {
    const quote = await service.quote(deployed.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'bound-agent' }, maxSeconds: 120 }, 'platform_reservation_001');
    const receipt = await send(quote.transaction); await service.admit(deployed.accounts.owner.address, quote.quote.runId, receipt.transactionHash); return quote;
  }
  it('mounts authenticated lifecycle routes and rejects an unfunded prepared quote as a lease', async () => {
    expect((await app.request('/api/agents')).status).toBe(401);
    const prepared = await service.quote(deployed.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'not-funded' }, maxSeconds: 120 }, 'platform_unfunded_001');
    await expect(sdk.agents.register(deployed.accounts.owner.address, deployed.accounts.owner.address, prepared.quote.runId)).rejects.toMatchObject({ code: 'agent_reservation_invalid' });
    const quote = await reserved(); const registered = await sdk.agents.register(deployed.accounts.owner.address, deployed.accounts.owner.address, quote.quote.runId);
    expect(registered.agent.currentRunId).toBe(quote.quote.runId); expect(registered.agent.mode).toBe('full');
    expect((await sdk.agents.list(deployed.accounts.owner.address)).agents).toHaveLength(1);
    const stopped = await send(bridge.stopTransaction(quote.quote.runId)); expect(stopped.status).toBe('success');
    await expect(platform.agents?.register(deployed.accounts.owner.address, { agent: deployed.accounts.owner.address, runId: quote.quote.runId })).rejects.toMatchObject({ code: 'agent_reservation_invalid' });
  });
  it('ingests only canonical confirmed settlements once, retaining the quoted agent after later budget changes', async () => {
    const quote = await reserved(); await sdk.agents.register(deployed.accounts.owner.address, deployed.accounts.owner.address, quote.quote.runId);
    await new Worker(store.db, bridge, createDemoCpuExecutor(), undefined, logger).drainOnce();
    await send(bridge.updateLeashTransaction(leashId, deployed.accounts.outsider.address, 1000000n, 1000000n, BigInt(Math.floor(Date.now() / 1000) + 86400)));
    await platform.maintain(); await platform.maintain();
    const rows = await store.db.select().from(agentBilling); expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe(deployed.accounts.owner.address.toLowerCase()); expect(rows[0]?.receiptId).toBe(quote.quote.runId);
    const evaluation = await sdk.agents.evaluate(deployed.accounts.owner.address, deployed.accounts.owner.address);
    expect(evaluation.trailing24hBurn).toBe(rows[0]?.amount); expect(evaluation.balance).toBe((await bridge.balance(deployed.accounts.owner.address)).available);
    await expect(sdk.agents.list(deployed.accounts.outsider.address)).rejects.toThrow('owner scope');
  });
  it('refuses attribution when the Leash agent changes between quote and admission', async () => {
    const quote = await service.quote(deployed.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'race' }, maxSeconds: 120 }, 'platform_binding_001');
    const receipt = await send(quote.transaction);
    await send(bridge.updateLeashTransaction(leashId, deployed.accounts.outsider.address, 1000000n, 1000000n, BigInt(Math.floor(Date.now() / 1000) + 86400)));
    await expect(service.admit(deployed.accounts.owner.address, quote.quote.runId, receipt.transactionHash)).rejects.toMatchObject({ code: 'agent_binding_changed' });
    expect((await service.requireJob(deployed.accounts.owner.address, quote.quote.runId)).status).toBe('prepared');
    expect((await bridge.run(quote.quote.runId)).status).toBe(1); // Accepted money remains available to its contract timeout-refund path.
  });
  it('keeps independent closed-hour maintenance available when one agent billing record requires reconciliation', async () => {
    const quote = await reserved(); await sdk.agents.register(deployed.accounts.owner.address, deployed.accounts.owner.address, quote.quote.runId);
    await new Worker(store.db, bridge, createDemoCpuExecutor(), undefined, logger).drainOnce();
    const original = await service.requireJob(deployed.accounts.owner.address, quote.quote.runId);
    await store.db.update(jobs).set({ charged: (BigInt(original.charged!) + 1n).toString() }).where(eq(jobs.id, quote.quote.runId));
    expect(await store.db.select().from(receiptHourBatches)).toHaveLength(0);
    await expect(platform.maintain()).rejects.toThrow('Agent billing receipt differs');
    expect(await store.db.select().from(agentBilling)).toHaveLength(0);
    // The original completed run is in the current open hour. Its faulty billing cannot block sealing the preceding empty hour.
    expect((await store.db.select().from(receiptHourBatches))[0]?.leafCount).toBe(0);
    await store.db.update(jobs).set({ charged: original.charged }).where(eq(jobs.id, quote.quote.runId));
    await platform.maintain(); expect(await store.db.select().from(agentBilling)).toHaveLength(1);
  });
  it('prepares a real signed deadline through the SDK without sending a wallet transaction', async () => {
    const quote = await sdk.quoteDeadline({ leashId, task: { kind: 'sha256', text: 'sdk deadline' }, maxSeconds: 5,
      maxSpend: '500', deadline: Math.floor(Date.now() / 1000) + 60 }, { idempotencyKey: 'platform_sdk_deadline_001' });
    expect(quote.deadlineJob.runId).toBe(quote.quote.runId); expect(quote.ceiling).toBe('500');
    expect((await bridge.run(quote.quote.runId)).status).toBe(0);
    expect((await sdk.deadlineJobs()).jobs).toHaveLength(1); expect((await sdk.prices()).samplesAreMarketWide).toBe(false);
    expect(await store.db.select().from(agentBilling).where(eq(agentBilling.receiptId, quote.quote.runId))).toHaveLength(0);
  });
  it('quotes, admits, reads and prepares stop through authenticated HTTP MCP and the actual paid controller', async () => {
    const port = await unusedLocalPort(), address = 'http://127.0.0.1:' + port;
    const pilot = await startPilot(loadConfig({ MODE: 'demo', DATA_DIR: join(root, 'http-mcp'), PORT: String(port),
      HOST: '127.0.0.1', RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: address, LOG_LEVEL: 'error',
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress }));
    try {
      expect((await fetch(address + '/api/suppliers/akash/runs/' + '0x' + '0'.repeat(64) + '/readiness')).status).toBe(404);
      expect((await fetch(address + '/mcp', { method: 'POST', headers: { Origin: address } })).status).toBe(401);
      const signedIn = await fetch(address + '/api/auth/demo', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: '{}' });
      const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]; if (!cookie) throw new Error('Demo fixture authentication did not set a cookie');
      const headers: Record<string, string> = { Origin: address, Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      const post = (body: unknown) => fetch(address + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
      const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25',
        capabilities: {}, clientInfo: { name: 'actual-pilot', version: '1.0.0' } } });
      expect(initialized.status).toBe(200);
      const id = initialized.headers.get('mcp-session-id'); if (!id) throw new Error('Actual MCP session did not initialize');
      headers['Mcp-Session-Id'] = id; headers['Mcp-Protocol-Version'] = '2025-11-25';
      expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      const tools = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
      expect(tools.result.tools).toHaveLength(16);
      const result = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'telomere_balance', arguments: {} } })).json();
      expect(result.result.structuredContent.data).toEqual({ available: '1000000', reserved: '0' });
      const tool = (id: number, name: string, args: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const quoteInput = { leashId, task: { kind: 'sha256', text: 'MCP paid CPU Cell' }, maxSeconds: 5,
        idempotencyKey: 'actual_mcp_cell_quote_001' };
      const quotedResponse = await (await post(tool(4, 'telomere_quote', quoteInput))).json() as {
        result: { structuredContent: { data: QuotedRun }; isError?: boolean } };
      expect(quotedResponse.result.isError).not.toBe(true);
      const quoted = quotedResponse.result.structuredContent.data;
      expect(quoted).toMatchObject({ idempotencyKey: quoteInput.idempotencyKey, ceiling: '500',
        walletAction: { purpose: 'open', requiresWallet: true, runId: quoted.quote.runId } });
      expect((await bridge.run(quoted.quote.runId)).status).toBe(0);
      const repeated = await (await post(tool(5, 'telomere_quote', quoteInput))).json();
      expect(repeated.result.structuredContent.data).toEqual(quoted);
      const replayHeaders = { ...headers }; delete replayHeaders['Mcp-Session-Id']; delete replayHeaders['Mcp-Protocol-Version'];
      const replayPost = (body: unknown) => fetch(address + '/mcp', { method: 'POST', headers: replayHeaders, body: JSON.stringify(body) });
      const replayInitialize = await replayPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-replay', version: '1.0.0' } } });
      expect(replayInitialize.status).toBe(200);
      const replaySession = replayInitialize.headers.get('mcp-session-id'); if (!replaySession) throw new Error('Replay MCP session missing');
      replayHeaders['Mcp-Session-Id'] = replaySession; replayHeaders['Mcp-Protocol-Version'] = '2025-11-25';
      expect((await replayPost({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      const acrossSession = await (await replayPost(tool(2, 'telomere_quote', quoteInput))).json();
      expect(acrossSession.result.structuredContent.data).toMatchObject({ quote: quoted.quote, signature: quoted.signature,
        ceiling: quoted.ceiling, idempotencyKey: quoted.idempotencyKey, walletAction: { purpose: 'open', intents: quoted.walletAction.intents } });
      expect((await fetch(address + '/mcp', { method: 'DELETE', headers: replayHeaders })).status).toBe(200);
      const changed = await (await post(tool(6, 'telomere_quote', { ...quoteInput, task: { kind: 'sha256', text: 'changed' } }))).json();
      expect(changed.result).toMatchObject({ isError: true, structuredContent: { data: { error: 'operation_failed' } } });
      const plan = quoted.walletAction.intents[0]; if (!plan) throw new Error('MCP quote omitted owner payment intent');
      expect(plan.chainId).toBe(31337); expect(plan.transaction).toEqual(bridge.openTransaction({
        ...quoted.quote, maxSeconds: BigInt(quoted.quote.maxSeconds), pricePerSecond: BigInt(quoted.quote.pricePerSecond),
        inferencePrice: BigInt(quoted.quote.inferencePrice), quoteExpiry: BigInt(quoted.quote.quoteExpiry),
      }, quoted.signature));
      const receipt = await send(plan.transaction);
      const admitted = await (await post(tool(7, 'telomere_admit_confirmed_run', {
        runId: quoted.quote.runId, txHash: receipt.transactionHash }))).json() as {
        result: { structuredContent: { data: RunView }; isError?: boolean } };
      expect(admitted.result.isError).not.toBe(true);
      expect(admitted.result.structuredContent.data).toMatchObject({ id: quoted.quote.runId, owner: deployed.accounts.owner.address.toLowerCase() });
      const status = await (await post(tool(8, 'telomere_run_status', { runId: quoted.quote.runId }))).json() as {
        result: { structuredContent: { data: RunView } } };
      expect(status.result.structuredContent.data.id).toBe(quoted.quote.runId);
      const stop = await (await post(tool(9, 'telomere_stop_plan', { runId: quoted.quote.runId }))).json() as {
        result: { structuredContent: { data: WalletActionPlan }; isError?: boolean } };
      expect(stop.result.isError).not.toBe(true);
      expect(stop.result.structuredContent.data).toMatchObject({ purpose: 'stop', requiresWallet: true, runId: quoted.quote.runId });
      expect(stop.result.structuredContent.data.intents[0]?.transaction).toEqual(bridge.stopTransaction(quoted.quote.runId));
      expect((await fetch(address + '/mcp', { method: 'DELETE', headers })).status).toBe(200);
      expect((await post({ jsonrpc: '2.0', id: 10, method: 'ping' })).status).toBe(404);
      expect(await local.publicClient.getTransactionCount({ address: deployed.accounts.signer.address })).toBe(0);
    } finally { await pilot.close(); }
  });
  it('exposes only an owner-scoped Akash runtime incompatibility proof from the actual controller', async () => {
    const port = await unusedLocalPort(), address = 'http://127.0.0.1:' + port;
    const profileFile = join(root, 'akash-readiness.json');
    const profile = { version: 1, mode: 'readiness_only', chainId: 31337,
      escrowAddress: deployed.escrowAddress, leaseCreationEnabled: false };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    const config = loadConfig({ MODE: 'demo', DATA_DIR: join(root, 'akash-readiness'), PORT: String(port),
      HOST: '127.0.0.1', RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: address, LOG_LEVEL: 'error',
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress,
      AKASH_READINESS_CONFIG: profileFile });
    const pilot = await startPilot(config);
    try {
      const quote = await pilot.service.quote(deployed.accounts.owner.address,
        { leashId, task: { kind: 'sha256', text: 'Akash eligibility proof' }, maxSeconds: 120 }, 'akash_readiness_001');
      const path = '/api/suppliers/akash/runs/' + quote.quote.runId + '/readiness';
      expect((await fetch(address + path)).status).toBe(401);
      const signedIn = await fetch(address + '/api/auth/demo', { method: 'POST',
        headers: { Origin: address, 'Content-Type': 'application/json' }, body: '{}' });
      const ownerCookie = signedIn.headers.get('set-cookie')?.split(';')[0];
      if (!ownerCookie) throw new Error('Demo fixture authentication did not set a cookie');
      const read = () => fetch(address + path, { headers: { Cookie: ownerCookie } });
      const prepared = await read(); expect(prepared.status).toBe(200);
      expect(await prepared.json()).toMatchObject({ network: 'akash', runId: quote.quote.runId,
        controllerRunState: 'prepared', escrowOpen: false, maxRunSeconds: 120,
        minConsoleRuntimeSeconds: 3600, leaseCreationEnabled: false, eligible: false,
        blockers: ['run_not_admitted', 'escrow_not_open', 'runtime_too_short', 'treasury_snapshot_unavailable', 'lease_creation_disabled'],
        meterEligible: false, billableSeconds: 0 });
      const outsider = await new Auth(pilot.service.db, config).session(deployed.accounts.outsider.address);
      expect((await fetch(address + path, { headers: { Cookie: 'telomere_session=' + outsider } })).status).toBe(404);
      await send(quote.transaction);
      const funded = await read(); expect(funded.status).toBe(200);
      expect(await funded.json()).toMatchObject({ escrowOpen: true, maxRunSeconds: 120,
        blockers: ['run_not_admitted', 'runtime_too_short', 'treasury_snapshot_unavailable', 'lease_creation_disabled'] });
      expect((await fetch(address + '/api/suppliers/akash/leases', { method: 'POST',
        headers: { Origin: address, Cookie: ownerCookie, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally { await pilot.close(); }
    await writeFile(profileFile, JSON.stringify({ ...profile, leaseCreationEnabled: true }), { mode: 0o600 });
    await expect(startPilot(config)).rejects.toThrow('Akash readiness configuration is unavailable');
  });
  it('refuses to release a previous Host Kit reservation when the executor mode changes', async () => {
    const quote = await reserved(), port = await unusedLocalPort();
    const config = loadConfig({ MODE: 'demo', CPU_MODE: 'demo', DATA_DIR: join(root, 'pending-host'), PORT: String(port),
      HOST: '127.0.0.1', RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, LOG_LEVEL: 'error',
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress });
    const seeded = await openStore(config), control = new Ed25519Identity(), host = new Ed25519Identity(), now = Date.now();
    try {
      const original = await service.requireJob(deployed.accounts.owner.address, quote.quote.runId);
      await seeded.db.insert(jobs).values({ ...original, status: 'running' });
      const lease = control.sign('lease', { version: 1 as const, hostKey: host.publicKey, runId: quote.quote.runId,
        owner: original.owner, image: 'registry.example/task@sha256:' + 'a'.repeat(64), argv: ['/usr/local/bin/node'],
        issuedAt: now, expiresAt: now + 120000, maxSeconds: 120, nonce: quote.quote.runId });
      await seeded.db.insert(controllerHostRuns).values({ runId: original.id, owner: original.owner,
        hostKey: host.publicKey, leaseHash: hostMessageHash(lease), lease, cleanupConfirmed: false });
    } finally { await seeded.close(); }
    await expect(startPilot(config)).rejects.toThrow('Unconfirmed Host Kit leases require their original configured host');
    const reopened = await openStore(config);
    try {
      expect((await reopened.db.select().from(jobs))[0]?.status).toBe('running');
      expect((await reopened.db.select().from(controllerHostRuns))[0]?.cleanupConfirmed).toBe(false);
      expect((await bridge.run(quote.quote.runId)).status).toBe(1);
    } finally { await reopened.close(); }
  });
});
