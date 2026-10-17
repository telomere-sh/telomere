import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestClient, createWalletClient, http, keccak256, maxUint256, parseEther, toHex,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain, unusedLocalPort } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/index.js';
import { Problem } from '../src/common.js';
import { loadConfig, type Config } from '../src/config.js';
import { startPilot } from '../src/main.js';
import { erc1967ImplementationSlot } from '../src/selection/reputation-deployment.js';
import { SelectionReputationPublisher } from '../src/selection/reputation-publisher.js';
import { createSelectionReader } from '../src/selection/rpc.js';
import { compileSelectionReputationPublisherFixture,
  type ReputationPublisherFixtureArtifact } from './selection-reputation-publisher-fixture.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Pilot = Awaited<ReturnType<typeof startPilot>>;
const id = (value: string): Hex => keccak256(toHex(value));

describe('actual startPilot opt-in Selection reputation publication', () => {
  let artifacts: Record<string, ReputationPublisherFixtureArtifact>;
  let local: Awaited<ReturnType<typeof startLocalChain>> | undefined;
  let pilot: Pilot | undefined;
  let root: string | undefined;

  beforeAll(() => { artifacts = compileSelectionReputationPublisherFixture(); }, 90_000);
  afterAll(async () => {
    await pilot?.close();
    await local?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-reputation-main-')) {
        throw new Error('Unexpected reputation integration directory');
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it('publishes through pinned ERC-1967 proxies only when enabled, fails closed on incomplete pins and upgrades', async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-reputation-main-'));
    local = await startLocalChain();
    const chain = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    const ownerKey = generatePrivateKey(), controllerKey = generatePrivateKey(), publisherKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerKey), controller = privateKeyToAccount(controllerKey),
      publisher = privateKeyToAccount(publisherKey), guardian = privateKeyToAccount(generatePrivateKey()),
      payer = privateKeyToAccount(generatePrivateKey()), agentWallet = privateKeyToAccount(generatePrivateKey()),
      treasury = privateKeyToAccount(generatePrivateKey());
    for (const account of [owner, controller, publisher, guardian, payer, agentWallet, treasury]) {
      await chain.setBalance({ address: account.address, value: parseEther('10') });
    }
    const artifact = (name: string) => {
      const value = artifacts[name]; if (!value) throw new Error('Missing compiled reputation fixture'); return value;
    };
    const wallet = (account: Account) => createWalletClient({ account, chain: localChain, transport: http(local!.rpcUrl) });
    const deploy = async (name: string, args: readonly unknown[] = []) => {
      const value = artifact(name);
      const receipt = await local!.publicClient.waitForTransactionReceipt({ hash: await wallet(owner).deployContract({
        abi: value.abi, bytecode: value.bytecode, args,
      }) });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Local reputation fixture deployment failed');
      return receipt;
    };
    const write = async (address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner) => {
      const receipt = await local!.publicClient.waitForTransactionReceipt({ hash: await wallet(account).writeContract({
        address, abi: artifact(name).abi, functionName, args,
      }) });
      if (receipt.status !== 'success') throw new Error('Local reputation fixture transaction reverted');
      return receipt;
    };
    const read = (address: Address, name: string, functionName: string, args: readonly unknown[] = []) =>
      local!.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });

    const token = (await deploy('MockToken')).contractAddress!;
    const escrow = (await deploy('TelomereRunEscrow', [token, controller.address, controller.address, treasury.address])).contractAddress!;
    const identityImplementation = (await deploy('PublisherIdentityFixture')).contractAddress!;
    const identity = (await deploy('Publisher1967ProxyFixture', [identityImplementation])).contractAddress!;
    const reputationImplementation = (await deploy('PublisherReputationFixture', [identity])).contractAddress!;
    const reputation = (await deploy('Publisher1967ProxyFixture', [reputationImplementation])).contractAddress!;
    expect((await local.publicClient.getStorageAt({ address: identity, slot: erc1967ImplementationSlot }))?.slice(-40).toLowerCase())
      .toBe(identityImplementation.slice(2).toLowerCase());
    expect((await local.publicClient.getStorageAt({ address: reputation, slot: erc1967ImplementationSlot }))?.slice(-40).toLowerCase())
      .toBe(reputationImplementation.slice(2).toLowerCase());
    const grace = (await deploy('PublisherGraceFixture')).contractAddress!;
    const registryReceipt = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address,
      guardian: guardian.address, identityRegistry: identity, staking: grace, treasury: treasury.address,
      entryFee: 100n, vaultFloor: 1000n }]);
    const registry = registryReceipt.contractAddress!;
    await write(token, 'MockToken', 'faucet', [owner.address, 100_000_000n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256]);
    await write(identity, 'PublisherIdentityFixture', 'register', [1n, owner.address]);
    const reader = createSelectionReader(local.rpcUrl), port = await unusedLocalPort();
    const base = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: local.rpcUrl, DATA_DIR: join(root, 'database'),
      ESCROW_ADDRESS: escrow, TOKEN_ADDRESS: token, SIGNER_PRIVATE_KEY: controllerKey, DEMO_PRIVATE_KEY: ownerKey,
      HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, CPU_MODE: 'demo',
      LOG_LEVEL: 'error', SELECTION_ENABLED: 'true', SELECTION_REGISTRY_ADDRESS: registry,
      SELECTION_CODE_HASH: await reader.codeHash(registry), SELECTION_START_BLOCK: registryReceipt.blockNumber.toString(),
      SELECTION_CONFIRMATIONS: '0' });
    const publisherKeyFile = join(root, 'publisher.key'), publisherConfigFile = join(root, 'publisher.json');
    const incompleteConfigFile = join(root, 'publisher-incomplete.json');
    await writeFile(publisherKeyFile, publisherKey, { mode: 0o600 });
    const target = { reviewed: true, deploymentKind: 'erc1967', chainId: 31337,
      identityAddress: identity, identityCodeHash: await reader.codeHash(identity), reputationAddress: reputation,
      reputationCodeHash: await reader.codeHash(reputation), publisherAddress: publisher.address,
      identityImplementationAddress: identityImplementation,
      identityImplementationCodeHash: await reader.codeHash(identityImplementation),
      reputationImplementationAddress: reputationImplementation,
      reputationImplementationCodeHash: await reader.codeHash(reputationImplementation) } as const;
    await writeFile(publisherConfigFile, JSON.stringify({ authorised: true, profile: target,
      signerKeyFile: publisherKeyFile, confirmations: 0 }), { mode: 0o600 });
    const { reputationImplementationCodeHash: _omitted, ...incomplete } = target;
    await writeFile(incompleteConfigFile, JSON.stringify({ authorised: true, profile: incomplete,
      signerKeyFile: publisherKeyFile, confirmations: 0 }), { mode: 0o600 });
    const enabled: Config = { ...base, REPUTATION_PUBLISHER_CONFIG: publisherConfigFile };

    pilot = await startPilot(base);
    await pilot.platform.maintain();
    expect(pilot.reputationPublisher).toBeUndefined();
    expect((await pilot.app.request('/health/ready')).status).toBe(200);
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(0n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(0);
    const now = (await local.publicClient.getBlock()).timestamp;
    await write(registry, 'SelectionRegistry', 'enter', [{ identityId: 1n, agentWallet: agentWallet.address,
      maxPerHour: 20_000_000n, maxPerDay: 200_000_000n, expiry: now + 100n * 86400n,
      cystHash: id('owner-private-checkpoint'), endowment: 1_000_000n }]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [1n]) as Hex;
    // REASON: the deployed fixture ABI supplies the registered agent's Vault address.
    const agent = await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as { vault: Address };
    const balance = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (balance) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [balance]);
    await chain.increaseTime({ seconds: 86401 }); await chain.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDormant', [agentId], payer);
    await chain.increaseTime({ seconds: 30 * 86400 + 1 }); await chain.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDeath', [agentId], payer);

    // The default-off controller indexes the actual death but cannot broadcast feedback.
    await pilot.platform.maintain();
    expect((await pilot.platform.selectionReputation!.death(agentId)).summary.agentId).toBe(agentId);
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(0n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(0);
    await pilot.close(); pilot = undefined;

    await expect(startPilot({ ...base, REPUTATION_PUBLISHER_CONFIG: incompleteConfigFile }))
      .rejects.toThrow('Reputation publisher configuration');
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(0);

    let releaseFirstPublisher!: () => void;
    const firstPublisher = new Promise<void>(resolve => { releaseFirstPublisher = resolve; });
    const originalMaintain = SelectionReputationPublisher.prototype.maintain;
    let firstCall = true;
    const heldMaintain = vi.spyOn(SelectionReputationPublisher.prototype, 'maintain').mockImplementation(async function (this: SelectionReputationPublisher) {
      if (firstCall) { firstCall = false; await firstPublisher; }
      return originalMaintain.call(this);
    });
    try {
      pilot = await startPilot(enabled);
      const pending = await pilot.app.request('/health/ready');
      expect(pending.status).toBe(503);
      expect(await pending.json()).toEqual({ status: 'unavailable', publisher: { state: 'pending' } });
    } finally { releaseFirstPublisher(); heldMaintain.mockRestore(); }
    await pilot!.platform.maintain();
    expect(pilot.reputationPublisher).toBeDefined();
    expect((await pilot.app.request('/health/ready')).status).toBe(200);
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(1);
    expect((await pilot.reputationPublisher!.status()).publications).toMatchObject([{
      state: 'published', feedbackIndex: '1', transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    }]);
    const failedSelection = vi.spyOn(pilot.platform.selection!, 'sync')
      .mockRejectedValue(new Problem(503, 'selection_index_unavailable', 'private index detail'));
    try {
      await expect(pilot.platform.maintain()).rejects.toMatchObject({ code: 'selection_index_unavailable' });
      const unhealthyIndex = await pilot.app.request('/health/ready');
      expect(unhealthyIndex.status).toBe(503);
      expect(await unhealthyIndex.json()).toEqual({ status: 'unavailable', publisher: {
        state: 'unavailable', code: 'selection_index_unavailable',
      } });
    } finally { failedSelection.mockRestore(); }
    await pilot.platform.maintain();
    expect((await pilot.app.request('/health/ready')).status).toBe(200);
    const failedReceipts = vi.spyOn(pilot.platform.receipts, 'seal').mockRejectedValueOnce(new Error('receipt-only failure'));
    try { await expect(pilot.platform.maintain()).rejects.toThrow('receipt-only failure'); }
    finally { failedReceipts.mockRestore(); }
    expect((await pilot.app.request('/health/ready')).status).toBe(200);
    await pilot.platform.maintain();
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(1);
    await pilot.close(); pilot = undefined;
    pilot = await startPilot(enabled);
    await pilot.platform.maintain();
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(1);
    const changedImplementation = (await deploy('PublisherReputationFixtureV2', [identity])).contractAddress!;
    await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [changedImplementation]);
    expect(await reader.codeHash(reputation)).toBe(target.reputationCodeHash);
    await expect(pilot.platform.maintain()).rejects.toMatchObject({
      code: 'selection_reputation_publication_unavailable',
    });
    const unhealthy = await pilot.app.request('/health/ready');
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toEqual({ status: 'unavailable', publisher: {
      state: 'unavailable', code: 'selection_reputation_publication_unavailable',
    } });
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(1);
    await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationImplementation]);
    await pilot.platform.maintain();
    expect((await pilot.app.request('/health/ready')).status).toBe(200);
    expect(await local.publicClient.getTransactionCount({ address: publisher.address })).toBe(1);
  }, 120_000);
});
