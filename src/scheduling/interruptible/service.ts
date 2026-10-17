import { and, desc, eq, sql } from 'drizzle-orm';
import { bytes32Schema, hashJson, Problem } from '../../common.js';
import type { Database } from '../../store.js';
import type { AgentLifecycleService } from '../../agents/service.js';
import { agentIntents } from '../../agents/schema.js';
import { hostKeySchema, hostMessageHash, verifyHostMessage } from '../../host-kit/protocol.js';
import { capacityIdentity, capacitySchema, selectCapacity, type Capacity } from '../planner.js';
import { interruptibleRuns, type InterruptibleRecord } from './schema.js';
import { approvedInterruptibleRunSchema, completedInterruptibleSettlementSchema, interruptibleAdmissionSchema,
  interruptibleKeySchema, interruptibleOwnerSchema, MAX_INTERRUPTIBLE_TARGETS, PREEMPTION_MAX_NOTICE_MS,
  PREEMPTION_MIN_NOTICE_MS, signedPreemptionNoticeSchema, type ApprovedInterruptibleRun,
  type CompletedInterruptibleSettlement } from './types.js';

export interface InterruptibleDependencies {
  lifecycle: AgentLifecycleService;
  controlKey: string;
  /** Reads existing authoritative reservations, owner/agent binding and admitted host terms. Never pays or reserves. */
  approvedRun(owner: string, agent: string, runId: string): Promise<ApprovedInterruptibleRun>;
  /** Actual admitted capacity only, never a synthetic host/GPU catalogue. */
  capacities(): Promise<Capacity[]>;
  /** Only confirmed controller receipts and confirmed cleanup qualify. Supports source and stopped target. Null means wait. */
  settlement(owner: string, agent: string, runId: string): Promise<CompletedInterruptibleSettlement | null>;
  now?: () => number;
}
export type InterruptibleProgress = { run: ReturnType<InterruptibleService['publicRecord']>;
  action: 'wait' | 'lifecycle' | 'done'; phase?: string };

/** Durable CPU preemption orchestration. Execution and encryption remain on the owner's client. */
export class InterruptibleService {
  constructor(private readonly db: Database, private readonly dependencies: InterruptibleDependencies) {
    hostKeySchema.parse(dependencies.controlKey);
  }
  private now() { return this.dependencies.now?.() ?? Date.now(); }
  private async row(ownerValue: string, idValue: string): Promise<InterruptibleRecord> {
    const owner = interruptibleOwnerSchema.parse(ownerValue), id = bytes32Schema.parse(idValue);
    const [row] = await this.db.select().from(interruptibleRuns).where(and(eq(interruptibleRuns.owner, owner), eq(interruptibleRuns.id, id))).limit(1);
    if (!row) throw new Problem(404, 'interruptible_not_found', 'Interruptible run not found.');
    const input = interruptibleAdmissionSchema.parse(row.input), source = approvedInterruptibleRunSchema.parse(row.source);
    if (input.agent !== row.agent || input.runId !== row.runId || source.owner !== owner || source.agent !== row.agent
      || source.runId !== row.runId || hashJson(input) !== row.requestHash || row.targets.length > MAX_INTERRUPTIBLE_TARGETS
      || !source.sourceLease || !verifyHostMessage(this.dependencies.controlKey, 'lease', source.sourceLease)
      || source.sourceLease.body.runId !== row.runId || source.sourceLease.body.owner !== owner
      || source.sourceLease.body.hostKey !== source.hostKey || source.capacity.lane !== 'interruptible'
      || source.sourceLease.body.maxSeconds !== source.maxSeconds || source.capacity.hardwareClass !== 'cpu') {
      throw new Problem(409, 'interruptible_journal_invalid', 'Durable interruptible admission failed validation.');
    }
    if (row.notice) {
      const notice = signedPreemptionNoticeSchema.parse(row.notice), body = notice.body;
      if (!verifyHostMessage(source.hostKey, 'control', notice) || body.owner !== owner || body.agent !== row.agent
        || body.runId !== row.runId || body.hostKey !== source.hostKey || body.leaseHash !== hostMessageHash(source.sourceLease)
        || body.interruptAt - body.issuedAt < PREEMPTION_MIN_NOTICE_MS || body.interruptAt - body.issuedAt > PREEMPTION_MAX_NOTICE_MS)
        throw new Problem(409, 'interruptible_journal_invalid', 'Durable host preemption notice failed validation.');
    }
    for (const candidate of row.targets) {
      const target = approvedInterruptibleRunSchema.parse(candidate);
      if (target.owner !== owner || target.agent !== row.agent || target.runId === row.runId
        || target.capacity.hostId === source.capacity.hostId || target.maxSeconds !== input.resumeSeconds)
        throw new Problem(409, 'interruptible_journal_invalid', 'Durable target reservation changed its approved scope.');
    }
    if (row.settlement) this.validateSettlement(row, row.settlement);
    if (row.targetSettlement) {
      const target = row.targets.find(candidate => candidate.runId === row.targetSettlement!.runId);
      if (!target) throw new Problem(409, 'interruptible_journal_invalid', 'Target receipt has no separately approved reservation.');
      this.validateSettlement(row, row.targetSettlement, target);
    }
    return row;
  }
  private validateRun(value: unknown, owner: string, agent: string, runId: string, source: boolean) {
    const run = approvedInterruptibleRunSchema.parse(value);
    if (run.owner !== owner || run.agent !== agent || run.runId !== runId || run.capacity.hardwareClass !== 'cpu'
      || run.active !== source || run.leaseUntil <= this.now()
      || BigInt(run.ceiling) !== BigInt(run.capacity.pricePerSecond) * BigInt(run.maxSeconds)) {
      throw new Problem(409, 'interruptible_reservation_invalid', 'Use an existing matching CPU reservation with exact published terms.');
    }
    if (source) {
      const lease = run.sourceLease;
      if (!lease || !verifyHostMessage(this.dependencies.controlKey, 'lease', lease) || lease.body.runId !== runId
        || lease.body.owner !== owner || lease.body.hostKey !== run.hostKey || lease.body.maxSeconds !== run.maxSeconds
        || lease.body.expiresAt <= this.now() || !lease.body.image.endsWith('@' + run.capacity.imageDigest)) {
        throw new Problem(409, 'interruptible_lease_invalid', 'The active run requires its original controller-signed host lease.');
      }
    }
    return run;
  }
  publicRecord(row: InterruptibleRecord) {
    const spent = (BigInt(row.settlement?.charged ?? '0') + BigInt(row.targetSettlement?.charged ?? '0')).toString();
    const budget = BigInt(row.input.maxSpend) - BigInt(spent);
    return { id: row.id, owner: row.owner, agent: row.agent, runId: row.runId, state: row.state, version: row.version,
      deadline: row.input.deadline, resumeSeconds: row.input.resumeSeconds, maxSpend: row.input.maxSpend,
      spent, remainingBudget: (budget < 0n ? 0n : budget).toString(),
      confirmedSourceRefund: row.settlement?.refund ?? null, refundConfirmed: row.settlement !== null,
      confirmedTargetRefund: row.targetSettlement?.refund ?? null,
      completedSeconds: row.settlement?.billableSeconds ?? null, receiptId: row.settlement?.receiptId ?? null,
      notice: row.notice, checkpointId: row.checkpointId, targetRunId: row.targetRunId,
      approvedTargetRunIds: row.targets.map(target => target.runId), reason: row.reason,
      unconfirmedTargetReservations: row.state === 'cancelled' ? row.targets.filter(target => target.runId !== row.targetSettlement?.runId)
        .map(target => ({ runId: target.runId, ceiling: target.ceiling, refundStatus: 'unconfirmed' as const })) : [],
      walletActionRequired: false as const, sourceSettlementPending: row.settlement === null && row.state !== 'admitted',
      cancellationMayKillJobAgent: true as const, applicationStateOnly: true as const };
  }
  async get(owner: string, id: string) { return this.publicRecord(await this.row(owner, id)); }
  async list(ownerValue: string) {
    const owner = interruptibleOwnerSchema.parse(ownerValue);
    const rows = await this.db.select().from(interruptibleRuns).where(eq(interruptibleRuns.owner, owner))
      .orderBy(desc(interruptibleRuns.createdAt), desc(interruptibleRuns.id)).limit(128);
    return { runs: rows.map(row => this.publicRecord(row)) };
  }
  async admit(ownerValue: string, value: unknown, keyValue: string) {
    const owner = interruptibleOwnerSchema.parse(ownerValue), input = interruptibleAdmissionSchema.parse(value);
    const key = interruptibleKeySchema.parse(keyValue), requestHash = hashJson(input);
    const id = hashJson({ domain: 'telomere.interruptible.v1', owner, key });
    const [old] = await this.db.select().from(interruptibleRuns).where(eq(interruptibleRuns.id, id)).limit(1);
    if (old) {
      if (old.owner !== owner || old.requestHash !== requestHash) throw new Problem(409, 'interruptible_idempotency_conflict', 'Keep the original opt-in and budget on retries.');
      return { run: await this.get(owner, id), replayed: true };
    }
    const source = this.validateRun(await this.dependencies.approvedRun(owner, input.agent, input.runId), owner, input.agent, input.runId, true);
    const current = await this.dependencies.lifecycle.get(owner, input.agent);
    if (source.capacity.lane !== 'interruptible' || current.agent.currentRunId !== input.runId || current.intent || current.agent.killedAt
      || BigInt(input.maxSpend) < BigInt(source.ceiling) || input.deadline * 1000 <= this.now() + input.resumeSeconds * 1000
      || input.deadline * 1000 > this.now() + 7 * 86400_000) {
      throw new Problem(409, 'interruptible_admission_rejected', 'Opt in an active interruptible CPU job with an attainable deadline and budget covering its existing ceiling.');
    }
    selectCapacity({ ...input.placement, seconds: 1, maxSpend: input.maxSpend, deadline: input.deadline,
      now: Math.floor(this.now() / 1000) }, [source.capacity]);
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${owner}), 26419)`);
      const [previous] = await tx.select().from(interruptibleRuns).where(eq(interruptibleRuns.id, id)).limit(1);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Problem(409, 'interruptible_idempotency_conflict', 'Keep the original admission on retries.');
        return { run: this.publicRecord(previous), replayed: true };
      }
      const rows = await tx.select().from(interruptibleRuns).where(eq(interruptibleRuns.owner, owner)).limit(128);
      if (rows.length >= 128) throw new Problem(409, 'interruptible_quota', 'Archive completed interruptible history before admitting another job.');
      if (rows.some(row => row.agent === input.agent && !['resumed', 'cancelled'].includes(row.state)) || rows.some(row => row.runId === input.runId))
        throw new Problem(409, 'interruptible_admission_conflict', 'The source run or agent already has an interruptible admission.');
      const [row] = await tx.insert(interruptibleRuns).values({ id, owner, agent: input.agent, runId: input.runId,
        idemKey: key, requestHash, input, source, createdAt: new Date(this.now()), updatedAt: new Date(this.now()) }).returning();
      if (!row) throw new Error('Interruptible admission was not persisted');
      return { run: this.publicRecord(row), replayed: false };
    });
  }
  async approveTarget(ownerValue: string, id: string, runIdValue: string) {
    const row = await this.row(ownerValue, id), runId = bytes32Schema.parse(runIdValue);
    const previous = row.targets.find(target => target.runId === runId);
    if (previous) return { run: this.publicRecord(row), replayed: true };
    const target = this.validateRun(await this.dependencies.approvedRun(row.owner, row.agent, runId), row.owner, row.agent, runId, false);
    if (target.runId === row.runId || target.capacity.hostId === row.source.capacity.hostId || target.maxSeconds !== row.input.resumeSeconds)
      throw new Problem(409, 'interruptible_target_invalid', 'Approve a different admitted host and an existing reservation bounded to the resume duration.');
    return this.db.transaction(async tx => {
      const [locked] = await tx.select().from(interruptibleRuns).where(and(eq(interruptibleRuns.id, id), eq(interruptibleRuns.owner, row.owner))).for('update');
      if (!locked) throw new Problem(404, 'interruptible_not_found', 'Interruptible run not found.');
      if (locked.targets.some(item => item.runId === runId)) return { run: this.publicRecord(locked), replayed: true };
      if (!['admitted', 'noticed', 'checkpointing', 'settling', 'selecting'].includes(locked.state)
        || locked.targets.length >= MAX_INTERRUPTIBLE_TARGETS || locked.targets.some(item => item.capacity.hostId === target.capacity.hostId))
        throw new Problem(409, 'interruptible_target_conflict', 'Target approval is closed, full, or ambiguous for this host.');
      const [updated] = await tx.update(interruptibleRuns).set({ targets: [...locked.targets, target], version: locked.version + 1,
        updatedAt: new Date(this.now()) }).where(eq(interruptibleRuns.id, id)).returning();
      if (!updated) throw new Error('Target approval was not persisted');
      return { run: this.publicRecord(updated), replayed: false };
    });
  }
  async acceptNotice(ownerValue: string, id: string, value: unknown) {
    const row = await this.row(ownerValue, id), notice = signedPreemptionNoticeSchema.parse(value), body = notice.body;
    if (row.notice) {
      if (hashJson(row.notice) !== hashJson(notice)) throw new Problem(409, 'interruptible_notice_conflict', 'The source already has a different immutable notice.');
      return { run: this.publicRecord(row), replayed: true };
    }
    const now = this.now(), current = await this.dependencies.lifecycle.get(row.owner, row.agent);
    if (!verifyHostMessage(row.source.hostKey, 'control', notice) || body.hostKey !== row.source.hostKey
      || body.owner !== row.owner || body.agent !== row.agent || body.runId !== row.runId
      || body.leaseHash !== hostMessageHash(row.source.sourceLease!) || Math.abs(body.issuedAt - now) > 5000
      || body.interruptAt - body.issuedAt < PREEMPTION_MIN_NOTICE_MS || body.interruptAt - now < PREEMPTION_MIN_NOTICE_MS
      || body.interruptAt - body.issuedAt > PREEMPTION_MAX_NOTICE_MS || body.interruptAt > row.source.sourceLease!.body.expiresAt
      || row.state !== 'admitted' || current.agent.currentRunId !== row.runId || current.intent || current.agent.killedAt) {
      throw new Problem(409, 'interruptible_notice_rejected', 'Use the pinned host notice for this opted-in active lease with at least 30 seconds remaining.');
    }
    const updated = await this.change(row, { notice, state: 'noticed', sleepVersion: current.agent.version });
    if (!updated.notice || hashJson(updated.notice) !== hashJson(notice)) throw new Problem(409, 'interruptible_notice_conflict', 'A different notice won the concurrent update.');
    return { run: this.publicRecord(updated), replayed: updated.version !== row.version + 1 };
  }
  private async change(row: InterruptibleRecord, patch: Partial<typeof interruptibleRuns.$inferInsert>) {
    const [updated] = await this.db.update(interruptibleRuns).set({ ...patch, version: row.version + 1, updatedAt: new Date(this.now()) })
      .where(and(eq(interruptibleRuns.id, row.id), eq(interruptibleRuns.owner, row.owner), eq(interruptibleRuns.version, row.version))).returning();
    return updated ?? this.row(row.owner, row.id);
  }
  private key(row: InterruptibleRecord, action: 'sleep' | 'wake' | 'cancel') { return 'interrupt_' + action + '_' + row.id.slice(2); }
  private async intent(row: InterruptibleRecord, action: 'sleep' | 'wake' | 'cancel') {
    // Read existing immutable operation identity before attempting a plan again. Completed wake intents must be
    // recoverable even when their former reservation is now active or expired; no new reservation is consulted.
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.owner, row.owner),
      eq(agentIntents.idemKey, this.key(row, action)))).limit(1);
    if (!intent) return undefined;
    if (intent.agent !== row.agent || intent.kind !== (action === 'cancel' ? 'kill' : action))
      throw new Problem(409, 'interruptible_lifecycle_scope', 'The durable operation identity belongs to a different lifecycle transition.');
    return { intent, agent: (await this.dependencies.lifecycle.get(row.owner, row.agent)).agent };
  }
  private async assertCancellationScope(row: InterruptibleRecord,
    current: Awaited<ReturnType<AgentLifecycleService['get']>>) {
    const active = current.agent.currentRunId, pending = current.intent;
    const changed = () => new Problem(409, 'interruptible_agent_changed',
      'The agent left the original source or approved wake transition before cancellation.');
    if (active !== null && active !== row.runId && active !== row.targetRunId) throw changed();
    if (pending?.kind === 'sleep') {
      const original = await this.intent(row, 'sleep');
      if (!original || original.intent.id !== pending.id || pending.sourceRunId !== row.runId) throw changed();
    } else if (pending?.kind === 'wake') {
      const original = await this.intent(row, 'wake');
      if (!original || original.intent.id !== pending.id || !row.targetRunId
        || pending.targetRunId !== row.targetRunId) throw changed();
    } else if (pending) throw changed();
    if (active !== null && active === row.targetRunId) {
      const original = await this.intent(row, 'wake');
      if (!original || original.intent.targetRunId !== row.targetRunId
        || original.intent.phase !== 'done') throw changed();
    }
  }
  private async cancellation(row: InterruptibleRecord, reason: string) {
    const current = await this.dependencies.lifecycle.get(row.owner, row.agent);
    await this.assertCancellationScope(row, current);
    return this.change(row, { state: 'cancelling', reason, cancelVersion: current.agent.version });
  }
  private validateSettlement(row: InterruptibleRecord, value: unknown, run: ApprovedInterruptibleRun = row.source) {
    const settlement = completedInterruptibleSettlementSchema.parse(value);
    if (settlement.owner !== row.owner || settlement.agent !== row.agent || settlement.runId !== run.runId
      || settlement.ceiling !== run.ceiling || settlement.pricePerSecond !== run.capacity.pricePerSecond
      || settlement.billableSeconds > run.maxSeconds
      || BigInt(settlement.charged) !== BigInt(settlement.billableSeconds) * BigInt(settlement.pricePerSecond)
      || BigInt(settlement.charged) + BigInt(settlement.refund) !== BigInt(settlement.ceiling)
      || BigInt(settlement.charged) + (run.runId === row.runId ? 0n : BigInt(row.settlement?.charged ?? '0')) > BigInt(row.input.maxSpend))
      throw new Problem(409, 'interruptible_settlement_invalid', 'Confirmed source settlement must charge completed seconds only and conserve the original reservation.');
    return settlement;
  }
  private async feasibleTarget(row: InterruptibleRecord, target: ApprovedInterruptibleRun) {
    const fresh = this.validateRun(await this.dependencies.approvedRun(row.owner, row.agent, target.runId), row.owner, row.agent, target.runId, false);
    if (fresh.hostKey !== target.hostKey || fresh.capacity.hostId !== target.capacity.hostId || fresh.ceiling !== target.ceiling
      || fresh.maxSeconds !== row.input.resumeSeconds || fresh.capacity.imageDigest !== target.capacity.imageDigest
      || fresh.capacity.lane !== target.capacity.lane || fresh.capacity.pricePerSecond !== target.capacity.pricePerSecond)
      throw new Problem(409, 'interruptible_target_changed', 'The separately approved target terms changed.');
    const catalogue = await this.dependencies.capacities();
    if (catalogue.length > 1000) throw new Problem(409, 'interruptible_capacity_limit', 'Admitted capacity exceeds its bounded catalogue.');
    const matching = catalogue.map(item => capacitySchema.parse(item))
      .filter(item => capacityIdentity(item) === capacityIdentity(fresh.capacity));
    if (matching.length !== 1 || matching[0]!.hardwareClass !== fresh.capacity.hardwareClass
      || matching[0]!.pricePerSecond !== fresh.capacity.pricePerSecond || matching[0]!.imageDigest !== fresh.capacity.imageDigest
      || matching[0]!.region !== fresh.capacity.region || matching[0]!.sealed !== fresh.capacity.sealed || matching[0]!.lane !== fresh.capacity.lane)
      throw new Problem(409, 'interruptible_capacity_unavailable', 'The target is absent from admitted capacity or its approved terms changed.');
    const budget = BigInt(row.input.maxSpend) - BigInt(row.settlement!.charged);
    const placement = selectCapacity({ ...row.input.placement, seconds: row.input.resumeSeconds, maxSpend: budget.toString(),
      deadline: row.input.deadline, now: Math.ceil(this.now() / 1000) }, matching);
    if (fresh.leaseUntil < placement.plannedFinish * 1000 || BigInt(fresh.ceiling) > budget)
      throw new Problem(409, 'interruptible_target_infeasible', 'The approved reservation cannot cover the remaining deadline and budget.');
    return { target: fresh, capacity: matching[0]! };
  }
  /** Advances trusted durable facts only. It never acknowledges client execution or runs a child process. */
  async advance(ownerValue: string, id: string): Promise<InterruptibleProgress> {
    let row = await this.row(ownerValue, id);
    for (let index = 0; index < 10; index++) {
      const result = (action: InterruptibleProgress['action'], phase?: string): InterruptibleProgress => ({ run: this.publicRecord(row), action,
        ...(phase === undefined ? {} : { phase }) });
      if (row.state === 'resumed' || row.state === 'cancelled') return result('done');
      if (row.state === 'admitted') return result('wait', 'host_notice');
      if (row.state === 'noticed') {
        const planned = await this.intent(row, 'sleep') ?? await this.dependencies.lifecycle.plan(row.owner, row.agent,
          { action: 'sleep', expectedVersion: row.sleepVersion! }, this.key(row, 'sleep'));
        if (planned.intent.sourceRunId !== row.runId || planned.intent.kind !== 'sleep') throw new Problem(409, 'interruptible_lifecycle_scope', 'The checkpoint intent differs from its admitted source.');
        row = await this.change(row, { state: 'checkpointing', sleepIntentId: planned.intent.id });
      } else if (row.state === 'checkpointing') {
        const planned = await this.intent(row, 'sleep') ?? await this.dependencies.lifecycle.plan(row.owner, row.agent,
          { action: 'sleep', expectedVersion: row.sleepVersion! }, this.key(row, 'sleep'));
        if (planned.intent.id !== row.sleepIntentId || planned.intent.sourceRunId !== row.runId) throw new Problem(409, 'interruptible_lifecycle_scope', 'Checkpoint recovery found a different lifecycle intent.');
        if (planned.intent.phase !== 'done') {
          if (this.now() >= row.notice!.body.interruptAt && planned.intent.phase === 'checkpoint') row = await this.cancellation(row, 'checkpoint_notice_expired');
          else return result('lifecycle', planned.intent.phase);
        } else if (planned.agent.currentRunId !== null || !planned.intent.checkpointId || planned.agent.checkpointId !== planned.intent.checkpointId) {
          throw new Problem(409, 'interruptible_stop_unconfirmed', 'Checkpoint and source stop must finish before choosing another host.');
        } else row = await this.change(row, { state: 'settling', checkpointId: planned.intent.checkpointId });
      } else if (row.state === 'settling') {
        const settlement = await this.dependencies.settlement(row.owner, row.agent, row.runId);
        if (!settlement) return result('wait', 'source_settlement');
        row = await this.change(row, { state: 'selecting', settlement: this.validateSettlement(row, settlement) });
      } else if (row.state === 'selecting') {
        // A wake plan can commit just before a provisional target loses capacity. Once it exists,
        // changing targets would reuse the same lifecycle operation key with different terms.
        // Stop conservatively instead of allowing a second attachment or payment claim.
        if (await this.intent(row, 'wake')) { row = await this.cancellation(row, 'wake_intent_during_replan'); continue; }
        const candidates: Awaited<ReturnType<InterruptibleService['feasibleTarget']>>[] = [];
        for (const target of row.targets) {
          try { candidates.push(await this.feasibleTarget(row, target)); }
          catch (error) { if (!(error instanceof Problem) || error.status >= 500) throw error; }
        }
        if (!candidates.length) { row = await this.cancellation(row, row.targets.length ? 'deadline_budget_or_capacity_infeasible' : 'no_separately_approved_target'); continue; }
        const selected = selectCapacity({ ...row.input.placement, seconds: row.input.resumeSeconds,
          maxSpend: (BigInt(row.input.maxSpend) - BigInt(row.settlement!.charged)).toString(), deadline: row.input.deadline,
          now: Math.ceil(this.now() / 1000) }, candidates.map(item => item.capacity));
        const target = candidates.find(item => item.capacity.hostId === selected.host.hostId)!.target;
        const current = await this.dependencies.lifecycle.get(row.owner, row.agent);
        if (current.intent || current.agent.currentRunId !== null || current.agent.checkpointId !== row.checkpointId)
          throw new Problem(409, 'interruptible_agent_changed', 'The sleeping job changed before its separately approved wake.');
        row = await this.change(row, { state: 'waking', targetRunId: target.runId, wakeVersion: current.agent.version });
      } else if (row.state === 'waking') {
        const existing = await this.intent(row, 'wake');
        if (existing && existing.intent.targetRunId !== row.targetRunId) {
          const original = row.targets.find(item => item.runId === existing.intent.targetRunId);
          if (!original) throw new Problem(409, 'interruptible_lifecycle_scope', 'A racing wake intent names an unapproved target.');
          const current = await this.dependencies.lifecycle.get(row.owner, row.agent);
          // A concurrent wake plan won the fixed operation key after a different target was
          // selected. Keep its actual target for stop/settlement accounting and do not attach
          // the newly selected one.
          row = await this.change(row, { state: 'cancelling', targetRunId: original.runId,
            cancelVersion: current.agent.version, reason: 'wake_intent_target_race' }); continue;
        }
        if (existing?.intent.phase === 'done') {
          if (existing.intent.targetRunId !== row.targetRunId || existing.agent.currentRunId !== row.targetRunId)
            throw new Problem(409, 'interruptible_resume_unconfirmed', 'The approved target did not resume.');
          row = await this.change(row, { state: 'resumed', wakeIntentId: existing.intent.id }); continue;
        }
        const selected = row.targets.find(item => item.runId === row.targetRunId);
        if (!selected) throw new Problem(409, 'interruptible_target_missing', 'The durable target is not separately approved.');
        // Check before both attach and resume. A late client can never resume an infeasible reserved target.
        try { await this.feasibleTarget(row, selected); }
        catch (error) {
          if (!(error instanceof Problem) || error.status >= 500) throw error;
          // No lifecycle wake intent has been created, so this selected target has had no
          // attach/resume effect. Re-evaluate the other already funded reservations using the
          // confirmed source charge, original deadline and remaining exact budget.
          if (!existing && !row.wakeIntentId && !await this.intent(row, 'wake')) {
            row = await this.change(row, { state: 'selecting' }); continue;
          }
          row = await this.cancellation(row, 'target_deadline_budget_or_reservation_lost'); continue;
        }
        const planned = existing ?? await this.dependencies.lifecycle.plan(row.owner, row.agent,
          { action: 'wake', expectedVersion: row.wakeVersion!, targetRunId: row.targetRunId! }, this.key(row, 'wake'));
        if (planned.intent.kind !== 'wake' || planned.intent.targetRunId !== row.targetRunId) {
          row = await this.cancellation(row, 'agent_cannot_resume'); continue;
        }
        if (!row.wakeIntentId) { row = await this.change(row, { wakeIntentId: planned.intent.id }); continue; }
        if (row.wakeIntentId !== planned.intent.id) throw new Problem(409, 'interruptible_lifecycle_scope', 'Wake recovery found a different intent.');
        if (planned.intent.phase !== 'done') return result('lifecycle', planned.intent.phase);
        if (planned.agent.currentRunId !== row.targetRunId) throw new Problem(409, 'interruptible_resume_unconfirmed', 'The approved target did not resume.');
        row = await this.change(row, { state: 'resumed' });
      } else {
        const current = await this.dependencies.lifecycle.get(row.owner, row.agent);
        if (!current.intent && current.agent.currentRunId === null) {
          // Settled source refunds remain facts; a missing receipt never becomes an invented refund.
          if (!row.settlement) {
            const settlement = await this.dependencies.settlement(row.owner, row.agent, row.runId);
            if (!settlement) return result('wait', 'source_settlement');
            row = await this.change(row, { settlement: this.validateSettlement(row, settlement) }); continue;
          }
          // An attached target may have an actual controller receipt even when resume was cancelled. Wait for it;
          // never manufacture a zero charge or full refund from the mere absence of an application resume ACK.
          const originalWake = row.targetRunId ? await this.intent(row, 'wake') : undefined;
          const targetMayHaveRun = originalWake?.intent.targetRunId === row.targetRunId
            && originalWake.intent.phase === 'done';
          if ((row.cancelIntentId || targetMayHaveRun) && row.targetRunId && !row.targetSettlement) {
            const target = row.targets.find(item => item.runId === row.targetRunId);
            if (!target) throw new Problem(409, 'interruptible_cancel_scope', 'Cancelled target is absent from approved reservations.');
            const settlement = await this.dependencies.settlement(row.owner, row.agent, row.targetRunId);
            if (!settlement) return result('wait', 'target_settlement');
            row = await this.change(row, { targetSettlement: this.validateSettlement(row, settlement, target) }); continue;
          }
          row = await this.change(row, { state: 'cancelled' }); continue;
        }
        let planned: { intent: { id: string; kind: string; phase: string } } | undefined = await this.intent(row, 'cancel');
        if (!planned) {
          await this.assertCancellationScope(row, current);
          try {
            planned = await this.dependencies.lifecycle.plan(row.owner, row.agent,
              { action: 'kill', expectedVersion: row.cancelVersion! }, this.key(row, 'cancel'));
          } catch (error) {
            // A wake acknowledgment can advance the agent after cancellation captures its version.
            // No cancel intent committed on a version conflict, so refresh before retrying the
            // same fixed kill operation key; otherwise the paid target could keep running.
            if (!(error instanceof Problem) || error.code !== 'agent_version_conflict') throw error;
            const latest = await this.dependencies.lifecycle.get(row.owner, row.agent);
            if (latest.agent.version === row.cancelVersion) throw error;
            // A concurrent owner stop may have left no work to kill. Re-enter the
            // idle branch rather than spending a fresh version on permanent kill.
            if (latest.agent.currentRunId === null && !latest.intent) {
              row = await this.change(row, { cancelVersion: latest.agent.version }); continue;
            }
            await this.assertCancellationScope(row, latest);
            row = await this.change(row, { cancelVersion: latest.agent.version }); continue;
          }
        }
        if (planned.intent.kind !== 'kill') throw new Problem(409, 'interruptible_cancel_scope', 'Cancellation did not produce a terminal stop.');
        if (!row.cancelIntentId) { row = await this.change(row, { cancelIntentId: planned.intent.id }); continue; }
        if (planned.intent.id !== row.cancelIntentId) throw new Problem(409, 'interruptible_cancel_scope', 'Cancellation recovery found a different intent.');
        if (planned.intent.phase !== 'done') return result('lifecycle', planned.intent.phase);
      }
    }
    return { run: this.publicRecord(row), action: 'wait', phase: 'retry' };
  }
  /** Call immediately before a client lifecycle phase; service rechecks feasibility on each phase. */
  async validateClientStep(owner: string, id: string, intentId: string, phase: string) {
    const progress = await this.advance(owner, id), row = await this.row(owner, id);
    const expected = row.state === 'checkpointing' ? row.sleepIntentId : row.state === 'waking' ? row.wakeIntentId : row.cancelIntentId;
    if (progress.action !== 'lifecycle' || expected !== intentId || progress.phase !== phase)
      throw new Problem(409, 'interruptible_phase_changed', 'Refresh the interruptible transition before executing this client phase.');
    return progress;
  }
}
