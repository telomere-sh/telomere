import { compileSelectionReputationPublisherFixture, type ReputationPublisherFixtureArtifact } from './selection-reputation-publisher-fixture.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestClient, createWalletClient, http, keccak256, maxUint256, parseEther, toHex,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/index.js';
import { openStore } from '../src/store.js';
import { PlatformTransactions } from '../src/platform-runtime/transactions.js';
import { platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { SelectionIndexer, type SelectionIndexProfile } from '../src/selection/indexer.js';
import { createSelectionReader } from '../src/selection/rpc.js';
import { SelectionReputation } from '../src/selection/reputation.js';
import type { SelectionReputationTargetProfile } from '../src/selection/reputation-feedback.js';
import { SelectionReputationPublisher, selectionReputationPublisherAbi } from '../src/selection/reputation-publisher.js';
import { selectionReputationPublications } from '../src/selection/reputation-publisher-schema.js';
import { configuredSelectionReputationPublisher } from '../src/selection/reputation-publisher-configured.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Artifact = ReputationPublisherFixtureArtifact;
type Agent = { owner: Address; vault: Address; leashId: Hex };
const id = (value: string): Hex => keccak256(toHex(value));
describe('durable canonical Selection ERC-8004 death publication', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, chain: ReturnType<typeof createTestClient>, artifacts: Record<string, Artifact>;
  let owner: Account, controller: Account, guardian: Account, payer: Account, agentKey: Account, treasury: Account, publisher: Account, publisherSecret: Hex;
  let token: Address, escrow: Address, registry: Address, identity: Address, reputation: Address, deployment: bigint, baseline: Hex;
  let identityImplementation: Address, reputationImplementation: Address, identityUpgrade: Address, reputationUpgrade: Address;
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, indexer: SelectionIndexer, feed: SelectionReputation;
  let profile: SelectionIndexProfile, target: SelectionReputationTargetProfile;
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error('Missing fixture artifact'); return value; };
  async function deploy(name: string, args: readonly unknown[] = []) {
    const wallet = createWalletClient({ account: owner, chain: localChain, transport: http(local.rpcUrl) }), value = artifact(name);
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: value.abi, bytecode: value.bytecode, args }) });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Fixture deployment failed'); return receipt;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner) {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) })
      .writeContract({ address, abi: artifact(name).abi, functionName, args }) });
    if (receipt.status !== 'success') throw new Error('Fixture transaction reverted'); return receipt;
  }
  async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []) {
    return local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  }
  const now = async () => (await local.publicClient.getBlock()).timestamp;
  async function advance(seconds: number) { await chain.increaseTime({ seconds }); await chain.mine({ blocks: 1 }); }
  async function enter(identityId = 1n, agentWallet = agentKey.address) {
    await write(registry, 'SelectionRegistry', 'enter', [{ identityId, agentWallet, maxPerHour: 20_000_000n,
      maxPerDay: 200_000_000n, expiry: await now() + 100n * 86400n, cystHash: id('encrypted-private-state'), endowment: 1_000_000n }]);
    // REASON: these reads use the locally compiled concrete registry ABI and successfully deployed fixture.
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [identityId]) as Hex;
    return { agentId, ...await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Agent };
  }
  async function fund(agent: Agent, amount: bigint) {
    await write(token, 'MockToken', 'approve', [agent.vault, amount], payer);
    await write(agent.vault, 'AgentVault', 'receiveFunds', [amount, id('private-payment')], payer);
  }
  async function kill(agent: Awaited<ReturnType<typeof enter>>) {
    // REASON: the deployed vault ABI returns uint256.
    const cash = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (cash) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [cash]);
    await advance(86401); await write(registry, 'SelectionRegistry', 'declareDormant', [agent.agentId], payer);
    await advance(30 * 86400 + 1); return write(registry, 'SelectionRegistry', 'declareDeath', [agent.agentId], payer);
  }
  async function connect() {
    store = await openStore({ DATA_DIR: join(directory, 'database') }); const reader = createSelectionReader(local.rpcUrl);
    indexer = new SelectionIndexer(store.db, profile, reader); feed = new SelectionReputation(store.db, indexer, reader);
  }
  async function catchUp() {
    for (let attempts = 0; attempts < 30; attempts++) if ((await indexer.sync()).processedBlocks === 0) return;
    throw new Error('Fixture index exceeded bounded pages');
  }
  function service(fetcher?: typeof fetch) {
    return new SelectionReputationPublisher(store.db, feed, indexer, { authorised: true, profile: target, rpcUrl: local.rpcUrl,
      signerPrivateKey: publisherSecret, financialSigners: [controller.address, treasury.address], confirmations: 0,
      ...(fetcher ? { fetch: fetcher } : {}) });
  }
  async function journal() {
    const rows = await store.db.select().from(platformTransactionJournal);
    const value = rows.find(row => row.key.startsWith('reputation:publish:')); if (!value) throw new Error('Missing publication journal'); return value;
  }
  async function nonce() { return local.publicClient.getTransactionCount({ address: publisher.address, blockTag: 'latest' }); }
  async function mineThrough(height: bigint) { const head = await local.publicClient.getBlockNumber(); if (head < height) await chain.mine({ blocks: Number(height - head) }); }

  beforeAll(async () => {
    artifacts = compileSelectionReputationPublisherFixture(); local = await startLocalChain(); chain = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    // REASON: fixed destructuring length follows the explicitly generated seven independent fixture keys.
    [owner, controller, guardian, payer, agentKey, treasury, publisher] = Array.from({ length: 7 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account, Account, Account, Account];
    publisherSecret = generatePrivateKey(); publisher = privateKeyToAccount(publisherSecret);
    for (const account of [owner, controller, guardian, payer, agentKey, treasury, publisher]) await chain.setBalance({ address: account.address, value: parseEther('10') });
    token = (await deploy('MockToken')).contractAddress!;
    escrow = (await deploy('TelomereRunEscrow', [token, controller.address, controller.address, treasury.address])).contractAddress!;
    identityImplementation = (await deploy('PublisherIdentityFixture')).contractAddress!;
    identity = (await deploy('Publisher1967ProxyFixture', [identityImplementation])).contractAddress!;
    reputationImplementation = (await deploy('PublisherReputationFixture', [identity])).contractAddress!;
    reputation = (await deploy('Publisher1967ProxyFixture', [reputationImplementation])).contractAddress!;
    identityUpgrade = (await deploy('PublisherIdentityFixtureV2')).contractAddress!;
    reputationUpgrade = (await deploy('PublisherReputationFixtureV2', [identity])).contractAddress!;
    const grace = (await deploy('PublisherGraceFixture')).contractAddress!;
    const receipt = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking: grace, treasury: treasury.address, entryFee: 100n, vaultFloor: 1000n }]);
    registry = receipt.contractAddress!; deployment = receipt.blockNumber;
    for (const account of [owner, payer]) await write(token, 'MockToken', 'faucet', [account.address, 100_000_000n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256]); await write(identity, 'PublisherIdentityFixture', 'register', [1n, owner.address]);
    baseline = await chain.snapshot();
  }, 60000);
  afterAll(async () => { await local?.close(); });
  beforeEach(async () => {
    await chain.revert({ id: baseline }); baseline = await chain.snapshot(); directory = await mkdtemp(join(tmpdir(), 'telomere-reputation-publisher-'));
    const reader = createSelectionReader(local.rpcUrl);
    profile = { reviewed: true, chainId: 31337, registryAddress: registry, registryCodeHash: await reader.codeHash(registry), startBlock: deployment,
      confirmations: 0, maxBlocksPerSync: 16, maxReorgDepth: 64, maxEvents: 2000, maxVaults: 16 };
    target = { reviewed: true, deploymentKind: 'erc1967', chainId: 31337, identityAddress: identity, identityCodeHash: await reader.codeHash(identity),
      reputationAddress: reputation, reputationCodeHash: await reader.codeHash(reputation), publisherAddress: publisher.address,
      identityImplementationAddress: identityImplementation, identityImplementationCodeHash: await reader.codeHash(identityImplementation),
      reputationImplementationAddress: reputationImplementation, reputationImplementationCodeHash: await reader.codeHash(reputationImplementation) };
    await connect();
  });
  afterEach(async () => {
    await store?.close();
    if (directory) { const path = resolve(directory);
      if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('telomere-reputation-publisher-')) throw new Error('Unexpected fixture directory');
      await rm(path, { recursive: true, force: true }); }
  });

  it('checks the reviewed implementation on an empty canonical death feed before reporting successful maintenance', async () => {
    await catchUp();
    const publisherService = service();
    expect(await publisherService.maintain()).toEqual({ published: 0, revoked: 0, retracted: 0 });
    expect(await nonce()).toBe(0);
    await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationUpgrade]);
    await catchUp();
    await expect(publisherService.maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0);
  });

  it('publishes exact canonical death bytes once, verifies live feedback, and preserves the original hash across disk restart', async () => {
    const agent = await enter(); await fund(agent, 12345n); await kill(agent); await catchUp();
    const expected = await service().planner.prepare(agent.agentId), result = await service().maintain(); expect(result).toEqual({ published: 1, revoked: 0, retracted: 0 });
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n); expect(await nonce()).toBe(1);
    const [row] = (await service().status()).publications; expect(row).toMatchObject({ state: 'published', feedbackHash: expected.feedbackHash, feedbackIndex: '1' });
    const [saved] = await store.db.select().from(selectionReputationPublications);
    expect(saved?.plan.originalOwner).toBe(owner.address.toLowerCase());
    const original = await journal(); expect(original.hash).toBe(row?.transactionHash); expect(original.data).toBe(expected.data);
    await store.close(); await connect(); await catchUp(); expect(await service().maintain()).toEqual({ published: 0, revoked: 0, retracted: 0 });
    expect(await journal()).toEqual(original); expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    const live = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [1n, publisher.address, 1n] });
    expect(live).toEqual([BigInt((await feed.death(agent.agentId)).summary.lifespanSeconds), 0, 'lifespan', 'telomere.death.v1', false]);
  });

  it('recovers a mined publication after a lost send acknowledgement and failed final read without signing a second transaction', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); let sent = false, afterSendReceipts = 0;
    const lossy: typeof fetch = async (input, init) => {
      // REASON: the viem transport serializes one ordinary JSON-RPC request here.
      const message = JSON.parse(String(init?.body)) as { method: string };
      if (sent && message.method === 'eth_getTransactionReceipt' && ++afterSendReceipts === 2) throw new Error('private-provider-response-lost');
      const response = await fetch(input, init);
      if (message.method === 'eth_sendRawTransaction') { await response.text(); sent = true; throw new Error('private-provider-ack-lost'); }
      return response;
    };
    await expect(service(lossy).maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(sent).toBe(true); expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    const original = await journal(); expect((await service().status()).publications[0]?.state).toBe('prepared');
    await store.close(); await connect(); await catchUp(); expect((await service().maintain()).published).toBe(1);
    expect(await journal()).toEqual(original); expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
  }, 30000);

  it('rebroadcasts the identical original intent after a real feedback reorg while its source death remains canonical', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const source = await chain.snapshot();
    await service().maintain(); const original = await journal(); await chain.revert({ id: source }); expect(await nonce()).toBe(0);
    await catchUp(); expect((await service().maintain()).published).toBe(1); expect(await journal()).toEqual(original);
    expect((await service().status()).publications[0]?.transactionHash).toBe(original.hash); expect(await nonce()).toBe(1);
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
  });

  it('never replays an orphaned death publication, and a lagging or unavailable index never authorizes revocation', async () => {
    const agent = await enter(); await catchUp(); const branch = await chain.snapshot(); const death = await kill(agent); await catchUp(); await service().maintain();
    const original = await journal(); await chain.revert({ id: branch });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(0);
    await catchUp(); await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect((await service().status()).publications[0]?.state).toBe('published'); expect(await nonce()).toBe(0);
    await mineThrough(death.blockNumber); await catchUp(); expect(await service().maintain()).toEqual({ published: 0, revoked: 0, retracted: 1 });
    expect(await journal()).toEqual(original); expect(await nonce()).toBe(0); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(0n);
    expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(0n);
  });

  it('revokes only a canonically replayed orphan feedback after the replacement source index covers its former death height', async () => {
    const agent = await enter(); await catchUp(); const branch = await chain.snapshot(); const death = await kill(agent); await catchUp(); await service().maintain();
    const original = await journal(); await chain.revert({ id: branch }); await mineThrough(death.blockNumber);
    // A third party can replay already public signed bytes on the replacement branch.
    // REASON: these transaction bytes come from the real local signer journal.
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: original.raw as Hex }) });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(1);
    await catchUp(); expect(await service().maintain()).toEqual({ published: 0, revoked: 1, retracted: 0 });
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    expect((await service().status()).publications[0]?.state).toBe('revoked'); expect(await nonce()).toBe(2);
    await store.close(); await connect(); await catchUp(); expect(await service().maintain()).toEqual({ published: 0, revoked: 0, retracted: 0 }); expect(await nonce()).toBe(2);
  });

  it('blocks operator approval granted after the indexed source anchor, and rejects code changes without sending', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const anchor = await chain.snapshot();
    await write(identity, 'PublisherIdentityFixture', 'approve', [publisher.address, 1n]);
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(0);
    await chain.revert({ id: anchor }); await chain.setCode({ address: reputation, bytecode: '0x60006000fd' });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(0);
  });

  it('refuses an ERC-1967 proxy presented as a direct fixture without implementation pins', async () => {
    const agent = await enter(); await kill(agent); await catchUp();
    const unpinned: SelectionReputationTargetProfile = { reviewed: true, deploymentKind: 'direct', chainId: 31337,
      identityAddress: identity, identityCodeHash: target.identityCodeHash,
      reputationAddress: reputation, reputationCodeHash: target.reputationCodeHash, publisherAddress: publisher.address };
    const planner = new SelectionReputationPublisher(store.db, feed, indexer, { authorised: true, profile: unpinned, rpcUrl: local.rpcUrl,
      signerPrivateKey: publisherSecret, financialSigners: [controller.address, treasury.address], confirmations: 0 });
    await expect(planner.maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
  });

  it('rejects an Identity implementation upgrade at the current head and recovers after its reorg', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const branch = await chain.snapshot();
    await write(identity, 'Publisher1967ProxyFixture', 'upgradeTo', [identityUpgrade]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    await chain.revert({ id: branch }); await catchUp(); expect((await service().maintain()).published).toBe(1);
    expect(await nonce()).toBe(1);
  });

  it('rejects a Reputation implementation upgrade at the historical source anchor before any signed intent', async () => {
    await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationUpgrade]);
    const agent = await enter(); await kill(agent); await catchUp();
    await expect(service().planner.prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_target_unavailable' });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
  });

  it('refuses changed implementation runtime under the same proxy slot and a post-receipt upgrade', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const branch = await chain.snapshot();
    await chain.setCode({ address: reputationImplementation, bytecode: '0x60006000fd' });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0); await chain.revert({ id: branch }); await catchUp();
    expect((await service().maintain()).published).toBe(1); expect(await nonce()).toBe(1);
    const accepted = await chain.snapshot(); await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationUpgrade]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(1); await chain.revert({ id: accepted }); await catchUp();
    expect((await service().maintain()).published).toBe(0); expect(await nonce()).toBe(1);
  });

  it('rejects a receipt executed under a temporary upgraded implementation even after the slot is restored', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); let raced = false;
    const transient: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method !== 'eth_sendRawTransaction' || raced) return fetch(input, init);
      raced = true; await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationUpgrade]);
      const response = await fetch(input, init);
      await write(reputation, 'Publisher1967ProxyFixture', 'upgradeTo', [reputationImplementation]);
      return response;
    };
    await expect(service(transient).maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(raced).toBe(true); expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect((await service().status()).publications[0]?.state).toBe('prepared'); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(1);
  });

  it('rejects an identity transferred after birth before death at the historical source anchor', async () => {
    const agent = await enter(); await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, guardian.address]);
    await kill(agent); await catchUp();
    await expect(service().planner.prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    expect(await nonce()).toBe(0);
  });

  it('rejects a transfer after death before signing without creating an intent', async () => {
    const agent = await enter(); await kill(agent); await catchUp();
    await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, guardian.address]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    expect(await nonce()).toBe(0); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    expect(await store.db.select().from(selectionReputationPublications)).toHaveLength(0);
  });

  it('revokes the exact existing feedback after ownership transfers, without signing a replacement', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); await service().maintain();
    await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, publisher.address]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    expect((await service().status()).publications[0]?.state).toBe('revoked');
    const live = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi,
      functionName: 'readFeedback', args: [1n, publisher.address, 1n] });
    expect(live[4]).toBe(true);
  });

  it('revokes existing feedback when the publisher becomes an approved identity operator', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); await service().maintain();
    await write(identity, 'PublisherIdentityFixture', 'approve', [publisher.address, 1n]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publisher_permission_changed' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    expect((await service().status()).publications[0]?.state).toBe('revoked');
  });

  it('revokes feedback mined while the identity was transferred, even if the owner transfers it back before observation', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); let raced = false;
    const racing: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method !== 'eth_sendRawTransaction' || raced) return fetch(input, init);
      raced = true; await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, guardian.address]);
      const response = await fetch(input, init);
      await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, owner.address], guardian); await catchUp();
      return response;
    };
    await expect(service(racing).maintain()).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    expect(raced).toBe(true); expect(await nonce()).toBe(2);
    expect((await service().status()).publications[0]?.state).toBe('revoked');
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    expect(await read(identity, 'PublisherIdentityFixture', 'ownerOf', [1n])).toBe(owner.address);
  });

  it('reconciles and revokes if ownership transfers between the signed send and receipt observation', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); let raced = false;
    const racing: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const response = await fetch(input, init);
      if (request.method === 'eth_sendRawTransaction' && !raced) {
        raced = true; await write(identity, 'PublisherIdentityFixture', 'transfer', [1n, guardian.address]); await catchUp();
      }
      return response;
    };
    await expect(service(racing).maintain()).rejects.toMatchObject({ code: 'selection_reputation_identity_owner_changed' });
    expect(raced).toBe(true); expect(await nonce()).toBe(2);
    expect((await service().status()).publications[0]?.state).toBe('revoked');
    expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
  });

  it('blocks a changed source generation until its original orphan intent is canonically reconciled and revoked', async () => {
    const agent = await enter(); await catchUp(); const branch = await chain.snapshot(); await kill(agent); await catchUp(); await service().maintain();
    const original = await journal(); await chain.revert({ id: branch }); await fund(agent, 2222n); await kill(agent); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_original_intent_unresolved' });
    expect(await nonce()).toBe(0); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(0n);
    expect((await service().status()).publications).toHaveLength(1); expect((await service().status()).publications[0]?.state).toBe('retracted');
    // REASON: exact already signed local journal bytes emulate external replay; the service itself never replays the absent source.
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: original.raw as Hex }) });
    await catchUp(); await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    await catchUp(); expect(await service().maintain()).toEqual({ published: 1, revoked: 0, retracted: 0 });
    expect(await nonce()).toBe(3); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(2n);
    expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
    const first = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [1n, publisher.address, 1n] });
    const second = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [1n, publisher.address, 2n] });
    expect(first[4]).toBe(true); expect(second[4]).toBe(false);
  });

  it.each([1, 2])('refuses success when the actual event or live feedback is inconsistent, fixture mode %s', async mode => {
    const agent = await enter(); await kill(agent); await catchUp(); await write(reputation, 'PublisherReputationFixture', 'setMode', [mode]); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(1); expect((await service().status()).publications[0]?.state).toBe('prepared');
    await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(1);
  });

  it('fails closed for restored source feedback with an existing revocation intent, including a canonically mined old revocation', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); await service().maintain(); const row = (await service().status()).publications[0]!;
    const wallet = createWalletClient({ account: publisher, chain: localChain, transport: http(local.rpcUrl) });
    const transactions = new PlatformTransactions(store.db, local.publicClient, wallet, 31337);
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({ abi: selectionReputationPublisherAbi, functionName: 'revokeFeedback', args: [1n, 1n] });
    // This is the canonical end state after an old revocation remine. Recovery cannot safely create a second active generation automatically.
    await transactions.submit('reputation:revoke:' + row.summaryHash.slice(2), reputation, data);
    await catchUp(); await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_republication_requires_review' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
  });

  it('binds the durable profile, rejects a shared financial signer, and loads authorized private configuration only when enabled', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); await service().initialize();
    expect(() => new SelectionReputationPublisher(store.db, feed, indexer, { authorised: true, profile: target, rpcUrl: local.rpcUrl,
      signerPrivateKey: publisherSecret, financialSigners: [publisher.address] })).toThrow('dedicated publisher');
    const unconfirmedPublic = new SelectionIndexer(store.db, { ...profile, chainId: 84532, confirmations: 0 }, createSelectionReader(local.rpcUrl));
    expect(() => new SelectionReputationPublisher(store.db, feed, unconfirmedPublic, { authorised: true, profile: { ...target, chainId: 84532 }, rpcUrl: local.rpcUrl,
      signerPrivateKey: publisherSecret, financialSigners: [controller.address], confirmations: 1 })).toThrow('confirmed source evidence');
    const changed = new SelectionReputationPublisher(store.db, feed, indexer, { authorised: true, profile: target, rpcUrl: local.rpcUrl,
      signerPrivateKey: publisherSecret, financialSigners: [controller.address, treasury.address], confirmations: 0, maxPublications: 100 });
    await expect(changed.initialize()).rejects.toThrow('another immutable profile');
    const input = { rpcUrl: local.rpcUrl, chainId: 31337, mode: 'demo' as const, financialSigners: [controller.address, treasury.address] };
    expect(await configuredSelectionReputationPublisher(store.db, feed, indexer, input)).toBeUndefined();
    const keyFile = join(directory, 'publisher.key'), configurationFile = join(directory, 'publisher.json');
    await writeFile(keyFile, publisherSecret, { mode: 0o600 });
    const configuration = { authorised: true, profile: target, signerKeyFile: keyFile, confirmations: 0, maxPublications: 1024 };
    await writeFile(configurationFile, JSON.stringify(configuration), { mode: 0o600 });
    const configured = await configuredSelectionReputationPublisher(store.db, feed, indexer, { ...input, configurationFile });
    expect(configured).toBeDefined(); expect(await nonce()).toBe(0); expect((await configured!.maintain()).published).toBe(1);
    await writeFile(configurationFile, JSON.stringify({ ...configuration, authorised: false }), { mode: 0o600 });
    await expect(configuredSelectionReputationPublisher(store.db, feed, indexer, { ...input, configurationFile })).rejects.toThrow('configuration, dedicated key');
  });

  it('rejects corrupted source-height metadata before an orphan can authorize a premature revocation', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); await service().maintain();
    await catchUp(); const [row] = await store.db.select().from(selectionReputationPublications); if (!row) throw new Error('Missing publication row');
    await store.db.update(selectionReputationPublications).set({ plan: { ...row.plan, sourceHeight: '0' } }).where(eq(selectionReputationPublications.summaryHash, row.summaryHash));
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); expect(await nonce()).toBe(1);
  });

  it('refuses a first signed intent when the publisher already has feedback outside this database', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const plan = await service().planner.prepare(agent.agentId);
    const wallet = createWalletClient({ account: publisher, chain: localChain, transport: http(local.rpcUrl) });
    await local.publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: reputation, data: plan.data }) }); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_existing_feedback_requires_review' });
    expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(1n);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    expect((await service().status()).publications[0]?.state).toBe('prepared');
  });

  it('fails closed when an external transaction appends another same-agent feedback after the original publication', async () => {
    const agent = await enter(); await catchUp(); const branch = await chain.snapshot(); const death = await kill(agent); await catchUp(); await service().maintain(); const original = await journal();
    const wallet = createWalletClient({ account: publisher, chain: localChain, transport: http(local.rpcUrl) });
    // REASON: this is the exact already validated calldata from the real local publication journal.
    const request = await wallet.prepareTransactionRequest({ to: reputation, data: original.data as Hex, nonce: 1 });
    const duplicate = await wallet.signTransaction(request);
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: duplicate }) }); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(2n);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(1);
    await chain.revert({ id: branch }); await mineThrough(death.blockNumber);
    // REASON: original bytes are already public; an external replay emulates the replacement branch.
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: original.raw as Hex }) });
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: duplicate }) }); await catchUp();
    expect((await service().maintain()).revoked).toBe(1); expect(await nonce()).toBe(3);
    const stale = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [1n, publisher.address, 1n] });
    const unknown = await local.publicClient.readContract({ address: reputation, abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [1n, publisher.address, 2n] });
    expect(stale[4]).toBe(true); expect(unknown[4]).toBe(false);
  });

  it('reports a per-agent review requirement after publishing another independent canonical death safely', async () => {
    await write(identity, 'PublisherIdentityFixture', 'register', [2n, owner.address]);
    const first = await enter(), second = await enter(2n, guardian.address); await kill(first); await kill(second); await catchUp();
    const plan = await service().planner.prepare(first.agentId), wallet = createWalletClient({ account: publisher, chain: localChain, transport: http(local.rpcUrl) });
    await local.publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: reputation, data: plan.data }) }); await catchUp();
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_existing_feedback_requires_review' });
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(2n);
    const rows = await store.db.select().from(selectionReputationPublications);
    expect(rows.find(row => row.plan.agentId === first.agentId)?.state).toBe('prepared');
    expect(rows.find(row => row.plan.agentId === second.agentId)?.state).toBe('published');
  });

  it('requires complete confirmed source-head coverage before publishing, including after a successful partial index sync', async () => {
    await store.close(); profile = { ...profile, maxBlocksPerSync: 1 }; await connect();
    const agent = await enter(); await kill(agent); await catchUp(); await chain.mine({ blocks: 4 });
    expect((await indexer.sync()).processedBlocks).toBe(1);
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(0); expect(await read(reputation, 'PublisherReputationFixture', 'count')).toBe(0n);
    await catchUp(); expect((await service().maintain()).published).toBe(1);
  });

  it('rechecks source-head freshness immediately before signing when a new confirmed block arrives during planning', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const original = feed.death.bind(feed); let reads = 0;
    const spy = vi.spyOn(feed, 'death').mockImplementation(async value => {
      const result = await original(value); if (++reads === 2) await chain.mine({ blocks: 1 }); return result;
    });
    try { await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' }); }
    finally { spy.mockRestore(); }
    expect(await nonce()).toBe(0); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    await catchUp(); expect((await service().maintain()).published).toBe(1);
  });

  it('refuses partial replacement-branch evidence until later real revival blocks are fully indexed before revocation', async () => {
    await store.close(); profile = { ...profile, maxBlocksPerSync: 1 }; await connect(); const agent = await enter();
    // REASON: the concrete deployed AgentVault ABI returns its uint256 balance.
    const balance = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    await write(agent.vault, 'AgentVault', 'ownerWithdraw', [balance]); await advance(86401);
    await write(registry, 'SelectionRegistry', 'declareDormant', [agent.agentId], payer); await catchUp();
    const branch = await chain.snapshot(); await advance(30 * 86400 + 1);
    const death = await write(registry, 'SelectionRegistry', 'declareDeath', [agent.agentId], payer); await catchUp(); await service().maintain();
    const original = await journal(); await chain.revert({ id: branch }); await fund(agent, 2222n);
    await write(registry, 'SelectionRegistry', 'revive', [agent.agentId]); await chain.mine({ blocks: 2 });
    // REASON: a third party can replay the already public exact signed bytes; this module does not.
    await local.publicClient.waitForTransactionReceipt({ hash: await local.publicClient.sendRawTransaction({ serializedTransaction: original.raw as Hex }) });
    await indexer.sync(); await indexer.sync();
    const status = await indexer.status(); expect(BigInt(status.indexedThrough ?? '0')).toBeGreaterThanOrEqual(death.blockNumber);
    await expect(service().maintain()).rejects.toMatchObject({ code: 'selection_reputation_publication_unavailable' });
    expect(await nonce()).toBe(1); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(0n);
    await catchUp(); expect((await feed.page()).summaries).toEqual([]); expect((await service().maintain()).revoked).toBe(1);
    expect(await nonce()).toBe(2); expect(await read(reputation, 'PublisherReputationFixture', 'revocations')).toBe(1n);
  }, 45000);
});
