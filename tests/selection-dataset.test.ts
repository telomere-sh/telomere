import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import solc from 'solc';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, http, keccak256, maxUint256, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { projectRoot } from '../scripts/compile-contracts.js';
import { startLocalChain, unusedLocalPort } from '../scripts/local-chain.js';
import { loadConfig } from '../src/config.js';
import { startPilot } from '../src/main.js';
import { localChain, quoteTypedData, settlementTypedData, type Quote } from '../src/chain/index.js';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import { SelectionDataset, createSelectionDatasetRoutes } from '../src/selection/dataset.js';
import { SelectionIndexer, type SelectionIndexProfile } from '../src/selection/indexer.js';
import { createSelectionReader, type SelectionReader } from '../src/selection/rpc.js';
import { selectionBlocks, selectionCursors, selectionEvents } from '../src/selection/schema.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Artifact = { abi: Abi; bytecode: Hex };
type Agent = { owner: Address; agentWallet: Address; vault: Address; leashId: Hex; cystHash: Hex; status: number; family: Hex };
const id = (value: string): Hex => keccak256(toHex(value));
const week = '2030-01-07', nextWeek = '2030-01-14';
const epoch = (value: string) => BigInt(Date.parse(value + 'T00:00:00.000Z') / 1000);
const start = epoch(week), end = epoch(nextWeek);

function csvRecords(text: string): Record<string, string>[] {
  const lines = text.split('\r\n'); expect(lines.pop()).toBe('');
  const cells = (line: string) => {
    const values: string[] = []; let offset = 0;
    for (const match of line.matchAll(/"((?:[^"\r\n]|"")*)"(?:,|$)/g)) {
      expect(match.index).toBe(offset); offset += match[0].length; values.push(match[1]!.replaceAll('""', '"'));
    }
    expect(offset).toBe(line.length); return values;
  };
  const keys = cells(lines.shift()!);
  return lines.map(line => { const values = cells(line); expect(values).toHaveLength(keys.length);
    return Object.fromEntries(keys.map((key, index) => [key, values[index]!])); });
}

function compile(): Record<string, Artifact> {
  const paths = ['contracts/SelectionRegistry.sol', 'contracts/AgentVault.sol', 'contracts/TelomereRunEscrow.sol', 'contracts/MockToken.sol'];
  const fixture = 'tests/DatasetDependencies.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [fixture]: { content: 'pragma solidity ^0.8.28; contract DatasetIdentity { mapping(uint256=>address) public ownerOf; function register(uint256 n,address o) external { require(block.chainid==31337 && ownerOf[n]==address(0)); ownerOf[n]=o; } } contract DatasetGrace { function graceExtension(bytes32) external view returns(uint64) { require(block.chainid==31337); return 0; } }' } };
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

describe('bounded weekly Selection datasets from real indexed canonical events', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, chain: ReturnType<typeof createTestClient>, artifacts: Record<string, Artifact>;
  let owner: Account, controller: Account, guardian: Account, payer: Account, agentKey: Account, childKey: Account, treasury: Account;
  let controllerPrivateKey: Hex;
  let token: Address, escrow: Address, registry: Address, identity: Address, deployment: bigint, baseline: Hex;
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, reader: SelectionReader, indexer: SelectionIndexer, dataset: SelectionDataset;
  let profile: SelectionIndexProfile, server: Server | undefined, origin: string;
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
  async function at(timestamp: bigint) { await chain.setNextBlockTimestamp({ timestamp }); }
  async function enter(number = 1n, account = agentKey) {
    await write(registry, 'SelectionRegistry', 'enter', [{ identityId: number, agentWallet: account.address, maxPerHour: 20_000_000n,
      maxPerDay: 200_000_000n, expiry: await now() + 200n * 86400n, cystHash: id('encrypted-state'), endowment: 1_000_000n }]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [number]) as Hex;
    return { agentId, ...await read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Agent };
  }
  async function fund(agent: { vault: Address }, amount: bigint, source = payer, when?: bigint) {
    await write(token, 'MockToken', 'approve', [agent.vault, amount], source);
    if (when !== undefined) await at(when);
    await write(agent.vault, 'AgentVault', 'receiveFunds', [amount, id('dataset-funding')], source);
  }
  async function burn(agent: Awaited<ReturnType<typeof enter>>, label = 'dataset-receipted-burn') {
    const quote: Quote = { runId: id(label), leashId: agent.leashId, payer: agent.vault, workloadHash: id('workload'),
      maxSeconds: 3n, pricePerSecond: 100n, inferencePrice: 0n, quoteExpiry: await now() + 300n };
    await write(agent.vault, 'AgentVault', 'payRun', [quote, await controller.signTypedData(quoteTypedData(31337, escrow, quote))], agentKey);
    await chain.increaseTime({ seconds: 3 }); await chain.mine({ blocks: 1 });
    const settlement = { runId: quote.runId, billableSeconds: 2n, inferenceCharge: 0n, receiptHash: id(label + '-receipt') };
    await write(escrow, 'TelomereRunEscrow', 'settleRun', [settlement, await controller.signTypedData(settlementTypedData(31337, escrow, settlement))], payer);
    await write(agent.vault, 'AgentVault', 'syncRun', [quote.runId], payer);
  }
  async function dormant(agent: Awaited<ReturnType<typeof enter>>) {
    const cash = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (cash) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [cash]);
    await chain.increaseTime({ seconds: 86401 }); await chain.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDormant', [agent.agentId], payer);
  }
  async function connect() {
    store = await openStore({ DATA_DIR: join(directory, 'database') }); reader = createSelectionReader(local.rpcUrl);
    indexer = new SelectionIndexer(store.db, profile, reader);
    dataset = new SelectionDataset(store.db, indexer, reader, () => Number(start + 86400n) * 1000);
  }
  async function catchUp(target = indexer) {
    for (let attempt = 0; attempt < 30; attempt++) if ((await target.sync()).processedBlocks === 0) return;
    throw new Error('Index exceeded bounded fixture pages');
  }
  async function httpServer(value = dataset) {
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_error' }, error instanceof Problem ? error.status : 503));
    app.route('/api/selection', createSelectionDatasetRoutes(value));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture');
    origin = 'http://127.0.0.1:' + address.port;
  }

  beforeAll(async () => {
    artifacts = compile(); local = await startLocalChain(); chain = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    const keys = Array.from({ length: 7 }, () => generatePrivateKey()); controllerPrivateKey = keys[1]!;
    [owner, controller, guardian, payer, agentKey, childKey, treasury] = keys.map(key => privateKeyToAccount(key)) as [Account, Account, Account, Account, Account, Account, Account];
    for (const account of [owner, controller, guardian, payer, agentKey, childKey, treasury]) await chain.setBalance({ address: account.address, value: parseEther('10') });
    await at(start - 43200n);
    token = (await deploy('MockToken')).contractAddress!;
    escrow = (await deploy('TelomereRunEscrow', [token, controller.address, controller.address, treasury.address])).contractAddress!;
    identity = (await deploy('DatasetIdentity')).contractAddress!;
    const grace = (await deploy('DatasetGrace')).contractAddress!;
    const receipt = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking: grace, treasury: treasury.address, entryFee: 100n, vaultFloor: 1000n }]);
    registry = receipt.contractAddress!; deployment = receipt.blockNumber;
    for (const account of [owner, controller, payer, agentKey, childKey, treasury]) await write(token, 'MockToken', 'faucet', [account.address, 2n ** 95n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256]);
    for (let value = 1n; value <= 4n; value++) await write(identity, 'DatasetIdentity', 'register', [value, owner.address]);
    baseline = await chain.snapshot();
  }, 60000);
  afterAll(async () => { await local?.close(); });
  beforeEach(async () => {
    await chain.revert({ id: baseline }); baseline = await chain.snapshot(); directory = await mkdtemp(join(tmpdir(), 'telomere-selection-dataset-'));
    profile = { reviewed: true, chainId: 31337, registryAddress: registry, registryCodeHash: await createSelectionReader(local.rpcUrl).codeHash(registry),
      startBlock: deployment, confirmations: 0, maxBlocksPerSync: 16, maxReorgDepth: 64, maxEvents: 2000, maxVaults: 16 };
    await connect(); server = undefined;
  });
  afterEach(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await store?.close();
    if (directory) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-selection-dataset-')) throw new Error('Unexpected fixture directory');
      await rm(target, { recursive: true, force: true });
    }
  });

  it('exports exact classified income, excluded subsidy and settled burn through actual public JSON/CSV HTTP', async () => {
    await at(start); const parent = await enter();
    const amount = 9_007_199_254_740_993n;
    await fund(parent, amount); await fund(parent, 1234n, owner); await burn(parent); await catchUp(); await httpServer();
    const response = await fetch(origin + '/api/selection/dataset?week=' + week);
    expect(response.status).toBe(200);
    const body = await response.json() as Awaited<ReturnType<SelectionDataset['page']>>;
    expect(body.currency).toBe('registry-token-base-units'); expect(body.periodTime).toBe('block-timestamp');
    expect(body.rows).toHaveLength(1); expect(body.rows[0]).toMatchObject({ agentId: parent.agentId, weeklyIncomeUnits: amount.toString(),
      weeklyIncomeFeeUnits: ((amount + 99n) / 100n).toString(), weeklyBurnUnits: '200', weeklySubsidyUnits: '1001234' });
    expect(body.coverage).toMatchObject({ partialStart: false, partialEnd: true, currentWeek: true, deploymentHistoryVerified: false });
    const serialized = JSON.stringify(body);
    for (const privateValue of [owner.address.toLowerCase(), parent.vault.toLowerCase(), parent.leashId, payer.address.toLowerCase(), 'paymentRef', 'recoveryKey']) expect(serialized).not.toContain(privateValue);
    const csv = await fetch(origin + '/api/selection/dataset.csv?week=' + week);
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('Cache-Control')).toBe('no-store'); expect(csv.headers.get('Content-Disposition')).toContain(week);
    const text = await csv.text(); expect(text).toContain('"' + amount.toString() + '"');
    expect(text.split('\r\n')).toHaveLength(4); expect(text.split('\n').every(line => !line || line.endsWith('\r'))).toBe(true);
    expect(text.split('\r\n').filter(Boolean).every(line => /^"[^\r\n]*"$/.test(line))).toBe(true);
    const records = csvRecords(text); expect(records.map(record => record.recordType)).toEqual(['metadata', 'agent']);
    expect(records[0]).toMatchObject({ agentId: '', partialStart: 'false', partialEnd: 'true', deploymentHistoryVerified: 'false', hasMore: 'false', nextCursor: '' });
    for (const path of ['sync', 'sign', 'dataset', 'analytics']) expect((await fetch(origin + '/api/selection/' + path, { method: 'POST' })).status).toBe(404);
  });

  it('replays historical state through exclusive UTC week-end instead of leaking later materialized state', async () => {
    await at(start); const parent = await enter(); await fund(parent, 10_001n); await burn(parent);
    await fund(parent, 22_222n, payer, end);
    await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'CSV formula =SUM(1,2), "quoted"\nprivate owner message', id('freeze')], guardian);
    const future = await enter(2n, childKey); await catchUp();
    const old = await dataset.page({ week });
    expect(old.rows).toHaveLength(1); expect(old.rows[0]).toMatchObject({ agentId: parent.agentId, frozen: false, weeklyIncomeUnits: '10001', lifetimeIncomeUnits: '10001' });
    expect(old.coverage.partialEnd).toBe(false); expect(JSON.stringify(old)).not.toContain(future.agentId);
    const later = await dataset.page({ week: nextWeek });
    expect(later.rows).toHaveLength(2); expect(later.rows.find(row => row.agentId === parent.agentId)).toMatchObject({ frozen: true, weeklyIncomeUnits: '22222', lifetimeIncomeUnits: '32223' });
    expect((await dataset.csv({ week: nextWeek })).csv).not.toContain('SUM');
    const analytics = await dataset.analytics({ week }); expect(analytics.daily[0]).toEqual({ date: week, births: 1, deaths: 0 });
    expect(analytics.weekly.incomeUnits).toBe('10001'); expect(analytics.population.entered).toBe(1);
    expect(analytics.evidence.periodTime).toBe('block-timestamp');
    const early = await dataset.page({ week: '2029-12-31' });
    expect(early.rows).toEqual([]); expect(early.coverage).toMatchObject({ partialStart: true, partialEnd: false, deploymentHistoryVerified: false });
    await httpServer();
    const empty = await fetch(origin + '/api/selection/dataset.csv?week=2029-12-31');
    const emptyRecords = csvRecords(await empty.text());
    expect(emptyRecords).toHaveLength(1); expect(emptyRecords[0]).toMatchObject({ recordType: 'metadata', agentId: '', weekStart: '2029-12-31',
      partialStart: 'true', partialEnd: 'false', deploymentHistoryVerified: 'false', blockHash: early.index.blockHash,
      firstPage: 'true', afterAgentId: '', returnedRows: '0', totalRowsInSnapshot: '0', hasMore: 'false', nextCursor: '' });
    expect(empty.headers.get('X-Selection-Partial-Start')).toBe('true'); expect(empty.headers.get('X-Selection-Partial-End')).toBe('false');
    expect(empty.headers.get('X-Selection-Deployment-History-Verified')).toBe('false');
    expect(empty.headers.get('X-Selection-Block-Hash')).toBe(early.index.blockHash);
    expect(empty.headers.get('X-Selection-Revision')).toBe(String(early.index.revision));
    expect(empty.headers.get('X-Selection-Period-Time')).toBe('block-timestamp');
  });

  it('paginates deterministically with original week/index/revision/hash binding and stable CSV after reopening the store', async () => {
    await at(start); const parent = await enter(), secondAgent = await enter(2n, childKey);
    await fund(parent, 1n); await fund(secondAgent, 2n); await catchUp();
    const analytics = await dataset.analytics({ week });
    expect(analytics.distribution.incomeUnits?.median).toEqual({ numerator: '3', denominator: '2' });
    expect(analytics.topIncome.map(row => row.incomeUnits)).toEqual(['2', '1']);
    const first = await dataset.page({ week, limit: 1 }); expect(first.nextCursor).toBeDefined();
    expect(first.pagination).toEqual({ limit: 1, afterAgentId: null, returnedRows: 1, totalRowsInSnapshot: 2, firstPage: true });
    const firstCSV = await dataset.csv({ week, limit: 1 }), csv = csvRecords(firstCSV.csv);
    expect(csv.map(record => record.recordType)).toEqual(['metadata', 'agent']);
    expect(csv[0]).toMatchObject({ hasMore: 'true', nextCursor: first.nextCursor, revision: String(first.index.revision), agentId: '',
      firstPage: 'true', afterAgentId: '', limit: '1', returnedRows: '1', totalRowsInSnapshot: '2' });
    expect(csv[1]!.agentId).toBe(first.rows[0]!.agentId);
    const second = await dataset.page({ week, limit: 1, cursor: first.nextCursor });
    expect(second.pagination).toEqual({ limit: 1, afterAgentId: first.rows[0]!.agentId, returnedRows: 1, totalRowsInSnapshot: 2, firstPage: false });
    expect(second.nextCursor).toBeUndefined(); expect(second.rows[0]!.agentId > first.rows[0]!.agentId).toBe(true);
    const secondCSV = csvRecords((await dataset.csv({ week, limit: 1, cursor: first.nextCursor })).csv);
    expect(secondCSV[0]).toMatchObject({ hasMore: 'false', nextCursor: '', firstPage: 'false', afterAgentId: first.rows[0]!.agentId,
      limit: '1', returnedRows: '1', totalRowsInSnapshot: '2' });
    const completeCSV = await dataset.csv({ week }); await store.close(); await connect();
    expect((await dataset.csv({ week })).csv).toBe(completeCSV.csv);
    for (const mutation of [{ week: nextWeek }, { revision: first.index.revision + 1 }, { indexKey: 'a'.repeat(64) }, { blockHash: '0x' + '0'.repeat(64) }]) {
      const cursor = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as object, ...mutation })).toString('base64url');
      await expect(dataset.page({ week, cursor })).rejects.toMatchObject({ status: 409, code: 'selection_dataset_cursor_changed' });
    }
    await fund({ vault: (await indexer.list(owner.address)).agents[0]!.vault as Address }, 100n); await catchUp();
    await expect(dataset.page({ week, cursor: first.nextCursor })).rejects.toMatchObject({ status: 409 });
  });

  it('aggregates public daily deaths, completed lifespan median and income/burn distributions from canonical fossils', async () => {
    await at(start); const parent = await enter(); await fund(parent, 1001n); await burn(parent); await dormant(parent);
    const dormantState = await read(registry, 'SelectionRegistry', 'getAgent', [parent.agentId]) as Agent & { deathAt: bigint };
    await at(dormantState.deathAt); await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer); await catchUp();
    const deathTime = await now(), deathDate = new Date(Number(deathTime) * 1000), weekday = (deathDate.getUTCDay() + 6) % 7;
    const deathWeek = new Date(Date.UTC(deathDate.getUTCFullYear(), deathDate.getUTCMonth(), deathDate.getUTCDate() - weekday)).toISOString().slice(0, 10);
    const result = await dataset.analytics({ week: deathWeek });
    expect(result.population).toMatchObject({ entered: 1, alive: 0, dormant: 0, dead: 1 });
    expect(result.daily[weekday]!.deaths).toBe(1);
    const row = (await dataset.page({ week: deathWeek })).rows[0]!;
    expect(row.deathCause).toBe(toHex('balance', { size: 32 })); expect(row.lifetimeIncomeUnits).toBe('1001'); expect(row.lifetimeBurnUnits).toBe('200');
    expect(result.medianCompletedLifespanSeconds).toEqual({ numerator: row.lifespanSeconds, denominator: '1' });
    expect(result.weekly.incomeUnits).toBe('0'); expect(result.topIncome).toEqual([]);
    expect(result.distribution.incomeUnits?.median).toEqual({ numerator: '0', denominator: '1' });
  });

  it('rejects an orphaned canonical snapshot before resync and replaces its public income after an actual Anvil reorg', async () => {
    await at(start); const parent = await enter(); await catchUp(); const branch = await chain.snapshot();
    await fund(parent, 777n); await catchUp(); const orphan = await dataset.page({ week }); expect(orphan.rows[0]!.weeklyIncomeUnits).toBe('777');
    await chain.revert({ id: branch }); await fund(parent, 888n);
    await expect(dataset.page({ week })).rejects.toMatchObject({ status: 503, code: 'selection_dataset_unavailable' });
    expect((await indexer.sync()).rollbackBlocks).toBeGreaterThan(0); await catchUp();
    const canonical = await dataset.page({ week }); expect(canonical.rows[0]!.weeklyIncomeUnits).toBe('888'); expect(canonical.index.blockHash).not.toBe(orphan.index.blockHash);
  });

  it('fails closed if canonical evidence changes between the two RPC checks or confirmation depth is lost', async () => {
    await at(start); const parent = await enter(); await fund(parent, 123n); await catchUp();
    let calls = 0;
    const changing = new SelectionDataset(store.db, indexer, { ...reader, block: async height => {
      const block = await reader.block(height); return ++calls === 2 ? { ...block, hash: '0x' + '0'.repeat(64) } : block;
    } });
    await expect(changing.page({ week })).rejects.toMatchObject({ status: 503 });
    const branch = await chain.snapshot(); await chain.mine({ blocks: 2 });
    const confirmed = new SelectionIndexer(store.db, { ...profile, confirmations: 2 }, reader); await catchUp(confirmed);
    const value = new SelectionDataset(store.db, confirmed, reader); expect((await value.page({ week })).rows).toHaveLength(1);
    await chain.revert({ id: branch }); await expect(value.page({ week })).rejects.toMatchObject({ status: 503 });
  });

  it('redacts provider failure and fails closed on missing event anchors, unindexed state and reviewed capacity', async () => {
    await expect(dataset.page({ week })).rejects.toMatchObject({ status: 503 });
    await at(start); const parent = await enter(); await fund(parent, 321n); await catchUp();
    const failed = new SelectionDataset(store.db, indexer, { ...reader, head: async () => { throw new Error('private-provider-api-key'); } });
    await httpServer(failed); const response = await fetch(origin + '/api/selection/dataset?week=' + week);
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"title":"selection_dataset_unavailable"}');
    const capacity = new SelectionIndexer(store.db, { ...profile, maxEvents: 1 }, reader);
    await expect(new SelectionDataset(store.db, capacity, reader).page({ week })).rejects.toMatchObject({ status: 503 });
    const ledger = await store.db.select().from(selectionEvents); const birth = ledger.find(event => event.name === 'Birth')!;
    await store.db.delete(selectionBlocks).where(eq(selectionBlocks.height, birth.height));
    await expect(dataset.page({ week })).rejects.toMatchObject({ status: 503 });
    expect(await store.db.select().from(selectionCursors)).toHaveLength(1);
  });

  it('rejects non-Mondays, invalid dates/epoch bounds, duplicate/unknown query keys and malformed or oversized cursors before RPC', async () => {
    let dispatched = 0;
    const value = new SelectionDataset(store.db, indexer, { ...reader, chainId: async () => { dispatched++; return 31337; } });
    await httpServer(value);
    for (const suffix of ['week=2030-01-08', 'week=2030-02-30', 'week=1969-12-29', 'week=9999-12-27',
      'week=' + week + '&week=' + week, 'week=' + week + '&owner=' + owner.address, 'week=' + week + '&limit=0',
      'week=' + week + '&limit=101', 'week=' + week + '&limit=01', 'week=' + week + '&cursor=' + 'a'.repeat(513),
      'week=' + week + '&cursor=malformed', 'week=' + week + '&limit=1&limit=2']) {
      const response = await fetch(origin + '/api/selection/dataset?' + suffix); expect(response.status, suffix).toBe(422);
    }
    expect((await fetch(origin + '/api/selection/analytics?week=' + week + '&limit=1')).status).toBe(422);
    expect(dispatched).toBe(0);
  });

  it('serves public canonical datasets through the configured pilot and retains them after a real server/database restart', async () => {
    await at(start); const parent = await enter(); await fund(parent, 12345n);
    const port = await unusedLocalPort(), address = 'http://127.0.0.1:' + port;
    const config = loadConfig({ MODE: 'demo', DATA_DIR: join(directory, 'pilot'), PORT: String(port), HOST: '127.0.0.1',
      RPC_URL: local.rpcUrl, PUBLIC_ORIGIN: address, LOG_LEVEL: 'error', SIGNER_PRIVATE_KEY: controllerPrivateKey,
      DEMO_PRIVATE_KEY: '0x' + '1'.repeat(64), ESCROW_ADDRESS: escrow, TOKEN_ADDRESS: token,
      SELECTION_ENABLED: 'true', SELECTION_REGISTRY_ADDRESS: registry, SELECTION_CODE_HASH: profile.registryCodeHash,
      SELECTION_START_BLOCK: deployment.toString(), SELECTION_CONFIRMATIONS: '0' });
    let pilot = await startPilot(config);
    try {
      const indexed = pilot.platform.selection;
      if (!indexed) throw new Error('Configured pilot did not create Selection indexing');
      await catchUp(indexed);
      const endpoint = address + '/api/selection/dataset?week=' + week;
      const first = await fetch(endpoint); expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
      const page = await first.json() as Awaited<ReturnType<SelectionDataset['page']>>;
      expect(page.rows).toHaveLength(1); expect(page.rows[0]).toMatchObject({ agentId: parent.agentId, weeklyIncomeUnits: '12345', weeklyIncomeFeeUnits: '124' });
      expect(JSON.stringify(page)).not.toContain(owner.address.toLowerCase());
      expect((await fetch(address + '/api/selection/agents')).status).toBe(401);
      expect((await fetch(address + '/api/selection/analytics?week=' + week)).status).toBe(200);
      const reputation = await fetch(address + '/api/selection/reputation/deaths');
      expect(reputation.status).toBe(200); expect(reputation.headers.get('cache-control')).toBe('no-store');
      expect(await reputation.json()).toMatchObject({ version: 1, summaries: [] });
      const csv = await (await fetch(address + '/api/selection/dataset.csv?week=' + week)).text();
      expect(csvRecords(csv)[1]).toMatchObject({ recordType: 'agent', agentId: parent.agentId, weeklyIncomeUnits: '12345' });
      await pilot.close(); pilot = await startPilot(config); await catchUp(pilot.platform.selection!);
      expect(await (await fetch(endpoint)).json()).toEqual(page);
      expect(await (await fetch(address + '/api/selection/dataset.csv?week=' + week)).text()).toBe(csv);
      expect(await (await fetch(address + '/api/selection/reputation/deaths')).json()).toMatchObject({ version: 1, summaries: [] });
      expect(await local.publicClient.getTransactionCount({ address: controller.address })).toBe(0);
    } finally { await pilot.close(); }
  }, 30000);
});
