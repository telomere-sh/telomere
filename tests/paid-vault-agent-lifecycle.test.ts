import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { bytes32Schema, hashJson } from '../src/common.js';
import { openStore } from '../src/store.js';
import { CystService } from '../src/cysts/service.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { createVaultPaidAgentLifecycle } from '../src/agents/vault-runtime.js';
import { createAgentRuntimeBinding } from '../src/agents/runtime-binding.js';
import { agentBilling, agentBillingAnchors, agentBillingProvenance, agents, agentVaultBindings } from '../src/agents/schema.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

describe('owner lifecycle with isolated real PlatformAgentVault Metabolism', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let vault: Awaited<ReturnType<typeof deployPlatformVault>>;
  let store: Awaited<ReturnType<typeof openStore>>, journal: HostJournal, hostAgent: HostKitAgent, server: Server;
  let root: string, bridge: PlatformBridge, vaults: PlatformVaultBridge, runtime: PlatformRuntimeService, cysts: CystService;
  let lifecycle: ReturnType<typeof createVaultPaidAgentLifecycle>, client: HostKitClient, service: PlatformVaultRuntimeService;
  let host: ReturnType<typeof platformHostSchema.parse>;
  beforeAll(() => {
    artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  }, 90_000);
  afterEach(async () => {
    vi.restoreAllMocks(); await hostAgent?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await journal?.close(); await store?.close(); await local?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-lifecycle-')) throw new Error('Unexpected owned Vault lifecycle directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  function rebuild() {
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    vaults = new PlatformVaultBridge(bridge, vault.pins);
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map([[host.hostId, client]])), receipts, vaults);
    service = new PlatformVaultRuntimeService(runtime, vaults);
    cysts = new CystService(store.db, join(root, 'cysts'));
    lifecycle = createVaultPaidAgentLifecycle(store.db, cysts, runtime);
  }
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'telomere-vault-lifecycle-'));
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity();
    const imageDigest = `sha256:${'a'.repeat(64)}`, image = 'fixture/node@' + imageDigest;
    hostAgent = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'), control.publicKey, new Set([image]));
    await hostAgent.initialize(); server = createServer(getRequestListener(createHostKitRoutes(hostAgent).fetch));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host fixture port missing');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    // REASON: The generated Ed25519 public key is already validated as bytes32.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts); vault = await deployPlatformVault(local);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu',
      region: 'local-test', image, imageDigest, execEnabled: true, sealed: false, lane: 'standard', pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    rebuild(); await cysts.initialize(); await lifecycle.initialize(); await runtime.initialize();
  }
  async function prepare(delay = 11000) {
    const prepared = await service.quote(vault.account.address, vault.agent.vault, { leashId: vault.agent.leashId,
      task: { kind: 'exec', imageDigest: host.imageDigest, argv: [process.execPath, '-e', `setTimeout(()=>process.stdout.write('42'),${delay})`] },
      maxSeconds: 120, maxSpend: '20000', deadline: await bridge.now() + 600 }, 'vault-lifecycle-run');
    const receipt = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to,
      // REASON: Prepared platform transaction data is validated Hex.
      data: prepared.transaction.data as Hex, value: 0n }));
    await service.admit(vault.account.address, vault.agent.vault, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'vault-lifecycle-admit');
    return prepared;
  }
  async function read<T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> {
    // REASON: The dynamic ABI comes from actual Solidity compilation; acceptance assertions narrow its outputs.
    return await bridge.public.readContract({ address, abi: local.artifact(name).abi, functionName, args }) as T;
  }
  it('binds the actual human owner, imports fee-inclusive Selection burn exactly once and rejects a lost later Vault sync after restart', async () => {
    await setup(); const owner = local.accounts.owner.address, agent = vault.account.address;
    await expect(lifecycle.agents.register(local.accounts.outsider.address, { agent })).rejects.toMatchObject({ status: 404 });
    await expect(lifecycle.agents.register(owner, { agent: local.accounts.outsider.address })).rejects.toMatchObject({ status: 404 });
    expect(await store.db.select().from(agents)).toHaveLength(0); expect(await store.db.select().from(agentVaultBindings)).toHaveLength(0);
    const prepared = await prepare();
    await expect(lifecycle.agents.register(owner, { agent: vault.agent.vault, runId: prepared.quote.runId }))
      .rejects.toMatchObject({ code: 'agent_reservation_invalid' });
    const registered = await lifecycle.agents.register(owner, { agent, runId: prepared.quote.runId });
    expect(registered.agent.owner).toBe(owner.toLowerCase()); expect(registered.agent.agent).toBe(agent.toLowerCase());
    expect((await store.db.select().from(agentVaultBindings))[0]).toMatchObject({ owner: owner.toLowerCase(), agent: agent.toLowerCase(),
      vault: vault.agent.vault.toLowerCase(), agentId: vault.agentId });
    expect((await lifecycle.agents.evaluate(owner, agent)).balance).toBe((1_000_000n - BigInt(prepared.ceiling)).toString());
    await runtime.drain(); const pending = await runtime.get(vault.agent.vault, prepared.quote.runId);
    if (!pending.settlement) throw new Error('Actual CPU outcome missing');
    expect(pending.result?.output).toBe('42');
    const closed = BigInt((Math.floor(pending.settlement.endedAt / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 });
    vi.spyOn(Date, 'now').mockReturnValue((Number(closed) + 60) * 1000);
    const unavailableSync = vi.spyOn(vaults, 'syncRun').mockRejectedValue(new Error('Temporary actual Vault sync outage'));
    await runtime.drain();
    expect((await runtime.get(vault.agent.vault, prepared.quote.runId)).status).toBe('completed');
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    expect(await store.db.select().from(agentBilling)).toHaveLength(0);
    unavailableSync.mockRestore();
    let beforeSync: Hex | undefined;
    const realSync = vaults.syncRun.bind(vaults);
    vi.spyOn(vaults, 'syncRun').mockImplementation(async (binding, runId) => {
      beforeSync = await local.test.snapshot(); return realSync(binding, runId);
    });
    await runtime.drain(); const done = await runtime.get(vault.agent.vault, prepared.quote.runId);
    expect(done.status).toBe('completed'); expect(BigInt(done.charged ?? '0')).toBeGreaterThan(0n);
    const evaluated = await lifecycle.agents.evaluate(owner, agent);
    expect(evaluated.trailing24hBurn).toBe(done.charged);
    expect(evaluated.balance).toBe((1_000_000n - BigInt(done.charged!)).toString());
    expect(await read(vault.agent.vault, 'PlatformAgentVault', 'finalizedRun', [prepared.quote.runId])).toBe(true);
    expect((await read<{ lifetimeBurn: bigint }>(vault.registryAddress, 'PlatformSelectionRegistry', 'getAgent', [vault.agentId])).lifetimeBurn.toString()).toBe(done.charged);
    const [entry] = await store.db.select().from(agentBilling), [proof] = await store.db.select().from(agentBillingProvenance);
    expect(entry?.owner).toBe(owner.toLowerCase()); expect(entry?.agent).toBe(agent.toLowerCase());
    const run = await bridge.run(prepared.quote.runId);
    expect(entry?.settledAt.getTime()).toBe(Number(run.openedAt + run.billableSeconds) * 1000);
    const [storedRun] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, prepared.quote.runId));
    expect(proof?.transactionHash).toBe(storedRun?.vaultSyncTx);
    expect(BigInt(proof!.blockNumber)).toBeGreaterThan((await bridge.canonicalReceipt(bytes32Schema.parse(storedRun!.settlementTx))).blockNumber);
    await lifecycle.maintain(); expect(await store.db.select().from(agentBilling)).toHaveLength(1);
    const originalAnchor = await store.db.select().from(agentBillingAnchors);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild();
    await cysts.initialize(); await lifecycle.initialize(); await runtime.initialize();
    expect((await lifecycle.agents.evaluate(owner, agent)).trailing24hBurn).toBe(done.charged);
    await expect(createAgentRuntimeBinding(store.db, { protocol: 'platform', chainId: 31337,
      escrow: local.pins.escrowAddress, token: local.pins.tokenAddress }).ensureReady()).rejects.toThrow('different reviewed runtime');
    await expect(createAgentRuntimeBinding(store.db, { protocol: 'platform_vault', chainId: 31337,
      escrow: local.pins.escrowAddress, token: local.pins.tokenAddress,
      vaultProfileHash: hashJson({ ...vault.pins, implementationCodeHash: `0x${'1'.repeat(64)}` }) }).ensureReady()).rejects.toThrow('different reviewed runtime');
    if (!beforeSync) throw new Error('Real Vault sync branch point missing');
    await local.test.revert({ id: beforeSync });
    expect((await bridge.run(prepared.quote.runId)).status).toBe(2);
    expect(await read(vault.agent.vault, 'PlatformAgentVault', 'finalizedRun', [prepared.quote.runId])).toBe(false);
    vi.mocked(Date.now).mockReturnValue((Number(closed) + 2 * 86_400) * 1000);
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    expect(await store.db.select().from(agentBillingAnchors)).toEqual(originalAnchor);
    vi.spyOn(vaults, 'forAgent').mockRejectedValue(new Error('Actual policy reader unavailable'));
    const state = await lifecycle.agents.get(owner, agent);
    const killed = await lifecycle.agents.plan(owner, agent, { action: 'kill', expectedVersion: state.agent.version }, 'owner-vault-kill');
    expect(killed.evaluation).toBeNull(); expect(killed.agent.killedAt).not.toBeNull();
    expect(vaults.forAgent).not.toHaveBeenCalled();
  }, 75_000);
  it('evaluates each owner agent against its own Vault and never the pooled EOA escrow balance', async () => {
    await setup(); const owner = local.accounts.owner.address, first = vault.account.address, second = local.accounts.host.address;
    // The same reviewed registry creates a second independent owner Vault with a smaller endowment.
    const identity = await read<Address>(vault.registryAddress, 'PlatformSelectionRegistry', 'identityRegistry');
    await local.confirmed(local.owner.writeContract({ address: identity, abi: local.artifact('PlatformRuntimeIdentityFixture').abi,
      functionName: 'register', args: [2n, owner] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: local.artifact('MockToken').abi,
      functionName: 'faucet', args: [owner, 200_100n] }));
    await local.confirmed(local.owner.writeContract({ address: vault.registryAddress, abi: local.artifact('PlatformSelectionRegistry').abi,
      functionName: 'enter', args: [{ identityId: 2n, agentWallet: second, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
        expiry: BigInt(await bridge.now() + 86_400), cystHash: `0x${'2'.repeat(64)}`, endowment: 200_000n,
        scope: { classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}` } }] }));
    await lifecycle.agents.register(owner, { agent: first }); await lifecycle.agents.register(owner, { agent: second });
    expect((await lifecycle.agents.evaluate(owner, first)).balance).toBe('1000000');
    expect((await lifecycle.agents.evaluate(owner, second)).balance).toBe('200000');
    await local.confirmed(local.owner.writeContract({ address: vault.agent.vault, abi: local.artifact('PlatformAgentVault').abi,
      functionName: 'ownerWithdraw', args: [1_000_000n] }));
    expect(await lifecycle.agents.evaluate(owner, first)).toMatchObject({ balance: '0', mode: 'cyst' });
    expect(await lifecycle.agents.evaluate(owner, second)).toMatchObject({ balance: '200000', mode: 'full' });
    expect((await bridge.balance(owner)).available).toBe('1000000');
    await expect(lifecycle.agents.get(vault.account.address, first)).rejects.toMatchObject({ code: 'agent_not_found' });
    const [binding] = await store.db.select().from(agentVaultBindings).where(eq(agentVaultBindings.agent, first.toLowerCase()));
    await store.db.update(agentVaultBindings).set({ vault: local.accounts.outsider.address.toLowerCase() }).where(eq(agentVaultBindings.agent, first.toLowerCase()));
    await expect(lifecycle.agents.evaluate(owner, first)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    await store.db.update(agentVaultBindings).set({ vault: binding!.vault }).where(eq(agentVaultBindings.agent, first.toLowerCase()));
    expect((await lifecycle.agents.evaluate(owner, second)).balance).toBe('200000');
  }, 40_000);
  it('rolls back the owner agent row when its authoritative Vault binding cannot be persisted, then retries cleanly', async () => {
    await setup(); const owner = local.accounts.owner.address, agent = vault.account.address;
    // This fixed test-only trigger represents a database failure after the agent INSERT but before binding persistence.
    await store.db.execute(sql.raw(`CREATE FUNCTION fixture_reject_vault_binding() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fixture binding storage failure'; END; $$ LANGUAGE plpgsql`));
    await store.db.execute(sql.raw(`CREATE TRIGGER fixture_reject_vault_binding BEFORE INSERT ON agent_vault_bindings
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_vault_binding()`));
    await expect(lifecycle.agents.register(owner, { agent })).rejects.toMatchObject({ cause: { message: 'fixture binding storage failure' } });
    expect(await store.db.select().from(agents)).toHaveLength(0);
    expect(await store.db.select().from(agentVaultBindings)).toHaveLength(0);
    await store.db.execute(sql.raw('DROP TRIGGER fixture_reject_vault_binding ON agent_vault_bindings'));
    await store.db.execute(sql.raw('DROP FUNCTION fixture_reject_vault_binding()'));
    const registered = await lifecycle.agents.register(owner, { agent });
    expect(registered.replayed).toBe(false); expect(await store.db.select().from(agentVaultBindings)).toHaveLength(1);
    expect((await lifecycle.agents.evaluate(owner, agent)).balance).toBe('1000000');
  }, 35_000);
});
