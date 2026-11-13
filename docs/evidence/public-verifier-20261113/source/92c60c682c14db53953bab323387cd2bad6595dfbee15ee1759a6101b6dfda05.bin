import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifyTypedData, type Address, type Hex } from 'viem';
import { hashJson, Problem, randomId, sameAddress, typedQuote, signatureSchema, bytes32Schema, addressSchema, moneySchema, jsonSafe, type QuoteInput } from './common.js';
import { jobs, leashRefs, ownerJob, type Database, type Job } from './store.js';
import { ChainBridge } from './bridge.js';
import { settlementTypes, type Settlement } from './chain/typed-data.js';
import type { Config } from './config.js';
import { nearReadinessSnapshot, type NearProviderReadiness } from './providers/readiness.js';

export const settlementSchema = z.object({ runId: bytes32Schema, billableSeconds: z.string().regex(/^\d{1,3}$/), inferenceCharge: moneySchema, receiptHash: bytes32Schema }).strict();
export const signedReceiptSchema = z.object({
  body: z.record(z.unknown()), receiptHash: bytes32Schema,
  settlement: settlementSchema, signature: signatureSchema, signer: addressSchema,
  domain: z.object({ name: z.literal('TelomereRunEscrow'), version: z.literal('1'), chainId: z.number().int(), verifyingContract: addressSchema }).strict(),
}).strict();
export type SignedReceipt = z.infer<typeof signedReceiptSchema>;
const receiptBodySchema = z.object({
  runId: bytes32Schema, payer: addressSchema, leashId: bytes32Schema, workloadHash: bytes32Schema,
  cpu: z.object({ billableSeconds: z.number().int().min(0).max(120), measuredSeconds: z.number().int().min(0).max(120), pricePerSecond: moneySchema }).passthrough(),
  near: z.object({ inferenceCharge: moneySchema }).passthrough().nullable(),
  billing: z.object({ token: addressSchema, ceiling: moneySchema, charged: moneySchema, refund: moneySchema }).strict(),
}).passthrough();
export function receiptSettlement(receipt: SignedReceipt): Settlement {
  return { ...receipt.settlement, billableSeconds: BigInt(receipt.settlement.billableSeconds), inferenceCharge: BigInt(receipt.settlement.inferenceCharge) };
}
export class Service {
  constructor(readonly db: Database, readonly bridge: ChainBridge, readonly config: Config, readonly nearAvailable: boolean,
    private readonly readiness?: () => Promise<NearProviderReadiness>) {}
  async nearReadiness(): Promise<NearProviderReadiness> {
    if (!this.nearAvailable) return nearReadinessSnapshot('disabled', 'NOT_CONFIGURED', null);
    if (this.readiness) {
      try { return await this.readiness(); }
      catch { return nearReadinessSnapshot('unavailable', 'READINESS_CHECK_FAILED', this.config.NEAR_VERIFICATION_MODE); }
    }
    return nearReadinessSnapshot('ready', 'CONFIGURATION_READY', this.config.NEAR_VERIFICATION_MODE);
  }
  async quote(owner: Address, input: QuoteInput, idemKey: string, options: { quoteExpiryCap?: number } = {}) {
    if (options.quoteExpiryCap !== undefined && (!Number.isSafeInteger(options.quoteExpiryCap) || options.quoteExpiryCap < 1)) {
      throw new Problem(422, 'invalid_quote_expiry', 'The quote expiry cap must be a positive Unix second.');
    }
    const inputHash = hashJson(input);
    const previous = (await this.db.select().from(jobs).where(and(eq(jobs.owner, owner.toLowerCase()), eq(jobs.idemKey, idemKey))).limit(1))[0];
    if (previous) {
      if (previous.inputHash !== inputHash) throw new Problem(409, 'idempotency_conflict', 'This idempotency key was used with different inputs.');
      if (input.nearPrompt && previous.status === 'prepared' && (await this.nearReadiness()).state !== 'ready') {
        throw new Problem(503, 'near_unavailable', 'NEAR inference is unavailable under the current provider policy.');
      }
      return this.quoteResponse(previous);
    }
    const readiness = input.nearPrompt ? await this.nearReadiness() : undefined;
    if (readiness && readiness.state !== 'ready') throw new Problem(503, 'near_unavailable', 'NEAR inference is unavailable under the current provider policy.');
    const leash = await this.bridge.leash(input.leashId);
    if (!sameAddress(leash.owner, owner) || leash.killed || leash.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Problem(403, 'leash_unavailable', 'The budget is unavailable or expired.');
    const now = Math.floor(Date.now() / 1000);
    const quoteExpiry = Math.min(now + 300, readiness?.policyExpiresAt ? Math.floor(Date.parse(readiness.policyExpiresAt) / 1000) : now + 300,
      options.quoteExpiryCap ?? now + 300);
    if (!Number.isSafeInteger(quoteExpiry) || quoteExpiry <= now) {
      if (options.quoteExpiryCap !== undefined && options.quoteExpiryCap <= now) throw new Problem(409, 'quote_expired', 'The deadline no longer leaves enough time for this run.');
      throw new Problem(503, 'near_unavailable', 'The provider policy expires before this quote can be used.');
    }
    const quote = { runId: randomId(), leashId: input.leashId, payer: owner, workloadHash: hashJson({ input, maxTokens: this.config.MAX_TOKENS, model: this.config.NEAR_MODEL ?? null }),
      maxSeconds: input.maxSeconds, pricePerSecond: this.config.CPU_PRICE_PER_SECOND, inferencePrice: input.nearPrompt ? this.config.INFERENCE_FIXED_PRICE : '0', quoteExpiry };
    const ceiling = (BigInt(quote.pricePerSecond) * BigInt(quote.maxSeconds) + BigInt(quote.inferencePrice)).toString();
    const signature = await this.bridge.signQuote(typedQuote(quote));
    const inserted = await this.db.transaction(async transaction => {
      await transaction.execute(sql`UPDATE quote_admission_lock SET id = id WHERE id = 1`);
      const replay = (await transaction.select().from(jobs).where(and(eq(jobs.owner, owner.toLowerCase()), eq(jobs.idemKey, idemKey))).limit(1))[0];
      if (replay) return [replay];
      // One database row serializes quote admission across owners and concurrent requests.
      const counts = await transaction.execute(sql`SELECT
        (SELECT count(*)::integer FROM jobs WHERE status IN ('queued','running','near_dispatching','receipt_pending','settling','reconciliation')
          OR status = 'prepared' AND created_at > now() - interval '5 minutes') AS active,
        (SELECT count(*)::integer FROM jobs WHERE owner = ${owner.toLowerCase()} AND created_at > now() - interval '1 day') AS daily,
        (SELECT count(*)::integer FROM jobs WHERE owner = ${owner.toLowerCase()} AND (status IN ('queued','running','near_dispatching','receipt_pending','settling','reconciliation')
          OR status = 'prepared' AND created_at > now() - interval '5 minutes')) AS owned`);
      const countsRow = (counts as {rows:{active:number;daily:number;owned:number}[]}).rows[0]!;
      if (this.config.WALLET_ACCESS === 'public' && (countsRow.active >= 64 || countsRow.owned >= 8 || countsRow.daily >= 500)) {
        throw new Problem(429, 'compute_capacity', 'Compute capacity or your daily run quota is reached. Try again later.');
      }
      return transaction.insert(jobs).values({ id: quote.runId, owner: owner.toLowerCase(), leashId: input.leashId, agentAddress: leash.agent.toLowerCase(),
      idemKey, inputHash, input, quote, signature, ceiling }).onConflictDoNothing().returning();
    });
    const row = inserted[0] ?? (await this.db.select().from(jobs).where(and(eq(jobs.owner, owner.toLowerCase()), eq(jobs.idemKey, idemKey))).limit(1))[0];
    if (!row || row.inputHash !== inputHash) throw new Problem(409, 'idempotency_conflict', 'This idempotency key was used with different inputs.');
    return this.quoteResponse(row);
  }
  quoteResponse(job: Job) {
    return { quote: job.quote, signature: job.signature, ceiling: job.ceiling,
      transaction: this.bridge.openTransaction(typedQuote(job.quote), signatureSchema.parse(job.signature)) };
  }
  async admit(owner: Address, id: Hex, hash: Hex) {
    const job = await this.requireJob(owner, id);
    if (job.txHash && job.txHash !== hash) throw new Problem(409, 'idempotency_conflict', 'This run is already linked to a different transaction.');
    if (job.status !== 'prepared') return this.publicJob(job);
    await this.bridge.verifyOpened(id, owner, hash);
    const chainRun = await this.bridge.run(id);
    if (job.agentAddress && !sameAddress((await this.bridge.leash(bytes32Schema.parse(job.leashId))).agent, addressSchema.parse(job.agentAddress))) {
      throw new Problem(409, 'agent_binding_changed', 'The budget agent changed after this quote. Keep the original reservation available for its timeout refund.');
    }
    if (chainRun.workloadHash !== job.quote.workloadHash || chainRun.ceiling.toString() !== job.ceiling) throw new Problem(409, 'terms_mismatch', 'The onchain reservation does not match the quote.');
    await this.db.transaction(async transaction => {
      await transaction.execute(sql`UPDATE quote_admission_lock SET id = id WHERE id = 1`);
      const current = (await transaction.select().from(jobs).where(and(eq(jobs.id,id),eq(jobs.owner,owner.toLowerCase()))).limit(1))[0];
      if (!current || current.status !== 'prepared') return;
      if (this.config.WALLET_ACCESS === 'public') {
        const active = await transaction.select({owner:jobs.owner}).from(jobs).where(inArray(jobs.status,
          ['queued','running','near_dispatching','receipt_pending','settling','reconciliation'])).limit(65);
        if (active.length >= 64 || active.filter(row => row.owner === owner.toLowerCase()).length >= 8) {
          throw new Problem(429,'compute_capacity','The queue is full. Your reservation remains on-chain. Check pending transactions to retry admission without paying again.');
        }
      }
      await transaction.update(jobs).set({status:'queued',txHash:hash,updatedAt:new Date()}).where(and(eq(jobs.id,id),eq(jobs.status,'prepared')));
    });
    return this.publicJob(await this.requireJob(owner, id));
  }
  async requireJob(owner: Address, id: string): Promise<Job> {
    const job = await ownerJob(this.db, owner, id);
    if (!job) throw new Problem(404, 'run_not_found', 'Run not found.');
    return job;
  }
  publicJob(job: Job) {
    const { input: _input, inputHash: _hash, idemKey: _idem, signature: _signature, quote: _quote, cpuResult: _cpu, nearResult: _near, ticks: _ticks, targetStatus: _target, ...result } = job;
    return { ...result, maxSeconds: job.quote.maxSeconds, task: { kind: job.input.task.kind } };
  }
  async listRuns(owner: Address) {
    return { runs: (await this.db.select().from(jobs).where(eq(jobs.owner, owner.toLowerCase())).orderBy(desc(jobs.createdAt)).limit(100)).map(job => this.publicJob(job)) };
  }
  async balance(owner: Address) {
    const balance = await this.bridge.balance(owner);
    const active = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.owner, owner.toLowerCase()), inArray(jobs.status, ['queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation'])));
    let reserved = 0n;
    for (const job of active) { const run = await this.bridge.run(bytes32Schema.parse(job.id)); if (run.status === 1) reserved += run.ceiling; }
    return { ...balance, reserved: reserved.toString() };
  }
  async createLeash(owner: Address, agent: Address, hour: bigint, day: bigint, expiry: bigint) {
    const id = randomId();
    if (hour <= 0n || day < hour || hour >= 2n ** 96n || day >= 2n ** 96n
      || expiry <= BigInt(Math.floor(Date.now() / 1000)) || expiry > BigInt(Math.floor(Date.now() / 1000) + 30 * 86400)) {
      throw new Problem(422, 'invalid_budget', 'Set positive limits and an expiry within 30 days.');
    }
    await this.db.insert(leashRefs).values({ id, owner: owner.toLowerCase() });
    return { leashId: id, transaction: this.bridge.createLeashTransaction(id, agent, hour, day, expiry) };
  }
  async listLeashes(owner: Address) {
    const refs = await this.db.select().from(leashRefs).where(eq(leashRefs.owner, owner.toLowerCase())).limit(100);
    const leashes = [];
    for (const ref of refs) {
      const leash = await this.bridge.leash(bytes32Schema.parse(ref.id));
      if (sameAddress(leash.owner, owner)) leashes.push(jsonSafe({ id: ref.id, ...leash }));
    }
    return { leashes };
  }
  async updateLeash(owner: Address, id: Hex, hour: bigint, day: bigint, expiry: bigint) {
    const leash = await this.bridge.leash(id);
    if (!sameAddress(leash.owner, owner)) throw new Problem(404, 'not_found', 'Budget not found.');
    if (leash.killed) throw new Problem(409, 'leash_killed', 'A killed budget cannot be edited. Create a new leash.');
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (hour <= 0n || day < hour || hour >= 2n ** 96n || day >= 2n ** 96n || expiry <= now || expiry > now + 30n * 86400n) {
      throw new Problem(422, 'invalid_budget', 'Set positive limits and an expiry within 30 days.');
    }
    if (leash.spentHour + leash.pending > hour || leash.spentDay + leash.pending > day) {
      throw new Problem(409, 'budget_committed', 'Limits must cover already spent funds and outstanding reservations.');
    }
    return { leashId: id, agent: leash.agent, transaction: this.bridge.updateLeashTransaction(id, leash.agent, hour, day, expiry) };
  }
  async verifyReceipt(input: unknown) {
    const receipt = signedReceiptSchema.parse(input);
    if (receipt.receiptHash !== hashJson(receipt.body) || receipt.settlement.receiptHash !== receipt.receiptHash
      || receipt.domain.chainId !== this.config.CHAIN_ID || !sameAddress(receipt.domain.verifyingContract, this.config.ESCROW_ADDRESS)
      || !sameAddress(receipt.signer, this.bridge.account.address)) return { valid: false, signer: receipt.signer };
    const valid = await verifyTypedData({ address: this.bridge.account.address, domain: this.bridge.domain, types: settlementTypes, primaryType: 'Settlement', message: receiptSettlement(receipt), signature: receipt.signature });
    const run = await this.bridge.run(receipt.settlement.runId);
    const body = receiptBodySchema.parse(receipt.body);
    const inferenceCharge = BigInt(body.near?.inferenceCharge ?? '0');
    const charged = BigInt(body.cpu.billableSeconds) * BigInt(body.cpu.pricePerSecond) + inferenceCharge;
    const consistent = body.runId === receipt.settlement.runId && sameAddress(body.payer, run.payer) && body.leashId === run.leashId && body.workloadHash === run.workloadHash
      && body.cpu.billableSeconds <= body.cpu.measuredSeconds && BigInt(body.cpu.billableSeconds) === BigInt(receipt.settlement.billableSeconds)
      && BigInt(body.cpu.pricePerSecond) === run.pricePerSecond && inferenceCharge === BigInt(receipt.settlement.inferenceCharge)
      && (inferenceCharge === 0n || inferenceCharge === run.inferencePrice) && BigInt(body.billing.charged) === charged && BigInt(body.billing.ceiling) === run.ceiling
      && charged <= run.ceiling && charged + BigInt(body.billing.refund) === run.ceiling && sameAddress(body.billing.token, this.config.TOKEN_ADDRESS);
    const anchored = valid && consistent && run.status === 2 && run.receiptHash === receipt.receiptHash && run.billableSeconds === BigInt(body.cpu.billableSeconds) && run.inferenceCharge === inferenceCharge;
    return { valid: valid && consistent, anchored, signer: receipt.signer, evidence: 'Operator-signed CPU metering; NEAR evidence is recorded separately.' };
  }
}
