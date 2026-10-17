import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { decodeFunctionData, type Hex } from 'viem';
import { expect, it, vi } from 'vitest';
import { compileContracts } from '../scripts/compile-contracts.js';
import { Auth } from '../src/auth.js';
import { Problem } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { platformVaultClientAbi } from '../src/platform-runtime/vault-client.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { PaidLifecycleClientVault } from '../src/agents/paid-lifecycle-runner.js';
import { DurableVaultCompute, FRAMEWORK_COMPUTE_SCHEMA, createTelomereAutomatonTools, createTelomereElizaPlugin } from '../src/integrations/index.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

class FrameworkCpuFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const program = "const{createHash}=require('node:crypto');let d='';process.stdin.on('data',b=>d+=b);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(JSON.parse(d).text).digest('hex')})),11000));";
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}

it('Eliza and Conway tools recover exact paid Vault work across response loss and encrypted journal restart over real HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telomere-framework-'));
  const masterKey = randomBytes(32), journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
  const child = new FrameworkCpuFixture(), image = 'fixture/node@sha256:' + '1'.repeat(64);
  const hostAgent = new HostKitAgent(journal, child, controller.publicKey, new Set([image]));
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let hostServer: Server | undefined, apiServer: Server | undefined, fileVault: CystCheckpointFileVault | undefined;
  try {
    await hostAgent.initialize();
    const listen = async (app: Hono) => {
      const server = createServer(getRequestListener(app.fetch));
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
      return { server, origin: 'http://127.0.0.1:' + address.port };
    };
    const hostHttp = await listen(createHostKitRoutes(hostAgent)); hostServer = hostHttp.server;
    const hostClient = new HostKitClient(hostHttp.origin, journal.identity.publicKey, controller, true);
    const artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
    // REASON: The HostKit identity is a verified 32-byte hex key.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    const chain = local, vault = await deployPlatformVault(chain);
    store = await openStore({ DATA_DIR: join(root, 'controller') });
    const bridge = new PlatformBridge(store.db, { pins: chain.pins, rpcUrl: chain.local.rpcUrl, signerPrivateKey: chain.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins);
    const binding = await vaults.authorize(vault.account.address, vault.agent.vault, 'run');
    const host = platformHostSchema.parse({ hostId: chain.hostId, hostKey: journal.identity.publicKey,
      hardwareClass: 'cpu', region: 'local-test', image, imageDigest: 'sha256:' + '1'.repeat(64), sealed: false,
      lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    let runtime: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: chain.pins.escrowAddress,
      receiptRootAddress: chain.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map([[host.hostId, hostClient]])), receipts, vaults);
    await runtime.initialize(); const wrapper = new PlatformVaultRuntimeService(runtime, vaults);
    let auth: Auth, origin: string;
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code
      : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_input' : 'service_unavailable' },
    error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong origin');
      await next();
    });
    app.get('/api/me', async context => context.json({ address: await auth.owner(getCookie(context, 'telomere_session')), demo: true }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(wrapper, context => auth.owner(getCookie(context, 'telomere_session'))));
    const api = await listen(app); apiServer = api.server; origin = api.origin;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: chain.local.rpcUrl,
      SIGNER_PRIVATE_KEY: chain.keys.signer, DEMO_PRIVATE_KEY: chain.keys.owner, ESCROW_ADDRESS: chain.pins.escrowAddress, TOKEN_ADDRESS: chain.pins.tokenAddress }));
    const sessionToken = await auth.session(binding.agentWallet), now = await bridge.now();
    const profile = { baseUrl: origin, pins: chain.pins, vaultPins: vault.pins, binding };
    const createJournal = () => {
      fileVault = new CystCheckpointFileVault({ directory: join(root, 'private-owner'), masterKey });
      return new PaidLifecycleClientVault(fileVault, { owner: binding.owner, agent: binding.agentWallet, applicationSchema: FRAMEWORK_COMPUTE_SCHEMA });
    };
    let ownerJournal = createJournal();
    const make = (drop?: 'quote' | 'admit') => {
      let dropped = false;
      return new DurableVaultCompute({ profile, journal: ownerJournal, sessionToken, nowSeconds: () => now,
        ...(drop === undefined ? {} : { fetch: async (url, init) => {
          const response = await fetch(url, init), path = new URL(String(url)).pathname;
          if (!dropped && init?.method === 'POST' && path.endsWith(drop === 'quote' ? '/quotes' : '/runs')) {
            await response.text(); dropped = true; throw new Error('Dropped actual HTTP response');
          }
          return response;
        } }) });
    };
    const input = { leashId: binding.leashId, task: { kind: 'sha256' as const, text: 'framework paid CPU' },
      maxSeconds: 25, deadline: now + 300, maxSpend: '3000', regions: ['local-test'] };
    const nonceBefore = await chain.local.publicClient.getTransactionCount({ address: vault.account.address });
    await expect(make('quote').prepare('original', input)).rejects.toThrow('Dropped actual');
    expect(await chain.local.publicClient.getTransactionCount({ address: vault.account.address })).toBe(nonceBefore);
    fileVault?.close(); ownerJournal = createJournal();
    const compute = make(), plugin = createTelomereElizaPlugin(compute), action = plugin.actions[0];
    if (!action) throw new Error('Missing Eliza action');
    const options = { parameters: { request: JSON.stringify({ action: 'prepare', operationId: 'original', input }) } };
    expect(await action.validate({}, {}, undefined, options)).toBe(true);
    const message = { content: { text: options.parameters.request } };
    expect(await action.validate({}, message)).toBe(true);
    expect((await action.handler({}, message)).success).toBe(true);
    const result = await action.handler({}, {}, undefined, options); expect(result.success).toBe(true);
    const preparedResult = z.object({ result: z.object({ phase: z.literal('wallet_required'), runId: z.string(), ceiling: z.literal('2725'),
      transaction: z.object({ to: z.string(), data: z.string(), chainId: z.literal(31337), value: z.literal('0') }) }) }).parse(JSON.parse(result.text));
    const runId = preparedResult.result.runId, transaction = preparedResult.result.transaction;
    expect(transaction.to.toLowerCase()).toBe(binding.vault.toLowerCase());
    // REASON: The checked SDK plan has already validated exact hexadecimal calldata.
    expect(decodeFunctionData({ abi: platformVaultClientAbi, data: transaction.data as Hex }).functionName).toBe('payRun');
    await expect(compute.prepare('original', { ...input, maxSpend: '3001' })).rejects.toThrow('different original');
    const requests = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(url, init));
    await expect(new DurableVaultCompute({ profile: { ...profile, pins: { ...profile.pins, chainId: 84532,
      tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', reviewedTokenKind: 'circle_proxy',
      assetImplementation: { address: binding.vault, codeHash: profile.pins.tokenCodeHash } } },
    journal: ownerJournal, sessionToken, fetch: requests }).status('original')).rejects.toThrow('different original');
    expect(requests).not.toHaveBeenCalled();
    await expect(new DurableVaultCompute({ profile, sessionToken, fetch: requests,
      journal: { scope: ownerJournal.scope, claim: async () => undefined, read: async () => undefined } })
      .prepare('unretained-profile', input)).rejects.toBeDefined();
    expect(requests).not.toHaveBeenCalled();
    await expect(new DurableVaultCompute({ profile, sessionToken, fetch: requests, nowSeconds: () => now,
      journal: { scope: ownerJournal.scope,
        claim: async (kind, value) => { if (!kind.endsWith(':intent')) await ownerJournal.claim(kind, value); },
        read: kind => ownerJournal.read(kind) } }).prepare('unretained-intent', input)).rejects.toBeDefined();
    expect(requests.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    await expect(compute.prepare('too-small', { ...input, maxSpend: '1' })).rejects.toBeDefined();
    expect(child.starts).toBe(0);
    // This separate external test wallet alone broadcasts one local-chain payment.
    const payment = await chain.confirmed(vault.wallet.sendTransaction({ to: binding.vault,
      data: transaction.data as Hex, value: 0n }));
    await expect(make('admit').admit('original', payment.transactionHash)).rejects.toThrow('Dropped actual');
    fileVault?.close(); ownerJournal = createJournal();
    const resumed = make(), tool = createTelomereAutomatonTools(resumed)[0]; if (!tool) throw new Error('Missing Automaton tool');
    const context = { identity: { address: binding.agentWallet, creatorAddress: binding.owner } };
    expect(JSON.parse(await tool.execute({ action: 'admit', operationId: 'original', transactionHash: payment.transactionHash }, context)).success).toBe(true);
    await expect(resumed.admit('original', '0x' + '7'.repeat(64))).rejects.toThrow('different original');
    const afterPaid = await resumed.prepare('original', input); expect(afterPaid).toMatchObject({ requiresWallet: false, phase: 'transaction_recorded', transactionHash: payment.transactionHash });
    expect('transaction' in afterPaid).toBe(false);
    await runtime.drain();
    const [row] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, runId));
    if (!row?.settlement) throw new Error('Actual CPU settlement missing');
    await chain.test.setNextBlockTimestamp({ timestamp: BigInt((Math.floor(row.settlement.endedAt / 3600) + 1) * 3600) });
    await chain.test.mine({ blocks: 1 }); await runtime.drain();
    const final = JSON.parse(await tool.execute({ action: 'status', operationId: 'original' }, context));
    expect(final).toMatchObject({ success: true, result: { id: runId, status: 'completed', admissionTx: payment.transactionHash } });
    expect(BigInt(final.result.charged)).toBeGreaterThan(0n);
    expect(BigInt(final.result.charged) + BigInt(final.result.refund)).toBe(2725n);
    expect(final.result.result.output).toBe(JSON.stringify({ sha256: createHash('sha256').update(input.task.text).digest('hex') }));
    expect(child.starts).toBe(1);
    expect(await chain.local.publicClient.getTransactionCount({ address: vault.account.address })).toBe(nonceBefore + 1);
    // Exercise the actual released-API-compatible starter executable in a new process.
    const profileFile = join(root, 'reviewed-profile.json'), keyFile = join(root, 'master-key.txt'), sessionFile = join(root, 'session.txt'),
      commandFile = join(root, 'status-command.json');
    await Promise.all([writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 }),
      writeFile(keyFile, masterKey.toString('hex'), { mode: 0o600 }), writeFile(sessionFile, sessionToken, { mode: 0o600 }),
      writeFile(commandFile, JSON.stringify({ action: 'status', operationId: 'original' }), { mode: 0o600 })]);
    for (const framework of ['elizaos', 'automaton']) {
      const invoked = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('src/integrations/cli.ts'),
        '--framework', framework, '--profile-file', profileFile, '--journal-directory', join(root, 'private-owner'),
        '--master-key-file', keyFile, '--session-token-file', sessionFile, '--command-file', commandFile], {
        timeout: 20000, maxBuffer: 1048576, env: { ...process.env, SIGNER_PRIVATE_KEY: '', DEMO_PRIVATE_KEY: '' } });
      expect(JSON.parse(invoked.stdout)).toMatchObject({ result: { id: runId, status: 'completed', admissionTx: payment.transactionHash } });
      expect(invoked.stderr).toBe('');
    }
    expect(JSON.parse(await tool.execute({ action: 'status', operationId: 'original' }, { identity: { address: binding.owner, creatorAddress: binding.owner } })).success).toBe(false);
    expect(await action.handler({}, {}, undefined, { parameters: { request: 'bad-json-secret' } })).toMatchObject({ success: false, error: 'telomere_compute_failed' });
  } finally {
    fileVault?.close(); masterKey.fill(0); await hostAgent.close();
    for (const server of [apiServer, hostServer]) if (server) {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    }
    await journal.close(); await store?.close(); await local?.close();
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-framework-')) throw new Error('Unsafe framework test cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 100_000);
