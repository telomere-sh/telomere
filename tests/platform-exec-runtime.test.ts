import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { keccak256, toHex, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { hashJson, Problem, randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { platformHostLeases, platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { platformExecTaskSchema, platformHostSchema, platformPreparedSchema, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact, type VaultAgent } from './fixtures/platform-vault-runtime.js';

/** Runs the exact requested command in a real child; isolation requires separate Linux/gVisor acceptance. */
class CommandFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  leases: HostLease[] = [];
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++; this.leases.push(structuredClone(lease));
    return super.start(lease, heartbeat);
  }
}

describe('one-shot platform CPU commands over real authenticated HTTP and financial contracts', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let vault: Awaited<ReturnType<typeof deployPlatformVault>>, store: Awaited<ReturnType<typeof openStore>>;
  let root: string, journal: HostJournal, hostAgent: HostKitAgent, hostServer: Server, apiServer: Server, child: CommandFixture;
  let host: ReturnType<typeof platformHostSchema.parse>, client: HostKitClient, leashId: Hex, origin: string;
  let bridge: PlatformBridge, vaults: PlatformVaultBridge, runtime: PlatformRuntimeService, executor: PlatformHostExecutor;
  let vaultRuntime: PlatformVaultRuntimeService, receipts: PlatformReceiptService;
  let tokens: { owner: string; agent: string; outsider: string };
  const digest = `sha256:${'1'.repeat(64)}`;
  const stdin = 'Привет 👋\ncommand input';
  const program = (delay = 0) => `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({echo:data,computed:6*7})),${delay}));`;
  const command = (delay = 0) => ({ kind: 'exec' as const, imageDigest: digest, argv: [process.execPath, '-e', program(delay)], stdin });
  beforeAll(() => {
    artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  }, 90_000);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-platform-exec-'));
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity(); child = new CommandFixture();
    const image = 'fixture/node@' + digest;
    hostAgent = new HostKitAgent(journal, child, control.publicKey, new Set([image])); await hostAgent.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hostAgent).fetch));
    await new Promise<void>(done => hostServer.listen(0, '127.0.0.1', done));
    const address = hostServer.address(); if (!address || typeof address === 'string') throw new Error('Actual HostKit address missing');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    // REASON: Ed25519Identity generates and validates this 32-byte hexadecimal public key.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts); vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'local-test',
      image, imageDigest: digest, execEnabled: true, sealed: false, lane: 'standard', pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    rebuild(); await runtime.initialize(); leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
        expiry: BigInt(await bridge.now() + 86_400) }] }));
    await mountApi();
  }, 40_000);
  afterEach(async () => {
    vi.restoreAllMocks(); await closeApi(); await hostAgent?.close();
    if (hostServer) { hostServer.closeAllConnections(); await new Promise<void>(done => hostServer.close(() => done())); }
    await journal?.close(); await store?.close(); await local?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-platform-exec-')) throw new Error('Unexpected owned command test directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  function rebuild() {
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    vaults = new PlatformVaultBridge(bridge, vault.pins);
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    runtime = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    vaultRuntime = new PlatformVaultRuntimeService(runtime, vaults);
  }
  it('refuses a reviewed Vault implementation without the required managed exposure cap', async () => {
    const actual = bridge.public.readContract.bind(bridge.public);
    vi.spyOn(bridge.public, 'readContract').mockImplementation(async request => {
      if (request.functionName === 'MAX_MANAGED_EXPOSURE') return 2_500_000_001n as never;
      return actual(request as never) as never;
    });
    await expect(vaults.check()).rejects.toThrow('Platform Vault exposure limit differs from reviewed policy');
  });
  async function closeApi() {
    if (apiServer) { apiServer.closeAllConnections(); await new Promise<void>(done => apiServer.close(() => done())); }
  }
  async function mountApi() {
    const app = new Hono(); let auth: Auth;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong origin');
      await next();
    });
    app.route('/api/platform', createPlatformRuntimeRoutes(runtime, context => auth.owner(getCookie(context, 'telomere_session'))));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(vaultRuntime, context => auth.owner(getCookie(context, 'telomere_session'))));
    apiServer = createServer(getRequestListener(app.fetch)); await new Promise<void>(done => apiServer.listen(0, '127.0.0.1', done));
    const address = apiServer.address(); if (!address || typeof address === 'string') throw new Error('Actual API address missing');
    origin = `http://127.0.0.1:${address.port}`;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner, ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const signIn = async (account: typeof vault.account) => {
      const challenge = await auth.challenge(account.address), signature = await account.signMessage({ message: challenge.message });
      return auth.verify(account.address, challenge.nonce, signature);
    };
    tokens = { owner: await signIn(local.accounts.owner), agent: await signIn(vault.account), outsider: await signIn(local.accounts.outsider) };
  }
  async function reopen() {
    await closeApi(); await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild();
    await runtime.initialize(); await mountApi();
  }
  function request(path: string, token: keyof typeof tokens = 'owner', value?: unknown, key = 'exec-http') {
    return fetch(origin + '/api/platform' + path, { method: value === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'telomere_session=' + tokens[token], Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }
  async function prepare(payer: 'owner' | 'vault' = 'owner', delay = 0, key = 'command-quote') {
    const response = await request(payer === 'owner' ? '/quotes' : `/vaults/${vault.agent.vault}/quotes`, payer === 'owner' ? 'owner' : 'agent',
      { leashId: payer === 'owner' ? leashId : vault.agent.leashId, task: command(delay), maxSeconds: 25,
        deadline: await bridge.now() + 300, maxSpend: '10000' }, key);
    expect(response.status).toBe(201); return platformPreparedSchema.parse(await response.json());
  }
  async function open(prepared: PlatformPrepared, payer: 'owner' | 'vault' = 'owner') {
    // REASON: Prepared transactions validate hexadecimal calldata before reaching the test wallet.
    const receipt = await local.confirmed((payer === 'owner' ? local.owner : vault.wallet).sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    const response = await request(payer === 'owner' ? '/runs' : `/vaults/${vault.agent.vault}/runs`, payer === 'owner' ? 'owner' : 'agent',
      { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-command');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'queued', admissionTx: receipt.transactionHash });
    return receipt;
  }
  async function row(runId: Hex) {
    const [value] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, runId));
    if (!value) throw new Error('Durable command run missing'); return value;
  }
  async function closeHour(runId: Hex) {
    const value = await row(runId); if (!value.settlement) throw new Error('Durable command settlement missing');
    const next = BigInt((Math.floor(value.settlement.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < next) { await local.test.setNextBlockTimestamp({ timestamp: next }); await local.test.mine({ blocks: 1 }); }
  }
  async function finish(runId: Hex) { await runtime.drain(); await closeHour(runId); await runtime.drain(); }

  it.each(['owner', 'vault'] as const)('executes the exact %s command and Unicode stdin, settles verified ticks and fee, then reopens without redispatch', async payer => {
    const prepared = await prepare(payer, 11000);
    expect(prepared.quote.workloadHash).toBe(hashJson({ task: command(11000) }));
    expect(prepared.quote.imageHash).toBe(keccak256(toHex(digest))); expect(prepared.ceiling).toBe('2725');
    expect(runtime.publicConfig().capacity[0]).toHaveProperty('execEnabled', true);
    await open(prepared, payer); await finish(prepared.quote.runId);
    const value = await row(prepared.quote.runId); expect(value.status).toBe('completed');
    expect(value.result?.output).toBe(JSON.stringify({ echo: stdin, computed: 42 }));
    expect(value.settlement?.billableSeconds).toBeGreaterThanOrEqual(3);
    const base = BigInt(value.settlement!.billableSeconds) * 100n, full = base + (base * 900n + 9999n) / 10000n;
    expect(value.charged).toBe(full.toString()); expect(BigInt(value.refund!) + full).toBe(2725n);
    const [lease] = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId));
    expect(lease?.lease.body.argv).toEqual(command(11000).argv); expect(lease?.lease.body.stdin).toBe(stdin);
    expect(lease?.ticks.length).toBeGreaterThan(1); expect(lease?.acknowledgments.length).toBe(lease?.ticks.length);
    expect(lease?.cleanupConfirmed).toBe(1); expect(child.starts).toBe(1);
    expect((await receipts.proof(value.owner, prepared.quote.runId))?.proof).toBeDefined();
    expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
    expect((await bridge.host(host.hostId)).openRuns).toBe(0n);
    if (payer === 'vault') {
      // REASON: Dynamic ABI originates from the real compiled Solidity contract; this getter returns the VaultAgent tuple.
      const selected = await local.local.publicClient.readContract({ address: vault.registryAddress,
        abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'getAgent', args: [vault.agentId] }) as VaultAgent;
      expect(selected.lifetimeBurn).toBe(full); expect(value.vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/);
    }
    const transactionCount = (await store.db.select().from(platformTransactionJournal)).length;
    await reopen(); await runtime.drain();
    const after = await row(prepared.quote.runId); expect(after.charged).toBe(full.toString()); expect(child.starts).toBe(1);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(transactionCount);
    const path = payer === 'owner' ? `/runs/${prepared.quote.runId}` : `/vaults/${vault.agent.vault}/runs/${prepared.quote.runId}`;
    expect((await request(path, 'outsider')).status).toBe(404);
  }, 45_000);

  it('requires exact host digest and explicit opt-in while leaving ordinary task quotes unchanged', async () => {
    const input = { leashId, task: { ...command(), imageDigest: `sha256:${'2'.repeat(64)}` }, maxSeconds: 25,
      deadline: await bridge.now() + 300, maxSpend: '10000' };
    let response = await request('/quotes', 'owner', input, 'wrong-digest'); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ title: 'deadline_infeasible' });
    const { execEnabled: _enabled, ...ordinary } = host; host = platformHostSchema.parse(ordinary); await reopen();
    expect(runtime.publicConfig().capacity[0]).not.toHaveProperty('execEnabled');
    response = await request('/quotes', 'owner', { ...input, task: command() }, 'not-enabled'); expect(response.status).toBe(409);
    response = await request('/quotes', 'owner', { ...input, task: { kind: 'sha256', text: 'legacy-hash-unchanged' } }, 'legacy-task');
    expect(response.status).toBe(201); const prepared = platformPreparedSchema.parse(await response.json());
    expect(prepared.quote.workloadHash).toBe(hashJson({ task: { kind: 'sha256', text: 'legacy-hash-unchanged' } }));
    expect(child.starts).toBe(0);
  });

  it('keeps a funded command queued when opt-in is revoked and executes its original intent once after explicit re-enablement', async () => {
    const prepared = await prepare(); const paid = await open(prepared);
    host = { ...host, execEnabled: false }; await reopen(); await runtime.drain();
    expect(await row(prepared.quote.runId)).toMatchObject({ status: 'queued', admissionTx: paid.transactionHash,
      errorCode: 'platform_exec_unavailable', settlement: null });
    expect(child.starts).toBe(0); expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
    host = { ...host, execEnabled: true }; await reopen(); await finish(prepared.quote.runId);
    expect(await row(prepared.quote.runId)).toMatchObject({ status: 'completed' }); expect(child.starts).toBe(1);
  }, 30_000);

  it('refuses a changed persisted command before claiming and preserves the original funded intent for recovery', async () => {
    const prepared = await prepare(); await open(prepared);
    const changed = { ...prepared.input, task: { ...command(), stdin: 'substituted input' } };
    await store.db.update(platformRuns).set({ input: changed }).where(eq(platformRuns.id, prepared.quote.runId));
    await runtime.drain(); expect(await row(prepared.quote.runId)).toMatchObject({ status: 'queued', errorCode: 'platform_workload_changed' });
    expect(child.starts).toBe(0);
    // Updating an unsigned input hash alone cannot replace the workload already signed into the paid quote.
    await store.db.update(platformRuns).set({ inputHash: hashJson(changed) }).where(eq(platformRuns.id, prepared.quote.runId));
    await runtime.drain(); expect(await row(prepared.quote.runId)).toMatchObject({ status: 'queued', errorCode: 'platform_workload_changed' });
    expect(child.starts).toBe(0);
    await store.db.update(platformRuns).set({ input: prepared.input, inputHash: hashJson(prepared.input) }).where(eq(platformRuns.id, prepared.quote.runId));
    await finish(prepared.quote.runId); expect((await row(prepared.quote.runId)).status).toBe('completed'); expect(child.starts).toBe(1);
  });

  it('refuses dispatch after the original host image is replaced while preserving the paid reservation and exact command', async () => {
    const prepared = await prepare(), paid = await open(prepared), original = host;
    host = { ...host, image: 'fixture/node@sha256:' + '2'.repeat(64), imageDigest: 'sha256:' + '2'.repeat(64) };
    await reopen(); await runtime.drain();
    expect(await row(prepared.quote.runId)).toMatchObject({ status: 'queued', admissionTx: paid.transactionHash,
      input: prepared.input, errorCode: 'platform_exec_unavailable' });
    expect(child.starts).toBe(0); expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    host = original; await reopen(); await finish(prepared.quote.runId);
    expect((await row(prepared.quote.runId)).status).toBe('completed'); expect(child.starts).toBe(1);
  }, 30_000);

  it.each(['disabled', 'removed'] as const)('settles owner-stopped command work for zero with a complete refund after its host is %s', async capability => {
    const prepared = await prepare(); await open(prepared);
    const originalHostId = host.hostId;
    host = capability === 'disabled' ? { ...host, execEnabled: false } : { ...host, hostId: randomId() };
    await reopen();
    if (capability === 'removed') {
      expect(runtime.publicConfig().capacity.some(candidate => candidate.hostId === originalHostId)).toBe(false);
      await runtime.drain();
      expect((await row(prepared.quote.runId)).status).toBe('queued');
      expect(child.starts).toBe(0); expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    }
    const response = await request(`/runs/${prepared.quote.runId}/stop`, 'owner', {}, 'stop-disabled-command');
    expect(response.status).toBe(200); const plan = platformPreparedSchema.shape.transaction.parse(await response.json());
    // REASON: The boundary schema validates calldata as hexadecimal before the disposable wallet submits it.
    await local.confirmed(local.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    await finish(prepared.quote.runId);
    expect(await row(prepared.quote.runId)).toMatchObject({ status: 'completed', charged: '0', refund: prepared.ceiling,
      settlement: { billableSeconds: 0 } });
    expect(child.starts).toBe(0); expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
    expect((await runtime.balance(local.accounts.owner.address)).available).toBe('1000000');
  });

  it('recovers the original completed command and confirms cleanup after a crash even with new command admission disabled', async () => {
    const prepared = await prepare(); await open(prepared);
    const run = executor.run.bind(executor);
    vi.spyOn(executor, 'run').mockImplementationOnce(async (...args) => { await run(...args); throw new Error('Lost controller outcome after original host cleanup'); });
    await expect(runtime.drain()).rejects.toThrow('original-lease recovery'); expect(child.starts).toBe(1);
    expect((await row(prepared.quote.runId)).status).toBe('running');
    host = { ...host, execEnabled: false }; await reopen(); await closeHour(prepared.quote.runId); await runtime.drain();
    expect(await row(prepared.quote.runId)).toMatchObject({ status: 'completed' }); expect(child.starts).toBe(1);
    const [lease] = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId));
    expect(lease?.cleanupConfirmed).toBe(1); expect(lease?.lease.body.argv).toEqual(command().argv);
  });

  it('settles a paid NUL-output command as a durable failed result and executes the next valid paid command', async () => {
    const invalid = { ...command(), argv: [process.execPath, '-e', 'process.stdout.write(String.fromCharCode(0));'] };
    const response = await request('/quotes', 'owner', { leashId, task: invalid, maxSeconds: 25,
      deadline: await bridge.now() + 300, maxSpend: '10000' }, 'invalid-output-command');
    expect(response.status).toBe(201); const prepared = platformPreparedSchema.parse(await response.json());
    await open(prepared); await finish(prepared.quote.runId);
    const failed = await row(prepared.quote.runId);
    expect(failed).toMatchObject({ status: 'completed', errorCode: null,
      result: { status: 'failed', output: '[telomere: invalid UTF-8 or NUL in stdout]', exitCode: -1 } });
    const base = BigInt(failed.settlement!.billableSeconds) * 100n, full = base + (base * 900n + 9999n) / 10000n;
    expect(failed.charged).toBe(full.toString()); expect(BigInt(failed.refund!) + full).toBe(BigInt(prepared.ceiling));
    expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
    const [lease] = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId));
    expect(lease?.cleanupConfirmed).toBe(1); expect(lease?.ticks.length).toBeGreaterThan(0);
    expect(lease?.acknowledgments.length).toBe(lease?.ticks.length); expect(hostAgent.identity().ready).toBe(true);
    const next = await prepare('owner', 0, 'valid-after-output-failure'); await open(next); await finish(next.quote.runId);
    expect(await row(next.quote.runId)).toMatchObject({ status: 'completed', result: { status: 'completed',
      output: JSON.stringify({ echo: stdin, computed: 42 }), exitCode: 0 } });
    expect(child.starts).toBe(2); expect(hostAgent.identity().ready).toBe(true);
    expect((await bridge.host(host.hostId)).openRuns).toBe(0n);
  }, 30_000);

  it('rejects shell entrypoints, excessive argument/stdin bytes, mutable images and extra fields before any reservation or process', async () => {
    const input = { leashId, maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' };
    const invalid = [{ ...command(), argv: ['/bin/sh', '-c', 'echo bad'] }, { ...command(), argv: [] },
      { ...command(), argv: Array(33).fill('node') }, { ...command(), argv: ['node', '👋'.repeat(2048)] },
      { ...command(), stdin: '👋'.repeat(2049) }, { ...command(), stdin: 'invalid\0jsonb' },
      { ...command(), argv: ['node', '\ud800'] }, { ...command(), argv: ['node', '\udfff'] },
      { ...command(), stdin: '\ud800' }, { ...command(), stdin: '\udfff' },
      { ...command(), imageDigest: 'node:latest' }, { ...command(), env: { TOKEN: 'rejected' } }];
    for (const [index, task] of invalid.entries()) {
      expect(platformExecTaskSchema.safeParse(task).success).toBe(false);
      expect((await request('/quotes', 'owner', { ...input, task }, 'invalid-command-' + index)).status).toBe(422);
    }
    expect(await store.db.select().from(platformRuns)).toHaveLength(0); expect(child.starts).toBe(0);
    expect(platformExecTaskSchema.parse({ ...command(), stdin: 'é'.repeat(4096) }).stdin).toHaveLength(4096);
  });
});
