import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Problem } from '../src/common.js';
import type { Database } from '../src/store.js';
import { SelectionDataset } from '../src/selection/dataset.js';
import { selectionProjection, type SelectionDecodedEvent } from '../src/selection/events.js';
import { SelectionIndexer } from '../src/selection/indexer.js';
import type { SelectionBlock, SelectionReader } from '../src/selection/rpc.js';
import { selectionAgents, selectionBlocks, selectionCursors, selectionEvents, selectionMigrationSQL, selectionSchema } from '../src/selection/schema.js';
import { AgentEconomics, createAgentEconomicsRoutes } from '../src/updates/agent-economics.js';

const hash = (name: string) => '0x' + createHash('sha256').update(name).digest('hex');
const address = (value: number) => '0x' + value.toString(16).padStart(40, '0');
const seconds = (value: string) => BigInt(Date.parse(value + 'Z') / 1000);
const registry = address(1), owner = address(2), source = address(3), parent = hash('parent'), zero = '0x' + '0'.repeat(64);
const code = hash('registry-code'), cause = hash('balance'), nowSeconds = seconds('2030-01-09T12:00:00');
const input = { agentId: parent, from: '2030-01-01', to: '2030-01-08' };

describe('public agent economics canonical view', () => {
  let pg: PGlite, db: Database, indexer: SelectionIndexer, dataset: SelectionDataset, reader: SelectionReader, service: AgentEconomics;
  let blocks: Map<bigint, SelectionBlock>, ledger: SelectionDecodedEvent[], height: bigint;
  const add = (name: string, agentId: string, timestamp: bigint, args: Record<string, string | boolean> = {}, at = registry) => {
    const number = BigInt(ledger.length + 2), block = { height: number, hash: hash('block-' + number), parentHash: hash('block-' + (number - 1n)), timestamp };
    blocks.set(number, block); const transactionHash = hash('tx-' + number);
    ledger.push({ name, address: at, height: number, blockHash: block.hash, transactionHash, logIndex: 0, topics: [], data: '0x', args: { agentId, ...args } });
  };
  const birth = (id: string, vault: string, at: bigint, parentId = zero) => add('Birth', id, at,
    { parent: parentId, owner, vault, identityId: '1', leashId: hash('leash-' + id), cystHash: hash('cyst-' + id), endowment: '100' });
  const app = (value: AgentEconomics | undefined = service) => {
    const app = new Hono(); app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_error' }, error instanceof Problem ? error.status : 500));
    app.route('/api/public/selection', createAgentEconomicsRoutes(value)); return app;
  };
  beforeEach(async () => {
    pg = new PGlite(); await pg.exec(selectionMigrationSQL); db = drizzle(pg, { schema: selectionSchema, casing: 'snake_case' }) as unknown as Database;
    blocks = new Map([[1n, { height: 1n, hash: hash('block-1'), parentHash: hash('block-0'), timestamp: seconds('2030-01-01T00:00:00') }]]); ledger = [];
    birth(parent, address(10), seconds('2030-01-02T00:00:00'));
    const child = hash('child-0'), childBorn = seconds('2030-01-03T00:00:00'), died = seconds('2030-01-05T00:00:00');
    birth(child, address(11), childBorn, parent);
    add('Dormant', child, seconds('2030-01-04T00:00:00'), { dormantAt: seconds('2030-01-04T00:00:00').toString(), deathAt: died.toString() });
    add('Death', child, died, { lifespan: (died - childBorn).toString(), lifetimeIncome: '0', lifetimeBurn: '0', cause });
    for (let count = 1; count <= 3; count++) birth(hash('child-' + count), address(11 + count), seconds('2030-01-06T00:00:00'), parent);
    add('Income', parent, seconds('2030-01-07T12:00:00'), { amount: '9007199254740993', fee: '90071992547410', source, paymentRef: hash('payment') });
    add('FundsReceived', parent, seconds('2030-01-07T12:00:00'), { grossAmount: '9007199254740993', incomeFee: '90071992547410', source, paymentRef: hash('payment') }, address(10));
    const incomeEvent = ledger[ledger.length - 2]!, mirror = ledger[ledger.length - 1]!;
    mirror.transactionHash = incomeEvent.transactionHash; mirror.logIndex = 1; mirror.height = incomeEvent.height; mirror.blockHash = incomeEvent.blockHash;
    add('Subsidy', parent, seconds('2030-01-08T12:00:00'), { amount: '333', source: owner, paymentRef: hash('top-up') });
    add('Burn', parent, seconds('2030-01-09T11:00:00'), { amount: '20', paidAt: seconds('2030-01-09T11:00:00').toString(), runId: hash('run') });
    height = BigInt(ledger.length + 2); blocks.set(height, { height, hash: hash('anchor'), parentHash: hash('block-' + (height - 1n)), timestamp: nowSeconds });
    reader = { chainId: async () => 8453, head: async () => height + 2n, block: async at => { const result = blocks.get(at); if (!result) throw new Error('Missing block'); return result; },
      codeHash: async () => code, logs: async () => [], spendableBalance: vi.fn(async () => '1000') };
    indexer = new SelectionIndexer(db, { reviewed: true, chainId: 8453, registryAddress: registry, registryCodeHash: code,
      startBlock: 1n, confirmations: 2, maxEvents: 100, maxVaults: 16 }, reader);
    await db.insert(selectionCursors).values({ key: indexer.indexKey, profileHash: createHash('sha256').update(JSON.stringify([indexer.indexKey, code])).digest('hex'),
      nextBlock: height + 1n, lastHash: hash('anchor'), revision: 4 });
    await db.insert(selectionBlocks).values([...blocks.values()].map(block => ({ indexKey: indexer.indexKey, ...block })));
    await db.insert(selectionEvents).values(ledger.map(event => ({ indexKey: indexer.indexKey, id: event.transactionHash + ':' + event.logIndex,
      height: event.height, blockHash: event.blockHash, transactionHash: event.transactionHash, logIndex: event.logIndex, address: event.address, name: event.name, args: event.args })));
    const projected = selectionProjection(ledger, blocks, registry);
    await db.insert(selectionAgents).values([...projected.agents.values()].map(data => ({ indexKey: indexer.indexKey, agentId: data.agentId, owner: data.owner, vault: data.vault, data })));
    dataset = new SelectionDataset(db, indexer, reader, () => Number(nowSeconds * 1000n));
    service = new AgentEconomics(db, dataset, indexer, reader, () => Number(nowSeconds * 1000n));
  });
  afterEach(async () => { await pg.close(); });

  it('uses the actual PGlite canonical dataset guard and separates exact Income, Fee, Net, Burn and Subsidy', async () => {
    const data = await service.get(input);
    expect(data.state).toBe('partial'); expect(data.coverage.partialStart).toBe(true);
    expect(data.totals).toEqual({ incomeUnits: '9007199254740993', feeUnits: '90071992547410', netIncomeUnits: '8917127262193583', burnUnits: '0', subsidyUnits: '333' });
    expect(data.daily.find(row => row.date === '2030-01-07')).toMatchObject({ incomeUnits: '9007199254740993', feeUnits: '90071992547410', netIncomeUnits: '8917127262193583', subsidyUnits: '0' });
    expect(data.daily.find(row => row.date === '2030-01-08')).toMatchObject({ incomeUnits: '0', subsidyUnits: '333' });
    expect(data.agent?.lifetime.burnUnits).toBe('20'); expect(data.coverage.verifiedEarnedUnits).toBeNull();
    expect(data.coverage).toMatchObject({ earningsProvenance: 'registry-classification-only', unclassifiedTransfers: 'excluded', deploymentHistoryVerified: false });
    expect(data.agent).toMatchObject({ livingChildren: 3, lifetimeOffspring: 4 });
    expect(data.metrics).toMatchObject({ spendableBalanceUnits: '1000', balanceAtBlock: height.toString(), trailing24hBurnUnits: '20',
      metabolism: { numerator: '20', denominator: '86400' }, runway: { numerator: '86400000', denominator: '20', unit: 'seconds' } });
    expect(reader.spendableBalance).toHaveBeenCalledWith(address(10), height);
    const serialized = JSON.stringify(data); for (const secret of [owner, source, address(10), hash('payment'), hash('top-up'), 'identityId', 'leashId', 'cystHash']) expect(serialized).not.toContain(secret);
  });

  it('filters mirror-vault Income by registry address, even with an injected canonical dataset reader', async () => {
    const canonical = await dataset.page({ week: '2030-01-07', limit: 100 });
    await db.insert(selectionEvents).values({ indexKey: indexer.indexKey, id: hash('mirror') + ':1', height, blockHash: hash('anchor'), transactionHash: hash('mirror'),
      logIndex: 1, address: address(10), name: 'Income', args: { agentId: parent, amount: '777777', fee: '0' } });
    const injected = new AgentEconomics(db, { page: async () => canonical }, indexer, reader, () => Number(nowSeconds * 1000n));
    expect((await injected.get(input)).totals.incomeUnits).toBe('9007199254740993');
    await expect(service.get(input)).rejects.toMatchObject({ status: 503 });
  });

  it('fails closed when RPC anchor changes after the pinned historical balance read', async () => {
    const changing = { ...reader, spendableBalance: async (vault: string, at: bigint) => {
      const balance = await reader.spendableBalance(vault, at); blocks.set(height, { ...blocks.get(height)!, hash: hash('reorg') }); return balance;
    } };
    await expect(new AgentEconomics(db, dataset, indexer, changing, () => Number(nowSeconds * 1000n)).get(input)).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a revision advance between before/after guards instead of mixing snapshots', async () => {
    let calls = 0;
    const advancing = { page: async (...args: Parameters<SelectionDataset['page']>) => {
      const result = await dataset.page(...args); return ++calls > 1 ? { ...result, index: { ...result.index, revision: result.index.revision + 1 } } : result;
    } };
    await expect(new AgentEconomics(db, advancing, indexer, reader, () => Number(nowSeconds * 1000n)).get(input)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a changed profile and inconsistent public projection', async () => {
    await db.update(selectionAgents).set({ data: { ...(await db.select().from(selectionAgents).where(eq(selectionAgents.agentId, parent)))[0]!.data, livingChildren: 2 } }).where(eq(selectionAgents.agentId, parent));
    await expect(service.get(input)).rejects.toMatchObject({ status: 503 });
    await db.update(selectionCursors).set({ profileHash: '0'.repeat(64) }); await expect(service.get(input)).rejects.toMatchObject({ status: 503 });
  });

  it('rejects orphaned event headers through the actual canonical dataset guard', async () => {
    const income = ledger.find(event => event.name === 'Income')!;
    await db.update(selectionBlocks).set({ hash: hash('orphan') }).where(eq(selectionBlocks.height, income.height));
    await expect(service.get(input)).rejects.toMatchObject({ status: 503 });
    expect(reader.spendableBalance).not.toHaveBeenCalled();
  });

  it('reports stale anchors and partial end coverage instead of declaring complete observations', async () => {
    const stale = new AgentEconomics(db, dataset, indexer, reader, () => Number((nowSeconds + 901n) * 1000n));
    const data = await stale.get({ ...input, from: '2030-01-08', to: '2030-01-10' });
    expect(data.state).toBe('stale'); expect(data.coverage).toMatchObject({ stale: true, partialStart: false, partialEnd: true });
    expect(data.asOfSeconds).toBe(nowSeconds.toString());
  });

  it('shows death reason and dormancy deadline, and keeps empty periods distinct from missing agents', async () => {
    const dead = await service.get({ ...input, agentId: hash('child-0') });
    expect(dead.agent).toMatchObject({ status: 'dead', deathCause: cause, dormantAt: seconds('2030-01-04T00:00:00').toString(), deathAt: seconds('2030-01-05T00:00:00').toString() });
    expect(dead.metrics?.runway).toBeNull(); expect(dead.metrics?.runwayReason).toBe('dead');
    const empty = await service.get({ ...input, from: '2030-01-03', to: '2030-01-03' }); expect(empty.state).toBe('no_data'); expect(empty.agent?.agentId).toBe(parent);
    const missing = await service.get({ ...input, agentId: hash('missing') }); expect(missing.state).toBe('no_data'); expect(missing.agent).toBeNull(); expect(missing.metrics).toBeNull();
  });

  it('bounds dates inclusively at 366 days and rejects malformed, duplicate and unknown public parameters', async () => {
    const readerSpy = vi.spyOn(reader, 'spendableBalance');
    for (const request of [{ ...input, from: '2030-02-30' }, { ...input, from: '1969-12-31' }, { ...input, to: '2029-12-31' },
      { ...input, to: '2031-01-02' }, { ...input, agentId: 'bad' }]) await expect(service.get(request)).rejects.toMatchObject({ status: 422 });
    expect(readerSpy).not.toHaveBeenCalled();
    const endpoint = '/api/public/selection/agents/' + parent;
    for (const suffix of ['?from=2030-01-01&to=2030-01-08&from=2030-01-02', '?from=2030-01-01&to=2030-01-08&owner=' + owner]) expect((await app().request(endpoint + suffix)).status).toBe(422);
    expect((await service.get({ ...input, from: '2029-01-08', to: '2030-01-08' })).daily).toHaveLength(366);
    const result = await app().request(endpoint + '?from=2030-01-01&to=2030-01-08'); expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store');
    const unconfigured = new Hono(); unconfigured.onError((error, context) => context.json({ title: (error as Problem).code }, (error as Problem).status));
    unconfigured.route('/api/public/selection', createAgentEconomicsRoutes());
    const response = await unconfigured.request(endpoint + '?from=2030-01-01&to=2030-01-08'); expect(response.status).toBe(503); expect(await response.json()).toEqual({ title: 'agent_economics_not_configured' });
    expect((await app().request(endpoint, { method: 'POST' })).status).toBe(404);
  });
});
