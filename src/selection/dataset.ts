import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { selectionProjection, type SelectionDecodedEvent } from './events.js';
import type { SelectionIndexer } from './indexer.js';
import type { SelectionBlock, SelectionReader } from './rpc.js';
import { selectionBlocks, selectionCursors, selectionEvents } from './schema.js';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const epochMaximum = 253_402_300_799n;
const day = 86_400n, weekSeconds = 7n * day;
const unavailable = () => new Problem(503, 'selection_dataset_unavailable', 'The canonical Selection dataset is unavailable; retry after indexing.');
const invalid = () => new Problem(422, 'selection_dataset_input', 'Use a UTC Monday week, bounded page size and original cursor.');
const changed = () => new Problem(409, 'selection_dataset_cursor_changed', 'The Selection snapshot changed; restart this week from its first page.');
const weekSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && date.getUTCDay() === 1 && date.getTime() >= 0
    && BigInt(date.getTime() / 1000) + weekSeconds <= epochMaximum;
});
const requestSchema = z.object({ week: weekSchema, limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const cursorSchema = z.object({ version: z.literal(1), week: weekSchema, indexKey: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.number().int().nonnegative().max(2 ** 31 - 1), blockHash: hash, lastId: hash }).strict();
const rowSchema = z.object({ agentId: hash, family: hash, parent: hash, generation: z.number().int().nonnegative().max(1024),
  status: z.enum(['alive', 'dormant', 'dead']), frozen: z.boolean(), bornAt: units, diedAt: units.nullable(),
  lifespanSeconds: units.nullable(), deathCause: hash.nullable(), offspring: z.number().int().nonnegative().max(1024),
  weeklyIncomeUnits: units, weeklyIncomeFeeUnits: units, weeklyNetIncomeUnits: units, weeklyBurnUnits: units, weeklySubsidyUnits: units,
  lifetimeIncomeUnits: units, lifetimeIncomeFeeUnits: units, lifetimeNetIncomeUnits: units, lifetimeBurnUnits: units, lifetimeSubsidyUnits: units }).strict();
export type SelectionDatasetRow = z.infer<typeof rowSchema>;
export interface SelectionDatasetRequest { week: string; limit?: number | undefined; cursor?: string | undefined }
type Index = Awaited<ReturnType<SelectionIndexer['status']>> & { indexedThrough: string; blockHash: string };
type Coverage = { weekStart: string; weekEndExclusive: string; asOfSeconds: string; historyStartBlock: string;
  historyStartSeconds: string; partialStart: boolean; partialEnd: boolean; currentWeek: boolean; deploymentHistoryVerified: false };
type Snapshot = { index: Index; coverage: Coverage; rows: SelectionDatasetRow[];
  daily: { date: string; births: number; deaths: number }[] };
const currency = 'registry-token-base-units' as const;

function date(seconds: bigint): string { return new Date(Number(seconds) * 1000).toISOString().slice(0, 10); }
function parseRequest(input: SelectionDatasetRequest) {
  const parsed = requestSchema.safeParse(input); if (!parsed.success) throw invalid(); return parsed.data;
}
function parseCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw invalid();
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch { throw invalid(); }
}
function median(values: readonly bigint[]): { numerator: string; denominator: '1' | '2' } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? { numerator: sorted[middle]!.toString(), denominator: '1' }
    : { numerator: (sorted[middle - 1]! + sorted[middle]!).toString(), denominator: '2' };
}
function distribution(values: readonly bigint[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { minimum: sorted[0]!.toString(), p10: sorted[Math.ceil(sorted.length / 10) - 1]!.toString(), median: median(sorted),
    p90: sorted[Math.ceil(sorted.length * 9 / 10) - 1]!.toString(), maximum: sorted.at(-1)!.toString(), method: 'nearest-rank' as const };
}
function total(rows: readonly SelectionDatasetRow[], key: 'weeklyIncomeUnits' | 'weeklyIncomeFeeUnits' | 'weeklyNetIncomeUnits' | 'weeklyBurnUnits' | 'weeklySubsidyUnits') {
  return rows.reduce((sum, row) => sum + BigInt(row[key]), 0n).toString();
}
function query(context: Context, analytics = false): SelectionDatasetRequest {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(context.req.url).searchParams) {
    if (Object.hasOwn(values, key) || !['week', ...(analytics ? [] : ['limit', 'cursor'])].includes(key)) throw invalid();
    values[key] = value;
  }
  if (values.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(values.limit)) throw invalid();
  return parseRequest({ week: values.week ?? '', ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.cursor === undefined ? {} : { cursor: values.cursor }) });
}

/** A public, bounded view of the reviewed registry's persisted event ledger.
 * It never reads private job/payment histories, balances, keys or mutable RPC state.
 * The cursor pins one indexed snapshot; a reorg or index advance requires restart.
 */
export class SelectionDataset {
  constructor(private readonly db: Database, private readonly indexer: SelectionIndexer, private readonly reader: SelectionReader,
    private readonly now: () => number = Date.now) {}

  private async canonical(index: Index, anchor: SelectionBlock, profileHash: string): Promise<void> {
    const [chain, code, head, actual] = await Promise.all([this.reader.chainId(), this.reader.codeHash(index.registryAddress),
      this.reader.head(), this.reader.block(BigInt(index.indexedThrough))]);
    if (chain !== index.chainId || !hash.safeParse(code).success || this.indexer.profile.registryCodeHash && code !== this.indexer.profile.registryCodeHash
      || createHash('sha256').update(JSON.stringify([index.indexKey, code])).digest('hex') !== profileHash
      || head < BigInt(index.indexedThrough) + BigInt(index.confirmations)
      || actual.height !== anchor.height || actual.hash !== anchor.hash || actual.timestamp !== anchor.timestamp) throw unavailable();
  }

  private async snapshot(week: string, cursor: ReturnType<typeof parseCursor>): Promise<Snapshot> {
    try {
      const result = await this.db.transaction(async tx => {
        const [saved] = await tx.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexer.indexKey)).limit(1);
        const profile = this.indexer.profile;
        if (!saved || saved.nextBlock <= profile.startBlock || !hash.safeParse(saved.lastHash).success
          || !Number.isInteger(saved.revision) || saved.revision < 0) throw unavailable();
        const index: Index = { indexKey: this.indexer.indexKey, chainId: profile.chainId, registryAddress: profile.registryAddress,
          confirmations: profile.confirmations, indexedThrough: (saved.nextBlock - 1n).toString(), blockHash: saved.lastHash!, revision: saved.revision };
        if (cursor && (cursor.week !== week || cursor.indexKey !== index.indexKey || cursor.revision !== index.revision || cursor.blockHash !== index.blockHash)) throw changed();
        const [anchor] = await tx.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, index.indexKey),
          eq(selectionBlocks.height, saved.nextBlock - 1n))).limit(1);
        const [first] = await tx.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, index.indexKey),
          eq(selectionBlocks.height, profile.startBlock))).limit(1);
        if (!anchor || !first || anchor.hash !== index.blockHash || anchor.timestamp < first.timestamp
          || first.timestamp < 0n || anchor.timestamp > epochMaximum) throw unavailable();
        await this.canonical(index, anchor, saved.profileHash);
        const ledger = await tx.select().from(selectionEvents).where(eq(selectionEvents.indexKey, index.indexKey))
          .orderBy(asc(selectionEvents.height), asc(selectionEvents.logIndex)).limit(profile.maxEvents + 1);
        if (ledger.length > profile.maxEvents) throw unavailable();
        // Join only event-bearing heights. Empty blocks do not grow this memory bound.
        const headers = await tx.selectDistinct({ height: selectionBlocks.height, hash: selectionBlocks.hash,
          parentHash: selectionBlocks.parentHash, timestamp: selectionBlocks.timestamp }).from(selectionBlocks)
          .innerJoin(selectionEvents, and(eq(selectionEvents.indexKey, selectionBlocks.indexKey), eq(selectionEvents.height, selectionBlocks.height)))
          .where(eq(selectionBlocks.indexKey, index.indexKey)).limit(profile.maxEvents + 1);
        if (headers.length > profile.maxEvents) throw unavailable();
        const blocks = new Map(headers.map(block => [block.height, block]));
        const start = BigInt(new Date(week + 'T00:00:00.000Z').getTime() / 1000), end = start + weekSeconds;
        const included: SelectionDecodedEvent[] = [], daily = Array.from({ length: 7 }, (_, offset) => ({ date: date(start + BigInt(offset) * day), births: 0, deaths: 0 }));
        const weekValues = new Map<string, { income: bigint; fee: bigint; burn: bigint; subsidy: bigint }>();
        for (const event of ledger) {
          const block = blocks.get(event.height);
          if (!block || block.hash !== event.blockHash || event.height < profile.startBlock || event.height >= saved.nextBlock
            || block.timestamp < first.timestamp || block.timestamp > anchor.timestamp || !hash.safeParse(event.transactionHash).success
            || !Number.isInteger(event.logIndex) || event.logIndex < 0
            || Object.keys(event.args).length > 16 || Object.values(event.args).some(value => typeof value !== 'boolean'
              && (typeof value !== 'string' || value.length > 8194))) throw unavailable();
          if (block.timestamp >= end) continue;
          included.push({ ...event, topics: [], data: '0x' });
          if (block.timestamp < start || event.address !== index.registryAddress) continue;
          const offset = Number((block.timestamp - start) / day);
          if (event.name === 'Birth') daily[offset]!.births++;
          if (event.name === 'Death') daily[offset]!.deaths++;
          if (!['Income', 'Subsidy', 'Burn'].includes(event.name)) continue;
          const id = hash.parse(event.args.agentId), value = BigInt(units.parse(event.args.amount));
          const aggregate = weekValues.get(id) ?? { income: 0n, fee: 0n, burn: 0n, subsidy: 0n };
          if (event.name === 'Income') { aggregate.income += value; aggregate.fee += BigInt(units.parse(event.args.fee)); }
          else if (event.name === 'Burn') aggregate.burn += value;
          else aggregate.subsidy += value;
          weekValues.set(id, aggregate);
        }
        const projected = selectionProjection(included, blocks, index.registryAddress);
        if (projected.agents.size > profile.maxVaults) throw unavailable();
        const rows = [...projected.agents.values()].map(agent => {
          const weekly = weekValues.get(agent.agentId) ?? { income: 0n, fee: 0n, burn: 0n, subsidy: 0n }, fossil = projected.fossils.get(agent.agentId);
          return rowSchema.parse({ agentId: agent.agentId, family: agent.family, parent: agent.parent, generation: agent.generation,
            status: agent.status, frozen: agent.frozen, bornAt: agent.bornAt, diedAt: fossil?.diedAt ?? null,
            lifespanSeconds: fossil?.lifespanSeconds ?? null, deathCause: fossil?.cause ?? null, offspring: agent.offspring,
            weeklyIncomeUnits: weekly.income.toString(), weeklyIncomeFeeUnits: weekly.fee.toString(), weeklyNetIncomeUnits: (weekly.income - weekly.fee).toString(),
            weeklyBurnUnits: weekly.burn.toString(), weeklySubsidyUnits: weekly.subsidy.toString(), lifetimeIncomeUnits: agent.income,
            lifetimeIncomeFeeUnits: agent.incomeFees, lifetimeNetIncomeUnits: (BigInt(agent.income) - BigInt(agent.incomeFees)).toString(),
            lifetimeBurnUnits: agent.burn, lifetimeSubsidyUnits: agent.subsidy });
        }).sort((a, b) => a.agentId.localeCompare(b.agentId));
        const clock = this.now(); if (!Number.isSafeInteger(clock) || clock < 0 || BigInt(Math.floor(clock / 1000)) > epochMaximum) throw unavailable();
        const seconds = BigInt(Math.floor(clock / 1000));
        const coverage: Coverage = { weekStart: week, weekEndExclusive: date(end), asOfSeconds: (anchor.timestamp < end ? anchor.timestamp : end - 1n).toString(),
          historyStartBlock: profile.startBlock.toString(), historyStartSeconds: first.timestamp.toString(),
          partialStart: first.timestamp >= start, partialEnd: anchor.timestamp < end, currentWeek: seconds >= start && seconds < end,
          deploymentHistoryVerified: false };
        return { index, coverage, rows, daily, anchor, profileHash: saved.profileHash };
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
      await this.canonical(result.index, result.anchor, result.profileHash);
      const [current] = await this.db.select().from(selectionCursors).where(eq(selectionCursors.key, result.index.indexKey)).limit(1);
      if (!current || current.revision !== result.index.revision || current.lastHash !== result.index.blockHash
        || current.nextBlock !== BigInt(result.index.indexedThrough) + 1n || current.profileHash !== result.profileHash) throw unavailable();
      return result;
    } catch (error) {
      if (error instanceof Problem && error.code === 'selection_dataset_cursor_changed') throw error;
      throw unavailable();
    }
  }

  async page(input: SelectionDatasetRequest) {
    const request = parseRequest(input), cursor = parseCursor(request.cursor), snapshot = await this.snapshot(request.week, cursor);
    const candidates = snapshot.rows.filter(row => cursor === undefined || row.agentId > cursor.lastId), rows = candidates.slice(0, request.limit);
    const nextCursor = candidates.length > rows.length ? Buffer.from(JSON.stringify({ version: 1, week: request.week,
      indexKey: snapshot.index.indexKey, revision: snapshot.index.revision, blockHash: snapshot.index.blockHash, lastId: rows.at(-1)!.agentId })).toString('base64url') : undefined;
    return { version: 1 as const, currency, periodTime: 'block-timestamp' as const, index: snapshot.index, coverage: snapshot.coverage,
      pagination: { limit: request.limit, afterAgentId: cursor?.lastId ?? null, returnedRows: rows.length,
        totalRowsInSnapshot: snapshot.rows.length, firstPage: cursor === undefined },
      rows, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
  async csv(input: SelectionDatasetRequest) {
    const page = await this.page(input), keys = Object.keys(rowSchema.shape) as (keyof SelectionDatasetRow)[];
    const prefix = ['recordType', 'weekStart', 'weekEndExclusive', 'currency', 'periodTime', 'indexKey', 'revision', 'indexedThrough', 'blockHash',
      'asOfSeconds', 'historyStartBlock', 'historyStartSeconds', 'partialStart', 'partialEnd', 'currentWeek', 'deploymentHistoryVerified',
      'limit', 'afterAgentId', 'returnedRows', 'totalRowsInSnapshot', 'firstPage', 'hasMore', 'nextCursor'];
    // Quote every cell, double embedded quotes and use RFC 4180 CRLF, including a final newline.
    const quote = (value: string | number | boolean | null) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const common = [page.coverage.weekStart, page.coverage.weekEndExclusive, page.currency, page.periodTime, page.index.indexKey, page.index.revision,
      page.index.indexedThrough, page.index.blockHash, page.coverage.asOfSeconds, page.coverage.historyStartBlock, page.coverage.historyStartSeconds,
      page.coverage.partialStart, page.coverage.partialEnd, page.coverage.currentWeek, false, page.pagination.limit, page.pagination.afterAgentId,
      page.pagination.returnedRows, page.pagination.totalRowsInSnapshot, page.pagination.firstPage, page.nextCursor !== undefined, page.nextCursor ?? null];
    // The downloaded artifact retains coverage and pagination without HTTP headers,
    // including an empty week. Consumers distinguish metadata from agent records.
    const records = [['metadata', ...common, ...keys.map(() => null)],
      ...page.rows.map(row => ['agent', ...common, ...keys.map(key => row[key])])];
    return { ...page, csv: [[...prefix, ...keys].map(quote).join(','), ...records.map(record => record.map(quote).join(','))].join('\r\n') + '\r\n' };
  }
  async analytics(input: { week: string }) {
    const request = parseRequest(input), snapshot = await this.snapshot(request.week, undefined), rows = snapshot.rows;
    return { version: 1 as const, currency, index: snapshot.index, coverage: snapshot.coverage,
      population: { entered: rows.length, alive: rows.filter(row => row.status === 'alive').length,
        dormant: rows.filter(row => row.status === 'dormant').length, dead: rows.filter(row => row.status === 'dead').length,
        frozen: rows.filter(row => row.frozen).length, families: new Set(rows.map(row => row.family)).size,
        maximumGeneration: rows.reduce((maximum, row) => Math.max(maximum, row.generation), 0) }, daily: snapshot.daily,
      weekly: { incomeUnits: total(rows, 'weeklyIncomeUnits'), incomeFeeUnits: total(rows, 'weeklyIncomeFeeUnits'),
        netIncomeUnits: total(rows, 'weeklyNetIncomeUnits'), burnUnits: total(rows, 'weeklyBurnUnits'), subsidyUnits: total(rows, 'weeklySubsidyUnits') },
      medianCompletedLifespanSeconds: median(rows.flatMap(row => row.lifespanSeconds === null ? [] : [BigInt(row.lifespanSeconds)])),
      distribution: { population: 'agents-born-before-week-end' as const, incomeUnits: distribution(rows.map(row => BigInt(row.weeklyIncomeUnits))),
        burnUnits: distribution(rows.map(row => BigInt(row.weeklyBurnUnits))),
        netIncomeVsBurn: { above: rows.filter(row => BigInt(row.weeklyNetIncomeUnits) > BigInt(row.weeklyBurnUnits)).length,
          equal: rows.filter(row => row.weeklyNetIncomeUnits === row.weeklyBurnUnits).length,
          below: rows.filter(row => BigInt(row.weeklyNetIncomeUnits) < BigInt(row.weeklyBurnUnits)).length } },
      topIncome: [...rows].filter(row => row.weeklyIncomeUnits !== '0').sort((a, b) => {
        const left = BigInt(a.weeklyIncomeUnits), right = BigInt(b.weeklyIncomeUnits);
        return left > right ? -1 : left < right ? 1 : a.agentId.localeCompare(b.agentId);
      }).slice(0, 10).map(row => ({ agentId: row.agentId, incomeUnits: row.weeklyIncomeUnits, incomeFeeUnits: row.weeklyIncomeFeeUnits, netIncomeUnits: row.weeklyNetIncomeUnits })),
      evidence: { income: 'registry-Income-events', burn: 'registry-Burn-events', source: 'canonical-persisted-selection-events', periodTime: 'block-timestamp' } };
  }
}

export function createSelectionDatasetRoutes(dataset: SelectionDataset): Hono {
  const routes = new Hono();
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.get('/dataset', async context => context.json(await dataset.page(query(context))));
  routes.get('/dataset.csv', async context => {
    const result = await dataset.csv(query(context));
    context.header('Content-Type', 'text/csv; charset=utf-8');
    context.header('Content-Disposition', 'attachment; filename="selection-' + result.coverage.weekStart + '.csv"');
    context.header('Cache-Control', 'no-store');
    // Coverage and canonical evidence remain available when the CSV has no data rows.
    const metadata = { 'Index-Key': result.index.indexKey, Revision: result.index.revision,
      'Indexed-Through': result.index.indexedThrough, 'Block-Hash': result.index.blockHash,
      'Week-Start': result.coverage.weekStart, 'Week-End-Exclusive': result.coverage.weekEndExclusive,
      'As-Of-Seconds': result.coverage.asOfSeconds, 'History-Start-Block': result.coverage.historyStartBlock,
      'History-Start-Seconds': result.coverage.historyStartSeconds, 'Partial-Start': result.coverage.partialStart,
      'Partial-End': result.coverage.partialEnd, 'Current-Week': result.coverage.currentWeek,
      'Deployment-History-Verified': result.coverage.deploymentHistoryVerified, Currency: result.currency, 'Period-Time': result.periodTime,
      'Page-Limit': result.pagination.limit, 'After-Agent-Id': result.pagination.afterAgentId ?? '',
      'Returned-Rows': result.pagination.returnedRows, 'Total-Rows-In-Snapshot': result.pagination.totalRowsInSnapshot, 'First-Page': result.pagination.firstPage };
    for (const [name, value] of Object.entries(metadata)) context.header('X-Selection-' + name, String(value));
    if (result.nextCursor) context.header('X-Selection-Next-Cursor', result.nextCursor);
    return context.body(result.csv);
  });
  routes.get('/analytics', async context => context.json(await dataset.analytics(query(context, true))));
  return routes;
}
