import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import solc from 'solc';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, http, keccak256, maxUint256, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { projectRoot } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { localChain, quoteTypedData, settlementTypedData, type Quote } from '../src/chain/index.js';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import { SelectionIndexer, type SelectionIndexProfile } from '../src/selection/indexer.js';
import { createSelectionReader, type SelectionReader } from '../src/selection/rpc.js';
import { selectionAgents, selectionCursors, selectionEvents, selectionMigrationSQL } from '../src/selection/schema.js';
import { createSelectionRoutes } from '../src/selection/routes.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Artifact = { abi: Abi; bytecode: Hex };
type Agent = { owner: Address; vault: Address; leashId: Hex; cystHash: Hex; status: number; family: Hex };
const id = (value: string): Hex => keccak256(toHex(value));
function compile() {
  const paths = ['contracts/SelectionRegistry.sol', 'contracts/AgentVault.sol', 'contracts/TelomereRunEscrow.sol', 'contracts/MockToken.sol', 'contracts/TlmrToken.sol', 'contracts/TlmrStaking.sol'];
  const identity = 'tests/IndexerIdentity.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [identity]: { content: 'pragma solidity ^0.8.28; contract IndexerIdentity { mapping(uint256=>address) public ownerOf; function register(uint256 n,address o) external { require(block.chainid==31337 && ownerOf[n]==address(0)); ownerOf[n]=o; } }' } };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), { import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
    ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported import' } })) as {
      errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter(error => error.severity === 'error') ?? []; if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(output.contracts).flatMap(contracts => Object.entries(contracts).map(([name, value]) => [name, { abi: value.abi, bytecode: ('0x' + value.evm.bytecode.object) as Hex }]))) as Record<string, Artifact>;
}
describe('Selection event index and immutable canonical Fossil Record on a disposable real EVM', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, test: ReturnType<typeof createTestClient>, artifacts: Record<string, Artifact>;
  let owner: Account, controller: Account, guardian: Account, payer: Account, agentKey: Account, childKey: Account, treasury: Account;
  let token: Address, escrow: Address, registry: Address, identity: Address, staking: Address, startBlock: bigint, codeHash: string, snapshot: Hex;
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, reader: SelectionReader, indexer: SelectionIndexer, profile: SelectionIndexProfile;
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error('Missing fixture contract'); return value; };
  async function deploy(name: string, args: readonly unknown[] = []) {
    const wallet = createWalletClient({ account: owner, chain: localChain, transport: http(local.rpcUrl) }), a = artifact(name);
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) });
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
  async function advance(seconds: number) { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); }
  async function enter() {
    await write(registry, 'SelectionRegistry', 'enter', [{ identityId: 1n, agentWallet: agentKey.address, maxPerHour: 20_000_000n,
      maxPerDay: 200_000_000n, expiry: await now() + 100n * 86400n, cystHash: id('encrypted-parent-state'), endowment: 1_000_000n }]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [1n]) as Hex;
    return { agentId, ...await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Agent };
  }
  async function fund(vault: Address, amount: bigint, account = payer) {
    await write(token, 'MockToken', 'approve', [vault, amount], account);
    await write(vault, 'AgentVault', 'receiveFunds', [amount, id('actual-payer-reference')], account);
  }
  async function spawn(parentId: Hex) {
    await write(registry, 'SelectionRegistry', 'spawn', [parentId, 2n, childKey.address, 50_000n, await now() + 90n * 86400n]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [2n]) as Hex;
    return { agentId, ...await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Agent };
  }
  async function burn(agent: Awaited<ReturnType<typeof enter>>, label: string, seconds = 2n) {
    const quote: Quote = { runId: id(label), leashId: agent.leashId, payer: agent.vault, workloadHash: id('actual-workload'),
      maxSeconds: 3n, pricePerSecond: 100n, inferencePrice: 0n, quoteExpiry: await now() + 300n };
    await write(agent.vault, 'AgentVault', 'payRun', [quote, await controller.signTypedData(quoteTypedData(31337, escrow, quote))], agentKey);
    await advance(3);
    const settlement = { runId: quote.runId, billableSeconds: seconds, inferenceCharge: 0n, receiptHash: id(label + '-receipt') };
    await write(escrow, 'TelomereRunEscrow', 'settleRun', [settlement, await controller.signTypedData(settlementTypedData(31337, escrow, settlement))], payer);
    await write(agent.vault, 'AgentVault', 'syncRun', [quote.runId], payer);
  }
  async function dormant(agent: Awaited<ReturnType<typeof enter>>) {
    const cash = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (cash > 0n) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [cash]);
    await advance(86401); await write(registry, 'SelectionRegistry', 'declareDormant', [agent.agentId], payer);
  }
  async function connect() {
    store = await openStore({ DATA_DIR: join(directory, 'database') });
    for (const statement of selectionMigrationSQL.split(';').map(value => value.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    reader = createSelectionReader(local.rpcUrl); indexer = new SelectionIndexer(store.db, profile, reader);
  }
  async function catchUp(target = indexer) {
    for (let i = 0; i < 20; i++) { const status = await target.sync(); if (status.processedBlocks === 0) return; } throw new Error('Indexer did not finish its bounded pages');
  }
  beforeAll(async () => {
    artifacts = compile(); local = await startLocalChain(); test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [owner, controller, guardian, payer, agentKey, childKey, treasury] = Array.from({ length: 7 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account, Account, Account, Account];
    for (const account of [owner, controller, guardian, payer, agentKey, childKey, treasury]) await test.setBalance({ address: account.address, value: parseEther('10') });
    token = (await deploy('MockToken')).contractAddress!; escrow = (await deploy('TelomereRunEscrow', [token, controller.address, controller.address, treasury.address])).contractAddress!;
    identity = (await deploy('IndexerIdentity')).contractAddress!; const utility = (await deploy('TlmrToken', [owner.address, parseEther('1000000')])).contractAddress!;
    staking = (await deploy('TlmrStaking', [utility])).contractAddress!;
    const deployment = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address, guardian: guardian.address, identityRegistry: identity,
      staking, treasury: treasury.address, entryFee: 100n, vaultFloor: 1000n }]); registry = deployment.contractAddress!; startBlock = deployment.blockNumber;
    for (const account of [owner, controller, payer, agentKey, childKey, treasury]) await write(token, 'MockToken', 'faucet', [account.address, 100_000_000n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256]);
    for (let n = 1; n <= 3; n++) await write(identity, 'IndexerIdentity', 'register', [BigInt(n), owner.address]);
    codeHash = await createSelectionReader(local.rpcUrl).codeHash(registry); snapshot = await test.snapshot();
  }, 60000);
  afterAll(async () => { await local?.close(); });
  beforeEach(async () => {
    await test.revert({ id: snapshot }); snapshot = await test.snapshot(); directory = await mkdtemp(join(tmpdir(), 'telomere-selection-index-'));
    profile = { reviewed: true, chainId: 31337, registryAddress: registry, registryCodeHash: codeHash, startBlock,
      confirmations: 0, maxBlocksPerSync: 16, maxReorgDepth: 64, maxEvents: 2000 }; await connect();
  });
  afterEach(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });

  it('indexes real vault income, excluded subsidies, paid burn and family generations without double-counting mirrored vault events', async () => {
    const parent = await enter(); await fund(parent.vault, 10_000n, owner); await fund(parent.vault, 20_000n); const child = await spawn(parent.agentId);
    await fund(parent.vault, 500n, childKey); await fund(parent.vault, 600n, controller); await fund(parent.vault, 700n, treasury);
    await fund(child.vault, 4000n); await burn(parent, 'real-indexed-burn'); await catchUp();
    const view = await indexer.get(owner.address, parent.agentId); expect(view.agent.status).toBe('alive'); expect(view.agent.income).toBe('20000');
    expect(view.agent.incomeFees).toBe('200'); expect(view.agent.subsidy).toBe('1011800'); expect(view.agent.burn).toBe('200'); expect(view.agent.openRuns).toBe(0);
    expect(view.agent.livingChildren).toBe(1); expect(view.agent.offspring).toBe(1); expect(view.metrics.netIncome).toBe('19800'); expect(view.metrics.trailing24hBurn).toBe('200');
    expect(view.metrics.balance).toBe((await read(parent.vault, 'AgentVault', 'spendableBalance') as bigint).toString());
    expect(view.metrics.runwayExact).toEqual({ numerator: (BigInt(view.metrics.balance) * 86400n).toString(), denominator: '200', unit: 'seconds' });
    const childView = await indexer.get(owner.address, child.agentId); expect(childView.agent.generation).toBe(1); expect(childView.agent.family).toBe(parent.agentId);
    expect(childView.agent.subsidy).toBe('50000'); expect(childView.agent.income).toBe('4000'); expect(childView.agent.incomeFees).toBe('40');
    expect(await indexer.population()).toMatchObject({ births: 2, alive: 2, dormant: 0, deaths: 0, families: 1, maximumGeneration: 1, lifetimeIncome: '24000', lifetimeBurn: '200' });
    expect((await indexer.list(payer.address)).agents).toEqual([]); await expect(indexer.get(payer.address, parent.agentId)).rejects.toThrow('not found');
  });
  it('persists/reopens the cursor and materialized agents, never duplicates accounting and stays idle without rewriting the cursor', async () => {
    const parent = await enter(); await fund(parent.vault, 12345n); await burn(parent, 'restart-indexed-burn'); await catchUp(); const before = await indexer.get(owner.address, parent.agentId), status = await indexer.status();
    await store.close(); await connect(); await catchUp(); const restored = await indexer.get(owner.address, parent.agentId);
    expect(restored.agent).toEqual(before.agent); expect(restored.metrics).toEqual(before.metrics); expect((await indexer.status()).revision).toBe(status.revision);
    expect((await store.db.select().from(selectionAgents))).toHaveLength(1);
  });
  it('records actual dormancy/revival/death and a public final fossil whose values stay fixed after later guardian activity', async () => {
    const parent = await enter(); await fund(parent.vault, 15000n); await burn(parent, 'fossil-paid-run'); await dormant(parent); await catchUp();
    expect((await indexer.get(owner.address, parent.agentId)).agent.status).toBe('dormant');
    await fund(parent.vault, 2000n, owner); await write(registry, 'SelectionRegistry', 'revive', [parent.agentId]); await catchUp();
    expect((await indexer.get(owner.address, parent.agentId)).agent.status).toBe('alive'); await dormant(parent); await advance(30 * 86400 + 1);
    await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer); await catchUp();
    const fossil = await indexer.fossil(parent.agentId); expect(fossil.fossil.lifetimeIncome).toBe('15000'); expect(fossil.fossil.lifetimeBurn).toBe('200');
    expect(fossil.fossil.lifetimeNetIncome).toBe('14850'); expect(fossil.fossil.lifetimeSubsidy).toBe('1002000'); expect(fossil.fossil.survivalRatio).toEqual({ numerator: '14850', denominator: '200' });
    await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'reviewed public evidence', id('fossil-evidence')], guardian); await catchUp();
    expect((await indexer.fossil(parent.agentId)).fossil).toEqual(fossil.fossil);
    expect(await indexer.population()).toMatchObject({ births: 1, alive: 0, dormant: 0, deaths: 1 });
  });
  it('rolls back orphaned death/fossil and replays a different canonical income history after an actual Anvil reorg', async () => {
    const parent = await enter(); await dormant(parent); await catchUp(); const branch = await test.snapshot();
    await advance(30 * 86400 + 1); await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer); await catchUp();
    expect((await indexer.fossils()).fossils).toHaveLength(1); const orphaned = await indexer.status();
    await test.revert({ id: branch }); await fund(parent.vault, 5555n); await write(registry, 'SelectionRegistry', 'revive', [parent.agentId]);
    const result = await indexer.sync(); expect(result.rollbackBlocks).toBeGreaterThan(0); await catchUp();
    expect((await indexer.fossils()).fossils).toEqual([]); const view = await indexer.get(owner.address, parent.agentId);
    expect(view.agent.status).toBe('alive'); expect(view.agent.income).toBe('5555'); expect(view.agent.incomeFees).toBe('56');
    expect((await indexer.status()).blockHash).not.toBe(orphaned.blockHash);
    const events = await store.db.select().from(selectionEvents).where(eq(selectionEvents.name, 'Death')); expect(events).toEqual([]);
  });
  it('waits for reviewed confirmations and limits each sync to its bounded block page', async () => {
    const parent = await enter(); const confirmed = new SelectionIndexer(store.db, { ...profile, confirmations: 2, maxBlocksPerSync: 2 }, reader);
    const first = await confirmed.sync(); expect(first.processedBlocks).toBeLessThanOrEqual(2); await catchUp(confirmed);
    expect((await confirmed.list(owner.address)).agents).toEqual([]); await test.mine({ blocks: 2 }); await catchUp(confirmed);
    expect((await confirmed.get(owner.address, parent.agentId)).agent.agentId).toBe(parent.agentId);
  });
  it('fails closed on wrong chain/code, log tampering and transient RPC failure without rolling back durable state', async () => {
    await enter(); await catchUp(); const before = await indexer.status();
    await expect(new SelectionIndexer(store.db, { ...profile, chainId: 84532 }, reader).sync()).rejects.toThrow('chain differs');
    await expect(new SelectionIndexer(store.db, { ...profile, registryCodeHash: '0x' + '00'.repeat(32) }, reader).sync()).rejects.toThrow('code differs');
    const transient = new SelectionIndexer(store.db, profile, { ...reader, block: async () => { throw new Error('RPC unavailable'); } });
    await expect(transient.sync()).rejects.toThrow('RPC unavailable'); expect(await indexer.status()).toEqual(before);
    await fund((await read(registry, 'SelectionRegistry', 'getAgent', [await read(registry, 'SelectionRegistry', 'identityAgent', [1n])]) as Agent).vault, 1234n);
    const tampered = new SelectionIndexer(store.db, profile, { ...reader, logs: async (...args) => (await reader.logs(...args)).map(log => ({ ...log, blockHash: '0x' + '00'.repeat(32) })) });
    await expect(tampered.sync()).rejects.toThrow('unavailable'); expect(await indexer.status()).toEqual(before);
    const malformed = new SelectionIndexer(store.db, profile, { ...reader, logs: async (...args) => (await reader.logs(...args)).map(log => ({ ...log, data: '0x' })) });
    await expect(malformed.sync()).rejects.toThrow('Malformed indexed Selection event'); expect(await indexer.status()).toEqual(before);
    const capacity = new SelectionIndexer(store.db, { ...profile, maxEvents: 1 }, reader);
    await expect(capacity.sync()).rejects.toThrow('replay capacity'); expect(await indexer.status()).toEqual(before);
  });
  it('retracts canonical records whose confirmation depth was lost when the chain head shortens, then confirms them again', async () => {
    const parent = await enter(), branch = await test.snapshot(); await test.mine({ blocks: 2 });
    const confirmed = new SelectionIndexer(store.db, { ...profile, confirmations: 2 }, reader); await catchUp(confirmed);
    expect((await confirmed.list(owner.address)).agents).toHaveLength(1); await test.revert({ id: branch });
    const rolled = await confirmed.sync(); expect(rolled.rollbackBlocks).toBe(2); expect((await confirmed.list(owner.address)).agents).toEqual([]);
    await test.mine({ blocks: 2 }); await catchUp(confirmed); expect((await confirmed.get(owner.address, parent.agentId)).agent.agentId).toBe(parent.agentId);
  });
  it('exposes intentionally public fossils and authenticated owner views without indexing/wallet mutation routes', async () => {
    const parent = await enter(); await dormant(parent); await advance(30 * 86400 + 1); await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId]); await catchUp();
    let authenticatedOwner = ''; const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : 503));
    app.route('/api/selection', createSelectionRoutes(indexer, async () => { if (!authenticatedOwner) throw new Problem(401, 'unauthorized', 'Sign in'); return authenticatedOwner; }));
    expect((await app.request('/api/selection/fossils')).status).toBe(200); expect((await app.request('/api/selection/fossils/' + parent.agentId)).status).toBe(200);
    expect((await app.request('/api/selection/agents')).status).toBe(401); authenticatedOwner = owner.address;
    expect((await app.request('/api/selection/agents/' + parent.agentId)).status).toBe(200); authenticatedOwner = payer.address;
    expect((await app.request('/api/selection/agents/' + parent.agentId)).status).toBe(404);
    for (const path of ['sync', 'sign', 'withdraw', 'enter']) expect((await app.request('/api/selection/' + path, { method: 'POST' })).status).toBe(404);
  });
  it('refuses a reorg deeper than configured recovery depth without deleting prior canonical evidence', async () => {
    const shallow = new SelectionIndexer(store.db, { ...profile, maxReorgDepth: 1 }, reader), branch = await test.snapshot();
    await enter(); await test.mine({ blocks: 4 }); await catchUp(shallow); const before = await shallow.status();
    await test.revert({ id: branch }); await test.mine({ blocks: 1 }); await expect(shallow.sync()).rejects.toThrow('exceeds the reviewed recovery depth');
    expect(await shallow.status()).toEqual(before); expect(await store.db.select().from(selectionCursors)).toHaveLength(1);
  });
});
