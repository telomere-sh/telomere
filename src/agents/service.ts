import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { bytes32Schema, hashJson, Problem } from '../common.js';
import type { Database } from '../store.js';
import type { CystService } from '../cysts/service.js';
import { cystIdSchema } from '../cysts/types.js';
import { agents, agentIntents, agentBilling, agentBillingProvenance, type AgentRecord, type AgentIntent } from './schema.js';
import { agentAddressSchema, evaluateMetabolism, intentIdSchema, lifecycleIdempotencySchema, POLICY, PAID_AGENT_POLICY,
  runIdSchema, unitsSchema, type ReservedAgentRun } from './types.js';
import { evaluateMetabolismV2, paidMetabolismRate, paidMetabolismSnapshotSchema, type PaidMetabolismSnapshot } from './metabolism-v2.js';

export interface AgentLifecycleDependencies {
  cysts: CystService;
  /** Read confirmed available escrow balance, excluding outstanding reservations. */
  balance(owner: string, agent: string): Promise<string>;
  /** Must verify authoritative run reservation, agent binding and owner; never reserve or send a transaction. */
  reservedRun(owner: string, agent: string, runId: string): Promise<ReservedAgentRun>;
  ensureReady?(): Promise<void>;
  refreshBilling?(owner: string, agent: string): Promise<void>;
  /** Trusted canonical paid run/catalogue reader; rates are never supplied in an HTTP request. */
  metabolismPricing?(owner: string, agent: string, currentRunId: string | null): Promise<PaidMetabolismSnapshot>;
  leasePolicy?: 'paid_cpu';
  /** Resolve registry authority before SQL; commit the reviewed binding atomically with the agent row. */
  prepareRegistration?(owner: string, agent: string): Promise<{ commit(tx: Transaction, existing: boolean): Promise<void> }>;
  now?: () => Date;
}
const checkpointAck = z.object({ phase: z.literal('checkpoint'), checkpointId: cystIdSchema,
  checkpointSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const stepAck = z.object({ phase: z.enum(['stop', 'attach', 'resume', 'profile']) }).strict();
const ackSchema = z.union([checkpointAck, stepAck]);
const billingProvenanceSchema = z.object({ transactionHash: bytes32Schema,
  blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), blockHash: bytes32Schema }).strict();
export function agentBillingFactsHash(entry: { owner: string; agent: string; receiptId: string; amount: string; settledAt: Date },
  provenance: z.output<typeof billingProvenanceSchema>): string {
  return hashJson({ owner: entry.owner, agent: entry.agent, receiptId: entry.receiptId, amount: entry.amount,
    settledAt: entry.settledAt.toISOString(), ...provenance });
}
const actionSchema = z.object({ action: z.enum(['evaluate', 'migrate', 'sleep', 'wake', 'kill']),
  expectedVersion: z.number().int().nonnegative(), targetRunId: runIdSchema.optional(),
  metabolismVersion: z.literal(2).optional(),
  wakeAt: z.string().datetime({ offset: true }).nullable().optional() }).strict();
function publicAgent(row: AgentRecord) {
  return { ...row, leaseUntil: row.leaseUntil?.toISOString() ?? null, wakeAt: row.wakeAt?.toISOString() ?? null,
    killedAt: row.killedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function publicIntent(row: AgentIntent) {
  const { metabolismVersion, metabolismEvaluation, ...original } = row;
  if (metabolismVersion === null ? metabolismEvaluation !== null : metabolismVersion !== 2 || !metabolismEvaluation) {
    throw new Error('Lifecycle intent Metabolism version is inconsistent');
  }
  if (metabolismEvaluation && (hashJson(evaluateMetabolismV2(metabolismEvaluation.balance,
    metabolismEvaluation.trailing24hBurn, metabolismEvaluation.pricing)) !== hashJson(metabolismEvaluation)
    || row.kind !== 'sleep' && row.targetMode !== metabolismEvaluation.mode)) {
    throw new Error('Lifecycle intent Metabolism decision changed');
  }
  return { ...original, ...(metabolismVersion === 2 ? { metabolismVersion: 2 as const, metabolismEvaluation: metabolismEvaluation! } : {}),
    targetLeaseUntil: row.targetLeaseUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
function assertTargetMetabolismRate(pricing: PaidMetabolismSnapshot, mode: string, target: ReservedAgentRun) {
  const projection = pricing.projections.find(rate => rate.resourceProfile === mode);
  if (!projection || !target.paidPrice) throw new Problem(409, 'agent_target_rate_unavailable', 'The approved target needs a canonical paid rate matching this Metabolism decision.');
  const actual = paidMetabolismRate({ ...projection, runId: bytes32Schema.parse(target.id), ...target.paidPrice, feeBps: 900 });
  if (BigInt(actual.completeLeaseCost) * BigInt(projection.leaseSeconds)
    > BigInt(projection.completeLeaseCost) * BigInt(actual.leaseSeconds)) {
    throw new Problem(409, 'agent_target_rate_exceeded', 'The canonical target rate exceeds the original reviewed Metabolism projection.');
  }
}

export class AgentLifecycleService {
  constructor(private readonly db: Database, private readonly dependencies: AgentLifecycleDependencies) {}
  private get policy() { return this.dependencies.leasePolicy === 'paid_cpu' ? PAID_AGENT_POLICY : POLICY; }
  private now(): Date { return this.dependencies.now?.() ?? new Date(); }
  private async row(ownerValue: string, agentValue: string, tx: Database | Transaction = this.db, locked = false): Promise<AgentRecord> {
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const query = tx.select().from(agents).where(and(eq(agents.owner, owner), eq(agents.agent, agent))).limit(1);
    const [record] = await (locked ? query.for('update') : query);
    if (!record) throw new Problem(404, 'agent_not_found', 'Agent not found.');
    return record;
  }
  private async reservation(owner: string, agent: string, runId: string): Promise<ReservedAgentRun> {
    const run = await this.dependencies.reservedRun(owner, agent, runIdSchema.parse(runId));
    const now = this.now().getTime();
    if (run.id !== runId || agentAddressSchema.parse(run.owner) !== owner || agentAddressSchema.parse(run.agent) !== agent
      || run.reserved !== true || !Number.isFinite(run.leaseUntil.getTime()) || run.leaseUntil.getTime() <= now
      || run.leaseUntil.getTime() > now + this.policy.maximumLeaseSeconds * 1000) {
      throw new Problem(409, 'agent_reservation_invalid', this.dependencies.leasePolicy === 'paid_cpu'
        ? 'Use an approved reserved CPU run for this owner and agent with a lease of at most 120 seconds.'
        : 'Use an approved reserved run for this owner and agent with a lease of at most 24 hours.');
    }
    return run;
  }
  async register(ownerValue: string, value: unknown) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue);
    const input = z.object({ agent: agentAddressSchema, runId: runIdSchema.optional() }).strict().parse(value);
    const run = input.runId === undefined ? undefined : await this.reservation(owner, input.agent, input.runId);
    const registration = await this.dependencies.prepareRegistration?.(owner, input.agent);
    return this.db.transaction(async tx => {
      // Serialize owner registration, including the first agent, without application-global process locks.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${owner}), 19471)`);
      const [previous] = await tx.select().from(agents).where(and(eq(agents.owner, owner), eq(agents.agent, input.agent))).limit(1);
      if (previous) {
        if (previous.currentRunId !== (input.runId ?? null)) throw new Problem(409, 'agent_registration_conflict', 'Agent already exists; use a lifecycle transition.');
        await registration?.commit(tx, true);
        return { agent: publicAgent(previous), replayed: true };
      }
      const count = await tx.select({ agent: agents.agent }).from(agents).where(eq(agents.owner, owner)).limit(POLICY.maximumAgentsPerOwner);
      if (count.length >= POLICY.maximumAgentsPerOwner) throw new Problem(409, 'agent_quota_exceeded', 'Owner agent registry is full.');
      const [record] = await tx.insert(agents).values({ owner, agent: input.agent, currentRunId: run?.id ?? null,
        leaseUntil: run?.leaseUntil ?? null, mode: run ? 'full' : 'cyst', createdAt: this.now(), updatedAt: this.now() }).returning();
      if (!record) throw new Error('Agent registration failed');
      await registration?.commit(tx, false);
      return { agent: publicAgent(record), replayed: false };
    });
  }
  async list(ownerValue: string) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue);
    return { agents: (await this.db.select().from(agents).where(eq(agents.owner, owner)).orderBy(asc(agents.agent))
      .limit(POLICY.maximumAgentsPerOwner)).map(publicAgent), policy: this.policy };
  }
  async get(owner: string, agent: string) {
    await this.dependencies.ensureReady?.();
    const record = await this.row(owner, agent);
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.owner, record.owner),
      eq(agentIntents.agent, record.agent), ne(agentIntents.phase, 'done'))).limit(1);
    return { agent: publicAgent(record), intent: intent ? publicIntent(intent) : null, policy: this.policy };
  }
  /** Trusted settlement ingestion only. HTTP callers cannot invent spend or move these records. */
  async appendSettledCharge(ownerValue: string, agentValue: string, receiptIdValue: string, amountValue: string, settledAt: Date,
    rawProvenance?: z.input<typeof billingProvenanceSchema>) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const receiptId = runIdSchema.parse(receiptIdValue), amount = unitsSchema.parse(amountValue);
    const provenance = rawProvenance === undefined ? undefined : billingProvenanceSchema.parse(rawProvenance);
    if (!Number.isFinite(settledAt.getTime()) || settledAt.getTime() > this.now().getTime()) throw new Error('Settlement time must be confirmed and not in the future');
    return this.db.transaction(async tx => {
      await this.row(owner, agent, tx, true);
      const [previous] = await tx.select().from(agentBilling).where(and(eq(agentBilling.owner, owner), eq(agentBilling.receiptId, receiptId))).limit(1);
      if (previous) {
        if (previous.agent !== agent || previous.amount !== amount || previous.settledAt.getTime() !== settledAt.getTime()) {
          throw new Problem(409, 'agent_billing_conflict', 'Settlement identifier already records different billing facts.');
        }
        if (provenance) {
          const [saved] = await tx.select().from(agentBillingProvenance).where(and(eq(agentBillingProvenance.owner, owner), eq(agentBillingProvenance.receiptId, receiptId)));
          if (!saved || saved.factsHash !== agentBillingFactsHash(previous, provenance)
            || saved.transactionHash !== provenance.transactionHash || saved.blockNumber !== provenance.blockNumber
            || saved.blockHash !== provenance.blockHash) throw new Problem(409, 'agent_billing_conflict', 'Canonical billing provenance changed.');
        }
        return { replayed: true };
      }
      const entry = { owner, agent, receiptId, amount, settledAt };
      await tx.insert(agentBilling).values(entry);
      if (provenance) await tx.insert(agentBillingProvenance).values({ owner, receiptId, ...provenance,
        factsHash: agentBillingFactsHash(entry, provenance) });
      return { replayed: false };
    });
  }
  async evaluate(owner: string, agent: string, metabolismVersion?: 2): Promise<
    (ReturnType<typeof evaluateMetabolism> | ReturnType<typeof evaluateMetabolismV2>)
    & { rollDue: boolean; scheduledWakeDue: boolean; killed: boolean }> {
    z.literal(2).optional().parse(metabolismVersion);
    await this.dependencies.ensureReady?.();
    const row = await this.row(owner, agent);
    await this.dependencies.refreshBilling?.(row.owner, row.agent);
    const now = this.now();
    const [sum] = await this.db.select({ burn: sql<string>`COALESCE(SUM(CAST(${agentBilling.amount} AS numeric)),0)::text` }).from(agentBilling)
      .where(and(eq(agentBilling.owner, row.owner), eq(agentBilling.agent, row.agent),
        gt(agentBilling.settledAt, new Date(now.getTime() - POLICY.trailingBurnSeconds * 1000)), lte(agentBilling.settledAt, now)));
    const burn = sum?.burn ?? '0';
    // A corrupted or overflowing trusted journal must fail closed, never round a financial threshold.
    unitsSchema.parse(burn);
    let evaluated: ReturnType<typeof evaluateMetabolism> | ReturnType<typeof evaluateMetabolismV2>;
    if (metabolismVersion === 2) {
      if (!this.dependencies.metabolismPricing) throw new Problem(409, 'agent_metabolism_version_unavailable', 'This runtime does not provide canonical current-rate Metabolism.');
      const pricing = paidMetabolismSnapshotSchema.parse(await this.dependencies.metabolismPricing(row.owner, row.agent, row.currentRunId));
      if (pricing.observedAt > Math.floor(now.getTime() / 1000) + 5 || pricing.observedAt + 30 < Math.floor(now.getTime() / 1000)) {
        throw new Problem(503, 'agent_billing_unconfirmed', 'Fresh canonical paid pricing is required.');
      }
      evaluated = evaluateMetabolismV2(pricing.availableBalance, burn, pricing);
    } else evaluated = evaluateMetabolism(await this.dependencies.balance(row.owner, row.agent), burn);
    return { ...evaluated,
      rollDue: row.leaseUntil !== null && row.leaseUntil.getTime() - now.getTime() <= this.policy.rollBeforeSeconds * 1000,
      scheduledWakeDue: row.wakeAt !== null && row.wakeAt.getTime() <= now.getTime(), killed: row.killedAt !== null };
  }
  async plan(ownerValue: string, agentValue: string, value: unknown, idempotencyKey: string) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const input = actionSchema.parse(value), idemKey = lifecycleIdempotencySchema.parse(idempotencyKey);
    if (input.action === 'kill' && input.targetRunId) throw new Problem(422, 'agent_target_unused', 'Owner kill cannot attach a target reservation.');
    const requestHash = createHash('sha256').update(JSON.stringify([agent, input])).digest('hex');
    // Resolve external reads before taking the SQL row lock; repeat the reservation before every attach/resume acknowledgment.
    // Owner kill must remain available when RPC or canonical billing evidence is unavailable.
    const evaluation = input.action === 'kill' ? null : await this.evaluate(owner, agent, input.metabolismVersion);
    const targetRun = input.targetRunId === undefined ? undefined : await this.reservation(owner, agent, input.targetRunId);
    const wakeAt = input.wakeAt === undefined ? undefined : input.wakeAt === null ? null : new Date(input.wakeAt);
    if (wakeAt && (wakeAt.getTime() <= this.now().getTime() || wakeAt.getTime() > this.now().getTime() + 30 * 86400_000)) {
      throw new Problem(422, 'agent_wake_time_invalid', 'Scheduled wake must be within the next 30 days.');
    }
    return this.db.transaction(async tx => {
      const row = await this.row(owner, agent, tx, true);
      const [previous] = await tx.select().from(agentIntents).where(and(eq(agentIntents.owner, owner), eq(agentIntents.idemKey, idemKey))).limit(1);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Problem(409, 'agent_idempotency_conflict', 'Reuse this key only for the original lifecycle request.');
        return { agent: publicAgent(row), intent: publicIntent(previous), replayed: true, evaluation };
      }
      if (row.killedAt) throw new Problem(409, 'agent_killed', 'This agent was permanently killed by its owner.');
      if (row.version !== input.expectedVersion) throw new Problem(409, 'agent_version_conflict', 'Refresh the agent before planning a transition.');
      const [pending] = await tx.select().from(agentIntents).where(and(eq(agentIntents.owner, owner), eq(agentIntents.agent, agent), ne(agentIntents.phase, 'done'))).limit(1);
      if (pending && input.action !== 'kill') throw new Problem(409, 'agent_transition_pending', 'Finish the durable transition before planning another.');
      if (pending) await tx.update(agentIntents).set({ phase: 'done', version: pending.version + 1, updatedAt: this.now() })
        .where(eq(agentIntents.id, pending.id));
      let mode = evaluation?.mode ?? 'cyst', kind: AgentIntent['kind'] = 'profile', phase: AgentIntent['phase'] = 'profile';
      if (input.action === 'evaluate' && !row.currentRunId && row.wakeAt && row.wakeAt.getTime() > this.now().getTime()) mode = 'cyst';
      if (input.action === 'kill') { kind = 'kill'; mode = 'cyst'; phase = row.currentRunId || pending?.sourceRunId || pending?.targetRunId ? 'stop' : 'done'; }
      else if (input.action === 'sleep' || mode === 'cyst' || (evaluation?.rollDue && !targetRun)) {
        kind = 'sleep'; mode = 'cyst'; phase = row.currentRunId ? 'checkpoint' : 'done';
      } else if (input.action === 'migrate' || (evaluation?.rollDue && targetRun)
        || this.dependencies.leasePolicy === 'paid_cpu' && row.currentRunId && row.mode !== mode && targetRun) {
        kind = evaluation?.rollDue ? 'rollover' : 'migrate';
        if (!row.currentRunId || !targetRun || targetRun.id === row.currentRunId) throw new Problem(409, 'agent_migration_invalid', 'Migration requires a different approved reserved run and an active source.');
        phase = 'checkpoint';
      } else if (input.action === 'wake' || !row.currentRunId) {
        kind = 'wake';
        if (!targetRun || !row.checkpointId) throw new Problem(409, 'agent_wake_requires_checkpoint_and_reservation', 'Wake requires an encrypted checkpoint and a separately approved reserved run.');
        phase = 'attach';
      } else if (!row.currentRunId || row.mode === mode) phase = 'done';
      if (this.dependencies.leasePolicy === 'paid_cpu' && kind === 'profile' && phase !== 'done') {
        throw new Problem(409, 'agent_profile_reservation_required', 'Changing the CPU quota requires a separately approved reservation with its matching resource profile.');
      }
      if (targetRun && this.dependencies.leasePolicy === 'paid_cpu' && (targetRun.resourceProfile ?? 'full') !== mode) {
        throw new Problem(409, 'agent_profile_mismatch', 'The approved target CPU resource profile differs from the Metabolism mode.');
      }
      if (targetRun && evaluation && 'pricing' in evaluation) {
        assertTargetMetabolismRate(paidMetabolismSnapshotSchema.parse(evaluation.pricing), mode, targetRun);
      }
      if (kind === 'wake' && row.currentRunId) throw new Problem(409, 'agent_already_active', 'Agent already has an active run.');
      if (targetRun && !['wake', 'migrate', 'rollover'].includes(kind)) throw new Problem(422, 'agent_target_unused', 'This transition does not attach a new run.');
      const [intent] = await tx.insert(agentIntents).values({ id: randomUUID(), owner, agent, idemKey, requestHash, kind, phase,
        ...(evaluation && 'metabolismVersion' in evaluation ? { metabolismVersion: 2,
          metabolismEvaluation: evaluateMetabolismV2(evaluation.balance, evaluation.trailing24hBurn,
            paidMetabolismSnapshotSchema.parse('pricing' in evaluation ? evaluation.pricing : undefined)) } : {}),
        targetMode: mode, sourceRunId: kind === 'kill' ? row.currentRunId ?? pending?.sourceRunId ?? pending?.targetRunId ?? null : row.currentRunId,
        targetRunId: kind === 'kill' ? pending?.targetRunId ?? null : targetRun?.id ?? null,
        targetLeaseUntil: targetRun?.leaseUntil ?? null, checkpointId: kind === 'wake' ? row.checkpointId : null,
        createdAt: this.now(), updatedAt: this.now() }).returning();
      const [updated] = await tx.update(agents).set({ version: row.version + 1, updatedAt: this.now(),
        ...(wakeAt === undefined ? {} : { wakeAt }), ...(kind === 'kill' ? { killedAt: this.now() } : {}),
        ...(phase === 'done' && (kind === 'sleep' || kind === 'kill') ? { mode: 'cyst' as const, currentRunId: null, leaseUntil: null } : {}) })
        .where(and(eq(agents.owner, owner), eq(agents.agent, agent), eq(agents.version, row.version))).returning();
      if (!intent || !updated) throw new Error('Lifecycle CAS failed');
      return { agent: publicAgent(updated), intent: publicIntent(intent), replayed: false, evaluation };
    });
  }
  async validateExecution(ownerValue: string, intentValue: string, expectedVersion: number, phase: string) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue), id = intentIdSchema.parse(intentValue);
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.owner, owner), eq(agentIntents.id, id))).limit(1);
    if (!intent) throw new Problem(404, 'agent_intent_not_found', 'Lifecycle intent not found.');
    publicIntent(intent);
    const row = await this.row(owner, intent.agent);
    if (intent.phase === 'done' || intent.phase !== phase || intent.version !== expectedVersion) {
      throw new Problem(409, 'agent_intent_version_conflict', 'Refresh the intent; phase or version changed.');
    }
    if (row.killedAt && intent.kind !== 'kill') throw new Problem(409, 'agent_killed', 'This agent was permanently killed by its owner.');
    if (phase === 'attach' || phase === 'resume') {
      if (!intent.targetRunId) throw new Problem(409, 'agent_target_missing', 'Transition has no reserved target run.');
      const target = await this.reservation(owner, intent.agent, intent.targetRunId);
      if (this.dependencies.leasePolicy === 'paid_cpu' && (target.resourceProfile ?? 'full') !== intent.targetMode) {
        throw new Problem(409, 'agent_profile_mismatch', 'The original target resource profile changed.');
      }
      if (intent.metabolismVersion === 2 && intent.metabolismEvaluation) assertTargetMetabolismRate(intent.metabolismEvaluation.pricing, intent.targetMode, target);
    }
    return { valid: true as const, operationId: intent.id + ':' + intent.phase };
  }
  async acknowledge(ownerValue: string, intentValue: string, expectedVersion: number, value: unknown) {
    await this.dependencies.ensureReady?.();
    const owner = agentAddressSchema.parse(ownerValue), id = intentIdSchema.parse(intentValue);
    z.number().int().nonnegative().parse(expectedVersion); const ack = ackSchema.parse(value);
    const [initial] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.id, id), eq(agentIntents.owner, owner))).limit(1);
    if (!initial) throw new Problem(404, 'agent_intent_not_found', 'Lifecycle intent not found.');
    publicIntent(initial);
    let checkpoint: Awaited<ReturnType<CystService['metadata']>> | undefined;
    if (ack.phase === 'checkpoint') {
      checkpoint = await this.dependencies.cysts.metadata(owner, ack.checkpointId);
      if (checkpoint.agent !== initial.agent || checkpoint.sha256 !== ack.checkpointSha256 || checkpoint.state !== 'ready') {
        throw new Problem(409, 'agent_checkpoint_invalid', 'Use the completed encrypted checkpoint for this owner and agent.');
      }
    }
    if (['attach', 'resume'].includes(ack.phase)) {
      if (!initial.targetRunId) throw new Problem(409, 'agent_target_missing', 'Transition has no reserved target run.');
      const target = await this.reservation(owner, initial.agent, initial.targetRunId);
      if (this.dependencies.leasePolicy === 'paid_cpu' && (target.resourceProfile ?? 'full') !== initial.targetMode) {
        throw new Problem(409, 'agent_profile_mismatch', 'The original target resource profile changed.');
      }
      if (initial.metabolismVersion === 2 && initial.metabolismEvaluation) assertTargetMetabolismRate(initial.metabolismEvaluation.pricing, initial.targetMode, target);
    }
    return this.db.transaction(async tx => {
      const row = await this.row(owner, initial.agent, tx, true);
      const [intent] = await tx.select().from(agentIntents).where(and(eq(agentIntents.owner, owner), eq(agentIntents.id, id))).for('update');
      if (!intent || intent.phase !== ack.phase || intent.version !== expectedVersion) throw new Problem(409, 'agent_intent_version_conflict', 'Refresh the intent; phase or version changed.');
      publicIntent(intent);
      if (row.killedAt && intent.kind !== 'kill') throw new Problem(409, 'agent_killed', 'This agent was permanently killed by its owner.');
      const next: AgentIntent['phase'] = ack.phase === 'checkpoint' ? 'stop' : ack.phase === 'stop'
        ? (intent.kind === 'migrate' || intent.kind === 'rollover' ? 'attach' : 'done') : ack.phase === 'attach' ? 'resume' : 'done';
      const [updatedIntent] = await tx.update(agentIntents).set({ phase: next, version: intent.version + 1, updatedAt: this.now(),
        ...(checkpoint ? { checkpointId: checkpoint.id, checkpointSha256: checkpoint.sha256 } : {}) })
        .where(and(eq(agentIntents.id, id), eq(agentIntents.version, expectedVersion), eq(agentIntents.phase, ack.phase))).returning();
      const [updatedAgent] = await tx.update(agents).set({ version: row.version + 1, updatedAt: this.now(),
        ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
        ...(ack.phase === 'stop' ? { currentRunId: null, leaseUntil: null, mode: 'cyst' as const } : {}),
        ...(ack.phase === 'resume' ? { currentRunId: intent.targetRunId, leaseUntil: intent.targetLeaseUntil, mode: intent.targetMode, wakeAt: null } : {}),
        ...(ack.phase === 'profile' ? { mode: intent.targetMode } : {}),
      }).where(and(eq(agents.owner, owner), eq(agents.agent, row.agent), eq(agents.version, row.version))).returning();
      if (!updatedIntent || !updatedAgent) throw new Error('Lifecycle CAS failed');
      return { agent: publicAgent(updatedAgent), intent: publicIntent(updatedIntent) };
    });
  }
}
