import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ne } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, decodeFunctionData, encodeFunctionData, getAddress, http, type Hex } from 'viem';
import { deployLocalContracts, startLocalChain, unusedLocalPort } from '../scripts/local-chain.js';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { escrowAbi, localChain, quoteTypedData, settlementTypedData, tokenAbi, type Quote } from '../src/chain/index.js';
import { randomId, type QuoteInput } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import type { Operations } from '../src/operations.js';
import { TelomereClient, type FetchTransport, type OwnerWallet, type WalletActionPlan, type WalletTransaction } from '../src/sdk/index.js';
import { Service } from '../src/service.js';
import { leashRefs, openStore } from '../src/store.js';

describe('owner budget changes through API, SDK and MCP on a disposable local chain', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: ChainBridge;
  let service: Service;
  let auth: Auth;
  let app: ReturnType<typeof createApp>;
  let httpServer: Server;
  let ownerWallet: ReturnType<typeof createWalletClient>;
  let agentWallet: ReturnType<typeof createWalletClient>;
  let session: string;
  let agentSession: string;
  let origin: string;
  let snapshot: Hex;
  let leashId: Hex;
  let expiry: number;
  let controllerState: Operations['worker']['state'] = 'idle';
  const initialDeposit = 10_000_000n;
  const logger = pino({ level: 'silent' });

  function api(path: string, body?: unknown, token = session, requestOrigin = origin) {
    return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: `telomere_session=${token}`, Origin: requestOrigin, 'Content-Type': 'application/json',
      'Idempotency-Key': 'budget-update-acceptance',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  function client(fetcher?: FetchTransport, token = session) {
    return new TelomereClient({ baseUrl: origin, sessionToken: token, pins: {
      chainId: 31337, escrowAddress: deployed.escrowAddress, tokenAddress: deployed.tokenAddress,
      receiptSigner: deployed.accounts.signer.address,
    }, ...(fetcher ? { fetch: fetcher } : {}) });
  }
  async function confirmed(transaction: Promise<Hex>) {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await transaction });
    expect(receipt.status).toBe('success');
    return receipt;
  }
  async function send(transaction: WalletTransaction) {
    return confirmed(ownerWallet.sendTransaction({ account: deployed.accounts.owner, chain: localChain,
      to: transaction.to, data: transaction.data, value: 0n }));
  }
  function walletAdapter(): OwnerWallet {
    return { address: deployed.accounts.owner.address,
      getChainId: async () => local.publicClient.getChainId(),
      signMessage: input => deployed.accounts.owner.signMessage(input),
      sendTransaction: input => ownerWallet.sendTransaction({ account: deployed.accounts.owner, chain: localChain,
        to: input.to, data: input.data, value: input.value }),
      waitForTransaction: async input => {
        const receipt = await local.publicClient.waitForTransactionReceipt({ hash: input.hash });
        return { status: receipt.status };
      },
    };
  }
  async function advance(seconds: number) {
    await deployed.testClient.increaseTime({ seconds });
    await deployed.testClient.mine({ blocks: 1 });
  }
  async function leash(id = leashId) {
    return local.publicClient.readContract({ address: deployed.escrowAddress, abi: escrowAbi,
      functionName: 'getLeash', args: [id] });
  }
  async function available() {
    return local.publicClient.readContract({ address: deployed.escrowAddress, abi: escrowAbi,
      functionName: 'availableBalance', args: [deployed.accounts.owner.address] });
  }
  async function tokenBalance(address: typeof deployed.escrowAddress) {
    return local.publicClient.readContract({ address: deployed.tokenAddress, abi: tokenAbi,
      functionName: 'balanceOf', args: [address] });
  }
  async function openRun(overrides: Partial<Quote> = {}) {
    const now = (await local.publicClient.getBlock()).timestamp;
    const quote: Quote = { runId: randomId(), leashId, payer: deployed.accounts.owner.address,
      workloadHash: randomId(), maxSeconds: 10n, pricePerSecond: 10n, inferencePrice: 50n,
      quoteExpiry: now + 300n, ...overrides };
    const signature = await deployed.accounts.signer.signTypedData(quoteTypedData(31337, deployed.escrowAddress, quote));
    await confirmed(agentWallet.writeContract({ account: deployed.accounts.outsider, chain: localChain,
      address: deployed.escrowAddress, abi: escrowAbi, functionName: 'openRun', args: [quote, signature] }));
    return quote;
  }
  async function settle(quote: Quote, seconds: bigint, inferenceCharge = 0n) {
    const settlement = { runId: quote.runId, billableSeconds: seconds, inferenceCharge, receiptHash: randomId() };
    const signature = await deployed.accounts.signer.signTypedData(settlementTypedData(31337, deployed.escrowAddress, settlement));
    await confirmed(agentWallet.writeContract({ account: deployed.accounts.outsider, chain: localChain,
      address: deployed.escrowAddress, abi: escrowAbi, functionName: 'settleRun', args: [settlement, signature] }));
  }
  function onlyTransaction(plan: WalletActionPlan): WalletTransaction {
    expect(plan.intents).toHaveLength(1);
    const intent = plan.intents[0];
    if (!intent) throw new Error('Missing budget wallet intent');
    expect(intent.chainId).toBe(31337);
    return intent.transaction;
  }
  async function simulateUpdate(transaction: WalletTransaction) {
    const decoded = decodeFunctionData({ abi: escrowAbi, data: transaction.data });
    if (decoded.functionName !== 'updateLeash') throw new Error('Expected a budget update');
    return local.publicClient.simulateContract({ account: deployed.accounts.owner.address,
      address: transaction.to, abi: escrowAbi, functionName: decoded.functionName, args: decoded.args });
  }
  const terms = (hour: bigint | string = '700', day: bigint | string = '1200') => ({
    maxPerHour: hour.toString(), maxPerDay: day.toString(), expiry,
  });

  beforeAll(async () => {
    local = await startLocalChain();
    deployed = await deployLocalContracts(local);
    const port = await unusedLocalPort();
    origin = `http://127.0.0.1:${port}`;
    const config = loadConfig({ MODE: 'demo', RPC_URL: local.rpcUrl, CHAIN_ID: '31337',
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress,
      DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin });
    store = await openStore(config);
    bridge = new ChainBridge(config); await bridge.check();
    service = new Service(store.db, bridge, config, false);
    auth = new Auth(store.db, config);
    app = createApp(service, auth, logger, './dist/public', async () => ({ worker: { state: controllerState },
      counts: {}, near: { configured: false, verification: 'disabled' }, cpu: { mode: 'demo' } }));
    ownerWallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain, transport: http(local.rpcUrl) });
    agentWallet = createWalletClient({ account: deployed.accounts.outsider, chain: localChain, transport: http(local.rpcUrl) });
    session = await auth.session(deployed.accounts.owner.address);
    agentSession = await auth.session(deployed.accounts.outsider.address);
    expect((await api('/api/demo/fund', {})).status).toBe(200);
    // Keep bucket-boundary tests deterministic while retaining a valid real-time API expiry.
    const now = (await local.publicClient.getBlock()).timestamp;
    const aligned = (now / 86_400n + 1n) * 86_400n + 7_200n;
    await deployed.testClient.setNextBlockTimestamp({ timestamp: aligned });
    await deployed.testClient.mine({ blocks: 1 });
    expiry = Math.floor(Date.now() / 1000) + 7 * 86_400;
    const created = await service.createLeash(deployed.accounts.owner.address, deployed.accounts.outsider.address,
      600n, 1_000n, BigInt(expiry));
    leashId = created.leashId;
    await send(created.transaction);
    snapshot = await deployed.testClient.snapshot();
    httpServer = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolvePromise, reject) => httpServer.listen(port, '127.0.0.1', resolvePromise).once('error', reject));
  }, 60_000);
  beforeEach(async () => {
    await deployed.testClient.revert({ id: snapshot });
    snapshot = await deployed.testClient.snapshot();
    await store.db.delete(leashRefs).where(ne(leashRefs.id, leashId));
    controllerState = 'idle';
  });
  afterAll(async () => {
    httpServer?.closeAllConnections();
    if (httpServer) await new Promise<void>(resolvePromise => httpServer.close(() => resolvePromise()));
    await store?.close(); await local?.close();
  });

  it('prepares exact five-argument calldata and changes limits only after owner confirmation', async () => {
    const sdk = client(); const before = await leash();
    const pending = await sdk.prepareUpdateLeash(leashId, terms());
    expect(pending).toMatchObject({ purpose: 'leash_update', requiresWallet: true, leashId });
    const transaction = onlyTransaction(pending);
    expect(transaction.to.toLowerCase()).toBe(deployed.escrowAddress.toLowerCase());
    expect(transaction.value).toBe('0x0');
    expect(decodeFunctionData({ abi: escrowAbi, data: transaction.data })).toEqual({
      functionName: 'updateLeash', args: [leashId, deployed.accounts.outsider.address, 700n, 1_200n, BigInt(expiry)],
    });
    expect(await leash()).toEqual(before);
    const confirm = vi.fn(async () => true);
    const result = await sdk.executePlan(pending, walletAdapter(), confirm);
    expect(confirm).toHaveBeenCalledTimes(1); expect(result.confirmed).toHaveLength(1);
    expect(await leash()).toMatchObject({ owner: before.owner, agent: before.agent,
      maxPerHour: 700n, maxPerDay: 1_200n, expiry: BigInt(expiry), pending: 0n, spentHour: 0n, spentDay: 0n });
    expect(await available()).toBe(initialDeposit);
    expect(await tokenBalance(deployed.escrowAddress)).toBe(initialDeposit);
    expect(await tokenBalance(deployed.accounts.treasury.address)).toBe(0n);
  });

  it('preserves settled spending, pending ceilings and funds when limits are lowered exactly to committed usage', async () => {
    const completed = await openRun(); await advance(5); await settle(completed, 4n, 50n);
    const pendingRun = await openRun();
    const before = await leash();
    expect(before).toMatchObject({ spentHour: 90n, spentDay: 90n, pending: 150n });
    expect((await api(`/api/leashes/${leashId}/update`, terms('239', '1000'))).status).toBe(409);
    expect((await api(`/api/leashes/${leashId}/update`, terms('240', '240'))).status).toBe(200);
    const sdk = client(); const plan = await sdk.prepareUpdateLeash(leashId, terms('240', '240'));
    await sdk.executePlan(plan, walletAdapter(), async () => true);
    expect(await leash()).toMatchObject({ owner: before.owner, agent: before.agent,
      maxPerHour: 240n, maxPerDay: 240n, pending: 150n, spentHour: 90n, spentDay: 90n });
    expect(await available()).toBe(initialDeposit - 240n);
    await expect(openRun()).rejects.toThrow(/BudgetExceeded/);
    await settle(pendingRun, 0n);
    expect(await available()).toBe(initialDeposit - 90n);
    expect(await tokenBalance(deployed.accounts.treasury.address)).toBe(90n);
    expect(await tokenBalance(deployed.escrowAddress) + await tokenBalance(deployed.accounts.treasury.address)).toBe(initialDeposit);
  });

  it('uses current chain hour/day buckets when checking a limit change without forgetting reservations', async () => {
    const completed = await openRun(); await advance(5); await settle(completed, 4n, 50n);
    await openRun(); await advance(3_601);
    const sdk = client();
    const plan = await sdk.prepareUpdateLeash(leashId, terms('150', '240'));
    await sdk.executePlan(plan, walletAdapter(), async () => true);
    expect(await leash()).toMatchObject({ maxPerHour: 150n, maxPerDay: 240n,
      pending: 150n, spentHour: 0n, spentDay: 90n, agent: deployed.accounts.outsider.address });
    expect((await api(`/api/leashes/${leashId}/update`, terms('150', '239'))).status).toBe(409);
    await advance(86_401);
    const next = await sdk.prepareUpdateLeash(leashId, terms('150', '150'));
    await sdk.executePlan(next, walletAdapter(), async () => true);
    expect(await leash()).toMatchObject({ pending: 150n, spentHour: 0n, spentDay: 0n });
    expect(await available()).toBe(initialDeposit - 240n);
  });

  it('hides foreign and unknown budgets and rejects the named agent as an updater on chain', async () => {
    const foreign = await api(`/api/leashes/${leashId}/update`, terms(), agentSession);
    const absent = await api(`/api/leashes/${randomId()}/update`, terms());
    expect(foreign.status).toBe(404); expect(absent.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ title: 'not_found' });
    expect(await absent.json()).toMatchObject({ title: 'not_found' });
    await expect(local.publicClient.simulateContract({ account: deployed.accounts.outsider.address,
      address: deployed.escrowAddress, abi: escrowAbi, functionName: 'updateLeash',
      args: [leashId, deployed.accounts.outsider.address, 700n, 1_200n, BigInt(expiry)] })).rejects.toThrow(/Unauthorized/);
    expect((await api(`/api/leashes/${leashId}/update`, terms(), 'invalid')).status).toBe(401);
    expect((await api(`/api/leashes/${leashId}/update`, terms(), session, 'https://unrelated.invalid')).status).toBe(403);
    expect(await leash()).toMatchObject({ maxPerHour: 600n, maxPerDay: 1_000n, pending: 0n });
  });

  it.each([
    ['zero cap', () => ({ ...terms(), maxPerHour: '0' })],
    ['day smaller than hour', () => terms('700', '699')],
    ['past expiry', () => ({ ...terms(), expiry: Math.floor(Date.now() / 1000) - 1 })],
    ['expiry over 30 days', () => ({ ...terms(), expiry: Math.floor(Date.now() / 1000) + 31 * 86_400 })],
    ['uint96 overflow', () => ({ ...terms(), maxPerDay: (2n ** 96n).toString() })],
    ['unsafe expiry integer', () => ({ ...terms(), expiry: Number.MAX_SAFE_INTEGER + 1 })],
    ['agent injection', () => ({ ...terms(), agent: deployed.accounts.owner.address })],
  ])('rejects %s before returning a signing action', async (_name, invalid) => {
    const before = await leash();
    expect((await api(`/api/leashes/${leashId}/update`, invalid())).status).toBe(422);
    expect(await leash()).toEqual(before);
  });

  it('permanently rejects killed budgets and pre-kill update intents', async () => {
    const sdk = client(); const prepared = await sdk.prepareUpdateLeash(leashId, terms());
    const transaction = onlyTransaction(prepared);
    await confirmed(ownerWallet.writeContract({ account: deployed.accounts.owner, chain: localChain,
      address: deployed.escrowAddress, abi: escrowAbi, functionName: 'killLeash', args: [leashId] }));
    expect((await api(`/api/leashes/${leashId}/update`, terms())).status).toBe(409);
    await expect(simulateUpdate(transaction)).rejects.toThrow(/LeashInactive/);
    expect(await leash()).toMatchObject({ killed: true, maxPerHour: 600n, maxPerDay: 1_000n });
  });

  it('rejects a previously valid intent after another run increases the reserved ceiling', async () => {
    const sdk = client(); const prepared = await sdk.prepareUpdateLeash(leashId, terms('200', '200'));
    const transaction = onlyTransaction(prepared);
    await openRun(); await openRun();
    await expect(simulateUpdate(transaction)).rejects.toThrow(/BudgetExceeded/);
    expect((await api(`/api/leashes/${leashId}/update`, terms('200', '200'))).status).toBe(409);
    expect(await leash()).toMatchObject({ maxPerHour: 600n, maxPerDay: 1_000n, pending: 300n });
    expect(await available()).toBe(initialDeposit - 300n);
  });

  it('renews an expired budget without reviving a killed budget or changing its agent', async () => {
    const chainTime = (await local.publicClient.getBlock()).timestamp;
    const created = await service.createLeash(deployed.accounts.owner.address, deployed.accounts.outsider.address,
      300n, 500n, chainTime + 2n);
    await send(created.transaction); await advance(3);
    expect((await leash(created.leashId)).expiry).toBeLessThan((await local.publicClient.getBlock()).timestamp);
    const sdk = client(); const prepared = await sdk.prepareUpdateLeash(created.leashId, terms('400', '600'));
    await sdk.executePlan(prepared, walletAdapter(), async () => true);
    expect(await leash(created.leashId)).toMatchObject({ owner: deployed.accounts.owner.address,
      agent: deployed.accounts.outsider.address, expiry: BigInt(expiry), killed: false,
      maxPerHour: 400n, maxPerDay: 600n });
  });

  it('permits owner budget maintenance when the controller pauses new work', async () => {
    controllerState = 'quarantined';
    const sdk = client(); const prepared = await sdk.prepareUpdateLeash(leashId, terms());
    await sdk.executePlan(prepared, walletAdapter(), async () => true);
    expect(await leash()).toMatchObject({ maxPerHour: 700n, maxPerDay: 1_200n });
    const input: QuoteInput = { leashId, task: { kind: 'sha256', text: 'paused controller' }, maxSeconds: 1 };
    expect((await api('/api/quotes', input)).status).toBe(503);
    expect(await available()).toBe(initialDeposit);
  });

  it.each(['agent', 'caps', 'target'] as const)('rejects a substituted %s in the API wallet intent', async substitution => {
    const fetcher: FetchTransport = async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(url).pathname !== `/api/leashes/${leashId}/update`) return response;
      const body = await response.json() as { leashId: Hex; agent: typeof deployed.accounts.owner.address; transaction: WalletTransaction };
      if (substitution === 'agent') {
        body.agent = deployed.accounts.owner.address;
        body.transaction.data = encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash',
          args: [leashId, deployed.accounts.owner.address, 700n, 1_200n, BigInt(expiry)] });
      } else if (substitution === 'caps') {
        body.transaction.data = encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash',
          args: [leashId, deployed.accounts.outsider.address, 701n, 1_200n, BigInt(expiry)] });
      } else body.transaction.to = deployed.tokenAddress;
      return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    };
    const before = await leash();
    await expect(client(fetcher).prepareUpdateLeash(leashId, terms())).rejects.toThrow();
    expect(await leash()).toEqual(before);
    expect(await available()).toBe(initialDeposit);
  });

  it('executes the allowed generated demo-owner action and refuses a foreign session to use the demo signer', async () => {
    const preparedResponse = await api(`/api/leashes/${leashId}/update`, terms());
    expect(preparedResponse.status).toBe(200);
    const prepared = await preparedResponse.json() as { transaction: WalletTransaction };
    expect((await api('/api/demo/transaction', prepared.transaction, agentSession)).status).toBe(403);
    expect(await leash()).toMatchObject({ maxPerHour: 600n });
    const executed = await api('/api/demo/transaction', prepared.transaction);
    expect(executed.status).toBe(200);
    expect(await leash()).toMatchObject({ agent: deployed.accounts.outsider.address, maxPerHour: 700n, maxPerDay: 1_200n });
    expect(await available()).toBe(initialDeposit);
  });

  it('exposes a real MCP budget-update tool that returns a pending owner action without broadcasting', async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'scripts/mcp.ts'], cwd: resolve('.'), stderr: 'pipe',
      env: { ...getDefaultEnvironment(), TELOMERE_API_URL: origin, TELOMERE_SESSION_TOKEN: session,
        TELOMERE_CHAIN_ID: '31337', TELOMERE_ESCROW_ADDRESS: deployed.escrowAddress,
        TELOMERE_TOKEN_ADDRESS: deployed.tokenAddress, TELOMERE_RECEIPT_SIGNER: deployed.accounts.signer.address } });
    const mcp = new Client({ name: 'budget-update-acceptance', version: '0.1.0' });
    try {
      await mcp.connect(transport);
      expect((await mcp.listTools()).tools.map(tool => tool.name)).toContain('telomere_leash_update');
      const before = await leash();
      const nonce = await local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address });
      const result = await mcp.callTool({ name: 'telomere_leash_update', arguments: { leashId, ...terms() } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { purpose: 'leash_update', leashId, requiresWallet: true,
        intents: [{ chainId: 31337, transaction: { to: getAddress(deployed.escrowAddress), value: '0x0' } }] } });
      expect(JSON.stringify(result)).toContain(encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash',
        args: [leashId, deployed.accounts.outsider.address, 700n, 1_200n, BigInt(expiry)] }));
      expect(await leash()).toEqual(before);
      expect(await local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address })).toBe(nonce);
      expect(await available()).toBe(initialDeposit);
    } finally { await mcp.close(); }
  }, 30_000);
});
