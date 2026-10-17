import { and, eq } from 'drizzle-orm';
import { addressSchema, bytes32Schema, canonical, hashJson, Problem, randomId } from '../common.js';
import type { PlatformRuntimeService } from '../platform-runtime/service.js';
import type { PlatformQuoteInput, PlatformPrepared } from '../platform-runtime/types.js';
import type { PlatformVaultBinding } from '../platform-runtime/vault.js';
import { assertCpuReplacementApproval, planCpuReplacement } from './cpu-replacement.js';
import { selectCapacity, type PlacementRequest } from './planner.js';
import { paidCpuJobs } from './paid-job-schema.js';
import { paidCpuJobApprovalSchema, paidCpuJobInputSchema, paidCpuJobReplanSchema, paidCpuJobFinishSchema, paidCpuJobSchema,
  paidCpuJobIntentHash, paidCpuJobQuoteKey, type PaidCpuJob, type PaidCpuJobInput } from './paid-job-types.js';
import { platformRuns } from '../platform-runtime/schema.js';

type Row = typeof paidCpuJobs.$inferSelect;
const keySchema = /^[a-zA-Z0-9:_-]{1,128}$/;
/** Owner-approved, durable bounded CPU jobs over the reviewed finite catalogue.
 * It writes quotes only. Every payRun, admission and application restore remains
 * a separate explicit action; a proposal cannot spend an anticipated refund.
 */
export class PaidCpuJobService {
  constructor(readonly runtime: PlatformRuntimeService) {
    if (!runtime.vaults) throw new Error('Paid CPU jobs require the reviewed Vault runtime');
  }
  private key(key: string) {
    if (!keySchema.test(key)) throw new Problem(422, 'idempotency_required', 'Use a bounded unique operation key.');
  }
  private async owner(principal: string, vault: string) {
    return this.runtime.vaults!.authorize(principal, vault, 'owner');
  }
  private intent(id: string, binding: PlatformVaultBinding, input: PaidCpuJobInput, createdAt: number) {
    return paidCpuJobIntentHash(id, binding, input, createdAt, this.runtime.bridge.pins);
  }
  private async row(binding: PlatformVaultBinding, id: string) {
    const [row] = await this.runtime.db.select().from(paidCpuJobs).where(and(eq(paidCpuJobs.id, bytes32Schema.parse(id)),
      eq(paidCpuJobs.owner, binding.owner.toLowerCase()), eq(paidCpuJobs.vault, binding.vault.toLowerCase()))).limit(1);
    if (!row) throw new Problem(404, 'paid_cpu_job_not_found', 'Owner CPU job was not found.');
    const state = paidCpuJobSchema.parse(row.state);
    if (canonical(state.binding) !== canonical(binding) || state.intentHash !== this.intent(state.id, binding, state.input, state.createdAt)
      || row.inputHash !== hashJson(state.input) || state.id !== row.id
      || !addressSchema.parse(state.owner) || state.owner.toLowerCase() !== row.owner || state.vault.toLowerCase() !== row.vault) {
      throw new Problem(409, 'paid_cpu_job_scope_changed', 'The original owner, Vault, chain or CPU job intent changed.');
    }
    return { ...row, state };
  }
  private async save(row: Row, state: PaidCpuJob, extra: Partial<Pick<Row, 'replanKey' | 'replan'>> = {}) {
    const [updated] = await this.runtime.db.update(paidCpuJobs).set({ state: paidCpuJobSchema.parse(state),
      revision: row.revision + 1, ...extra }).where(and(eq(paidCpuJobs.id, row.id), eq(paidCpuJobs.revision, row.revision))).returning();
    if (!updated) throw new Problem(409, 'paid_cpu_job_busy', 'The owner CPU job changed; read its original state before retrying.');
    return updated;
  }
  private original(state: PaidCpuJob): PlacementRequest {
    return { hardwareClasses: ['cpu'], regions: state.input.regions, images: [state.input.task.imageDigest], sealedOnly: false,
      lanes: state.input.lanes, seconds: state.input.workSeconds, maxSpend: state.input.maxSpend,
      deadline: state.input.deadline, now: state.createdAt };
  }
  private input(state: PaidCpuJob, seconds: number, budget: string): PlatformQuoteInput {
    return { leashId: state.input.leashId, task: state.input.task, maxSeconds: seconds,
      deadline: state.input.deadline, maxSpend: budget, regions: state.input.regions };
  }
  private async accounting(state: PaidCpuJob) {
    let charged = 0n, outstanding = 0n;
    for (const id of state.runIds) {
      const run = await this.runtime.get(state.vault, id);
      if (['completed', 'refunded'].includes(run.status) && run.charged !== null && run.refund !== null
        && BigInt(run.charged) + BigInt(run.refund) === BigInt(run.ceiling)) charged += BigInt(run.charged);
      else outstanding += BigInt(run.status === 'prepared'
        ? await this.runtime.cpuQuoteLiability(state.vault, id) : run.ceiling);
    }
    return { charged: charged.toString(), outstandingLiability: outstanding.toString() };
  }
  private async view(row: Row) {
    const accounting = await this.accounting(row.state);
    return paidCpuJobSchema.parse({ ...row.state, ...accounting,
      stopAndRefundRequired: row.state.phase === 'cancelled' && BigInt(accounting.outstandingLiability) !== 0n });
  }
  private async originalQuote(state: PaidCpuJob, decisionHash?: string) {
    const [row] = await this.runtime.db.select({ id: platformRuns.id }).from(platformRuns).where(and(
      eq(platformRuns.owner, state.vault.toLowerCase()), eq(platformRuns.idemKey, paidCpuJobQuoteKey(state.id, decisionHash)))).limit(1);
    return row ? this.runtime.preparedQuote(state.vault, row.id) : undefined;
  }
  async create(principal: string, vault: string, raw: unknown, key: string): Promise<PaidCpuJob> {
    this.key(key); const binding = await this.owner(principal, vault), input = paidCpuJobInputSchema.parse(raw);
    if (input.leashId !== binding.leashId) throw new Problem(409, 'platform_vault_leash_mismatch', 'Use the original Vault Leash.');
    let [row] = await this.runtime.db.select().from(paidCpuJobs).where(and(eq(paidCpuJobs.owner, binding.owner.toLowerCase()),
      eq(paidCpuJobs.vault, binding.vault.toLowerCase()), eq(paidCpuJobs.idemKey, key))).limit(1);
    if (row && row.inputHash !== hashJson(input)) throw new Problem(409, 'idempotency_conflict', 'This owner job key belongs to different work.');
    if (!row) {
      const id = randomId(), createdAt = await this.runtime.bridge.now();
      const state = paidCpuJobSchema.parse({ protocol: 'telomere-paid-cpu-job-v1', id, owner: binding.owner, vault: binding.vault,
        binding, input, intentHash: this.intent(id, binding, input, createdAt), createdAt,
        phase: 'preparing', runIds: [], currentRunId: null, proposal: null, approvalHash: null,
        charged: '0', outstandingLiability: '0', cancellationReason: null, prepared: null,
        fundsReserved: false, funding: 'external-wallet-required', stopAndRefundRequired: false });
      await this.runtime.db.insert(paidCpuJobs).values({ id, owner: binding.owner.toLowerCase(), vault: binding.vault.toLowerCase(),
        idemKey: key, inputHash: hashJson(input), state }).onConflictDoNothing();
      const [stored] = await this.runtime.db.select().from(paidCpuJobs).where(and(eq(paidCpuJobs.owner, binding.owner.toLowerCase()),
        eq(paidCpuJobs.vault, binding.vault.toLowerCase()), eq(paidCpuJobs.idemKey, key))).limit(1);
      if (!stored || stored.inputHash !== hashJson(input)) throw new Problem(409, 'idempotency_conflict', 'Concurrent owner job changed its original intent.');
      row = stored;
    }
    row = await this.row(binding, row.id);
    if (row.state.phase !== 'preparing') return this.view(row);
    const recovered = await this.originalQuote(row.state);
    if (recovered) return this.view(await this.save(row, { ...row.state, phase: 'active', currentRunId: recovered.quote.runId,
      runIds: [recovered.quote.runId], prepared: recovered }));
    const base = this.input(row.state, input.workSeconds, input.maxSpend);
    const catalogue = await this.runtime.paidCpuCatalogue(binding, base, input.lanes);
    const selected = selectCapacity({ ...this.original(row.state), now: catalogue.now }, catalogue.capacity, catalogue.options);
    const prepared = await this.runtime.quote(binding.vault, { ...base, cpuScheduling: { version: 1,
      lane: selected.host.lane, ...(selected.host.lane === 'interruptible' ? { interruptibleConsent: input.interruptibleConsent } : {}),
      job: { jobId: row.id, intentHash: row.state.intentHash, targetHostId: selected.host.hostId } } }, paidCpuJobQuoteKey(row.id), binding);
    return this.view(await this.save(row, { ...row.state, phase: 'active', currentRunId: prepared.quote.runId,
      runIds: [prepared.quote.runId], prepared }));
  }
  async get(principal: string, vault: string, id: string) {
    const binding = await this.owner(principal, vault); return this.view(await this.row(binding, id));
  }
  async replan(principal: string, vault: string, id: string, raw: unknown, key: string) {
    this.key(key); const binding = await this.owner(principal, vault), input = paidCpuJobReplanSchema.parse(raw);
    const row = await this.row(binding, id), state = row.state;
    if (row.replanKey === key) {
      if (canonical(row.replan) !== canonical(input)) throw new Problem(409, 'idempotency_conflict', 'The replacement key changed its checkpoint or remaining work.');
      return this.view(row);
    }
    if (input.expectedSourceRunId !== undefined && input.expectedSourceRunId !== state.currentRunId) {
      throw new Problem(409, 'paid_cpu_job_source_changed', 'Replan only the original source run retained by this owner operation.');
    }
    if (state.phase !== 'active' || !state.currentRunId || state.runIds.length >= 64 || input.remainingSeconds > state.input.workSeconds) {
      throw new Problem(409, 'paid_cpu_job_phase', 'Replacement requires the current immutable paid source and remaining original work.');
    }
    const now = await this.runtime.bridge.now();
    if (BigInt(now) + BigInt(input.remainingSeconds + input.restoreSeconds) > BigInt(state.input.deadline)) {
      return this.view(await this.save(row, { ...state, phase: 'cancelled', cancellationReason: 'deadline_infeasible',
        stopAndRefundRequired: true, prepared: null }, { replanKey: key, replan: input }));
    }
    const source = await this.runtime.paidCpuSource(binding.vault, state.currentRunId);
    const original = this.original(state), accounting = await this.accounting(state);
    if (source.row.input.cpuScheduling?.job?.jobId !== state.id
      || source.row.input.cpuScheduling.job.intentHash !== state.intentHash) throw new Problem(409, 'paid_cpu_job_source_changed', 'The source quote belongs to a different owner job.');
    const budget = BigInt(state.input.maxSpend) - BigInt(accounting.charged) - BigInt(accounting.outstandingLiability);
    const catalogue = budget > 0n ? await this.runtime.paidCpuCatalogue(binding,
      { ...this.input(state, input.remainingSeconds + input.restoreSeconds, budget.toString()), excludedHostIds: [source.row.quote.hostId] }, state.input.lanes)
      : { capacity: [], options: {}, now };
    const result = planCpuReplacement({ jobId: state.id, original, source: { runId: source.row.quote.runId,
      hostId: source.row.quote.hostId, quoteHash: hashJson(source.row.quote), ceiling: source.row.ceiling },
      now: catalogue.now, remainingSeconds: input.remainingSeconds, restoreSeconds: input.restoreSeconds,
      checkpointHash: input.checkpointHash, sourceCleanupConfirmed: true,
      sourceSettlement: { receiptHash: source.row.settlement!.receiptHash, charged: source.row.charged!, refund: source.row.refund!, confirmed: true },
      priorCharged: (BigInt(accounting.charged) - BigInt(source.row.charged!)).toString(),
      outstandingLiability: accounting.outstandingLiability }, catalogue.capacity, catalogue.options);
    if (result.action === 'wait') throw new Problem(409, 'paid_cpu_source_pending', 'The original source is not ready for replacement.');
    if (result.action === 'cancel') return this.view(await this.save(row, { ...state, phase: 'cancelled',
      cancellationReason: result.reason, prepared: null, stopAndRefundRequired: true }, { replanKey: key, replan: input }));
    return this.view(await this.save(row, { ...state, phase: 'awaiting_owner', proposal: result.proposal,
      approvalHash: null, prepared: null }, { replanKey: key, replan: input }));
  }
  async approve(principal: string, vault: string, id: string, raw: unknown) {
    const binding = await this.owner(principal, vault), approval = paidCpuJobApprovalSchema.parse(raw);
    let row = await this.row(binding, id), state = row.state;
    if (state.approvalHash === approval.decisionHash && state.phase === 'active') return this.view(row);
    if (!['awaiting_owner', 'approved'].includes(state.phase) || !state.proposal
      || state.proposal.decisionHash !== approval.decisionHash || state.currentRunId !== state.proposal.sourceRunId) {
      throw new Problem(409, 'paid_cpu_job_approval_changed', 'Approve only the exact current owner job proposal.');
    }
    const source = await this.runtime.paidCpuSource(binding.vault, state.proposal.sourceRunId), proposal = state.proposal;
    const accounting = await this.accounting(state);
    if (accounting.charged !== proposal.charged || accounting.outstandingLiability !== proposal.outstandingLiability) {
      throw new Problem(409, 'paid_cpu_job_finances_changed', 'Original paid liabilities changed before owner approval.');
    }
    const base = this.input(state, proposal.reservationSeconds, proposal.remainingBudget);
    const catalogue = await this.runtime.paidCpuCatalogue(binding, { ...base, excludedHostIds: [proposal.sourceHostId] }, state.input.lanes);
    const target = catalogue.capacity.find(value => value.hostId === proposal.target.hostId && value.lane === proposal.target.lane);
    const ceiling = catalogue.options.chargeCeilings?.find(value => value.capacityId === proposal.capacityId)?.ceiling;
    if (!target || !ceiling) throw new Problem(409, 'paid_cpu_job_target_unavailable', 'The exact approved reviewed CPU offer is unavailable.');
    assertCpuReplacementApproval(proposal, approval.decisionHash, target, ceiling,
      hashJson({ domain: 'telomere.cpu-deadline-intent.v1', jobId: state.id, request: this.original(state),
        source: { runId: source.row.id, hostId: source.row.quote.hostId, quoteHash: hashJson(source.row.quote), ceiling: source.row.ceiling } }), catalogue.now);
    if (state.phase === 'awaiting_owner') {
      row = await this.save(row, { ...state, phase: 'approved', approvalHash: approval.decisionHash }); state = row.state;
    }
    const prepared: PlatformPrepared = await this.runtime.quote(binding.vault, { ...base,
      excludedHostIds: [proposal.sourceHostId], cpuScheduling: { version: 1, lane: target.lane,
        ...(target.lane === 'interruptible' ? { interruptibleConsent: state.input.interruptibleConsent } : {}),
        job: { jobId: state.id, intentHash: state.intentHash, decisionHash: proposal.decisionHash,
          sourceRunId: source.row.id, sourceQuoteHash: hashJson(source.row.quote), targetHostId: target.hostId } } },
      paidCpuJobQuoteKey(state.id, proposal.decisionHash), binding);
    if (prepared.quote.hostId !== target.hostId || prepared.quote.pricePerSecond !== target.pricePerSecond
      || prepared.ceiling !== proposal.liabilityCeiling) throw new Problem(409, 'paid_cpu_job_terms_changed', 'The new immutable quote differs from the exact owner-approved terms.');
    return this.view(await this.save(row, { ...state, phase: 'active', currentRunId: prepared.quote.runId,
      runIds: [...state.runIds, prepared.quote.runId], prepared }));
  }
  async cancel(principal: string, vault: string, id: string) {
    const binding = await this.owner(principal, vault), row = await this.row(binding, id);
    if (row.state.phase === 'cancelled') return this.view(row);
    return this.view(await this.save(row, { ...row.state, phase: 'cancelled', cancellationReason: 'owner_cancelled',
      prepared: null, stopAndRefundRequired: true }));
  }
  async finish(principal: string, vault: string, id: string, raw: unknown = {}) {
    const input = paidCpuJobFinishSchema.parse(raw);
    const binding = await this.owner(principal, vault), row = await this.row(binding, id);
    if (input.expectedSourceRunId !== undefined && input.expectedSourceRunId !== row.state.currentRunId) {
      throw new Problem(409, 'paid_cpu_job_source_changed', 'Finish only the original source run retained by this owner operation.');
    }
    if (row.state.phase === 'finished') return this.view(row);
    if (row.state.phase !== 'active' || !row.state.currentRunId) throw new Problem(409, 'paid_cpu_job_phase', 'Finish only the current paid CPU job.');
    await this.runtime.paidCpuSource(binding.vault, row.state.currentRunId);
    const accounting = await this.accounting(row.state);
    if (BigInt(accounting.outstandingLiability)) throw new Problem(409, 'paid_cpu_source_pending', 'Every original job reservation must settle before completion.');
    return this.view(await this.save(row, { ...row.state, phase: 'finished', prepared: null }));
  }
  async reliability(principal: string, vault: string, hostId: string, lane: 'standard' | 'interruptible') {
    await this.owner(principal, vault); return this.runtime.cpuReliability(bytes32Schema.parse(hostId), lane);
  }
}
