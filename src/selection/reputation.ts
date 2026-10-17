import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { keccak256, toHex } from 'viem';
import { z } from 'zod';
import { canonical, Problem } from '../common.js';
import type { Database } from '../store.js';
import { selectionProjection } from './events.js';
import type { SelectionIndexer } from './indexer.js';
import type { SelectionBlock, SelectionReader } from './rpc.js';
import { selectionBlocks, selectionCursors, selectionEvents } from './schema.js';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
const summarySchema = z.object({
  type: z.literal('telomere-selection-death-summary/v1'), agentId: hash, identityId: units,
  lifespanSeconds: units, lifetimeIncomeUnits: units, lifetimeIncomeFeeUnits: units,
  lifetimeNetIncomeUnits: units, lifetimeBurnUnits: units, cause: hash,
  currency: z.literal('registry-token-base-units'),
  evidence: z.object({ chainId: z.number().int().positive(), registryAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    birthBlock: units, deathBlock: units, deathBlockHash: hash, deathTransactionHash: hash,
    deathLogIndex: z.number().int().nonnegative(), bornAtSeconds: units, diedAtSeconds: units }).strict(),
}).strict();
export type SelectionDeathSummary = z.infer<typeof summarySchema>;
const cursorSchema = z.object({ version: z.literal(1), indexKey: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.number().int().nonnegative(), blockHash: hash, lastId: hash }).strict();
const requestSchema = z.object({ limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
export interface SelectionReputationRequest { limit?: number | undefined; cursor?: string | undefined }
type Index = Awaited<ReturnType<SelectionIndexer['status']>> & { indexedThrough: string; blockHash: string };
const unavailable = () => new Problem(503, 'selection_reputation_unavailable', 'Canonical Selection death evidence is unavailable; retry after indexing.');
const invalid = () => new Problem(422, 'selection_reputation_input', 'Use a bounded page size, original cursor and canonical agent or file hash.');
const changed = () => new Problem(409, 'selection_reputation_cursor_changed', 'The Selection snapshot changed; restart the death feed from its first page.');
const notFound = () => new Problem(404, 'selection_reputation_not_found', 'Canonical Selection death summary not found.');
function parseCursor(input: string | undefined) {
  if (input === undefined) return undefined;
  try {
    const bytes = Buffer.from(input, 'base64url'); if (bytes.toString('base64url') !== input) throw invalid();
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch { throw invalid(); }
}
function inputHash(value: string): string { const parsed = hash.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data; }
function query(context: Context): SelectionReputationRequest {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(context.req.url).searchParams) {
    if (!['limit', 'cursor'].includes(key) || Object.hasOwn(values, key)) throw invalid(); values[key] = value;
  }
  if (values.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(values.limit)) throw invalid();
  return { ...(values.limit === undefined ? {} : { limit: Number(values.limit) }), ...(values.cursor === undefined ? {} : { cursor: values.cursor }) };
}
function record(summary: SelectionDeathSummary) {
  const content = canonical(summary), feedbackHash = keccak256(toHex(content));
  return { summary, feedbackHash, content, publication: 'feed-only' as const };
}

/** Derived solely from the persisted, confirmed Selection ledger. No caller-supplied
 * metrics, private runtime state, signatures, financial writes or feedback broadcasts.
 * Content is stable across index advances, but orphaned summaries are retracted.
 */
export class SelectionReputation {
  constructor(private readonly db: Database, private readonly indexer: SelectionIndexer, private readonly reader: SelectionReader) {}

  private async canonical(index: Index, anchor: SelectionBlock, profileHash: string): Promise<void> {
    const [chain, code, head, actual] = await Promise.all([this.reader.chainId(), this.reader.codeHash(index.registryAddress),
      this.reader.head(), this.reader.block(BigInt(index.indexedThrough))]);
    if (chain !== index.chainId || !hash.safeParse(code).success || this.indexer.profile.registryCodeHash && code !== this.indexer.profile.registryCodeHash
      || createHash('sha256').update(JSON.stringify([index.indexKey, code])).digest('hex') !== profileHash
      || head < BigInt(index.indexedThrough) + BigInt(index.confirmations)
      || actual.height !== anchor.height || actual.hash !== anchor.hash || actual.timestamp !== anchor.timestamp) throw unavailable();
  }

  private async snapshot(cursor: ReturnType<typeof parseCursor>) {
    try {
      const result = await this.db.transaction(async tx => {
        const [saved] = await tx.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexer.indexKey)).limit(1);
        const profile = this.indexer.profile;
        if (!saved || saved.nextBlock <= profile.startBlock || !hash.safeParse(saved.lastHash).success
          || !Number.isInteger(saved.revision) || saved.revision < 0) throw unavailable();
        const index: Index = { indexKey: this.indexer.indexKey, chainId: profile.chainId, registryAddress: profile.registryAddress,
          confirmations: profile.confirmations, indexedThrough: (saved.nextBlock - 1n).toString(), blockHash: saved.lastHash!, revision: saved.revision };
        if (cursor && (cursor.indexKey !== index.indexKey || cursor.revision !== index.revision || cursor.blockHash !== index.blockHash)) throw changed();
        const [anchor] = await tx.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, index.indexKey),
          eq(selectionBlocks.height, saved.nextBlock - 1n))).limit(1);
        const [first] = await tx.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, index.indexKey),
          eq(selectionBlocks.height, profile.startBlock))).limit(1);
        if (!anchor || !first || anchor.hash !== index.blockHash || first.timestamp < 0n || first.timestamp > anchor.timestamp) throw unavailable();
        await this.canonical(index, anchor, saved.profileHash);
        const events = await tx.select().from(selectionEvents).where(eq(selectionEvents.indexKey, index.indexKey))
          .orderBy(asc(selectionEvents.height), asc(selectionEvents.logIndex)).limit(profile.maxEvents + 1);
        const headers = await tx.selectDistinct({ height: selectionBlocks.height, hash: selectionBlocks.hash,
          parentHash: selectionBlocks.parentHash, timestamp: selectionBlocks.timestamp }).from(selectionBlocks)
          .innerJoin(selectionEvents, and(eq(selectionEvents.indexKey, selectionBlocks.indexKey), eq(selectionEvents.height, selectionBlocks.height)))
          .where(eq(selectionBlocks.indexKey, index.indexKey)).limit(profile.maxEvents + 1);
        if (events.length > profile.maxEvents || headers.length > profile.maxEvents) throw unavailable();
        const blocks = new Map(headers.map(block => [block.height, block])), positions = new Set<string>();
        for (const event of events) {
          const block = blocks.get(event.height), position = `${event.height}:${event.logIndex}`;
          if (!block || block.hash !== event.blockHash || event.height < profile.startBlock || event.height >= saved.nextBlock
            || block.timestamp < first.timestamp || block.timestamp > anchor.timestamp || !hash.safeParse(event.transactionHash).success
            || event.id !== event.transactionHash + ':' + event.logIndex || !Number.isInteger(event.logIndex) || event.logIndex < 0
            || positions.has(position) || Object.keys(event.args).length > 16 || Object.values(event.args).some(value => typeof value !== 'boolean'
              && (typeof value !== 'string' || value.length > 8194))) throw unavailable();
          positions.add(position);
        }
        const projection = selectionProjection(events.map(event => ({ ...event, topics: [], data: '0x' })), blocks, index.registryAddress);
        if (projection.agents.size > profile.maxVaults) throw unavailable();
        const deaths = new Map<string, typeof events[number]>();
        for (const event of events) if (event.address === index.registryAddress && event.name === 'Death') {
          const agentId = hash.parse(event.args.agentId);
          if (deaths.has(agentId)) throw unavailable();
          deaths.set(agentId, event);
        }
        const records = [...projection.fossils.values()].map(fossil => {
          const agent = projection.agents.get(fossil.agentId), death = deaths.get(fossil.agentId);
          if (!agent || !death || death.transactionHash !== fossil.deathTransaction || death.blockHash !== fossil.deathBlockHash
            || death.height.toString() !== fossil.deathBlock) throw unavailable();
          return { ...record(summarySchema.parse({ type: 'telomere-selection-death-summary/v1', agentId: fossil.agentId,
            identityId: fossil.identityId, lifespanSeconds: fossil.lifespanSeconds, lifetimeIncomeUnits: fossil.lifetimeIncome,
            lifetimeIncomeFeeUnits: fossil.lifetimeIncomeFees, lifetimeNetIncomeUnits: fossil.lifetimeNetIncome,
            lifetimeBurnUnits: fossil.lifetimeBurn, cause: fossil.cause, currency: 'registry-token-base-units',
            evidence: { chainId: index.chainId, registryAddress: index.registryAddress, birthBlock: agent.birthBlock,
              deathBlock: fossil.deathBlock, deathBlockHash: fossil.deathBlockHash, deathTransactionHash: fossil.deathTransaction,
              deathLogIndex: death.logIndex, bornAtSeconds: fossil.bornAt, diedAtSeconds: fossil.diedAt } })), originalOwner: fossil.owner };
        }).sort((a, b) => a.summary.agentId.localeCompare(b.summary.agentId));
        return { records, index, anchor, profileHash: saved.profileHash,
          coverage: { historyStartBlock: profile.startBlock.toString(), historyStartSeconds: first.timestamp.toString(),
            asOfSeconds: anchor.timestamp.toString(), deploymentHistoryVerified: false as const, source: 'confirmed-indexed-events' as const } };
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
      await this.canonical(result.index, result.anchor, result.profileHash);
      const [current] = await this.db.select().from(selectionCursors).where(eq(selectionCursors.key, result.index.indexKey)).limit(1);
      if (!current || current.revision !== result.index.revision || current.lastHash !== result.index.blockHash
        || current.nextBlock !== BigInt(result.index.indexedThrough) + 1n || current.profileHash !== result.profileHash) throw unavailable();
      return result;
    } catch (error) {
      if (error instanceof Problem && error.code === 'selection_reputation_cursor_changed') throw error;
      throw unavailable();
    }
  }

  async page(input: SelectionReputationRequest = {}) {
    const parsed = requestSchema.safeParse(input); if (!parsed.success) throw invalid();
    const cursor = parseCursor(parsed.data.cursor), snapshot = await this.snapshot(cursor);
    const candidates = snapshot.records.filter(row => !cursor || row.summary.agentId > cursor.lastId), rows = candidates.slice(0, parsed.data.limit);
    const nextCursor = candidates.length > rows.length ? Buffer.from(JSON.stringify({ version: 1, indexKey: snapshot.index.indexKey,
      revision: snapshot.index.revision, blockHash: snapshot.index.blockHash, lastId: rows.at(-1)!.summary.agentId })).toString('base64url') : undefined;
    return { version: 1 as const, index: snapshot.index, coverage: snapshot.coverage,
      summaries: rows.map(({ content: _content, originalOwner: _originalOwner, ...row }) => row),
      pagination: { limit: parsed.data.limit, returnedRows: rows.length, totalRowsInSnapshot: snapshot.records.length, afterAgentId: cursor?.lastId ?? null },
      ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
  async death(agentValue: string) {
    const agentId = inputHash(agentValue), snapshot = await this.snapshot(undefined), row = snapshot.records.find(value => value.summary.agentId === agentId);
    if (!row) throw notFound();
    const { content: _content, originalOwner: _originalOwner, ...entry } = row; return { ...entry, index: snapshot.index, coverage: snapshot.coverage };
  }
  /** Private canonical birth owner; never included in the public death feed. */
  async origin(agentValue: string) {
    const agentId = inputHash(agentValue), snapshot = await this.snapshot(undefined), row = snapshot.records.find(value => value.summary.agentId === agentId);
    if (!row) throw notFound();
    return { owner: row.originalOwner, feedbackHash: row.feedbackHash, index: snapshot.index };
  }
  async file(hashValue: string) {
    const feedbackHash = inputHash(hashValue), snapshot = await this.snapshot(undefined), row = snapshot.records.find(value => value.feedbackHash === feedbackHash);
    if (!row) throw notFound(); return { content: row.content, feedbackHash: row.feedbackHash };
  }
}

/** Public facts only. Queries cannot write metrics, publish reputation or initiate RPC sync. */
export function createSelectionReputationRoutes(reputation: SelectionReputation): Hono {
  const routes = new Hono();
  routes.use('/reputation/*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.get('/reputation/deaths', async context => context.json(await reputation.page(query(context))));
  routes.get('/reputation/deaths/:id', async context => {
    if (new URL(context.req.url).search) throw invalid(); return context.json(await reputation.death(context.req.param('id')));
  });
  routes.get('/reputation/files/:hash', async context => {
    if (new URL(context.req.url).search) throw invalid(); const file = await reputation.file(context.req.param('hash'));
    context.header('Content-Type', 'application/json; charset=utf-8'); context.header('ETag', '"' + file.feedbackHash + '"'); return context.body(file.content);
  });
  return routes;
}
