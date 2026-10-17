import { z } from 'zod';
import { bytes32Schema, canonical, hashJson } from '../common.js';
import { platformVaultBindingSchema, type PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import { platformPinsSchema } from '../platform-runtime/types.js';
import { paidCpuJobFinishSchema, paidCpuJobIntentHash, paidCpuJobSchema, type PaidCpuJob } from '../scheduling/paid-job-types.js';
import { TelomereApiError } from '../sdk/transport.js';
import type { PaidLifecycleClientVault } from './paid-lifecycle-runner.js';

export const PAID_CPU_JOB_FINISH_SCHEMA = 'telomere-paid-cpu-job-finish/v1';
type Journal = Pick<PaidLifecycleClientVault, 'scope' | 'claim' | 'read' | 'exclusiveOperation'>;
type Client = Pick<PlatformVaultRuntimeClient, 'config' | 'cpuJob' | 'get' | 'finishCpuJob'>;

export interface PaidCpuJobFinishRunnerOptions {
  /** Retain the same original active snapshot across process restarts. */
  job: PaidCpuJob;
  /** Explicit owner/application declaration, never inferred from billed time or
   * financial completion. The owner retains its meaning and original value. */
  applicationCompletionHash: string;
  client: Client;
  journal: Journal;
}
export interface PaidCpuJobFinishResult {
  readonly state: 'waiting_source' | 'finished' | 'cancelled' | 'superseded' | 'aborted';
  readonly jobId: string;
  readonly sourceRunId: string;
  readonly applicationCompletionHash: string;
  readonly job?: PaidCpuJob;
}

/** Explicit owner completion -> original canonical accounting/cleanup -> finish.
 * This process never stops work, infers application success, buys compute,
 * approves a successor, admits a reservation or signs a wallet transaction. */
export class PaidCpuJobFinishRunner {
  private readonly original: PaidCpuJob;
  private readonly sourceRunId: string;
  private readonly applicationCompletionHash: string;
  private readonly prefix: string;
  private readonly client: Client;
  private readonly journal: Journal;

  constructor(options: PaidCpuJobFinishRunnerOptions) {
    const job = paidCpuJobSchema.parse(options.job), prepared = job.prepared, sourceRunId = job.currentRunId;
    if (job.phase !== 'active' || !sourceRunId || !prepared
      || job.owner.toLowerCase() !== job.binding.owner.toLowerCase() || job.vault.toLowerCase() !== job.binding.vault.toLowerCase()
      || job.input.leashId !== job.binding.leashId || prepared.quote.payer.toLowerCase() !== job.binding.vault.toLowerCase()
      || prepared.quote.leashId !== job.binding.leashId || prepared.quote.runId !== sourceRunId || !job.runIds.includes(sourceRunId)
      || prepared.input.cpuScheduling?.job?.jobId !== job.id || prepared.input.cpuScheduling.job.intentHash !== job.intentHash
      || prepared.input.deadline !== job.input.deadline || canonical(prepared.input.task) !== canonical(job.input.task)
      || job.approvalHash !== (prepared.input.cpuScheduling.job.decisionHash ?? null)) {
      throw new Error('Completion requires the original active owner-approved CPU source');
    }
    if (options.journal.scope.owner !== job.binding.owner.toLowerCase()
      || options.journal.scope.agent !== job.binding.agentWallet.toLowerCase()
      || options.journal.scope.applicationSchema !== PAID_CPU_JOB_FINISH_SCHEMA) {
      throw new Error('CPU completion changed its private owner journal scope');
    }
    this.original = job; this.sourceRunId = sourceRunId;
    this.applicationCompletionHash = bytes32Schema.parse(options.applicationCompletionHash);
    this.prefix = 'cpu-finish:' + hashJson([job.id, sourceRunId]).slice(2);
    this.client = options.client; this.journal = options.journal;
  }
  private key(kind: string) { return this.prefix + ':' + kind; }
  private result(state: PaidCpuJobFinishResult['state'], job?: PaidCpuJob): PaidCpuJobFinishResult {
    return Object.freeze({ state, jobId: this.original.id, sourceRunId: this.sourceRunId,
      applicationCompletionHash: this.applicationCompletionHash, ...(job === undefined ? {} : { job }) });
  }
  private sameSource(job: PaidCpuJob) {
    return job.id === this.original.id && job.intentHash === this.original.intentHash
      && job.owner.toLowerCase() === this.original.owner.toLowerCase() && job.vault.toLowerCase() === this.original.vault.toLowerCase()
      && job.currentRunId === this.sourceRunId && canonical(job.runIds) === canonical(this.original.runIds)
      && job.createdAt === this.original.createdAt && canonical(job.binding) === canonical(this.original.binding)
      && canonical(job.input) === canonical(this.original.input) && canonical(job.proposal) === canonical(this.original.proposal)
      && job.approvalHash === this.original.approvalHash
      && (job.phase !== 'active' || !!job.prepared && job.prepared.ceiling === this.original.prepared!.ceiling
        && canonical(job.prepared.quote) === canonical(this.original.prepared!.quote)
        && canonical(job.prepared.input) === canonical(this.original.prepared!.input));
  }
  private async current() {
    const config = await this.client.config(), binding = platformVaultBindingSchema.parse(config.binding);
    if (canonical(binding) !== canonical(this.original.binding)
      || paidCpuJobIntentHash(this.original.id, binding, this.original.input, this.original.createdAt,
        platformPinsSchema.parse(config.pins)) !== this.original.intentHash) {
      throw new Error('CPU completion changed its reviewed owner, agent Vault or chain configuration');
    }
    return paidCpuJobSchema.parse(await this.client.cpuJob(this.original.id));
  }
  private async claim(kind: string, value: unknown) {
    await this.journal.claim(this.key(kind), value);
    if (canonical(await this.journal.read(this.key(kind))) !== canonical(value)) {
      throw new Error('CPU completion journal did not retain its original operation');
    }
  }
  private request() {
    return { protocol: 'telomere-paid-cpu-job-finish-request/v1', jobId: this.original.id,
      intentHash: this.original.intentHash, applicationCompletionHash: this.applicationCompletionHash,
      input: paidCpuJobFinishSchema.parse({ expectedSourceRunId: this.sourceRunId }) };
  }
  private async cycle(): Promise<PaidCpuJobFinishResult> {
    let job = await this.current();
    if (!this.sameSource(job)) return this.result('superseded', job);
    if (job.phase === 'cancelled') return this.result('cancelled', job);
    if (job.phase !== 'active' && job.phase !== 'finished') return this.result('superseded', job);
    await this.claim('original', { protocol: 'telomere-paid-cpu-job-finish-runner/v1', jobId: this.original.id,
      sourceRunId: this.sourceRunId, intentHash: this.original.intentHash, binding: this.original.binding,
      sourceQuoteHash: hashJson(this.original.prepared!.quote), applicationCompletionHash: this.applicationCompletionHash });
    const request = this.request(), savedRequest = await this.journal.read(this.key('request'));
    // Do not adopt an unrelated manual finish as our original operation.
    if (job.phase === 'finished' && savedRequest === undefined) return this.result('superseded', job);
    if (savedRequest !== undefined) await this.claim('request', request);
    const source = await this.client.get(this.sourceRunId);
    if (source.id !== this.sourceRunId || canonical(source.quote) !== canonical(this.original.prepared!.quote)
      || source.ceiling !== this.original.prepared!.ceiling) throw new Error('CPU completion source reservation changed');
    if (source.status !== 'completed' || !source.settlement || source.settlement.runId !== this.sourceRunId
      || !source.settlementTx || !source.admissionTx || source.charged === null || source.refund === null
      || BigInt(source.charged) + BigInt(source.refund) !== BigInt(source.ceiling)
      || BigInt(job.outstandingLiability) !== 0n) return this.result('waiting_source', job);
    await this.claim('request', request);
    // The server independently confirms canonical source settlement and retained
    // HostKit cleanup. The source fence precedes even its finished replay.
    try { job = paidCpuJobSchema.parse(await this.client.finishCpuJob(this.original.id, request.input)); }
    catch (error) {
      if (error instanceof TelomereApiError && error.status === 409
        && ['paid_cpu_source_pending', 'paid_cpu_cleanup_unconfirmed'].includes(error.code)) return this.result('waiting_source', job);
      if (error instanceof TelomereApiError && error.status === 409
        && ['paid_cpu_job_source_changed', 'paid_cpu_job_phase', 'paid_cpu_job_busy'].includes(error.code)) {
        job = await this.current();
        if (!this.sameSource(job)) return this.result('superseded', job);
        if (job.phase === 'cancelled') return this.result('cancelled', job);
        if (job.phase !== 'active' && job.phase !== 'finished') return this.result('superseded', job);
      }
      throw error;
    }
    if (!this.sameSource(job)) return this.result('superseded', job);
    if (job.phase !== 'finished' || BigInt(job.outstandingLiability) !== 0n) {
      throw new Error('CPU completion response changed its original finished source or accounting');
    }
    await this.claim('accepted', { protocol: 'telomere-paid-cpu-job-finish-accepted/v1', requestHash: hashJson(request) });
    return this.result('finished', job);
  }
  /** The private cross-process lock serializes runOnce and explicit watch. */
  runOnce(): Promise<PaidCpuJobFinishResult> { return this.journal.exclusiveOperation(this.prefix, () => this.cycle()); }
  tick(): Promise<PaidCpuJobFinishResult> { return this.runOnce(); }
  /** Sequential opt-in polling; abort drains an in-flight cycle without stop,
   * cancellation, target approval or any wallet operation. */
  async watch(options: { signal: AbortSignal; pollMs?: number;
    onStatus?: (result: PaidCpuJobFinishResult) => void | Promise<void> }): Promise<PaidCpuJobFinishResult> {
    const pollMs = z.number().int().min(100).max(5000).parse(options.pollMs ?? 1000);
    while (!options.signal.aborted) {
      const result = await this.runOnce();
      await options.onStatus?.(result);
      if (result.state !== 'waiting_source') return result;
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
