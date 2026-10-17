import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, getTableColumns, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { jobs, transactions, type Database, type Job } from './store.js';
import { bytes32Schema, hashJson, jsonSafe } from './common.js';
import { ChainBridge, SettlementRejectedError } from './bridge.js';
import { signedReceiptSchema, receiptSettlement, type SignedReceipt } from './service.js';
import { AmbiguousProviderError, ProviderRequestRejectedError, type NearProvider } from './providers/index.js';
import type { CpuExecutor, CpuRunResult, CpuRunStatus, MeterTick } from './runtime/index.js';
import { CpuCleanupError } from './runtime/index.js';
import { validateCpuResult, validateTicks } from './runtime/validation.js';
import { RunMeter } from './runtime/meter.js';
import { getNearProviderReadiness } from './providers/index.js';
import { validateRecoveredNearResult } from './providers/recovery.js';
import { deadlineForRun } from './scheduling/service.js';

export type WorkerSnapshot = { state: 'idle' | 'running' | 'stopped' | 'quarantined' | 'faulted'; activeRunId?: string; reason?: string };
const outcomeSchema = z.enum(['completed', 'failed', 'cancelled', 'timed_out']);

export class Worker {
  private stopped = false;
  private current: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private activeRunId: string | undefined;
  private quarantineReason: string | undefined;
  private faulted = false;
  private readonly lastSettlementAttempt = new Map<string, number>();
  private readonly lastReceiptAttempt = new Map<string, number>();
  private readonly receiptsInFlight = new Set<string>();
  private refundCursor: { createdAt: string; id: string } | undefined;
  private readonly retryCursors = new Map<'receipt_pending' | 'settling', { createdAt: string; id: string }>();
  private drainQueue: Promise<void> = Promise.resolve();
  private drainsPending = 0;
  constructor(private readonly db: Database, private readonly bridge: ChainBridge, private readonly cpu: CpuExecutor,
    private readonly near: NearProvider | undefined, private readonly logger: Logger) {}
  snapshot(): WorkerSnapshot {
    return { state: this.quarantineReason ? 'quarantined' : this.faulted ? 'faulted' : this.stopped ? 'stopped' : this.current ? 'running' : 'idle',
      ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}), ...(this.quarantineReason ? { reason: this.quarantineReason } : {}) };
  }
  async recover(cpuCleanupConfirmed = false): Promise<void> {
    const pending = await this.db.select().from(jobs).where(inArray(jobs.status, ['running', 'near_dispatching', 'receipt_pending', 'reconciliation']));
    for (const job of pending) {
      const savedProviderSuccess = job.status === 'reconciliation' && job.errorCode === 'PROVIDER_OUTCOME_UNKNOWN' && job.nearResult != null;
      if (job.status === 'reconciliation' && job.errorCode !== 'CPU_RECOVERY_REQUIRED' && !savedProviderSuccess) continue;
      if (job.errorCode === 'CPU_RECOVERY_REQUIRED' && !cpuCleanupConfirmed) { this.quarantineReason = 'CPU_RECOVERY_REQUIRED'; continue; }
      if (job.status === 'receipt_pending') {
        if (!this.loop || Date.now() - (this.lastReceiptAttempt.get(job.id) ?? 0) > 10000) await this.retryReceipt(job);
        continue;
      }
      if (job.status === 'near_dispatching' || savedProviderSuccess) {
        // A durably stored successful result can settle without another paid request.
        let cpu: CpuRunResult;
        let near: Awaited<ReturnType<NearProvider['complete']>>;
        try {
          ({ cpu, near } = await this.knownProviderResult(job));
        } catch { await this.update(job.id, { status: 'reconciliation', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }); continue; }
        // Transport/signing/storage failures do not invalidate already persisted results.
        await this.queueReceipt(job, cpu, near);
      } else {
        let result: CpuRunResult;
        let errorCode = 'CONTROLLER_RESTART';
        let targetStatus: CpuRunStatus;
        try {
          // Never reconstruct a larger charge from a database counter alone.
          const ticks = validateTicks(job.ticks, job.id, job.input.maxSeconds), billableSeconds = ticks.at(-1)?.billableSeconds ?? 0;
          if (billableSeconds !== job.billableSeconds) throw new Error('CPU meter counter mismatch');
          if (job.cpuResult == null) {
            // Close interrupted host observations after exclusive CPU cleanup; do not invent output or extra seconds.
            if (ticks.at(-1) && ticks.at(-1)?.state !== 'running') throw new Error('Missing terminal CPU result');
            const meter = new RunMeter(job.id, job.input.maxSeconds); meter.ticks.push(...ticks);
            await meter.emit('failed', ticks.at(-1)?.elapsedMs ?? 0, '');
            result = validateCpuResult({ status: 'failed', output: '', exitCode: -1, billableSeconds, ticks: meter.ticks }, job.id, job.input.maxSeconds);
          } else {
            result = validateCpuResult(job.cpuResult, job.id, job.input.maxSeconds);
            if (result.billableSeconds !== billableSeconds || hashJson(result.ticks) !== hashJson(ticks)) throw new Error('CPU result meter mismatch');
          }
          targetStatus = result.status;
          if (job.cpuResult != null && !job.input.nearPrompt) errorCode = job.errorCode ?? '';
          else if (job.input.nearPrompt && result.status === 'completed') { targetStatus = 'failed'; errorCode = 'CONTROLLER_RESTART_BEFORE_PROVIDER'; }
        } catch { this.quarantineReason = 'CPU_RECOVERY_REQUIRED'; await this.update(job.id, { status: 'reconciliation', errorCode: 'CPU_RECOVERY_REQUIRED' }); continue; }
        await this.queueReceipt(job, result, undefined, errorCode || undefined, targetStatus);
      }
    }
  }
  start(): void {
    if (this.loop) throw new Error('Worker already started');
    if (this.drainsPending) throw new Error('Manual worker drain is still active');
    this.loop = this.runLoop().catch(error => { this.faulted = true; this.logger.error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'worker_stopped'); });
  }
  async stop(): Promise<void> { this.stopped = true; this.current?.abort(); await this.loop; await this.drainQueue; }
  private async update(id: string, values: Partial<typeof jobs.$inferInsert>): Promise<void> {
    await this.db.update(jobs).set({ ...values, updatedAt: new Date() }).where(eq(jobs.id, id));
  }
  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        // Recover a known stored outcome left by a transient database failure in the preceding iteration.
        if (this.faulted && !this.quarantineReason) await this.recover();
        await this.retryReceipts();
        if (this.stopped) break;
        const cooling = [...this.lastSettlementAttempt].filter(([, at]) => Date.now() - at <= 10000).map(([id]) => id);
        const settlement = await this.nextRetryJob('settling', cooling);
        if (this.stopped) break;
        if (settlement) {
          this.lastSettlementAttempt.set(settlement.id, Date.now());
          try { await this.settle(settlement); }
          catch (error) {
            if (error instanceof SettlementRejectedError || error instanceof z.ZodError) await this.update(settlement.id, { status: 'reconciliation', errorCode: 'SETTLEMENT_REJECTED' });
            else this.logger.warn({ runId: settlement.id, errorCode: 'SETTLEMENT_PENDING' }, 'settlement_waiting');
          }
          const current = (await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, settlement.id)).limit(1))[0];
          if (current?.status !== 'settling') this.lastSettlementAttempt.delete(settlement.id);
        }
        await this.reconcileRefunds();
        const waiting = this.stopped || this.quarantineReason ? undefined : (await this.db.select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.createdAt)).limit(1))[0];
        if (waiting && !this.stopped) {
          const claimed = (await this.db.update(jobs).set({ status: 'running', updatedAt: new Date() }).where(and(eq(jobs.id, waiting.id), eq(jobs.status, 'queued'))).returning())[0];
          if (claimed) await this.execute(claimed);
          continue;
        }
        this.faulted = false;
      } catch (error) { this.faulted = true; this.logger.warn({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'worker_iteration_failed'); }
      await delay(1000);
    }
  }
  private async stoppedOnchain(job: Job): Promise<boolean> {
    const [run, leash] = await Promise.all([this.bridge.run(bytes32Schema.parse(job.id)), this.bridge.leash(bytes32Schema.parse(job.leashId))]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    return run.status !== 1 || run.stopAt > 0n || leash.killed || now >= run.acceptedExpiry || now >= leash.expiry
      || now >= run.openedAt + run.maxSeconds + 21600n;
  }
  private async execute(job: Job): Promise<void> {
    const deadline = await deadlineForRun(this.db, job);
    const abort = new AbortController(); this.current = abort; this.activeRunId = job.id;
    if (this.stopped) abort.abort();
    let monitorBusy = false;
    const monitor = setInterval(() => {
      if (monitorBusy) return;
      monitorBusy = true;
      this.stoppedOnchain(job).then(stopped => { if (stopped || (deadline && Date.now() >= deadline.deadlineAt.getTime())) abort.abort(); })
        .catch(() => abort.abort()).finally(() => { monitorBusy = false; }).catch(() => undefined);
    }, 1000);
    const ticks: MeterTick[] = [];
    let result: CpuRunResult | undefined;
    let providerIntentPersisted = false;
    try {
      if (deadline && Date.now() + job.input.maxSeconds * 1000 > deadline.deadlineAt.getTime()) {
        const meter = new RunMeter(job.id, job.input.maxSeconds);
        await meter.emit('timed_out', 0, '');
        result = { status: 'timed_out', output: '', exitCode: -1, billableSeconds: 0, ticks: meter.ticks };
        await this.queueReceipt(job, result, undefined, 'DEADLINE_MISSED'); return;
      }
      if (job.input.nearPrompt && (!this.near || (this.near.readiness && (await getNearProviderReadiness(this.near)).state !== 'ready'))) {
        const meter = new RunMeter(job.id, job.input.maxSeconds);
        await meter.emit('failed', 0, '');
        result = { status: 'failed', output: '', exitCode: -1, billableSeconds: 0, ticks: meter.ticks };
        await this.update(job.id, { cpuResult: jsonSafe(result), ticks: jsonSafe(result.ticks), billableSeconds: 0, output: '', errorCode: 'NEAR_NOT_READY' });
        await this.queueReceipt(job, result, undefined, 'NEAR_NOT_READY'); return;
      }
      if (await this.stoppedOnchain(job)) abort.abort();
      result = await this.cpu.run({ runId: job.id, task: job.input.task, maxSeconds: job.input.maxSeconds }, abort.signal, async tick => {
        ticks.push(tick);
        await this.update(job.id, { ticks: jsonSafe(ticks), billableSeconds: tick.billableSeconds });
      });
      await this.update(job.id, { cpuResult: jsonSafe(result), output: result.output, billableSeconds: result.billableSeconds, ticks: jsonSafe(result.ticks) });
      if (job.input.nearPrompt && result.status === 'completed' && !abort.signal.aborted) {
        if (!this.near) throw new ProviderRequestRejectedError();
        if (await this.stoppedOnchain(job)) { abort.abort(); await this.queueReceipt(job, result, undefined, undefined, 'cancelled'); return; }
        else {
          // Persist intent before the external request. Recovery never repeats this dispatch.
          await this.update(job.id, { status: 'near_dispatching' });
          providerIntentPersisted = true;
          const near = await this.near.complete({ prompt: job.input.nearPrompt, maxTokens: this.bridge.config.MAX_TOKENS, runId: job.id }, abort.signal);
          await this.update(job.id, { nearResult: jsonSafe(near), output: near.output, status: 'receipt_pending', targetStatus: result.status });
          // Once the successful provider result is durable, receipt failures cannot turn it into an unknown dispatch.
          await this.tryMakeReceipt(job, result, near);
          return;
        }
      }
      await this.queueReceipt(job, result, undefined, undefined,
        job.input.nearPrompt && result.status === 'completed' ? 'cancelled' : result.status);
    } catch (error) {
      if (error instanceof AmbiguousProviderError || (providerIntentPersisted && !(error instanceof ProviderRequestRejectedError))) {
        // A committed result write can lose its acknowledgement. Inspect durable evidence before declaring uncertainty.
        const saved = (await this.db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1))[0];
        let known: Awaited<ReturnType<Worker['knownProviderResult']>> | undefined;
        if (saved?.nearResult != null) {
          try { known = await this.knownProviderResult(saved); } catch { /* Invalid/missing evidence must remain unresolved. */ }
        }
        if (known && saved) await this.queueReceipt(saved, known.cpu, known.near);
        else await this.update(job.id, { status: 'reconciliation', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' });
      } else if (result && !(error instanceof CpuCleanupError)) {
        await this.queueReceipt(job, result, undefined, job.input.nearPrompt ? 'EXECUTION_FAILED' : undefined,
          job.input.nearPrompt && result.status === 'completed' ? (abort.signal.aborted ? 'cancelled' : 'failed') : result.status);
      } else {
        // Container/persistence cleanup failures must be inspected before settlement.
        this.quarantineReason = 'CPU_RECOVERY_REQUIRED';
        await this.update(job.id, { status: 'reconciliation', errorCode: 'CPU_RECOVERY_REQUIRED' });
      }
    } finally { clearInterval(monitor); this.current = undefined; this.activeRunId = undefined; }
  }
  private async knownProviderResult(job: Job) {
    const cpu = validateCpuResult(job.cpuResult, job.id, job.input.maxSeconds);
    if (cpu.billableSeconds !== job.billableSeconds || hashJson(cpu.ticks) !== hashJson(validateTicks(job.ticks, job.id, job.input.maxSeconds))) throw new Error('CPU result meter mismatch');
    return { cpu, near: await this.recoveredNear(job, cpu) };
  }
  private async recoveredNear(job: Job, cpu: CpuRunResult): Promise<Awaited<ReturnType<NearProvider['complete']>>> {
    const model = this.bridge.config.NEAR_MODEL;
    if (cpu.status !== 'completed' || !job.input.nearPrompt || BigInt(job.quote.inferencePrice) === 0n || !model) throw new Error('Invalid provider recovery');
    return await validateRecoveredNearResult(job.nearResult, { model, maxTokens: this.bridge.config.MAX_TOKENS });
  }
  private async queueReceipt(job: Job, cpu: CpuRunResult, near: Awaited<ReturnType<NearProvider['complete']>> | undefined,
    errorCode?: string, targetStatus: CpuRunStatus = cpu.status): Promise<void> {
    await this.update(job.id, { status: 'receipt_pending', targetStatus, cpuResult: jsonSafe(cpu), ticks: jsonSafe(cpu.ticks),
      billableSeconds: cpu.billableSeconds, output: near?.output ?? cpu.output, errorCode: errorCode ?? null });
    await this.tryMakeReceipt(job, { ...cpu, status: targetStatus }, near, errorCode);
  }
  private async tryMakeReceipt(job: Job, cpu: CpuRunResult, near: Awaited<ReturnType<NearProvider['complete']>> | undefined, errorCode?: string): Promise<void> {
    if (this.receiptsInFlight.has(job.id)) return;
    this.receiptsInFlight.add(job.id);
    this.lastReceiptAttempt.set(job.id, Date.now());
    try { await this.makeReceipt(job, cpu, near, errorCode); this.lastReceiptAttempt.delete(job.id); }
    catch { this.logger.warn({ runId: job.id, errorCode: 'RECEIPT_PENDING' }, 'receipt_waiting'); }
    finally { this.receiptsInFlight.delete(job.id); }
  }
  private async retryReceipt(job: Job): Promise<void> {
    let cpu: CpuRunResult, targetStatus: CpuRunStatus, near: Awaited<ReturnType<NearProvider['complete']>> | undefined;
    try {
      cpu = validateCpuResult(job.cpuResult, job.id, job.input.maxSeconds);
      const ticks = validateTicks(job.ticks, job.id, job.input.maxSeconds);
      targetStatus = outcomeSchema.parse(job.targetStatus);
      if (cpu.billableSeconds !== job.billableSeconds || hashJson(cpu.ticks) !== hashJson(ticks)) throw new Error('CPU result meter mismatch');
      if (targetStatus !== cpu.status && !(job.input.nearPrompt && cpu.status === 'completed' && ['failed', 'cancelled'].includes(targetStatus))) throw new Error('Invalid receipt outcome transition');
      if (job.nearResult != null) near = await this.recoveredNear(job, cpu);
      if (near && targetStatus !== 'completed') throw new Error('Invalid successful provider outcome');
      if (!near && job.input.nearPrompt && targetStatus === 'completed') throw new Error('Provider outcome missing');
    } catch {
      await this.update(job.id, { status: 'reconciliation', errorCode: 'RECEIPT_RECOVERY_REQUIRED' });
      this.lastReceiptAttempt.delete(job.id); return;
    }
    await this.tryMakeReceipt(job, { ...cpu, status: targetStatus }, near, job.errorCode ?? undefined);
  }
  private async retryReceipts(ignoreCooldown = false): Promise<void> {
    const cooling = ignoreCooldown ? [] : [...this.lastReceiptAttempt].filter(([, at]) => Date.now() - at <= 10000).map(([id]) => id);
    const pending = await this.nextRetryJob('receipt_pending', cooling);
    if (pending) await this.retryReceipt(pending);
  }
  private async nextRetryJob(status: 'receipt_pending' | 'settling', cooling: string[]): Promise<Job | undefined> {
    const cursor = this.retryCursors.get(status);
    const filters = [eq(jobs.status, status), ...(cooling.length ? [notInArray(jobs.id, cooling)] : [])];
    const selectNext = async (afterCursor: boolean) => (await this.db.select({ ...getTableColumns(jobs),
      cursorCreatedAt: sql<string>`${jobs.createdAt}::text` }).from(jobs).where(and(...filters,
        ...(afterCursor && cursor ? [or(gt(jobs.createdAt, sql`${cursor.createdAt}::timestamptz`),
          and(eq(jobs.createdAt, sql`${cursor.createdAt}::timestamptz`), gt(jobs.id, cursor.id)))] : [])))
      .orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(1))[0];
    const job = await selectNext(true) ?? (cursor ? await selectNext(false) : undefined);
    // Rotate rather than restarting at the oldest failure when its cooldown expires.
    if (job) this.retryCursors.set(status, { createdAt: job.cursorCreatedAt, id: job.id });
    return job;
  }
  private async makeReceipt(job: Job, cpu: CpuRunResult, near: Awaited<ReturnType<NearProvider['complete']>> | undefined, errorCode?: string): Promise<void> {
    const [run, leash] = await Promise.all([this.bridge.run(bytes32Schema.parse(job.id)), this.bridge.leash(bytes32Schema.parse(job.leashId))]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const cutoffs = [now, run.acceptedExpiry, ...(run.stopAt > 0n ? [run.stopAt] : []), ...(leash.killed ? [leash.killedAt] : [])];
    const cutoff = cutoffs.reduce((a, b) => a < b ? a : b);
    const measuredSeconds = cpu.billableSeconds;
    const deadline = await deadlineForRun(this.db, job);
    const finishedAt = cpu.ticks.at(-1)?.timestamp;
    const deadlineMissed = Boolean(deadline && (errorCode === 'DEADLINE_MISSED'
      || !finishedAt || !Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) > deadline.deadlineAt.getTime()));
    const billableSeconds = deadlineMissed ? 0 : Math.max(0, Math.min(measuredSeconds, Number(cutoff > run.openedAt ? cutoff - run.openedAt : 0n) + 1));
    const inferenceCharge = near ? job.quote.inferencePrice : '0';
    const charged = BigInt(job.quote.pricePerSecond) * BigInt(billableSeconds) + BigInt(inferenceCharge);
    const body = jsonSafe({ version: 1, runId: job.id, payer: job.owner, leashId: job.leashId, workloadHash: job.quote.workloadHash,
      status: cpu.status, cpu: { billingUnit: 'running_seconds', mode: this.bridge.config.CPU_MODE, billableSeconds, measuredSeconds,
        pricePerSecond: job.quote.pricePerSecond, ticks: cpu.ticks, outputHash: hashJson(cpu.output) },
      near: near ? { billingUnit: 'bounded_request', inferenceCharge, model: near.model, requestId: near.requestId,
        usage: near.usage ?? null, evidence: near.evidence, outputHash: hashJson(near.output) } : null,
      billing: { token: this.bridge.config.TOKEN_ADDRESS, ceiling: job.ceiling, charged: charged.toString(), refund: (BigInt(job.ceiling) - charged).toString() },
      ...(deadline ? { deadline: { jobId: deadline.id, deadlineAt: deadline.deadlineAt.toISOString(), finishedAt: finishedAt ?? null,
        missed: deadlineMissed, policy: 'full-ceiling-return-on-miss' } } : {}),
      issuedAt: new Date().toISOString() });
    const receiptHash = hashJson(body);
    const settlement = { runId: bytes32Schema.parse(job.id), billableSeconds: BigInt(billableSeconds), inferenceCharge: BigInt(inferenceCharge), receiptHash };
    const signature = await this.bridge.signSettlement(settlement);
    const receipt = { body, receiptHash, settlement: jsonSafe(settlement), signature, signer: this.bridge.account.address, domain: this.bridge.domain };
    await this.update(job.id, { status: 'settling', targetStatus: deadlineMissed ? 'timed_out' : cpu.status, receipt, billableSeconds,
      charged: charged.toString(), refund: (BigInt(job.ceiling) - charged).toString(),
      ...(deadlineMissed ? { errorCode: 'DEADLINE_MISSED' } : errorCode ? { errorCode } : {}) });
  }
  private async settle(job: Job): Promise<void> {
    const receipt: SignedReceipt = signedReceiptSchema.parse(job.receipt);
    const run = await this.bridge.run(bytes32Schema.parse(job.id));
    if (run.status === 3) { await this.update(job.id, { status: 'refunded', charged: '0', refund: job.ceiling }); return; }
    if (run.status === 2) {
      const settlement = receiptSettlement(receipt);
      if (run.receiptHash !== receipt.receiptHash || receipt.receiptHash !== hashJson(receipt.body) || settlement.runId !== job.id
        || run.billableSeconds !== settlement.billableSeconds || run.inferenceCharge !== settlement.inferenceCharge) throw new SettlementRejectedError();
      const journal = (await this.db.select().from(transactions).where(eq(transactions.runId, job.id)).limit(1))[0];
      // Recover the canonical transaction hash after mining but before the local final update.
      const hash = journal ? await this.bridge.settle(this.db, settlement, receipt.signature) : undefined;
      await this.update(job.id, { status: job.targetStatus ?? 'completed', ...(hash ? { settlementTxHash: hash } : {}) }); return;
    }
    if (run.status !== 1) { await this.update(job.id, { status: 'reconciliation', errorCode: 'CHAIN_RESERVATION_MISSING' }); return; }
    const hash = await this.bridge.settle(this.db, receiptSettlement(receipt), receipt.signature);
    await this.update(job.id, { status: job.targetStatus ?? 'completed', settlementTxHash: hash });
  }
  private async reconcileRefunds(): Promise<void> {
    const cursor = this.refundCursor;
    // Keep PostgreSQL microseconds: converting this cursor to Date would revisit its own row.
    const unknown = await this.db.select({ id: jobs.id, ceiling: jobs.ceiling, createdAt: sql<string>`${jobs.createdAt}::text` }).from(jobs)
      .where(and(eq(jobs.status, 'reconciliation'), ...(cursor ? [or(gt(jobs.createdAt, sql`${cursor.createdAt}::timestamptz`),
        and(eq(jobs.createdAt, sql`${cursor.createdAt}::timestamptz`), gt(jobs.id, cursor.id)))] : [])))
      .orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(20);
    // Advance across unresolved rows, including equal timestamps and temporary RPC failures.
    this.refundCursor = unknown.length === 20 ? unknown.at(-1) : undefined;
    const outcomes = await Promise.allSettled(unknown.map(job => this.bridge.run(bytes32Schema.parse(job.id))));
    for (const [index, outcome] of outcomes.entries()) {
      const job = unknown[index]!;
      if (outcome.status === 'rejected') {
        this.logger.warn({ runId: job.id, errorCode: 'REFUND_RECONCILIATION_PENDING' }, 'refund_reconciliation_waiting');
      } else if (outcome.value.status === 3) {
        await this.db.update(jobs).set({ status: 'refunded', charged: '0', refund: job.ceiling, updatedAt: new Date() })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, 'reconciliation')));
      }
    }
  }
  drainOnce(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Worker is stopped'));
    if (this.loop) return Promise.reject(new Error('Manual drain requires a worker without a running loop'));
    this.drainsPending++;
    const operation = this.drainQueue.then(() => this.drainOne()).finally(() => { this.drainsPending--; });
    this.drainQueue = operation.catch(() => undefined);
    return operation;
  }
  private async drainOne(): Promise<void> {
    const job = this.stopped || this.quarantineReason ? undefined : (await this.db.select().from(jobs).where(eq(jobs.status, 'queued')).limit(1))[0];
    if (job) {
      const claimed = (await this.db.update(jobs).set({ status: 'running', updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued'))).returning())[0];
      if (claimed) await this.execute(claimed);
    }
    await this.retryReceipts(true);
    const settling = await this.nextRetryJob('settling', []);
    if (settling) await this.settle(settling);
  }
}
