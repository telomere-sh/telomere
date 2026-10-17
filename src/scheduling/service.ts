import { and, eq, desc, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Address } from 'viem';
import { addressSchema, hashJson, moneySchema, Problem, quoteInputSchema } from '../common.js';
import type { Database, Job } from '../store.js';
import { jobs } from '../store.js';
import { Service } from '../service.js';
import { deadlineJobs } from './schema.js';
import { priceQuantiles } from './planner.js';

export const deadlineInputSchema = quoteInputSchema.omit({ nearPrompt: true }).extend({
  deadline: z.number().int().safe().positive(), maxSpend: moneySchema,
}).strict();
export const deadlineIdempotencySchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export class DeadlineService {
  constructor(private readonly service: Service, private readonly now: () => number = Date.now) {}
  private get db(): Database { return this.service.db; }
  async prepare(authenticatedOwner: Address, input: unknown, idem: string) {
    const owner = addressSchema.parse(authenticatedOwner), parsed = deadlineInputSchema.parse(input);
    const key = deadlineIdempotencySchema.parse(idem), inputHash = hashJson(parsed);
    const id = hashJson({ domain: 'telomere.deadline.v1', owner: owner.toLowerCase(), key });
    let [record] = await this.db.select().from(deadlineJobs).where(eq(deadlineJobs.id, id)).limit(1);
    if (record && record.inputHash !== inputHash) throw new Problem(409, 'idempotency_conflict', 'Keep the original deadline and budget on retries.');
    if (!record) {
      const now = Math.floor(this.now() / 1000), required = BigInt(this.service.config.CPU_PRICE_PER_SECOND) * BigInt(parsed.maxSeconds);
      if (parsed.deadline <= now + parsed.maxSeconds || parsed.deadline > now + 7 * 86400) {
        throw new Problem(422, 'invalid_deadline', 'Allow the full maximum runtime and choose a deadline within seven days.');
      }
      if (BigInt(parsed.maxSpend) < required) throw new Problem(409, 'deadline_infeasible', 'The maximum spend does not cover the published CPU ceiling.');
      await this.db.insert(deadlineJobs).values({ id, owner: owner.toLowerCase(), idemKey: key, inputHash,
        deadlineAt: new Date(parsed.deadline * 1000), maxSpend: parsed.maxSpend, maxSeconds: parsed.maxSeconds,
        hostId: hashJson({ domain: 'telomere.controlled.cpu.host', chainId: this.service.config.CHAIN_ID,
          escrow: this.service.config.ESCROW_ADDRESS.toLowerCase() }) }).onConflictDoNothing();
      [record] = await this.db.select().from(deadlineJobs).where(eq(deadlineJobs.id, id)).limit(1);
    }
    if (!record || record.inputHash !== inputHash) throw new Problem(409, 'idempotency_conflict', 'The original deadline request changed.');
    const { deadline: _deadline, maxSpend: _maxSpend, ...task } = parsed;
    const prepared = await this.service.quote(owner, task, 'deadline_' + id.slice(2), { quoteExpiryCap: parsed.deadline - parsed.maxSeconds });
    if (BigInt(prepared.ceiling) > BigInt(record.maxSpend)) throw new Problem(409, 'deadline_infeasible', 'The current quote exceeds the original maximum spend.');
    await this.db.update(deadlineJobs).set({ runId: prepared.quote.runId }).where(and(eq(deadlineJobs.id, id), sql`${deadlineJobs.runId} IS NULL`));
    const [linked] = await this.db.select().from(deadlineJobs).where(eq(deadlineJobs.id, id)).limit(1);
    if (!linked || linked.runId !== prepared.quote.runId) throw new Problem(503, 'deadline_unavailable', 'The original deadline reservation is unavailable.');
    return { deadlineJob: await this.get(owner, id), ...prepared };
  }
  async get(authenticatedOwner: Address, id: string) {
    const owner = addressSchema.parse(authenticatedOwner);
    const [record] = await this.db.select().from(deadlineJobs).where(and(eq(deadlineJobs.id, id), eq(deadlineJobs.owner, owner.toLowerCase()))).limit(1);
    if (!record) throw new Problem(404, 'deadline_not_found', 'Deadline job not found.');
    const [run] = record.runId ? await this.db.select().from(jobs).where(and(eq(jobs.id, record.runId), eq(jobs.owner, record.owner))).limit(1) : [];
    return { id: record.id, runId: record.runId, deadline: Math.floor(record.deadlineAt.getTime() / 1000),
      maxSpend: record.maxSpend, maxSeconds: record.maxSeconds, hostId: record.hostId,
      status: run?.status ?? 'preparing', deadlineMissed: run?.errorCode === 'DEADLINE_MISSED',
      charged: run?.charged ?? null, refund: run?.refund ?? null,
      enforcement: 'operator-signed-zero-charge-on-missed-deadline', walletActionRequired: run?.status === 'prepared' };
  }
  async list(owner: Address) {
    const rows = await this.db.select({ id: deadlineJobs.id }).from(deadlineJobs).where(eq(deadlineJobs.owner, owner.toLowerCase()))
      .orderBy(desc(deadlineJobs.createdAt), desc(deadlineJobs.id)).limit(100);
    return { jobs: await Promise.all(rows.map(row => this.get(owner, row.id))) };
  }
  async prices() {
    const now = this.now(), result = [];
    for (const [label, milliseconds] of [['1h', 3600000], ['24h', 86400000], ['7d', 604800000]] as const) {
      const rows = await this.db.select({ quote: jobs.quote, charged: jobs.charged, billableSeconds: jobs.billableSeconds }).from(jobs)
        .where(and(inArray(jobs.status, ['completed', 'failed', 'cancelled', 'timed_out']), gte(jobs.updatedAt, new Date(now - milliseconds)),
          sql`${jobs.receipt} IS NOT NULL`, sql`${jobs.settlementTxHash} IS NOT NULL`))
        .orderBy(desc(jobs.updatedAt)).limit(10001);
      if (rows.length > 10000) throw new Problem(503, 'price_window_limit', 'Price history requires an indexed aggregate before publication.');
      const prices = rows.filter(row => row.billableSeconds > 0 && row.charged !== null && BigInt(row.charged) > 0n)
        .map(row => BigInt(row.quote.pricePerSecond));
      result.push({ window: label, ...priceQuantiles(prices) });
    }
    return { hardwareClass: 'cpu', lane: 'standard', unit: 'token-base-units-per-second',
      source: 'controller-indexed-settled-controlled-host-receipts', samplesAreMarketWide: false, windows: result };
  }
}
export async function deadlineForRun(db: Database, job: Job) {
  const [record] = await db.select().from(deadlineJobs).where(and(eq(deadlineJobs.runId, job.id), eq(deadlineJobs.owner, job.owner))).limit(1);
  return record;
}
