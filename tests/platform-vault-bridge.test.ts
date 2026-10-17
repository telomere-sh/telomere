import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { compileContracts } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { platformEscrowAbi, PLATFORM_ZERO, typedPlatformQuote, typedPlatformSettlement, type PlatformQuote } from '../src/platform-runtime/types.js';
import { PlatformVaultBridge, platformVaultBindingSchema, type PlatformVaultBinding } from '../src/platform-runtime/vault.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

async function fixture() {
  const artifacts = compileContracts(); artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(keccak256(toHex('vault-adapter-host')), artifacts);
  try {
    const child = await deployPlatformVault(local);
    const read = async <T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> => {
      // REASON: fixture calls use the ABI of the real deployed contract.
      return await local.local.publicClient.readContract({ address, abi: local.artifact(name).abi, functionName, args }) as T;
    };
    const write = (address: Address, name: string, functionName: string, args: readonly unknown[] = []) =>
      local.confirmed(local.owner.writeContract({ address, abi: local.artifact(name).abi, functionName, args }));
    return { ...local, vaultConfig: child.pins, vault: child.agent.vault, leashId: child.agent.leashId,
      agentId: child.agentId, agent: child.wallet, agentAccount: child.account, guardianWallet: child.guardianWallet, read, write };
  } catch (error) { await local.close(); throw error; }
}

describe('reviewed Platform Vault adapter authorization and canonical financial synchronization', () => {
  let deployed: Awaited<ReturnType<typeof fixture>>, snapshot: Hex;
  let store: Awaited<ReturnType<typeof openStore>>, bridge: PlatformBridge, vault: PlatformVaultBridge, binding: PlatformVaultBinding;
  const id = (label: string) => keccak256(toHex(label));
  beforeAll(async () => {
    deployed = await fixture();
    snapshot = await deployed.test.snapshot();
  }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: deployed.pins, rpcUrl: deployed.local.rpcUrl, signerPrivateKey: deployed.keys.signer });
    vault = new PlatformVaultBridge(bridge, deployed.vaultConfig);
    binding = await vault.authorize(deployed.agentAccount.address, deployed.vault, 'run');
  });
  afterEach(async () => { await store?.close(); });
  afterAll(async () => { await deployed?.close(); });
  async function prepare(): Promise<{ quote: PlatformQuote; signature: Hex; ceiling: string }> {
    const quote: PlatformQuote = { runId: randomId(), leashId: binding.leashId, hostId: deployed.hostId, payer: binding.vault,
      hwClass: 0, regionHash: id('local'), imageHash: id('image'), workloadHash: id('work'), maxSeconds: 10,
      pricePerSecond: '100', inferencePrice: '0', quoteExpiry: await bridge.now() + 300 };
    return { quote, signature: await bridge.signQuote(quote), ceiling: (await bridge.ceiling(quote, false)).toString() };
  }
  async function open() {
    const prepared = await prepare(), plan = vault.openPlan(binding, prepared.quote, prepared.signature, [], []);
    const receipt = await deployed.confirmed(deployed.agent.sendTransaction({ to: plan.to, data: plan.data, value: 0n }));
    return { ...prepared, receipt };
  }
  async function settle(quote: PlatformQuote) {
    const opened = await bridge.run(quote.runId);
    await deployed.test.setNextBlockTimestamp({ timestamp: opened.openedAt + 3n }); await deployed.test.mine({ blocks: 1 });
    const settlement = { runId: quote.runId, billableSeconds: 3, endedAt: await bridge.now(), inferenceCharge: '0' as const,
      receiptHash: randomId() }, hour = Math.floor(await bridge.now() / 3600);
    const leaf = await bridge.public.readContract({ address: deployed.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'receiptLeaf', args: [typedPlatformSettlement(settlement)] });
    await deployed.test.setNextBlockTimestamp({ timestamp: BigInt((hour + 1) * 3600) }); await deployed.test.mine({ blocks: 1 });
    await deployed.confirmed(bridge.wallet.writeContract({ address: deployed.pins.receiptRootAddress, abi: deployed.artifact('ReceiptRoot').abi,
      functionName: 'postRoot', args: [BigInt(hour), leaf, 1] }));
    await deployed.write(deployed.pins.escrowAddress, 'PlatformRunEscrow', 'settleRun', [typedPlatformSettlement(settlement), BigInt(hour), []]);
    return settlement;
  }
  async function refund(quote: PlatformQuote) {
    const at = await bridge.public.readContract({ address: deployed.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'refundAt', args: [quote.runId] });
    await deployed.test.setNextBlockTimestamp({ timestamp: at + 1n }); await deployed.test.mine({ blocks: 1 });
    const plan = vault.refundPlan(binding, quote.runId);
    return deployed.confirmed(deployed.owner.sendTransaction({ to: plan.to, data: plan.data, value: 0n }));
  }
  async function lifetimeBurn() {
    const agent = await deployed.read<{ lifetimeBurn: bigint }>(deployed.vaultConfig.registryAddress, 'PlatformSelectionRegistry', 'getAgent', [binding.agentId]);
    return agent.lifetimeBurn;
  }
  it('binds the actual factory clone, human owner, agent wallet and Vault-owned scoped Leash', async () => {
    expect(binding).toEqual({ vault: deployed.vault, owner: deployed.accounts.owner.address, agentWallet: deployed.agentAccount.address,
      agentId: deployed.agentId, leashId: deployed.leashId });
    expect(await vault.authorize(deployed.accounts.owner.address, deployed.vault, 'owner')).toEqual(binding);
    expect(await vault.authorize(deployed.accounts.owner.address, deployed.vault, 'read')).toEqual(binding);
    await expect(vault.authorize(deployed.accounts.owner.address, deployed.vault, 'run')).rejects.toMatchObject({ status: 404 });
    await expect(vault.authorize(deployed.accounts.host.address, deployed.vault, 'read')).rejects.toMatchObject({ status: 404 });
    await expect(vault.authorize(deployed.agentAccount.address, deployed.vaultConfig.implementationAddress, 'read')).rejects.toMatchObject({ status: 404 });
    expect(await vault.runnable(binding)).toBe(true); expect(await vault.balance(binding.vault)).toEqual({ available: '1000000' });
    expect(() => platformVaultBindingSchema.parse({ ...binding, agentId: 'bad' })).toThrow();
  });
  it('rejects replaced reviewed code and an unregistered byte-identical proxy', async () => {
    const wrong = new PlatformVaultBridge(bridge, { ...deployed.vaultConfig, registryCodeHash: PLATFORM_ZERO });
    await expect(wrong.check()).rejects.toThrow('code pin');
    await expect(new PlatformVaultBridge(bridge, { ...deployed.vaultConfig, implementationCodeHash: PLATFORM_ZERO }).check()).rejects.toThrow('code pin');
    const code = await bridge.public.getCode({ address: binding.vault }); if (!code) throw new Error('Missing clone');
    await deployed.test.setCode({ address: deployed.accounts.host.address, bytecode: code });
    await expect(vault.authorize(deployed.accounts.owner.address, deployed.accounts.host.address, 'read')).rejects.toMatchObject({ status: 404 });
    await deployed.test.setCode({ address: deployed.vaultConfig.implementationAddress, bytecode: '0x00' });
    await expect(vault.checkBinding(binding)).rejects.toThrow('code pin');
  });
  it('rejects a stored principal or Leash substitution before signer mutation', async () => {
    await expect(vault.checkBinding({ ...binding, agentWallet: deployed.accounts.host.address })).rejects.toThrow('binding changed');
    await expect(vault.syncRun({ ...binding, leashId: randomId() }, randomId())).rejects.toThrow('binding changed');
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
  });
  it('keeps cleanup/read access after guardian freeze and owner Leash kill while denying new runs', async () => {
    await deployed.confirmed(deployed.guardianWallet.writeContract({ address: deployed.vaultConfig.registryAddress,
      abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'setFrozen', args: [binding.agentId, true, 'test policy', id('evidence')] }));
    expect(await vault.runnable(binding)).toBe(false);
    await expect(vault.authorize(binding.agentWallet, binding.vault, 'run')).rejects.toMatchObject({ status: 409 });
    expect(await vault.authorize(binding.owner, binding.vault, 'read')).toEqual(binding);
    await deployed.write(binding.vault, 'PlatformAgentVault', 'killLeash'); await expect(vault.checkBinding(binding)).resolves.toBeUndefined();
    expect(await vault.runnable(binding)).toBe(false);
  });
  it('admits only the byte-exact agent payRun with both escrow and Vault reservation events', async () => {
    const prepared = await open();
    await expect(vault.verifyAdmission(binding, prepared.quote, prepared.ceiling, prepared.receipt.transactionHash, prepared.signature, [], [])).resolves.toBeUndefined();
    expect(await vault.balance(binding.vault)).toEqual({ available: '998910' });
    await expect(vault.verifyAdmission(binding, prepared.quote, '1000', prepared.receipt.transactionHash, prepared.signature, [], [])).rejects.toThrow('reservation differs');
    await expect(vault.verifyAdmission(binding, prepared.quote, prepared.ceiling, prepared.receipt.transactionHash, prepared.signature, [randomId()], [])).rejects.toThrow('outer transaction differs');
    expect(() => vault.openPlan(binding, { ...prepared.quote, payer: binding.owner }, prepared.signature, [], [])).toThrow('binding differs');
  });
  it('refuses a successful controller payRun as an external agent admission', async () => {
    const prepared = await prepare();
    const receipt = await deployed.confirmed(bridge.wallet.writeContract({ address: binding.vault,
      abi: deployed.artifact('PlatformAgentVault').abi, functionName: 'payRun', args: [typedPlatformQuote(prepared.quote), prepared.signature, [], []] }));
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
    await expect(vault.verifyAdmission(binding, prepared.quote, prepared.ceiling, receipt.transactionHash, prepared.signature, [], [])).rejects.toThrow('outer transaction differs');
  });
  it('refuses ABI trailing calldata even when the Vault successfully accepts the underlying call', async () => {
    const prepared = await prepare(), plan = vault.openPlan(binding, prepared.quote, prepared.signature, [], []);
    const data: Hex = `${plan.data}${'00'.repeat(32)}`;
    const receipt = await deployed.confirmed(deployed.agent.sendTransaction({ to: plan.to, data, value: 0n }));
    await expect(vault.verifyAdmission(binding, prepared.quote, prepared.ceiling, receipt.transactionHash, prepared.signature, [], [])).rejects.toThrow('outer transaction differs');
  });
  it('targets stop at the Vault owner path and a permissionless deadline refund at escrow', async () => {
    const prepared = await open(), plan = vault.stopPlan(binding, prepared.quote.runId);
    const hash = await deployed.confirmed(deployed.owner.sendTransaction({ to: plan.to, data: plan.data, value: 0n }));
    expect(hash.to?.toLowerCase()).toBe(binding.vault.toLowerCase());
    expect((await bridge.run(prepared.quote.runId)).stopAt).toBeGreaterThan(0n);
    const refunded = await refund(prepared.quote); expect(refunded.to?.toLowerCase()).toBe(deployed.pins.escrowAddress.toLowerCase());
    const finalized = await vault.syncRun(binding, prepared.quote.runId);
    expect(finalized).toMatchObject({ charged: '0', refunded: true });
    expect(await vault.balance(binding.vault)).toEqual({ available: '1000000' }); expect(await lifetimeBurn()).toBe(0n);
  });
  it('synchronizes actual fee-inclusive settlement through the durable signer exactly once', async () => {
    const prepared = await open(); await settle(prepared.quote);
    const first = await vault.syncRun(binding, prepared.quote.runId), second = await vault.syncRun(binding, prepared.quote.runId);
    expect(first).toEqual(second); expect(first).toMatchObject({ charged: '327', refunded: false });
    expect(await vault.verifyFinalized(binding, prepared.quote.runId, first.transactionHash)).toEqual(first);
    expect(await lifetimeBurn()).toBe(327n); expect(await vault.balance(binding.vault)).toEqual({ available: '999673' });
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(1);
  });
  it('reconciles a third-party sync from canonical events without producing another signer intent', async () => {
    const prepared = await open(); await settle(prepared.quote);
    const thirdParty = await deployed.write(binding.vault, 'PlatformAgentVault', 'syncRun', [prepared.quote.runId]);
    expect(await vault.syncRun(binding, prepared.quote.runId)).toEqual({ transactionHash: thirdParty.transactionHash, charged: '327', refunded: false });
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0); expect(await lifetimeBurn()).toBe(327n);
  });
  it('reconciles multiple recent third-party finalizations using the latest uncached canonical block', async () => {
    for (let index = 0; index < 2; index++) {
      const prepared = await open(); await settle(prepared.quote);
      const thirdParty = await deployed.write(binding.vault, 'PlatformAgentVault', 'syncRun', [prepared.quote.runId]);
      expect((await vault.syncRun(binding, prepared.quote.runId)).transactionHash).toBe(thirdParty.transactionHash);
    }
    expect(await lifetimeBurn()).toBe(654n); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
  });
  it('rejects unrelated sync evidence and refuses open/untracked reservations', async () => {
    const prepared = await open(); await expect(vault.syncRun(binding, prepared.quote.runId)).rejects.toMatchObject({ status: 409 });
    await settle(prepared.quote); await vault.syncRun(binding, prepared.quote.runId);
    const unrelated = await deployed.confirmed(deployed.owner.sendTransaction({ to: binding.owner, value: 0n }));
    await expect(vault.verifyFinalized(binding, prepared.quote.runId, unrelated.transactionHash)).rejects.toThrow('financial evidence differs');
    await expect(vault.syncRun(binding, randomId())).rejects.toMatchObject({ status: 409 });
  });
  it('revalidates an orphaned sync and replays the same journaled bytes after reorg without duplicate burn', async () => {
    const prepared = await open(); await settle(prepared.quote); const beforeSync = await deployed.test.snapshot();
    const first = await vault.syncRun(binding, prepared.quote.runId);
    const [original] = await store.db.select().from(platformTransactionJournal); expect(original).toBeDefined();
    await deployed.test.revert({ id: beforeSync }); await deployed.test.mine({ blocks: 1 });
    await expect(vault.verifyFinalized(binding, prepared.quote.runId, first.transactionHash)).rejects.toThrow();
    const repeated = await vault.syncRun(binding, prepared.quote.runId);
    expect(repeated).toEqual(first); expect(await lifetimeBurn()).toBe(327n);
    expect(await store.db.select().from(platformTransactionJournal)).toEqual([original]);
  });
  it('checks the exact factory/implementation relationships rather than trusting only supplied code hashes', async () => {
    const code = await bridge.public.getCode({ address: deployed.pins.escrowAddress }); if (!code) throw new Error('No escrow code');
    const wrong = new PlatformVaultBridge(bridge, { ...deployed.vaultConfig, implementationAddress: deployed.pins.escrowAddress, implementationCodeHash: keccak256(code) });
    await expect(wrong.check()).rejects.toThrow();
  });
});
