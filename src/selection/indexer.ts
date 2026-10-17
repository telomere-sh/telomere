import { createHash } from 'node:crypto';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { decodeSelectionEvent, selectionProjection, type SelectionDecodedEvent } from './events.js';
import type { SelectionBlock, SelectionLog, SelectionReader } from './rpc.js';
import { selectionAgents, selectionBlocks, selectionCursors, selectionEvents, selectionFossils } from './schema.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const profileSchema = z.object({ reviewed: z.literal(true), chainId: z.number().int().positive().max(2 ** 31 - 1), registryAddress: addressSchema,
  startBlock: z.bigint().nonnegative().max(2n ** 63n - 1n), confirmations: z.number().int().min(0).max(10_000), registryCodeHash: hashSchema.optional(),
  maxBlocksPerSync: z.number().int().min(1).max(256).default(64), maxReorgDepth: z.number().int().min(1).max(256).default(64),
  maxEvents: z.number().int().min(1).max(100_000).default(50_000), maxVaults: z.number().int().min(1).max(1024).default(1024) }).strict();
export type SelectionIndexProfile = z.input<typeof profileSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => new Problem(503, 'selection_index_unavailable', 'Selection index is unavailable; retain the reviewed profile and retry.');
export class SelectionIndexer {
  readonly profile: z.output<typeof profileSchema>; readonly indexKey: string;
  #syncing: Promise<{ indexedThrough: string | null; processedBlocks: number; rollbackBlocks: number }> | undefined;
  constructor(private readonly db: Database, profile: SelectionIndexProfile, private readonly reader: SelectionReader) {
    this.profile = profileSchema.parse(profile);
    this.indexKey = digest([this.profile.chainId, this.profile.registryAddress, this.profile.startBlock.toString(), this.profile.confirmations]);
  }
  async sync(): Promise<{ indexedThrough: string | null; processedBlocks: number; rollbackBlocks: number }> {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.synchronize();
    try { return await this.#syncing; } finally { this.#syncing = undefined; }
  }
  private async synchronize() {
    if (await this.reader.chainId() !== this.profile.chainId) throw new Problem(503, 'selection_chain_mismatch', 'Selection RPC chain differs from the reviewed profile.');
    const codeHash = await this.reader.codeHash(this.profile.registryAddress);
    if (this.profile.registryCodeHash && codeHash !== this.profile.registryCodeHash) throw new Problem(503, 'selection_code_mismatch', 'Selection registry code differs from the reviewed deployment.');
    const profileHash = digest([this.indexKey, codeHash]);
    const [cursor] = await this.db.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexKey)).limit(1);
    if (cursor && cursor.profileHash !== profileHash) throw new Problem(503, 'selection_code_mismatch', 'Selection registry code changed since indexing began.');
    const head = await this.reader.head(), safe = head - BigInt(this.profile.confirmations);
    const previousNext = cursor?.nextBlock ?? this.profile.startBlock, previousLast = previousNext - 1n;
    let from = previousNext, rollbackBlocks = 0;
    if (cursor?.lastHash) {
      const canonical = previousLast > head ? undefined : await this.reader.block(previousLast);
      if (!canonical || canonical.hash !== cursor.lastHash) {
        const retained = await this.db.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, this.indexKey),
          lt(selectionBlocks.height, previousNext))).orderBy(sql`${selectionBlocks.height} DESC`).limit(this.profile.maxReorgDepth + 1);
        let ancestor: bigint | undefined;
        for (const block of retained) {
          if (previousLast - block.height > BigInt(this.profile.maxReorgDepth)) break;
          const actual = block.height > head ? undefined : await this.reader.block(block.height);
          if (actual?.hash === block.hash) { ancestor = block.height; break; }
        }
        if (ancestor === undefined) {
          if (previousNext - this.profile.startBlock > BigInt(this.profile.maxReorgDepth)) throw new Problem(503, 'selection_reorg_too_deep', 'Selection reorg exceeds the reviewed recovery depth.');
          from = this.profile.startBlock;
        } else from = ancestor + 1n;
        rollbackBlocks = Number(previousNext - from);
      }
    }
    if (safe + 1n < from && previousNext > this.profile.startBlock) {
      from = safe + 1n > this.profile.startBlock ? safe + 1n : this.profile.startBlock;
      rollbackBlocks = Number(previousNext - from);
      if (rollbackBlocks > this.profile.maxReorgDepth) throw new Problem(503, 'selection_reorg_too_deep', 'Selection reorg exceeds the reviewed recovery depth.');
    }
    const end = safe < from ? from - 1n : safe < from + BigInt(this.profile.maxBlocksPerSync) - 1n ? safe : from + BigInt(this.profile.maxBlocksPerSync) - 1n;
    const blocks: SelectionBlock[] = [];
    for (let first = from; first <= end; first += 16n) {
      const heights: bigint[] = []; for (let height = first; height <= end && height < first + 16n; height++) heights.push(height);
      blocks.push(...await Promise.all(heights.map(height => this.reader.block(height))));
    }
    let preceding: string | undefined;
    if (from > this.profile.startBlock) {
      const [previous] = await this.db.select().from(selectionBlocks).where(and(eq(selectionBlocks.indexKey, this.indexKey), eq(selectionBlocks.height, from - 1n))).limit(1);
      if (!previous) throw unavailable(); preceding = previous.hash;
    }
    for (const block of blocks) { if (preceding && block.parentHash !== preceding) throw unavailable(); preceding = block.hash; }
    const registryLogs = from <= end ? await this.reader.logs(from, end, [this.profile.registryAddress]) : [];
    if (registryLogs.length > 5000) throw new Problem(503, 'selection_log_limit', 'Selection log batch exceeds its published bound.');
    const decodedRegistry = registryLogs.map(log => decodeSelectionEvent(log, this.profile.registryAddress)).filter((value): value is SelectionDecodedEvent => value !== undefined);
    const indexedVaults = await this.db.select({ vault: selectionAgents.vault }).from(selectionAgents).where(eq(selectionAgents.indexKey, this.indexKey)).limit(this.profile.maxVaults + 1);
    const vaults = [...new Set([...indexedVaults.map(value => value.vault), ...decodedRegistry.filter(value => value.name === 'Birth').map(value => String(value.args.vault))])];
    if (vaults.length > this.profile.maxVaults) throw new Problem(503, 'selection_index_capacity', 'Selection vault count exceeds the reviewed index capacity.');
    const logs: SelectionLog[] = [...registryLogs];
    if (from <= end) for (let offset = 0; offset < vaults.length; offset += 64) {
      logs.push(...await this.reader.logs(from, end, vaults.slice(offset, offset + 64)));
      if (logs.length > 5000) throw new Problem(503, 'selection_log_limit', 'Selection log batch exceeds its published bound.');
    }
    const allowedAddresses = new Set([this.profile.registryAddress, ...vaults]), headerMap = new Map(blocks.map(block => [block.height, block]));
    const ids = new Set<string>(), positions = new Set<string>();
    for (const log of logs) {
      const header = headerMap.get(log.height), id = log.transactionHash + ':' + log.logIndex, position = log.height + ':' + log.logIndex;
      if (!allowedAddresses.has(log.address) || !header || header.hash !== log.blockHash || ids.has(id) || positions.has(position)) throw unavailable(); ids.add(id); positions.add(position);
    }
    const decoded = logs.map(log => decodeSelectionEvent(log, this.profile.registryAddress)).filter((value): value is SelectionDecodedEvent => value !== undefined)
      .sort((a, b) => a.height < b.height ? -1 : a.height > b.height ? 1 : a.logIndex - b.logIndex);
    if (blocks.length && (await this.reader.block(end)).hash !== blocks.at(-1)?.hash) throw unavailable();
    if (cursor && blocks.length === 0 && rollbackBlocks === 0) return { indexedThrough: previousNext > this.profile.startBlock ? (previousNext - 1n).toString() : null, processedBlocks: 0, rollbackBlocks: 0 };
    return this.db.transaction(async tx => {
      await tx.insert(selectionCursors).values({ key: this.indexKey, profileHash, nextBlock: this.profile.startBlock }).onConflictDoNothing();
      const [locked] = await tx.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexKey)).for('update');
      if (!locked || locked.nextBlock !== previousNext || locked.revision !== (cursor?.revision ?? 0) || locked.profileHash !== profileHash) {
        throw new Problem(409, 'selection_cursor_changed', 'Another indexer advanced this profile; retry from the durable cursor.');
      }
      if (rollbackBlocks) {
        await tx.delete(selectionEvents).where(and(eq(selectionEvents.indexKey, this.indexKey), gt(selectionEvents.height, from - 1n)));
        await tx.delete(selectionBlocks).where(and(eq(selectionBlocks.indexKey, this.indexKey), gt(selectionBlocks.height, from - 1n)));
      }
      for (const block of blocks) await tx.insert(selectionBlocks).values({ indexKey: this.indexKey, ...block });
      for (const event of decoded) await tx.insert(selectionEvents).values({ indexKey: this.indexKey, id: event.transactionHash + ':' + event.logIndex,
        height: event.height, blockHash: event.blockHash, transactionHash: event.transactionHash, logIndex: event.logIndex, address: event.address, name: event.name, args: event.args });
      const ledger = await tx.select().from(selectionEvents).where(eq(selectionEvents.indexKey, this.indexKey)).orderBy(asc(selectionEvents.height), asc(selectionEvents.logIndex)).limit(this.profile.maxEvents + 1);
      if (ledger.length > this.profile.maxEvents) throw new Problem(503, 'selection_index_capacity', 'Selection event ledger exceeds the reviewed replay capacity.');
      const headers = await tx.selectDistinct({ height: selectionBlocks.height, hash: selectionBlocks.hash,
        parentHash: selectionBlocks.parentHash, timestamp: selectionBlocks.timestamp }).from(selectionBlocks)
        .innerJoin(selectionEvents, and(eq(selectionEvents.indexKey, selectionBlocks.indexKey), eq(selectionEvents.height, selectionBlocks.height)))
        .where(eq(selectionBlocks.indexKey, this.indexKey));
      const projection = selectionProjection(ledger.map(row => ({ address: row.address, blockHash: row.blockHash, height: row.height,
        transactionHash: row.transactionHash, logIndex: row.logIndex, name: row.name, args: row.args, topics: [], data: '0x' })),
      new Map(headers.map(header => [header.height, header])), this.profile.registryAddress);
      await tx.delete(selectionAgents).where(eq(selectionAgents.indexKey, this.indexKey)); await tx.delete(selectionFossils).where(eq(selectionFossils.indexKey, this.indexKey));
      for (const agent of projection.agents.values()) await tx.insert(selectionAgents).values({ indexKey: this.indexKey, agentId: agent.agentId, owner: agent.owner, vault: agent.vault, data: agent });
      for (const fossil of projection.fossils.values()) await tx.insert(selectionFossils).values({ indexKey: this.indexKey, agentId: fossil.agentId, deathBlock: BigInt(fossil.deathBlock), data: fossil });
      const nextBlock = blocks.length ? end + 1n : from;
      const hash = blocks.at(-1)?.hash ?? (from > this.profile.startBlock ? preceding ?? null : null);
      await tx.update(selectionCursors).set({ nextBlock, lastHash: hash, revision: locked.revision + 1 }).where(eq(selectionCursors.key, this.indexKey));
      return { indexedThrough: nextBlock > this.profile.startBlock ? (nextBlock - 1n).toString() : null, processedBlocks: blocks.length, rollbackBlocks };
    });
  }
  async status() {
    const [cursor] = await this.db.select().from(selectionCursors).where(eq(selectionCursors.key, this.indexKey)).limit(1);
    return { indexKey: this.indexKey, chainId: this.profile.chainId, registryAddress: this.profile.registryAddress, confirmations: this.profile.confirmations,
      indexedThrough: cursor && cursor.nextBlock > this.profile.startBlock ? (cursor.nextBlock - 1n).toString() : null,
      blockHash: cursor?.lastHash ?? null, revision: cursor?.revision ?? 0 };
  }
  async list(ownerValue: string, cursor?: string) {
    const owner = addressSchema.parse(ownerValue); if (cursor !== undefined) hashSchema.parse(cursor);
    const rows = await this.db.select().from(selectionAgents).where(and(eq(selectionAgents.indexKey, this.indexKey), eq(selectionAgents.owner, owner),
      cursor === undefined ? undefined : gt(selectionAgents.agentId, cursor))).orderBy(asc(selectionAgents.agentId)).limit(51);
    const agents = rows.slice(0, 50).map(row => row.data); return { agents, ...(rows.length > 50 ? { nextCursor: agents.at(-1)?.agentId } : {}), index: await this.status() };
  }
  async get(ownerValue: string, agentValue: string) {
    const owner = addressSchema.parse(ownerValue), agentId = hashSchema.parse(agentValue);
    const [row] = await this.db.select().from(selectionAgents).where(and(eq(selectionAgents.indexKey, this.indexKey), eq(selectionAgents.agentId, agentId), eq(selectionAgents.owner, owner))).limit(1);
    if (!row) throw new Problem(404, 'selection_agent_not_found', 'Selection agent not found.');
    const index = await this.status(); if (index.indexedThrough === null || !index.blockHash) throw unavailable();
    const height = BigInt(index.indexedThrough), block = await this.reader.block(height); if (block.hash !== index.blockHash) throw unavailable();
    const [sum] = await this.db.select({ burn: sql<string>`COALESCE(SUM(CAST(${selectionEvents.args}->>'amount' AS numeric)),0)::text` }).from(selectionEvents)
      .where(and(eq(selectionEvents.indexKey, this.indexKey), eq(selectionEvents.name, 'Burn'), sql`${selectionEvents.args}->>'agentId' = ${agentId}`,
        sql`CAST(${selectionEvents.args}->>'paidAt' AS numeric) > ${String(block.timestamp - 86400n)}`,
        sql`CAST(${selectionEvents.args}->>'paidAt' AS numeric) <= ${block.timestamp.toString()}`));
    const burn = BigInt(sum?.burn ?? '0'), available = await this.reader.spendableBalance(row.vault, height);
    if ((await this.reader.block(height)).hash !== index.blockHash) throw unavailable();
    const balance = BigInt(available), net = BigInt(row.data.income) - BigInt(row.data.incomeFees);
    return { agent: row.data, metrics: { balance: balance.toString(), trailing24hBurn: burn.toString(),
      runwaySeconds: burn === 0n ? null : (balance * 86400n / burn).toString(),
      runwayExact: burn === 0n ? null : { numerator: (balance * 86400n).toString(), denominator: burn.toString(), unit: 'seconds' },
      netIncome: net.toString(), survivalRatio: row.data.burn === '0' ? null : { numerator: net.toString(), denominator: row.data.burn } }, index };
  }
  async fossils(cursor?: string) {
    if (cursor !== undefined) hashSchema.parse(cursor);
    const rows = await this.db.select().from(selectionFossils).where(and(eq(selectionFossils.indexKey, this.indexKey),
      cursor === undefined ? undefined : gt(selectionFossils.agentId, cursor))).orderBy(asc(selectionFossils.agentId)).limit(51);
    const fossils = rows.slice(0, 50).map(row => row.data); return { fossils, ...(rows.length > 50 ? { nextCursor: fossils.at(-1)?.agentId } : {}), index: await this.status() };
  }
  async fossil(agentValue: string) {
    const agentId = hashSchema.parse(agentValue), [row] = await this.db.select().from(selectionFossils).where(and(eq(selectionFossils.indexKey, this.indexKey), eq(selectionFossils.agentId, agentId))).limit(1);
    if (!row) throw new Problem(404, 'selection_fossil_not_found', 'Selection fossil not found.'); return { fossil: row.data, index: await this.status() };
  }
  async population() {
    const rows = await this.db.select({ data: selectionAgents.data }).from(selectionAgents).where(eq(selectionAgents.indexKey, this.indexKey)).limit(this.profile.maxVaults + 1);
    if (rows.length > this.profile.maxVaults) throw unavailable();
    const agents = rows.map(row => row.data), sum = (key: 'income' | 'incomeFees' | 'burn' | 'subsidy') => agents.reduce((total, agent) => total + BigInt(agent[key]), 0n).toString();
    return { births: agents.length, alive: agents.filter(agent => agent.status === 'alive').length,
      dormant: agents.filter(agent => agent.status === 'dormant').length, deaths: agents.filter(agent => agent.status === 'dead').length,
      frozen: agents.filter(agent => agent.frozen).length, families: new Set(agents.map(agent => agent.family)).size,
      maximumGeneration: agents.reduce((maximum, agent) => Math.max(maximum, agent.generation), 0),
      lifetimeIncome: sum('income'), lifetimeIncomeFees: sum('incomeFees'), lifetimeBurn: sum('burn'), lifetimeSubsidy: sum('subsidy'), index: await this.status() };
  }
}
