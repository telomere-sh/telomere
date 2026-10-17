import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { decodeFunctionData, keccak256, type Hex } from 'viem';
import { beforeAll, expect, it, vi } from 'vitest';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { hashJson, Problem } from '../src/common.js';
import { localChain } from '../src/chain/chains.js';
import { CystService } from '../src/cysts/service.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { DurableVaultCompute, FRAMEWORK_COMPUTE_SCHEMA } from '../src/integrations/durable-vault-compute.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformVaultBridge, platformVaultAbi } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { openStore } from '../src/store.js';
import { createVaultPaidAgentLifecycle } from '../src/agents/vault-runtime.js';
import { PaidLifecycleClientVaultV3 } from '../src/agents/paid-lifecycle-vault-v3.js';
import { PaidLifelineReservations, PAID_LIFELINE_FUNDING_SCHEMA, type PaidLifelineFundingPort } from '../src/agents/paid-lifeline-reservations.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

let artifacts: Record<string, ContractArtifact>;
beforeAll(() => {
  artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
    'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
}, 90_000);

it('funds one real Vault reservation through v3 journals and reconciles lost wallet/admission responses after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-lifeline-funding-anvil-')), masterKey = randomBytes(32);
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  let server: Server | undefined, fundingJournal: PaidLifecycleClientVaultV3 | undefined, computeJournal: PaidLifecycleClientVaultV3 | undefined;
  try {
    const hostKey = new Ed25519Identity().publicKey;
    local = await deployPlatformRuntime(hostKey as Hex, artifacts); const vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(directory, 'db') });
    const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins), executor = new PlatformHostExecutor(store.db, new Map());
    // Only the host's placement hint is a fixture. No CPU job is dispatched in this funding acceptance.
    vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(true); const dispatch = vi.spyOn(executor, 'run');
    const digest = `sha256:${'a'.repeat(64)}`, image = 'fixture/session@' + digest;
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey, hardwareClass: 'cpu', region: 'funding-fixture', image,
      imageDigest: digest, sealed: false, lane: 'standard', sessionEnabled: true, pricePerSecond: '100',
      sessionPrices: { full: '100', lean: '50', torpor: '25' }, reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    let runtime: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    const service = new PlatformVaultRuntimeService(runtime, vaults), cysts = new CystService(store.db, join(directory, 'cysts'));
    await cysts.initialize(); const lifecycle = createVaultPaidAgentLifecycle(store.db, cysts, runtime);
    await runtime.initialize(); await lifecycle.initialize();
    const owner = local.accounts.owner.address.toLowerCase(), agent = vault.account.address.toLowerCase(), app = new Hono();
    const principal = async (context: Parameters<Parameters<typeof createPlatformVaultRuntimeRoutes>[1]>[0]) =>
      getCookie(context, 'telomere_session') === '1'.repeat(64) ? owner : agent;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_error' }, error instanceof Problem ? error.status : 503));
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(service, principal));
    server = createServer(getRequestListener(app.fetch)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new PlatformVaultRuntimeClient({ baseUrl, pins: local.pins, vaultPins: vault.pins,
      vault: vault.agent.vault, sessionToken: '2'.repeat(64) });
    const source = await client.quote({ leashId: vault.agent.leashId, task: { kind: 'session', imageDigest: digest, maxCommands: 4 },
      maxSeconds: 100, maxSpend: '20000', deadline: await bridge.now() + 300 }, 'funding-source');
    const sourceReceipt = await local.confirmed(vault.wallet.sendTransaction({ to: source.transaction.to, data: source.transaction.data as Hex, value: 0n }));
    await client.admit({ runId: source.quote.runId, transactionHash: sourceReceipt.transactionHash }, 'funding-source-admit');
    await lifecycle.agents.register(owner, { agent, runId: source.quote.runId });
    const config = await client.config(), profile = { baseUrl, pins: config.pins, vaultPins: config.vaultPins, binding: config.binding };
    const privatePolicy = { version: 3, buckets: 64, maxRecordsPerBucket: 512, maxEncodedRecordBytes: 32768, maxJournalBytes: 1073741824 } as const;
    const fundingDirectory = join(directory, 'funding'), computeDirectory = join(directory, 'compute'), walletDirectory = join(directory, 'wallet');
    for (const path of [fundingDirectory, computeDirectory, walletDirectory]) await mkdir(path, { mode: 0o700 });
    const policy = { version: 1, owner, agent, computeProfileHash: hashJson(profile), imageDigest: digest, maxCommands: 4,
      leaseSeconds: 100, regions: ['funding-fixture'], maxReservationCeiling: '20000', maxReservedUnits: '20000', maxReservations: 1,
      notBefore: await bridge.now() - 1, expiresAt: await bridge.now() + 600 } as const;
    let loseAdmission = true, loseWallet = true, broadcasts = 0;
    type WalletRecord = { policyHash: string; index: number; ledgerHash: string; totalReserved: string; transactionHash: Hex; raw: Hex };
    const walletRecord = async (id: string): Promise<WalletRecord | null> => {
      try { return JSON.parse(await readFile(join(walletDirectory, id + '.json'), 'utf8')) as WalletRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const wallet: PaidLifelineFundingPort = {
      anchor: async policyHash => {
        const record = await walletRecord('anchor');
        if (!record) return null; if (record.policyHash !== policyHash) throw new Error('Wallet policy changed');
        return { index: record.index, ledgerHash: record.ledgerHash, totalReserved: record.totalReserved };
      },
      lookup: async operationId => {
        const record = await walletRecord(operationId);
        if (!record) return null; if (keccak256(record.raw) !== record.transactionHash) throw new Error('Wallet signed bytes changed');
        return record.transactionHash;
      },
      submit: async (plan, operationId, approval) => {
        expect(hashJson(approval.policy)).toBe(hashJson(policy)); expect(approval.policyHash).toBe(hashJson(policy));
        expect(approval.index).toBe(0); expect(approval.totalReserved).toBe(approval.ceiling);
        expect(BigInt(approval.ceiling)).toBeLessThanOrEqual(BigInt(policy.maxReservedUnits));
        expect(await walletRecord('anchor')).toBeNull(); expect(plan.to.toLowerCase()).toBe(vault.agent.vault.toLowerCase());
        const decoded = decodeFunctionData({ abi: platformVaultAbi, data: plan.data as Hex });
        if (decoded.functionName !== 'payRun') throw new Error('Wallet refuses non-compute calldata');
        const quote = decoded.args[0], base = quote.pricePerSecond * quote.maxSeconds + quote.inferencePrice;
        expect((base + (base * 900n + 9999n) / 10000n).toString()).toBe(approval.ceiling);
        const request = await vault.wallet.prepareTransactionRequest({ account: vault.account, chain: localChain,
          to: plan.to, data: plan.data as Hex, value: 0n });
        const raw = await vault.wallet.signTransaction(request), transactionHash = keccak256(raw);
        const record: WalletRecord = { policyHash: approval.policyHash, index: approval.index, ledgerHash: approval.ledgerHash,
          totalReserved: approval.totalReserved, transactionHash, raw };
        // Both the immutable operation and independent cumulative anchor precede the sole broadcast.
        await writeFile(join(walletDirectory, operationId + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await writeFile(join(walletDirectory, 'anchor.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        broadcasts++; await local!.confirmed(local!.local.publicClient.sendRawTransaction({ serializedTransaction: raw }));
        if (loseWallet) { loseWallet = false; throw new Error('Lost wallet submit response'); } return transactionHash;
      },
    };
    const make = () => {
      fundingJournal = new PaidLifecycleClientVaultV3({ directory: fundingDirectory, masterKey, owner, agent,
        applicationSchema: PAID_LIFELINE_FUNDING_SCHEMA, policy: privatePolicy });
      computeJournal = new PaidLifecycleClientVaultV3({ directory: computeDirectory, masterKey, owner, agent,
        applicationSchema: FRAMEWORK_COMPUTE_SCHEMA, policy: privatePolicy });
      const compute = new DurableVaultCompute({ profile, journal: computeJournal, sessionToken: '2'.repeat(64), fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (loseAdmission && init?.method === 'POST' && String(url).endsWith('/runs') && typeof init.body === 'string'
          && 'transactionHash' in JSON.parse(init.body)) { loseAdmission = false; await response.arrayBuffer(); throw new Error('Lost admission response'); }
        return response;
      } });
      return new PaidLifelineReservations({ policy: { ...policy, regions: [...policy.regions] }, compute, journal: fundingJournal,
        control: { get: lifecycle.agents.get.bind(lifecycle.agents) }, wallet });
    };
    const before = BigInt((await client.balance()).available), first = make();
    await expect(first.approvedTarget(owner, agent, 'lean')).rejects.toThrow('Lost admission response');
    expect(broadcasts).toBe(1); const pendingInventory = await first.inventory(); expect(pendingInventory).toHaveLength(1);
    expect(pendingInventory[0]).toMatchObject({ attempted: true, state: 'pending', reserved: '5450' });
    fundingJournal?.close(); computeJournal?.close(); const reopened = make();
    const [target, replay] = await Promise.all([reopened.approvedTarget(owner, agent, 'lean'), reopened.approvedTarget(owner, agent, 'lean')]);
    expect(target).toBe(replay); expect(target).not.toBeUndefined(); expect(broadcasts).toBe(1);
    const run = await client.get(target!); expect(run).toMatchObject({ status: 'queued', ceiling: '5450' });
    expect((await bridge.run(run.quote.runId)).status).toBe(1); expect(before - BigInt((await client.balance()).available)).toBe(5450n);
    expect(await reopened.inventory()).toMatchObject([{ state: 'admitted', runId: target, reserved: '5450' }]);
    const current = await lifecycle.agents.get(owner, agent);
    await lifecycle.agents.plan(owner, agent, { action: 'kill', expectedVersion: current.agent.version }, 'funding-owner-kill');
    expect(await reopened.approvedTarget(owner, agent, 'lean')).toBeUndefined(); expect(broadcasts).toBe(1); expect(dispatch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); fundingJournal?.close(); computeJournal?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await store?.close(); await local?.close(); masterKey.fill(0); await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
