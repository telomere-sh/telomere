import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import solc from 'solc';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, decodeFunctionData, http, keccak256, maxUint256, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { projectRoot } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { localChain, quoteTypedData, settlementTypedData, type Quote } from '../src/chain/index.js';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import { SelectionIndexer, type SelectionIndexProfile } from '../src/selection/indexer.js';
import { createSelectionReader, type SelectionReader } from '../src/selection/rpc.js';
import { selectionEvents, selectionFossils } from '../src/selection/schema.js';
import { createSelectionReputationRoutes, SelectionReputation } from '../src/selection/reputation.js';
import { createSelectionReputationTargetReader, SelectionReputationPlanner, selectionReputationFeedbackAbi,
  type SelectionReputationTargetProfile } from '../src/selection/reputation-feedback.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Artifact = { abi: Abi; bytecode: Hex };
type Agent = { owner: Address; vault: Address; leashId: Hex };
const id = (value: string): Hex => keccak256(toHex(value));
const zeroAddress = '0x' + '00'.repeat(20);
function compile(): Record<string, Artifact> {
  const paths = ['contracts/SelectionRegistry.sol', 'contracts/AgentVault.sol', 'contracts/TelomereRunEscrow.sol', 'contracts/MockToken.sol'];
  const fixture = 'tests/ReputationDependencies.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [fixture]: { content: `pragma solidity ^0.8.28;
      contract ReputationIdentityFixture {
        mapping(uint256=>address) public ownerOf; mapping(uint256=>address) public getApproved;
        mapping(address=>mapping(address=>bool)) public isApprovedForAll;
        function register(uint256 id,address owner) external { require(block.chainid==31337 && ownerOf[id]==address(0)); ownerOf[id]=owner; }
        function approve(address operator,uint256 id) external { require(msg.sender==ownerOf[id]); getApproved[id]=operator; }
        function setApprovalForAll(address operator,bool value) external { isApprovedForAll[msg.sender][operator]=value; }
      }
      contract ReputationGraceFixture { function graceExtension(bytes32) external view returns(uint64) { require(block.chainid==31337); return 0; } }
      contract ReputationAbiFixture {
        ReputationIdentityFixture public immutable identity; uint256 public count; uint256 public lastAgent;
        int128 public lastValue; uint8 public lastDecimals; bytes32 public lastHash; string public lastURI;
        constructor(address target) { identity=ReputationIdentityFixture(target); }
        function getIdentityRegistry() external view returns(address) { return address(identity); }
        function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string calldata,string calldata,string calldata,string calldata uri,bytes32 digest) external {
          address owner=identity.ownerOf(agentId); require(owner!=address(0) && msg.sender!=owner && identity.getApproved(agentId)!=msg.sender
            && !identity.isApprovedForAll(owner,msg.sender) && valueDecimals<=18);
          count++; lastAgent=agentId; lastValue=value; lastDecimals=valueDecimals; lastHash=digest; lastURI=uri;
        }
      }` } };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), {
    import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported import' },
  })) as { errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string,
    { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(output.contracts).flatMap(contracts => Object.entries(contracts)
    .map(([name, value]) => [name, { abi: value.abi, bytecode: ('0x' + value.evm.bytecode.object) as Hex }])));
}

describe('canonical Selection death reputation feed and unsigned ERC-8004 plans', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, chain: ReturnType<typeof createTestClient>, artifacts: Record<string, Artifact>;
  let owner: Account, controller: Account, guardian: Account, payer: Account, agentKey: Account, childKey: Account, treasury: Account;
  let token: Address, escrow: Address, registry: Address, identity: Address, reputation: Address, deployment: bigint, baseline: Hex;
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, reader: SelectionReader, indexer: SelectionIndexer, feed: SelectionReputation;
  let profile: SelectionIndexProfile, target: SelectionReputationTargetProfile;
  const artifact = (name: string) => { const result = artifacts[name]; if (!result) throw new Error('Missing fixture artifact'); return result; };
  async function deploy(name: string, args: readonly unknown[] = []) {
    const wallet = createWalletClient({ account: owner, chain: localChain, transport: http(local.rpcUrl) }), value = artifact(name);
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: value.abi, bytecode: value.bytecode, args }) });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Fixture deployment failed'); return receipt;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner) {
    const wallet = createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args }) });
    if (receipt.status !== 'success') throw new Error('Fixture transaction reverted'); return receipt;
  }
  async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []) {
    return local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  }
  const now = async () => (await local.publicClient.getBlock()).timestamp;
  async function advance(seconds: number) { await chain.increaseTime({ seconds }); await chain.mine({ blocks: 1 }); }
  async function enter(number = 1n, key = agentKey) {
    await write(registry, 'SelectionRegistry', 'enter', [{ identityId: number, agentWallet: key.address, maxPerHour: 20_000_000n,
      maxPerDay: 200_000_000n, expiry: await now() + 100n * 86400n, cystHash: id('private-encrypted-state'), endowment: 1_000_000n }]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [number]) as Hex;
    return { agentId, ...await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Agent };
  }
  async function fund(agent: Agent, amount: bigint, source = payer) {
    await write(token, 'MockToken', 'approve', [agent.vault, amount], source);
    await write(agent.vault, 'AgentVault', 'receiveFunds', [amount, id('private-payment-ref')], source);
  }
  async function burn(agent: Awaited<ReturnType<typeof enter>>) {
    const quote: Quote = { runId: id('private-run'), leashId: agent.leashId, payer: agent.vault, workloadHash: id('private-workload'),
      maxSeconds: 3n, pricePerSecond: 100n, inferencePrice: 0n, quoteExpiry: await now() + 300n };
    await write(agent.vault, 'AgentVault', 'payRun', [quote, await controller.signTypedData(quoteTypedData(31337, escrow, quote))], agentKey);
    await advance(3);
    const settlement = { runId: quote.runId, billableSeconds: 2n, inferenceCharge: 0n, receiptHash: id('real-settlement-receipt') };
    await write(escrow, 'TelomereRunEscrow', 'settleRun', [settlement, await controller.signTypedData(settlementTypedData(31337, escrow, settlement))], payer);
    await write(agent.vault, 'AgentVault', 'syncRun', [quote.runId], payer);
  }
  async function kill(agent: Awaited<ReturnType<typeof enter>>) {
    const cash = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (cash) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [cash]);
    await advance(86401); await write(registry, 'SelectionRegistry', 'declareDormant', [agent.agentId], payer);
    await advance(30 * 86400 + 1); return write(registry, 'SelectionRegistry', 'declareDeath', [agent.agentId], payer);
  }
  async function connect() {
    store = await openStore({ DATA_DIR: join(directory, 'database') }); reader = createSelectionReader(local.rpcUrl);
    indexer = new SelectionIndexer(store.db, profile, reader); feed = new SelectionReputation(store.db, indexer, reader);
  }
  async function catchUp() {
    for (let attempt = 0; attempt < 30; attempt++) if ((await indexer.sync()).processedBlocks === 0) return;
    throw new Error('Index exceeded bounded fixture pages');
  }
  function app(value = feed) {
    const routes = new Hono(); routes.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'internal' }, error instanceof Problem ? error.status : 503));
    routes.route('/api/selection', createSelectionReputationRoutes(value)); return routes;
  }
  beforeAll(async () => {
    artifacts = compile(); local = await startLocalChain(); chain = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [owner, controller, guardian, payer, agentKey, childKey, treasury] = Array.from({ length: 7 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account, Account, Account, Account];
    for (const account of [owner, controller, guardian, payer, agentKey, childKey, treasury]) await chain.setBalance({ address: account.address, value: parseEther('10') });
    token = (await deploy('MockToken')).contractAddress!;
    escrow = (await deploy('TelomereRunEscrow', [token, controller.address, controller.address, treasury.address])).contractAddress!;
    identity = (await deploy('ReputationIdentityFixture')).contractAddress!;
    reputation = (await deploy('ReputationAbiFixture', [identity])).contractAddress!;
    const grace = (await deploy('ReputationGraceFixture')).contractAddress!;
    const receipt = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking: grace, treasury: treasury.address, entryFee: 100n, vaultFloor: 1000n }]);
    registry = receipt.contractAddress!; deployment = receipt.blockNumber;
    for (const account of [owner, payer, agentKey, childKey]) await write(token, 'MockToken', 'faucet', [account.address, 100_000_000n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256]);
    for (const number of [1n, 2n]) await write(identity, 'ReputationIdentityFixture', 'register', [number, owner.address]);
    baseline = await chain.snapshot();
  }, 60000);
  afterAll(async () => { await local?.close(); });
  beforeEach(async () => {
    await chain.revert({ id: baseline }); baseline = await chain.snapshot(); directory = await mkdtemp(join(tmpdir(), 'telomere-selection-reputation-'));
    profile = { reviewed: true, chainId: 31337, registryAddress: registry, registryCodeHash: await createSelectionReader(local.rpcUrl).codeHash(registry),
      startBlock: deployment, confirmations: 0, maxBlocksPerSync: 16, maxReorgDepth: 64, maxEvents: 2000, maxVaults: 16 };
    const rpc = createSelectionReader(local.rpcUrl);
    target = { reviewed: true, deploymentKind: 'direct', chainId: 31337, identityAddress: identity, identityCodeHash: await rpc.codeHash(identity),
      reputationAddress: reputation, reputationCodeHash: await rpc.codeHash(reputation), publisherAddress: payer.address };
    await connect();
  });
  afterEach(async () => {
    await store?.close();
    if (directory) { const path = resolve(directory);
      if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('telomere-selection-reputation-')) throw new Error('Unexpected fixture directory');
      await rm(path, { recursive: true, force: true }); }
  });

  it('derives exact income/burn/lifespan/cause from real canonical contracts and serves only public summary fields', async () => {
    const agent = await enter(); await fund(agent, 12345n); await fund(agent, 777n, owner); await burn(agent);
    const death = await kill(agent); await catchUp(); const result = await feed.death(agent.agentId);
    expect(await feed.origin(agent.agentId)).toMatchObject({ owner: owner.address.toLowerCase(), feedbackHash: result.feedbackHash });
    expect(result).not.toHaveProperty('originalOwner');
    expect((await feed.page()).summaries[0]).not.toHaveProperty('originalOwner');
    expect(result.summary).toMatchObject({ identityId: '1', lifetimeIncomeUnits: '12345', lifetimeIncomeFeeUnits: '124',
      lifetimeNetIncomeUnits: '12221', lifetimeBurnUnits: '200', evidence: { deathBlock: death.blockNumber.toString(), deathTransactionHash: death.transactionHash } });
    expect(BigInt(result.summary.lifespanSeconds)).toBe(BigInt(result.summary.evidence.diedAtSeconds) - BigInt(result.summary.evidence.bornAtSeconds));
    expect(result.coverage).toMatchObject({ deploymentHistoryVerified: false, source: 'confirmed-indexed-events' });
    const http = app(), response = await http.request('/api/selection/reputation/files/' + result.feedbackHash), bytes = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBe('"' + result.feedbackHash + '"'); expect(keccak256(toHex(bytes))).toBe(result.feedbackHash);
    for (const privateField of ['owner', 'vault', 'leashId', 'cystHash', 'subsidy', 'paymentRef', 'workload', 'runId', 'balance', 'endpoint']) expect(bytes).not.toContain('"' + privateField + '"');
    for (const privateValue of [owner.address.toLowerCase(), payer.address.toLowerCase(), agent.vault.toLowerCase(), agent.leashId, id('private-encrypted-state')]) expect(bytes.toLowerCase()).not.toContain(privateValue);
    expect(await read(reputation, 'ReputationAbiFixture', 'count')).toBe(0n);
    expect((await http.request('/api/selection/reputation/deaths/' + agent.agentId)).status).toBe(200);
    expect((await http.request('/api/selection/reputation/deaths', { method: 'POST', body: '{"lifespan":999}' })).status).toBe(404);
    for (const suffix of ['?limit=0', '?limit=50&limit=60', '?score=100', '?cursor=bad']) expect((await http.request('/api/selection/reputation/deaths' + suffix)).status).toBe(422);
  });

  it('keeps identical content after durable database reopen and index advance, with bounded snapshot pagination', async () => {
    const first = await enter(), second = await enter(2n, childKey); await fund(first, 1111n); await kill(first); await kill(second); await catchUp();
    const page = await feed.page({ limit: 1 }); expect(page.summaries).toHaveLength(1); expect(page.nextCursor).toBeDefined();
    const next = await feed.page({ limit: 1, cursor: page.nextCursor }); expect(next.summaries).toHaveLength(1); expect(next.nextCursor).toBeUndefined();
    expect(new Set([...page.summaries, ...next.summaries].map(value => value.summary.agentId)).size).toBe(2);
    const before = await feed.death(first.agentId), file = await feed.file(before.feedbackHash);
    await store.close(); await connect(); expect(await feed.file(before.feedbackHash)).toEqual(file);
    await chain.mine({ blocks: 1 }); await catchUp(); expect(await feed.file(before.feedbackHash)).toEqual(file);
    await expect(feed.page({ cursor: page.nextCursor })).rejects.toMatchObject({ code: 'selection_reputation_cursor_changed' });
  });

  it('refuses orphaned death evidence before sync and retracts its summary/file after a real chain reorg', async () => {
    const agent = await enter(); await fund(agent, 1111n); await catchUp(); const branch = await chain.snapshot();
    await kill(agent); await catchUp(); const orphan = await feed.death(agent.agentId);
    await chain.revert({ id: branch }); await fund(agent, 2222n);
    await expect(feed.death(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_unavailable' });
    await catchUp(); expect((await feed.page()).summaries).toEqual([]);
    await expect(feed.file(orphan.feedbackHash)).rejects.toMatchObject({ code: 'selection_reputation_not_found' });
    await kill(agent); await catchUp(); const replacement = await feed.death(agent.agentId);
    expect(replacement.summary.lifetimeIncomeUnits).toBe('3333'); expect(replacement.feedbackHash).not.toBe(orphan.feedbackHash);
  });

  it('prepares exact unsigned ERC-8004 lifespan calldata after historical target checks, without sending a transaction', async () => {
    const agent = await enter(); await fund(agent, 1000n); await kill(agent); await catchUp();
    const planner = new SelectionReputationPlanner(feed, target, createSelectionReputationTargetReader(local.rpcUrl));
    const blockBefore = await local.publicClient.getBlockNumber(), plan = await planner.prepare(agent.agentId);
    expect(await local.publicClient.getBlockNumber()).toBe(blockBefore); expect(await read(reputation, 'ReputationAbiFixture', 'count')).toBe(0n);
    expect(plan).toMatchObject({ state: 'unsigned', value: '0', numericSignal: 'lifespan-seconds', publicationConfirmed: false });
    const decoded = decodeFunctionData({ abi: selectionReputationFeedbackAbi, data: plan.data });
    expect(decoded.functionName).toBe('giveFeedback'); expect(decoded.args[0]).toBe(1n); expect(decoded.args[1]).toBe(BigInt((await feed.death(agent.agentId)).summary.lifespanSeconds));
    expect(decoded.args.slice(2, 6)).toEqual([0, 'lifespan', 'telomere.death.v1', '']);
    expect(keccak256(toHex(plan.feedbackContent))).toBe(plan.feedbackHash);
    expect(Buffer.from(plan.feedbackURI.split(',')[1]!, 'base64').toString()).toBe(plan.feedbackContent);
    const content = JSON.parse(plan.feedbackContent) as { agentId: number; clientAddress: string; summary: { lifetimeIncomeUnits: string } };
    expect(content.agentId).toBe(1); expect(content.clientAddress).toBe('eip155:31337:' + payer.address.toLowerCase()); expect(content.summary.lifetimeIncomeUnits).toBe('1000');
    // This generated-key loopback-only transaction validates the official ABI shape against a minimal fixture; it is not a reference registry deployment.
    const wallet = createWalletClient({ account: payer, chain: localChain, transport: http(local.rpcUrl) });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: reputation, data: plan.data }) });
    expect(receipt.status).toBe('success'); expect(await read(reputation, 'ReputationAbiFixture', 'count')).toBe(1n);
    expect(await read(reputation, 'ReputationAbiFixture', 'lastHash')).toBe(plan.feedbackHash);
    expect(await read(reputation, 'ReputationAbiFixture', 'lastURI')).toBe(plan.feedbackURI);
  });

  it('rejects wrong deployment pins, owner/operator feedback and unavailable target RPC with redacted errors', async () => {
    const agent = await enter(); await kill(agent); await catchUp(); const targetReader = createSelectionReputationTargetReader(local.rpcUrl);
    for (const invalid of [{ ...target, identityCodeHash: id('wrong-identity') }, { ...target, reputationCodeHash: id('wrong-reputation') },
      { ...target, identityAddress: reputation }, { ...target, chainId: 1 }]) {
      await expect(new SelectionReputationPlanner(feed, invalid, targetReader).prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_target_unavailable' });
    }
    await expect(new SelectionReputationPlanner(feed, { ...target, publisherAddress: owner.address }, targetReader).prepare(agent.agentId))
      .rejects.toMatchObject({ code: 'selection_reputation_self_feedback' });
    const checksummedOwnerReader = { state: async (...args: Parameters<typeof targetReader.state>) => ({ ...await targetReader.state(...args), owner: owner.address }) };
    await expect(new SelectionReputationPlanner(feed, { ...target, publisherAddress: owner.address }, checksummedOwnerReader).prepare(agent.agentId))
      .rejects.toMatchObject({ code: 'selection_reputation_self_feedback' });
    await write(identity, 'ReputationIdentityFixture', 'approve', [payer.address, 1n]); await catchUp();
    await expect(new SelectionReputationPlanner(feed, target, targetReader).prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_self_feedback' });
    await write(identity, 'ReputationIdentityFixture', 'approve', [zeroAddress, 1n]);
    await write(identity, 'ReputationIdentityFixture', 'setApprovalForAll', [payer.address, true]); await catchUp();
    await expect(new SelectionReputationPlanner(feed, target, targetReader).prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_self_feedback' });
    await expect(new SelectionReputationPlanner(feed, target, { state: async () => { throw new Error('private-provider-secret'); } }).prepare(agent.agentId))
      .rejects.toThrow('Reviewed reputation target evidence is unavailable or changed.');
  });

  it('replays the event ledger instead of trusting materialized fossils and refuses corrupt accounting/canonical evidence', async () => {
    const agent = await enter(); await fund(agent, 1111n); await kill(agent); await catchUp(); const correct = await feed.death(agent.agentId);
    const [fossil] = await store.db.select().from(selectionFossils); if (!fossil) throw new Error('Missing fixture fossil');
    await store.db.update(selectionFossils).set({ data: { ...fossil.data, lifetimeIncome: '999999' } }).where(eq(selectionFossils.agentId, agent.agentId));
    expect((await feed.death(agent.agentId)).summary).toEqual(correct.summary);
    const wrongChain = new SelectionReputation(store.db, indexer, { ...reader, chainId: async () => 1 });
    await expect(wrongChain.page()).rejects.toMatchObject({ code: 'selection_reputation_unavailable' });
    const fewerConfirmations = new SelectionReputation(store.db, indexer, { ...reader, head: async () => 0n });
    await expect(fewerConfirmations.page()).rejects.toMatchObject({ code: 'selection_reputation_unavailable' });
    const [death] = await store.db.select().from(selectionEvents).where(eq(selectionEvents.name, 'Death')); if (!death) throw new Error('Missing fixture death');
    await store.db.update(selectionEvents).set({ args: { ...death.args, lifetimeIncome: '999999' } }).where(eq(selectionEvents.id, death.id));
    await expect(feed.page()).rejects.toMatchObject({ code: 'selection_reputation_unavailable' });
  });

  it('bounds a stalled target response body and rejects oversized responses without leaking upstream data', async () => {
    const agent = await enter(); await kill(agent); await catchUp();
    const stalled = createSelectionReputationTargetReader('http://127.0.0.1:1', { timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); } })) });
    const start = Date.now();
    await expect(new SelectionReputationPlanner(feed, target, stalled).prepare(agent.agentId)).rejects.toMatchObject({ code: 'selection_reputation_target_unavailable' });
    expect(Date.now() - start).toBeLessThan(3000);
    const oversized = createSelectionReputationTargetReader('http://127.0.0.1:1', {
      fetch: async () => new Response('provider-private-data', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }) });
    await expect(new SelectionReputationPlanner(feed, target, oversized).prepare(agent.agentId)).rejects.toThrow('Reviewed reputation target evidence is unavailable or changed.');
  });
});
