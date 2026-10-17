import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
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
import { platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { platformEscrowAbi, platformHostSchema, typedPlatformQuote, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact, type VaultAgent } from './fixtures/platform-vault-runtime.js';

/** This executes a real child process; gVisor's separate Linux acceptance verifies isolation. */
class VaultCpuFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  delay = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const program = `const {createHash}=require('node:crypto');let data='';process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>setTimeout(()=>{const task=JSON.parse(data);process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(task.text).digest('hex')}));},${this.delay}));`;
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}

describe('full backend delegated Vault runtime with actual CPU and automatic Selection burn', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let vault: Awaited<ReturnType<typeof deployPlatformVault>>, store: Awaited<ReturnType<typeof openStore>>;
  let root: string, journal: HostJournal, hostAgent: HostKitAgent, hostServer: Server, child: VaultCpuFixture;
  let host: ReturnType<typeof platformHostSchema.parse>, client: HostKitClient;
  let bridge: PlatformBridge, vaults: PlatformVaultBridge, runtime: PlatformRuntimeService;
  let service: PlatformVaultRuntimeService, receipts: PlatformReceiptService;

  beforeAll(() => {
    artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  }, 90_000);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-vault-runtime-'));
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity(); child = new VaultCpuFixture();
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    hostAgent = new HostKitAgent(journal, child, control.publicKey, new Set([image])); await hostAgent.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hostAgent).fetch));
    await new Promise<void>(resolveListen => hostServer.listen(0, '127.0.0.1', resolveListen));
    const address = hostServer.address(); if (!address || typeof address === 'string') throw new Error('Actual HostKit address missing');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    // REASON: Ed25519Identity's publicKey is a verified 32-byte hex string.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts); vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'local-test',
      image, imageDigest: `sha256:${'1'.repeat(64)}`, sealed: false, lane: 'standard', pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    rebuild(); await runtime.initialize();
  }, 40_000);
  afterEach(async () => {
    vi.restoreAllMocks(); await hostAgent?.close();
    if (hostServer) await new Promise<void>(resolveClose => hostServer.close(() => resolveClose()));
    await journal?.close(); await store?.close(); await local?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-runtime-')) throw new Error('Unexpected owned Vault test directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  function rebuild() {
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    vaults = new PlatformVaultBridge(bridge, vault.pins);
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map([[host.hostId, client]])), receipts, vaults);
    service = new PlatformVaultRuntimeService(runtime, vaults);
  }
  const principal = () => vault.account.address;
  const payer = () => vault.agent.vault;
  async function prepare(key = 'vault-cpu') {
    return service.quote(principal(), payer(), { leashId: vault.agent.leashId, task: { kind: 'sha256', text: 'delegated-financial-cpu' },
      maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, key);
  }
  async function open(prepared: PlatformPrepared, admit = true) {
    const transaction = prepared.transaction;
    // REASON: Prepared transactions validate their data as hexadecimal at the public boundary.
    const receipt = await local.confirmed(vault.wallet.sendTransaction({ to: transaction.to, data: transaction.data as Hex, value: 0n }));
    if (admit) await service.admit(principal(), payer(), { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'vault-admit');
    return receipt;
  }
  async function row(runId: Hex) {
    const [value] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, runId));
    if (!value) throw new Error('Durable Vault run missing'); return value;
  }
  async function closeHour(runId: Hex) {
    const value = await row(runId); if (!value.settlement) throw new Error('Durable Vault settlement missing');
    const next = BigInt((Math.floor(value.settlement.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < next) { await local.test.setNextBlockTimestamp({ timestamp: next }); await local.test.mine({ blocks: 1 }); }
  }
  async function finish(runId: Hex) { await runtime.drain(); await closeHour(runId); await runtime.drain(); }
  async function read<T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> {
    // REASON: Dynamic ABIs originate from real contract compilation; assertions exercise their typed return values.
    return await local.local.publicClient.readContract({ address, abi: local.artifact(name).abi, functionName, args }) as T;
  }
  const currentAgent = () => read<VaultAgent>(vault.registryAddress, 'PlatformSelectionRegistry', 'getAgent', [vault.agentId]);
  const openRuns = () => read<bigint>(payer(), 'PlatformAgentVault', 'openRuns');
  const finalized = (runId: Hex) => read<boolean>(payer(), 'PlatformAgentVault', 'finalizedRun', [runId]);
  async function freeze() {
    await local.confirmed(vault.guardianWallet.writeContract({ address: vault.registryAddress, abi: local.artifact('PlatformSelectionRegistry').abi,
      functionName: 'setFrozen', args: [vault.agentId, true, 'bounded acceptance freeze', `0x${'2'.repeat(64)}`] }));
  }
  async function kill() {
    await local.confirmed(local.owner.writeContract({ address: payer(), abi: local.artifact('PlatformAgentVault').abi, functionName: 'killLeash' }));
  }

  it('authenticates the generated agent key, executes one CPU child, pays full fees and automatically records burn once', async () => {
    const auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: 'http://127.0.0.1:3280', RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner, ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const challenge = await auth.challenge(vault.account.address), signature = await vault.account.signMessage({ message: challenge.message });
    const token = await auth.verify(vault.account.address, challenge.nonce, signature), authenticated = await auth.owner(token);
    expect(authenticated).toBe(vault.account.address.toLowerCase());
    child.delay = 11000;
    const prepared = await service.quote(authenticated, payer(), { leashId: vault.agent.leashId,
      task: { kind: 'sha256', text: 'delegated-financial-cpu' }, maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'signed-agent');
    expect(prepared.quote.payer.toLowerCase()).toBe(payer().toLowerCase()); expect(prepared.ceiling).toBe('2725');
    expect(prepared.transaction.to.toLowerCase()).toBe(payer().toLowerCase());
    const outer = decodeFunctionData({ abi: local.artifact('PlatformAgentVault').abi, data: prepared.transaction.data as Hex });
    expect(outer.functionName).toBe('payRun');
    expect(prepared.transaction.data).toBe(encodeFunctionData({ abi: local.artifact('PlatformAgentVault').abi,
      functionName: 'payRun', args: [typedPlatformQuote(prepared.quote), prepared.signature, prepared.imageProof, prepared.regionProof] }));
    await open(prepared); expect(await openRuns()).toBe(1n);
    await finish(prepared.quote.runId);
    const done = await service.get(authenticated, payer(), prepared.quote.runId), persisted = await row(prepared.quote.runId);
    expect(done.status).toBe('completed'); expect(done.settlement?.billableSeconds).toBeGreaterThanOrEqual(3);
    expect(done.result?.output).toBe(JSON.stringify({ sha256: createHash('sha256').update('delegated-financial-cpu').digest('hex') }));
    const base = BigInt(done.settlement!.billableSeconds) * 100n, full = base + (base * 900n + 9999n) / 10000n;
    expect(done.charged).toBe(full.toString()); expect(BigInt(done.refund!) + full).toBe(2725n);
    expect((await currentAgent()).lifetimeBurn).toBe(full); expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect(persisted.vaultBinding).not.toBeNull(); expect(persisted.vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/); expect(persisted.errorCode).toBeNull();
    expect(await read(payer(), 'PlatformAgentVault', 'spendableBalance')).toBe(1_000_000n - full);
    expect(await read(local.pins.feeRouterAddress, 'FeeRouter', 'accountedBalance')).toBe(full);
    expect((await bridge.host(local.hostId)).openRuns).toBe(0n);
    const transactionCount = (await store.db.select().from(platformTransactionJournal)).length;
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await runtime.initialize(); await runtime.drain();
    expect((await service.get(principal(), payer(), prepared.quote.runId)).charged).toBe(full.toString());
    expect((await currentAgent()).lifetimeBurn).toBe(full); expect(child.starts).toBe(1);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(transactionCount);
  }, 40_000);

  it('restricts new work to the agent, preserves human owner reads and stop, and denies unrelated wallet access', async () => {
    const prepared = await prepare();
    expect((await service.get(local.accounts.owner.address, payer(), prepared.quote.runId)).id).toBe(prepared.quote.runId);
    expect((await service.list(local.accounts.owner.address, payer())).runs).toHaveLength(1);
    await expect(service.quote(local.accounts.owner.address, payer(), prepared.input, 'owner-cannot-spend')).rejects.toMatchObject({ status: 404 });
    for (const outsider of [local.accounts.outsider.address, local.accounts.host.address]) {
      await expect(service.get(outsider, payer(), prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
      await expect(service.quote(outsider, payer(), prepared.input, 'outside-cannot-spend')).rejects.toMatchObject({ status: 404 });
      await expect(service.stopPlan(outsider, payer(), prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    }
    await open(prepared);
    await expect(service.stopPlan(principal(), payer(), prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    const stop = await service.stopPlan(local.accounts.owner.address, payer(), prepared.quote.runId);
    expect(stop.to.toLowerCase()).toBe(payer().toLowerCase());
    expect(decodeFunctionData({ abi: local.artifact('PlatformAgentVault').abi, data: stop.data as Hex }).functionName).toBe('requestStop');
    await local.confirmed(local.owner.sendTransaction({ to: stop.to, data: stop.data as Hex, value: 0n }));
    await finish(prepared.quote.runId);
    expect(await service.get(local.accounts.owner.address, payer(), prepared.quote.runId)).toMatchObject({ status: 'completed', charged: '0', refund: '2725' });
    expect(child.starts).toBe(0); expect(await openRuns()).toBe(0n); expect((await currentAgent()).lifetimeBurn).toBe(0n);
  });

  it('admits only the actual canonical Vault payRun transaction and retains the exact prepared intent', async () => {
    const prepared = await prepare();
    const unrelated = await local.confirmed(vault.wallet.sendTransaction({ to: local.accounts.outsider.address, value: 0n }));
    await expect(service.admit(principal(), payer(), { runId: prepared.quote.runId, transactionHash: unrelated.transactionHash }, 'unrelated')).rejects.toThrow();
    expect((await row(prepared.quote.runId)).status).toBe('prepared'); expect(child.starts).toBe(0);
    const paid = await open(prepared, false);
    await expect(service.admit(local.accounts.owner.address, payer(), { runId: prepared.quote.runId, transactionHash: paid.transactionHash }, 'human-admission')).rejects.toMatchObject({ status: 404 });
    const accepted = await service.admit(principal(), payer(), { runId: prepared.quote.runId, transactionHash: paid.transactionHash }, 'exact-admission');
    expect(accepted.admissionTx).toBe(paid.transactionHash); expect(accepted.status).toBe('queued');
    const replay = await service.quote(principal(), payer(), prepared.input, 'vault-cpu'); expect(replay).toEqual(prepared);
  });

  it.each(['frozen', 'killed'] as const)('returns a previously paid %s reservation without dispatching CPU and automatically closes Vault tracking', async cause => {
    const prepared = await prepare(), paid = await open(prepared, false);
    if (cause === 'frozen') await freeze(); else await kill();
    // A pre-existing paid reservation must remain recoverable even after permission to start new work is revoked.
    await service.admit(principal(), payer(), { runId: prepared.quote.runId, transactionHash: paid.transactionHash }, 'revoked-paid-admission');
    await finish(prepared.quote.runId);
    expect(await service.get(local.accounts.owner.address, payer(), prepared.quote.runId)).toMatchObject({ status: 'completed', charged: '0', refund: '2725' });
    expect(child.starts).toBe(0); expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect((await currentAgent()).lifetimeBurn).toBe(0n); expect(await read(payer(), 'PlatformAgentVault', 'spendableBalance')).toBe(1_000_000n);
  });

  it('rejects idempotent quote reuse after the agent is frozen, preserving owner recovery access', async () => {
    const prepared = await prepare(); await freeze();
    await expect(service.quote(principal(), payer(), prepared.input, 'vault-cpu')).rejects.toThrow();
    expect((await service.get(local.accounts.owner.address, payer(), prepared.quote.runId)).id).toBe(prepared.quote.runId);
    expect(child.starts).toBe(0);
  });

  it('retains the paid queued reservation across a temporary Vault policy RPC failure and dispatches its original work only once', async () => {
    const prepared = await prepare(), paid = await open(prepared);
    vi.spyOn(vaults, 'runnable').mockRejectedValueOnce(new Error('Disposable policy RPC outage before HostKit dispatch'));
    await runtime.drain();
    const waiting = await row(prepared.quote.runId);
    expect(waiting.status).toBe('queued'); expect(waiting.admissionTx).toBe(paid.transactionHash);
    expect(waiting.settlement).toBeNull(); expect(waiting.errorCode).toBe('platform_dispatch_unavailable');
    expect(child.starts).toBe(0); expect(await openRuns()).toBe(1n); expect(await finalized(prepared.quote.runId)).toBe(false);
    await finish(prepared.quote.runId);
    const done = await row(prepared.quote.runId);
    expect(done.status).toBe('completed'); expect(done.admissionTx).toBe(paid.transactionHash);
    expect(done.errorCode).toBeNull(); expect(done.vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(child.starts).toBe(1); expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    const transactions = (await store.db.select().from(platformTransactionJournal)).length;
    await runtime.drain(); expect(child.starts).toBe(1);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(transactions);
  });

  it('reopens a financially finalized database after sync failure and closes the original Vault tracking without repeating CPU', async () => {
    child.delay = 11000;
    const prepared = await prepare(); await open(prepared);
    const unavailable = vi.spyOn(vaults, 'syncRun').mockRejectedValue(new Error('Disposable outage after full financial settlement'));
    await finish(prepared.quote.runId);
    expect((await row(prepared.quote.runId)).status).toBe('completed');
    expect((await row(prepared.quote.runId)).errorCode).toMatch(/^platform_vault_sync_/);
    expect(await openRuns()).toBe(1n); expect(await finalized(prepared.quote.runId)).toBe(false); expect(child.starts).toBe(1);
    const charged = BigInt((await row(prepared.quote.runId)).charged!);
    expect(charged).toBeGreaterThan(0n); expect((await currentAgent()).lifetimeBurn).toBe(0n);
    unavailable.mockRestore();
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await runtime.initialize();
    expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect((await row(prepared.quote.runId)).vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await row(prepared.quote.runId)).errorCode).toBeNull();
    expect((await currentAgent()).lifetimeBurn).toBe(charged);
    await runtime.drain(); expect(child.starts).toBe(1); expect((await currentAgent()).lifetimeBurn).toBe(charged);
  }, 40_000);

  it('observes permissionless third-party Vault sync without duplicate burn or a second sync transaction', async () => {
    child.delay = 11000;
    const prepared = await prepare(); await open(prepared);
    const original = vaults.syncRun.bind(vaults); let outsideHash: Hex | undefined;
    vi.spyOn(vaults, 'syncRun').mockImplementationOnce(async (...args) => {
      const receipt = await local.confirmed(local.host.writeContract({ address: payer(), abi: local.artifact('PlatformAgentVault').abi,
        functionName: 'syncRun', args: [prepared.quote.runId] }));
      outsideHash = receipt.transactionHash;
      return original(...args);
    });
    await finish(prepared.quote.runId);
    expect(outsideHash).toBeDefined(); expect((await row(prepared.quote.runId)).vaultSyncTx).toBe(outsideHash);
    expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    const burned = (await currentAgent()).lifetimeBurn;
    expect(burned).toBeGreaterThan(0n); expect(burned.toString()).toBe((await row(prepared.quote.runId)).charged);
    const count = (await store.db.select().from(platformTransactionJournal)).length;
    await runtime.drain(); expect((await currentAgent()).lifetimeBurn).toBe(burned);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(count); expect(child.starts).toBe(1);
  }, 40_000);

  it('reconciles the original permissionless timeout refund and automatically closes the Vault without dispatch', async () => {
    const prepared = await prepare(); await open(prepared);
    const refundAt = await read<bigint>(local.pins.escrowAddress, 'PlatformRunEscrow', 'refundAt', [prepared.quote.runId]);
    await local.test.setNextBlockTimestamp({ timestamp: refundAt }); await local.test.mine({ blocks: 1 });
    const plan = await service.refundPlan(local.accounts.owner.address, payer(), prepared.quote.runId);
    expect(plan.to.toLowerCase()).toBe(local.pins.escrowAddress.toLowerCase());
    expect(decodeFunctionData({ abi: platformEscrowAbi, data: plan.data as Hex }).functionName).toBe('refundRun');
    await local.confirmed(local.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    await runtime.drain();
    expect(await service.get(local.accounts.owner.address, payer(), prepared.quote.runId)).toMatchObject({ status: 'refunded', charged: '0', refund: '2725' });
    expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect((await currentAgent()).lifetimeBurn).toBe(0n); expect(child.starts).toBe(0);
    expect(await read(payer(), 'PlatformAgentVault', 'spendableBalance')).toBe(1_000_000n);
  });

  it('reconciles an orphaned Vault sync from its original signed journal without re-running CPU or changing financial settlement', async () => {
    const prepared = await prepare(); await open(prepared);
    const original = vaults.syncRun.bind(vaults); let beforeSync: Hex | undefined;
    vi.spyOn(vaults, 'syncRun').mockImplementationOnce(async (...args) => {
      beforeSync = await local.test.snapshot(); return original(...args);
    });
    await finish(prepared.quote.runId);
    const done = await row(prepared.quote.runId);
    expect(done.vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/); expect(await finalized(prepared.quote.runId)).toBe(true);
    if (!beforeSync) throw new Error('Disposable pre-sync chain snapshot missing');
    await local.test.revert({ id: beforeSync });
    expect(await finalized(prepared.quote.runId)).toBe(false); expect(await openRuns()).toBe(1n);
    const observed = await service.get(principal(), payer(), prepared.quote.runId);
    expect(observed.status).toBe('completed'); expect(observed.charged).toBe(done.charged);
    expect((await row(prepared.quote.runId)).vaultSyncTx).toBeNull();
    await runtime.drain();
    const reconciled = await row(prepared.quote.runId);
    expect(reconciled.vaultSyncTx).toBe(done.vaultSyncTx); expect(reconciled.settlementTx).toBe(done.settlementTx);
    expect(reconciled.errorCode).toBeNull(); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect(await openRuns()).toBe(0n); expect(child.starts).toBe(1);
  });

  it('recovers a paid reservation refunded before HTTP admission after database reopen and closes the original Vault tracking', async () => {
    const prepared = await prepare(); await open(prepared, false);
    expect((await row(prepared.quote.runId)).status).toBe('prepared'); expect(await openRuns()).toBe(1n);
    const refundAt = await read<bigint>(local.pins.escrowAddress, 'PlatformRunEscrow', 'refundAt', [prepared.quote.runId]);
    await local.test.setNextBlockTimestamp({ timestamp: refundAt }); await local.test.mine({ blocks: 1 });
    const plan = await service.refundPlan(local.accounts.owner.address, payer(), prepared.quote.runId);
    await local.confirmed(local.host.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    expect(await finalized(prepared.quote.runId)).toBe(false);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await runtime.initialize();
    const done = await service.get(local.accounts.owner.address, payer(), prepared.quote.runId), persisted = await row(prepared.quote.runId);
    expect(done).toMatchObject({ status: 'refunded', charged: '0', refund: '2725', admissionTx: null });
    expect(await openRuns()).toBe(0n); expect(await finalized(prepared.quote.runId)).toBe(true);
    expect(persisted.vaultSyncTx).toMatch(/^0x[0-9a-f]{64}$/); expect(persisted.errorCode).toBeNull();
    expect((await currentAgent()).lifetimeBurn).toBe(0n); expect(child.starts).toBe(0);
    expect(await read(payer(), 'PlatformAgentVault', 'spendableBalance')).toBe(1_000_000n);
    expect((await bridge.host(local.hostId)).openRuns).toBe(0n);
    await runtime.drain(); expect(await openRuns()).toBe(0n); expect(child.starts).toBe(0);
  });
});
