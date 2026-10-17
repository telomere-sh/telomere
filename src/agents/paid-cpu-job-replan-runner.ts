import { z } from 'zod';
import { bytes32Schema, canonical, hashJson, moneySchema } from '../common.js';
import { cystIdSchema } from '../cysts/types.js';
import { paidPreemptionNoticeSchema } from '../host-kit/sessions/paid-preemption-protocol.js';
import { platformVaultBindingSchema, type PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import { platformPinsSchema } from '../platform-runtime/types.js';
import { paidCpuJobIntentHash, paidCpuJobReplanSchema, paidCpuJobSchema, type PaidCpuJob } from '../scheduling/paid-job-types.js';
import { TelomereApiError } from '../sdk/transport.js';
import type { PaidLifecycleClientVault } from './paid-lifecycle-runner.js';
import type { PaidPreemptionHandoff } from './paid-preemption-handoff.js';

export const PAID_CPU_JOB_REPLAN_SCHEMA = 'telomere-paid-cpu-job-replan/v1';
const captureSchema = z.object({ protocol: z.literal('telomere-paid-preemption-capture-v1'),
  sourceRunId: bytes32Schema, sourceHostId: bytes32Schema, sourceLeaseHash: bytes32Schema,
  notice: paidPreemptionNoticeSchema, checkpointOperationId: z.string().regex(/^cyst-hook-[a-f0-9]{64}$/),
  checkpointId: cystIdSchema, checkpointCompletedAtMs: z.number().int().nonnegative().safe(),
  maxSpend: moneySchema, deadline: z.number().int().positive().safe() }).strict();
type Capture = z.infer<typeof captureSchema>;
type Journal = Pick<PaidLifecycleClientVault, 'scope' | 'claim' | 'read' | 'exclusiveOperation'>;
type Client = Pick<PlatformVaultRuntimeClient, 'config' | 'cpuJob' | 'get' | 'preemptionNotice' | 'replanCpuJob'>;

export interface PaidCpuJobReplanRunnerOptions {
  /** The immutable active source snapshot, retained by the owner across restart. */
  job: PaidCpuJob;
  /** Owner/application estimates, never inferred from billed wall-clock seconds. */
  remainingSeconds: number;
  restoreSeconds: number;
  client: Client;
  handoff: Pick<PaidPreemptionHandoff, 'capture'>;
  journal: Journal;
}
export interface PaidCpuJobReplanResult {
  readonly state: 'waiting_notice' | 'waiting_source' | 'awaiting_owner' | 'cancelled' | 'superseded' | 'aborted';
  readonly jobId: string;
  readonly sourceRunId: string;
  readonly checkpointId?: string;
  readonly decisionHash?: string;
  readonly job?: PaidCpuJob;
}

/** Optional owner process: one original source -> one durable replacement request.
 * Existing HostKit enforcement stops the source. This runner never approves a
 * target, buys compute, admits a payment, restores an application or signs a tx.
 */
export class PaidCpuJobReplanRunner {
  private readonly original: PaidCpuJob;
  private readonly sourceRunId: string;
  private readonly remainingSeconds: number;
  private readonly restoreSeconds: number;
  private readonly prefix: string;
  private readonly client: Client;
  private readonly handoff: Pick<PaidPreemptionHandoff, 'capture'>;
  private readonly journal: Journal;

  constructor(options: PaidCpuJobReplanRunnerOptions) {
    const job = paidCpuJobSchema.parse(options.job), sourceRunId = job.currentRunId;
    if (job.phase !== 'active' || !sourceRunId || !job.prepared
      || job.owner.toLowerCase() !== job.binding.owner.toLowerCase() || job.vault.toLowerCase() !== job.binding.vault.toLowerCase()
      || job.input.leashId !== job.binding.leashId || job.prepared.quote.payer.toLowerCase() !== job.binding.vault.toLowerCase()
      || job.prepared.quote.leashId !== job.binding.leashId
      || job.prepared.quote.runId !== sourceRunId || !job.runIds.includes(sourceRunId)
      || job.prepared.input.cpuScheduling?.lane !== 'interruptible'
      || job.prepared.input.cpuScheduling.job?.jobId !== job.id
      || job.prepared.input.cpuScheduling.job.intentHash !== job.intentHash
      || job.prepared.input.deadline !== job.input.deadline
      || canonical(job.prepared.input.task) !== canonical(job.input.task)) {
      throw new Error('Replanning requires the original active owner-approved interruptible CPU source');
    }
    const intent = paidCpuJobReplanSchema.parse({ checkpointHash: '0x' + '0'.repeat(64),
      remainingSeconds: options.remainingSeconds, restoreSeconds: options.restoreSeconds });
    if (intent.remainingSeconds > job.input.workSeconds
      || options.journal.scope.owner !== job.binding.owner.toLowerCase()
      || options.journal.scope.agent !== job.binding.agentWallet.toLowerCase()
      || options.journal.scope.applicationSchema !== PAID_CPU_JOB_REPLAN_SCHEMA) {
      throw new Error('CPU replanning changed its original work estimate or private owner journal scope');
    }
    this.original = job; this.sourceRunId = sourceRunId;
    this.remainingSeconds = intent.remainingSeconds; this.restoreSeconds = intent.restoreSeconds;
    this.prefix = 'cpu-replan:' + hashJson([job.id, sourceRunId]).slice(2);
    this.client = options.client; this.handoff = options.handoff; this.journal = options.journal;
  }
  private key(kind: string) { return this.prefix + ':' + kind; }
  private result(state: PaidCpuJobReplanResult['state'], job?: PaidCpuJob, capture?: Capture): PaidCpuJobReplanResult {
    return Object.freeze({ state, jobId: this.original.id, sourceRunId: this.sourceRunId,
      ...(job === undefined ? {} : { job }), ...(capture === undefined ? {} : { checkpointId: capture.checkpointId }),
      ...(state === 'awaiting_owner' && job?.proposal ? { decisionHash: job.proposal.decisionHash } : {}) });
  }
  private sameSource(job: PaidCpuJob) {
    return job.id === this.original.id && job.intentHash === this.original.intentHash
      && job.owner.toLowerCase() === this.original.owner.toLowerCase() && job.vault.toLowerCase() === this.original.vault.toLowerCase()
      && job.currentRunId === this.sourceRunId && job.runIds.includes(this.sourceRunId)
      && job.createdAt === this.original.createdAt && canonical(job.binding) === canonical(this.original.binding)
      && canonical(job.input) === canonical(this.original.input)
      && (job.phase !== 'active' || !!job.prepared && job.prepared.ceiling === this.original.prepared!.ceiling
        && canonical(job.prepared.quote) === canonical(this.original.prepared!.quote)
        && canonical(job.prepared.input) === canonical(this.original.prepared!.input));
  }
  private async current() {
    const config = await this.client.config(), binding = platformVaultBindingSchema.parse(config.binding);
    if (canonical(binding) !== canonical(this.original.binding)
      || paidCpuJobIntentHash(this.original.id, binding, this.original.input, this.original.createdAt,
        platformPinsSchema.parse(config.pins)) !== this.original.intentHash) {
      throw new Error('CPU replanning changed its reviewed owner, agent Vault or chain configuration');
    }
    return paidCpuJobSchema.parse(await this.client.cpuJob(this.original.id));
  }
  private checkedCapture(raw: unknown, notice: z.infer<typeof paidPreemptionNoticeSchema>): Capture {
    const capture = captureSchema.parse(raw), body = notice.body;
    if (capture.sourceRunId !== this.sourceRunId || capture.sourceHostId !== this.original.prepared!.quote.hostId
      || capture.sourceLeaseHash !== body.leaseHash || canonical(capture.notice) !== canonical(notice)
      || capture.maxSpend !== this.original.input.maxSpend || capture.deadline !== this.original.input.deadline
      || body.runId !== this.sourceRunId || body.owner.toLowerCase() !== this.original.vault.toLowerCase()
      || capture.checkpointCompletedAtMs < body.issuedAt || capture.checkpointCompletedAtMs > body.interruptAt) {
      throw new Error('CPU replanning checkpoint changed its original source, notice, deadline or budget');
    }
    return capture;
  }
  private matchesProposal(job: PaidCpuJob, capture: Capture) {
    const proposal = job.proposal;
    if (!proposal) return false;
    const { decisionHash, requiresSeparateOwnerApproval: _approval, fundsReserved: _reserved, ...body } = proposal;
    return hashJson(body) === decisionHash && proposal.jobId === this.original.id && proposal.sourceRunId === this.sourceRunId
      && proposal.sourceHostId === capture.sourceHostId && proposal.sourceQuoteHash === hashJson(this.original.prepared!.quote)
      && proposal.checkpointHash === hashJson({ checkpointId: capture.checkpointId })
      && proposal.remainingSeconds === this.remainingSeconds && proposal.restoreSeconds === this.restoreSeconds
      && proposal.originalDeadline === this.original.input.deadline && proposal.originalMaxSpend === this.original.input.maxSpend;
  }
  private async claim(kind: string, value: unknown) {
    await this.journal.claim(this.key(kind), value);
    if (canonical(await this.journal.read(this.key(kind))) !== canonical(value)) {
      throw new Error('CPU replanning journal did not retain its original operation');
    }
  }
  private async cycle(): Promise<PaidCpuJobReplanResult> {
    let job = await this.current();
    if (!this.sameSource(job)) return this.result('superseded', job);
    if (job.phase === 'cancelled') return this.result('cancelled', job);
    if (!['active', 'awaiting_owner'].includes(job.phase)) return this.result('superseded', job);
    await this.claim('original', { protocol: 'telomere-paid-cpu-job-replan-runner/v1', jobId: this.original.id,
      sourceRunId: this.sourceRunId, intentHash: this.original.intentHash, binding: this.original.binding,
      sourceQuoteHash: hashJson(this.original.prepared!.quote), remainingSeconds: this.remainingSeconds,
      restoreSeconds: this.restoreSeconds });
    const savedNotice = await this.journal.read(this.key('notice'));
    const savedCapture = await this.journal.read(this.key('capture'));
    let notice = savedNotice === undefined ? undefined : paidPreemptionNoticeSchema.parse(savedNotice);
    let capture: Capture | undefined;
    if (savedCapture !== undefined) {
      if (!notice) throw new Error('CPU replanning capture lacks its original signed notice');
      capture = this.checkedCapture(savedCapture, notice);
    }
    const request = await this.journal.read(this.key('request'));
    if (job.phase === 'awaiting_owner') {
      if (!capture || request === undefined || !this.matchesProposal(job, capture)) return this.result('superseded', job, capture);
      await this.claim('request', this.request(capture));
      const accepted = await this.journal.read(this.key('accepted'));
      if (accepted !== undefined) {
        await this.claim('accepted', this.accepted(job, capture));
        return this.result('awaiting_owner', job, capture);
      }
      // The request journal precedes POST. An identical manual proposal under a
      // different server key is not evidence that our operation was accepted.
      return this.replan(job, capture);
    }
    // A different caller's proposal or approval is never adopted as our cycle.
    if (canonical(job.proposal) !== canonical(this.original.proposal) || job.approvalHash !== this.original.approvalHash) {
      return this.result('superseded', job, capture);
    }
    if (!capture) {
      let observed;
      try { observed = await this.client.preemptionNotice(this.sourceRunId); }
      catch (error) {
        if (!notice && error instanceof TelomereApiError && error.status === 404 && error.code === 'paid_preemption_notice_not_found') {
          return this.result('waiting_notice', job);
        }
        throw error;
      }
      const freshNotice = paidPreemptionNoticeSchema.parse(observed.notice);
      if (notice && canonical(freshNotice) !== canonical(notice)) throw new Error('CPU replanning source notice changed');
      notice = freshNotice;
      await this.claim('notice', notice);
      // The existing handoff verifies the original controller/host signatures,
      // durable opt-in, application capture marker and thirty-second notice.
      capture = this.checkedCapture(await this.handoff.capture(this.sourceRunId,
        this.original.input.maxSpend, this.original.input.deadline), notice);
      await this.claim('capture', capture);
    }
    job = await this.current();
    if (!this.sameSource(job)) return this.result('superseded', job, capture);
    if (job.phase === 'cancelled') return this.result('cancelled', job, capture);
    if (job.phase !== 'active' || canonical(job.proposal) !== canonical(this.original.proposal)
      || job.approvalHash !== this.original.approvalHash) return this.result('superseded', job, capture);
    const source = await this.client.get(this.sourceRunId);
    if (source.id !== this.sourceRunId || canonical(source.quote) !== canonical(this.original.prepared!.quote)
      || source.ceiling !== this.original.prepared!.ceiling) throw new Error('CPU replanning source reservation changed');
    if (source.status !== 'completed' || !source.settlement || !source.settlementTx || !source.admissionTx
      || source.charged === null || source.refund === null || BigInt(source.charged) + BigInt(source.refund) !== BigInt(source.ceiling)
      || BigInt(job.outstandingLiability) !== 0n) return this.result('waiting_source', job, capture);
    const originalRequest = this.request(capture);
    await this.claim('request', originalRequest);
    return this.replan(job, capture);
  }
  private accepted(job: PaidCpuJob, capture: Capture) {
    return { protocol: 'telomere-paid-cpu-job-replan-accepted/v1', requestHash: hashJson(this.request(capture)),
      decisionHash: job.proposal!.decisionHash };
  }
  private async replan(job: PaidCpuJob, capture: Capture): Promise<PaidCpuJobReplanResult> {
    const originalRequest = this.request(capture);
    let replanned: PaidCpuJob;
    try { replanned = paidCpuJobSchema.parse(await this.client.replanCpuJob(this.original.id,
      originalRequest.input, originalRequest.idempotencyKey)); }
    catch (error) {
      if (error instanceof TelomereApiError && error.status === 409 && error.code === 'paid_cpu_source_pending') {
        return this.result('waiting_source', job, capture);
      }
      if (error instanceof TelomereApiError && error.status === 409 && error.code === 'paid_cpu_job_source_changed') {
        const current = await this.current();
        if (!this.sameSource(current)) return this.result('superseded', current, capture);
      }
      throw error;
    }
    if (!this.sameSource(replanned)) return this.result('superseded', replanned, capture);
    if (replanned.phase === 'cancelled') return this.result('cancelled', replanned, capture);
    if (replanned.phase !== 'awaiting_owner' || !this.matchesProposal(replanned, capture)) {
      throw new Error('CPU replanning response changed its original checkpoint or replacement scope');
    }
    await this.claim('accepted', this.accepted(replanned, capture));
    return this.result('awaiting_owner', replanned, capture);
  }
  private request(capture: Capture) {
    return { protocol: 'telomere-paid-cpu-job-replan-request/v1',
      input: paidCpuJobReplanSchema.parse({ expectedSourceRunId: this.sourceRunId,
        checkpointHash: hashJson({ checkpointId: capture.checkpointId }),
        remainingSeconds: this.remainingSeconds, restoreSeconds: this.restoreSeconds }),
      idempotencyKey: 'cpu-replan-' + hashJson([this.original.id, this.sourceRunId, capture.notice.body.noticeId]).slice(2) };
  }
  /** Cross-process owner lock also serializes concurrent runOnce/watch callers. */
  runOnce(): Promise<PaidCpuJobReplanResult> {
    return this.journal.exclusiveOperation(this.prefix, () => this.cycle());
  }
  tick(): Promise<PaidCpuJobReplanResult> { return this.runOnce(); }
  /** Explicit sequential polling. Aborting drains an in-flight cycle and wakes
   * the wait; it cannot cancel a captured source or a separately approved target. */
  async watch(options: { signal: AbortSignal; pollMs?: number;
    onStatus?: (result: PaidCpuJobReplanResult) => void | Promise<void> }): Promise<PaidCpuJobReplanResult> {
    const pollMs = z.number().int().min(100).max(5000).parse(options.pollMs ?? 1000);
    while (!options.signal.aborted) {
      const result = await this.runOnce();
      await options.onStatus?.(result);
      if (!['waiting_notice', 'waiting_source'].includes(result.state)) return result;
      if (options.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, pollMs);
        options.signal.addEventListener('abort', finish, { once: true });
        if (options.signal.aborted) finish();
      });
    }
    return this.result('aborted');
  }
}
