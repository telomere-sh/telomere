import { and, asc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import type { SelectionDataset, SelectionDatasetRow } from '../selection/dataset.js';
import type { SelectionIndexer } from '../selection/indexer.js';
import { selectionBlocks, selectionCursors, selectionEvents } from '../selection/schema.js';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const day = 86_400;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const seconds = Date.parse(value + 'T00:00:00.000Z') / 1000;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 253_402_128_000 && new Date(seconds * 1000).toISOString().slice(0, 10) === value;
});
const statusSchema = z.enum(['all', 'alive', 'dormant', 'dead']);
const inputSchema = z.object({ from: dateSchema, to: dateSchema, status: statusSchema.default('all'),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict()
  .refine(value => { const days = (Date.parse(value.to) - Date.parse(value.from)) / (day * 1000); return days >= 0 && days < 366; });
const cursorSchema = z.object({ version: z.literal(1), from: dateSchema, to: dateSchema, status: statusSchema,
  indexKey: z.string().regex(/^[0-9a-f]{64}$/), revision: z.number().int().nonnegative().max(2 ** 31 - 1), blockHash: hash,
  height: units.refine(value => BigInt(value) <= 2n ** 63n - 1n), logIndex: z.number().int().nonnegative().max(2 ** 31 - 1) }).strict();
const names = ['Birth', 'Dormant', 'Revived', 'Death', 'Income', 'Burn', 'Subsidy'] as const;
export type SelectionExplorerEventName = typeof names[number];
export type SelectionExplorerRequest = { from: string; to: string; status?: z.infer<typeof statusSchema>; limit?: number; cursor?: string };
type CanonicalPage = Awaited<ReturnType<SelectionDataset['page']>>;
export type SelectionExplorerCanonicalReader = Pick<SelectionDataset, 'page'>;
export type SelectionExplorerIndex = Pick<SelectionIndexer, 'indexKey' | 'profile'>;
export interface SelectionExplorerEvent {
  event: SelectionExplorerEventName; agentId: string; timestampSeconds: string; blockNumber: string; blockHash: string;
  transactionHash: string; logIndex: number; amountUnits: string | null; feeUnits: string | null;
}
export interface SelectionExplorerAgent {
  agentId: string; status: 'alive' | 'dormant' | 'dead'; family: string; parent: string; generation: number;
  bornAt: string; diedAt: string | null; lifespanSeconds: string | null; deathCause: string | null;
  registryIncomeUnits: string; registryIncomeFeeUnits: string; registryBurnUnits: string; registrySubsidyUnits: string;
  actualIncomeUnits: null; eventRefs: { transactionHash: string; logIndex: number }[];
}
export interface SelectionExplorerResponse {
  version: 1; state: 'ready' | 'partial' | 'stale' | 'no_data'; source: 'canonical-persisted-selection-events';
  currency: 'registry-token-base-units'; periodTime: 'block-timestamp';
  period: { from: string; to: string; endExclusive: string; status: z.infer<typeof statusSchema>; statusTime: 'indexed-snapshot' };
  index: CanonicalPage['index']; asOfSeconds: string;
  coverage: { historyStartBlock: string; historyStartSeconds: string; partialStart: boolean; partialEnd: boolean;
    deploymentHistoryVerified: false; stale: boolean; staleAfterSeconds: number };
  events: SelectionExplorerEvent[]; agents: SelectionExplorerAgent[];
  pagination: { limit: number; returnedEvents: number; firstPage: boolean }; nextCursor?: string;
}
const invalid = () => new Problem(422, 'selection_explorer_input', 'Use UTC dates spanning at most 366 days, a lifecycle status and the original cursor.');
const unavailable = () => new Problem(503, 'selection_explorer_unavailable', 'Canonical Selection evidence is unavailable. Retry after indexing.');
const changed = () => new Problem(409, 'selection_explorer_snapshot_changed', 'The indexed snapshot changed. Apply filters again to restart.');
const seconds = (date: string) => BigInt(Date.parse(date + 'T00:00:00.000Z') / 1000);
const isoDate = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
function decodeCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  try { const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) throw invalid();
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown); } catch { throw invalid(); }
}
function sameIndex(a: CanonicalPage['index'], b: CanonicalPage['index']) {
  return a.indexKey === b.indexKey && a.revision === b.revision && a.blockHash === b.blockHash && a.indexedThrough === b.indexedThrough;
}

/** Read-only registry events. Dataset.page remains the canonical chain/profile/ledger guard.
 * No owner, vault funding source, payment reference, job or private account history is returned.
 * Canonical public rows are paged rather than trusting the owner-facing materialized projection.
 */
export class SelectionExplorer {
  constructor(private readonly db: Database, private readonly dataset: SelectionExplorerCanonicalReader,
    private readonly indexer: SelectionExplorerIndex, private readonly now: () => number = Date.now) {}

  async page(input: SelectionExplorerRequest): Promise<SelectionExplorerResponse> {
    const parsed = inputSchema.safeParse(input); if (!parsed.success) throw invalid();
    const request = parsed.data, cursor = decodeCursor(request.cursor), clock = this.now();
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > 253_402_214_400_000) throw unavailable();
    const monday = new Date(clock); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const week = monday.toISOString().slice(0, 10);
    let canonical: CanonicalPage;
    try { canonical = await this.dataset.page({ week, limit: 100 }); } catch { throw unavailable(); }
    if (canonical.index.indexKey !== this.indexer.indexKey) throw unavailable();
    if (BigInt(canonical.coverage.asOfSeconds) > BigInt(Math.floor(clock / 1000)) + 300n) throw unavailable();
    if (cursor && (cursor.from !== request.from || cursor.to !== request.to || cursor.status !== request.status
      || cursor.indexKey !== canonical.index.indexKey || cursor.revision !== canonical.index.revision || cursor.blockHash !== canonical.index.blockHash)) throw changed();
    if (cursor && BigInt(cursor.height) > BigInt(canonical.index.indexedThrough)) throw invalid();
    const agents = new Map<string, SelectionDatasetRow>();
    let part = canonical, pages = 0;
    while (true) {
      if (!sameIndex(canonical.index, part.index)) throw changed();
      for (const row of part.rows) {
        if (agents.has(row.agentId)) throw unavailable(); agents.set(row.agentId, row);
      }
      if (agents.size > this.indexer.profile.maxVaults || ++pages > Math.ceil(this.indexer.profile.maxVaults / 100) + 1) throw unavailable();
      if (!part.nextCursor) break;
      try { part = await this.dataset.page({ week, limit: 100, cursor: part.nextCursor }); } catch { throw unavailable(); }
    }
    const eligible = [...agents.values()].filter(agent => request.status === 'all' || agent.status === request.status).map(agent => agent.agentId);
    const start = seconds(request.from), end = seconds(request.to) + BigInt(day);
    let selected: SelectionExplorerEvent[];
    try {
      selected = await this.db.transaction(async tx => {
        const [saved] = await tx.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexer.indexKey)).limit(1);
        if (!saved || saved.revision !== canonical.index.revision || saved.lastHash !== canonical.index.blockHash
          || saved.nextBlock !== BigInt(canonical.index.indexedThrough) + 1n) throw changed();
        if (!eligible.length) return [];
        const rows = await tx.select({ event: selectionEvents, timestamp: selectionBlocks.timestamp, headerHash: selectionBlocks.hash })
          .from(selectionEvents).innerJoin(selectionBlocks, and(eq(selectionBlocks.indexKey, selectionEvents.indexKey), eq(selectionBlocks.height, selectionEvents.height)))
          .where(and(eq(selectionEvents.indexKey, this.indexer.indexKey), eq(selectionEvents.address, this.indexer.profile.registryAddress),
            inArray(selectionEvents.name, [...names]), inArray(sql<string>`${selectionEvents.args}->>'agentId'`, eligible),
            gte(selectionBlocks.timestamp, start), lt(selectionBlocks.timestamp, end), lt(selectionEvents.height, saved.nextBlock),
            cursor ? or(gt(selectionEvents.height, BigInt(cursor.height)), and(eq(selectionEvents.height, BigInt(cursor.height)), gt(selectionEvents.logIndex, cursor.logIndex))) : undefined))
          .orderBy(asc(selectionEvents.height), asc(selectionEvents.logIndex)).limit(request.limit + 1);
        return rows.map(({ event, timestamp, headerHash }) => {
          if (!names.includes(event.name as SelectionExplorerEventName) || event.blockHash !== headerHash || !hash.safeParse(event.blockHash).success
            || !hash.safeParse(event.transactionHash).success || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0
            || !units.safeParse(timestamp.toString()).success || !hash.safeParse(event.args.agentId).success
            || event.id !== event.transactionHash + ':' + event.logIndex) throw unavailable();
          const monetary = ['Income', 'Burn', 'Subsidy'].includes(event.name);
          const amount = monetary ? units.parse(event.args.amount) : null, fee = event.name === 'Income' ? units.parse(event.args.fee) : null;
          if (fee !== null && amount !== null && BigInt(fee) > BigInt(amount)) throw unavailable();
          return { event: event.name as SelectionExplorerEventName, agentId: String(event.args.agentId), timestampSeconds: timestamp.toString(),
            blockNumber: event.height.toString(), blockHash: event.blockHash, transactionHash: event.transactionHash,
            logIndex: event.logIndex, amountUnits: amount, feeUnits: fee };
        });
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
      const after = await this.dataset.page({ week, limit: 1 }); if (!sameIndex(canonical.index, after.index)) throw changed();
    } catch (error) { if (error instanceof Problem && error.code === 'selection_explorer_snapshot_changed') throw error; throw unavailable(); }
    const events = selected.slice(0, request.limit), staleAfterSeconds = 900;
    const asOf = BigInt(canonical.coverage.asOfSeconds), stale = BigInt(Math.floor(clock / 1000)) - asOf > BigInt(staleAfterSeconds);
    const partialStart = BigInt(canonical.coverage.historyStartSeconds) >= start, partialEnd = asOf < end - 1n;
    const summaries = [...new Set(events.map(event => event.agentId))].map(agentId => {
      const agent = agents.get(agentId); if (!agent) throw unavailable();
      return { agentId, status: agent.status, family: agent.family, parent: agent.parent, generation: agent.generation,
        bornAt: agent.bornAt, diedAt: agent.diedAt, lifespanSeconds: agent.lifespanSeconds, deathCause: agent.deathCause,
        registryIncomeUnits: agent.lifetimeIncomeUnits, registryIncomeFeeUnits: agent.lifetimeIncomeFeeUnits,
        registryBurnUnits: agent.lifetimeBurnUnits, registrySubsidyUnits: agent.lifetimeSubsidyUnits, actualIncomeUnits: null,
        eventRefs: events.filter(event => event.agentId === agentId).map(event => ({ transactionHash: event.transactionHash, logIndex: event.logIndex })) };
    });
    const last = events.at(-1);
    return { version: 1, state: stale ? 'stale' : partialStart || partialEnd ? 'partial' : events.length ? 'ready' : 'no_data',
      source: 'canonical-persisted-selection-events', currency: 'registry-token-base-units', periodTime: 'block-timestamp',
      period: { from: request.from, to: request.to, endExclusive: isoDate(end), status: request.status, statusTime: 'indexed-snapshot' },
      index: canonical.index, asOfSeconds: asOf.toString(),
      coverage: { historyStartBlock: canonical.coverage.historyStartBlock, historyStartSeconds: canonical.coverage.historyStartSeconds,
        partialStart, partialEnd, deploymentHistoryVerified: false, stale, staleAfterSeconds }, events, agents: summaries,
      pagination: { limit: request.limit, returnedEvents: events.length, firstPage: !cursor },
      ...(selected.length > events.length && last ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, from: request.from, to: request.to,
        status: request.status, indexKey: canonical.index.indexKey, revision: canonical.index.revision, blockHash: canonical.index.blockHash,
        height: last.blockNumber, logIndex: last.logIndex })).toString('base64url') } : {}) };
  }
}

/** Mount at /api/public/selection. Feature flag gating belongs to the root dispatcher. */
export function createSelectionExplorerRoutes(explorer?: SelectionExplorer): Hono {
  const routes = new Hono();
  routes.get('/explorer', async context => {
    context.header('Cache-Control', 'no-store');
    if (!explorer) throw new Problem(503, 'selection_explorer_not_configured', 'Selection is not configured. No indexed population is available.');
    const values: Record<string, string> = {};
    for (const [key, value] of new URL(context.req.url).searchParams) {
      if (!['from', 'to', 'status', 'limit', 'cursor'].includes(key) || Object.hasOwn(values, key)) throw invalid(); values[key] = value;
    }
    if (values.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(values.limit)) throw invalid();
    return context.json(await explorer.page({ from: values.from ?? '', to: values.to ?? '',
      ...(values.status === undefined ? {} : { status: values.status as z.infer<typeof statusSchema> }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }), ...(values.cursor === undefined ? {} : { cursor: values.cursor }) }));
  });
  return routes;
}
