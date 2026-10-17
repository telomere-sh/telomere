import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bytes32Schema, canonical, moneySchema } from '../common.js';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema } from '../cysts/types.js';
import { paidPreemptionNoticeSchema } from '../host-kit/sessions/paid-preemption-protocol.js';
import { hostKeySchema, hostMessageHash, imageDigestSchema, verifyHostMessage } from '../host-kit/protocol.js';
import { platformVaultBindingSchema, type PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import { validateCpuResult } from '../runtime/validation.js';
import { type CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import { decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import { PaidSessionStateHandoff } from './paid-session-handoff.js';

const operationIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const WATCHDOG_CLEANUP_TOLERANCE_MS = 5000;
const checkpointOperationIdSchema = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const captureSchema = z.object({ protocol: z.literal('telomere-paid-preemption-capture-v1'),
  sourceRunId: bytes32Schema, sourceHostId: bytes32Schema, sourceLeaseHash: bytes32Schema,
  notice: paidPreemptionNoticeSchema, checkpointOperationId: checkpointOperationIdSchema,
  checkpointId: cystIdSchema, checkpointCompletedAtMs: z.number().int().nonnegative().safe(),
  maxSpend: moneySchema, deadline: z.number().int().positive().safe() }).strict();
export type PaidPreemptionCapture = z.infer<typeof captureSchema>;
const captureIntentSchema = z.object({ protocol: z.literal('telomere-paid-preemption-intent-v1'),
  owner: cystAddressSchema, agent: cystAddressSchema, agentId: bytes32Schema, vault: cystAddressSchema,
  leashId: bytes32Schema, applicationSchema: cystHeaderSchema.shape.applicationSchema,
  sourceRunId: bytes32Schema, sourceHostId: bytes32Schema, sourceLeaseHash: bytes32Schema,
  notice: paidPreemptionNoticeSchema, maxSpend: moneySchema, deadline: z.number().int().positive().safe() }).strict();
const restoreInputSchema = z.object({ capture: captureSchema, targetRunId: bytes32Schema,
  restoreOperationId: operationIdSchema }).strict();
const bindingSchema = z.object({ protocol: z.literal('telomere-paid-preemption-restore-v1'),
  owner: cystAddressSchema, agent: cystAddressSchema, agentId: bytes32Schema, vault: cystAddressSchema,
  leashId: bytes32Schema, applicationSchema: cystHeaderSchema.shape.applicationSchema,
  capture: captureSchema, sourceSettlementTx: bytes32Schema, sourceCharged: moneySchema,
  targetRunId: bytes32Schema, targetHostId: bytes32Schema, targetLeaseHash: bytes32Schema,
  targetCeiling: moneySchema, targetImage: imageDigestSchema, restoreOperationId: operationIdSchema }).strict();
const targetClaimSchema = bindingSchema.omit({ protocol: true }).extend({
  protocol: z.literal('telomere-paid-preemption-target-claim-v1') }).strict();
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function same(left: unknown, right: unknown) { return canonical(left) === canonical(right); }
function addressSame(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }

/** Explicit owner/agent orchestration across two separately funded CPU Cells.
 * Captured application bytes remain in the owner's encrypted Cyst vault. The
 * source can wait in Cyst until the hourly financial root is canonical; no
 * target is bought, admitted or reserved by this class.
 */
export class PaidPreemptionHandoff {
  private readonly binding: z.infer<typeof platformVaultBindingSchema>;
  private readonly applicationSchema: string;
  private readonly controllerKey: string;
  private readonly hostKeys: ReadonlyMap<string, string>;
  private readonly client: Pick<PlatformVaultRuntimeClient,
    'config' | 'get' | 'sessionLease' | 'preemptionNotice'>;
  private readonly handoff: PaidSessionStateHandoff;
  private readonly vault: CystCheckpointVault;
  private readonly now: () => number;

  constructor(options: { binding: z.infer<typeof platformVaultBindingSchema>; applicationSchema: string;
    controllerKey: string; hostKeys: ReadonlyMap<string, string>;
    client: Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'sessionLease' | 'preemptionNotice'>;
    handoff: PaidSessionStateHandoff; vault: CystCheckpointVault; now?: () => number }) {
    this.binding = platformVaultBindingSchema.parse(options.binding);
    this.applicationSchema = cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    this.controllerKey = hostKeySchema.parse(options.controllerKey);
    this.hostKeys = new Map([...options.hostKeys].map(([id, key]) => [bytes32Schema.parse(id), hostKeySchema.parse(key)]));
    if (!this.hostKeys.size || !options.client || !options.handoff || !options.vault) {
      throw new Error('Reviewed Vault, hosts, client, handoff and private owner vault are required');
    }
    this.client = options.client; this.handoff = options.handoff; this.vault = options.vault;
    this.now = options.now ?? Date.now;
  }
  private time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid owner clock');
    return value;
  }
  private async config() {
    const config = await this.client.config();
    if (!same(config.binding, this.binding) || !addressSame(config.binding.vault, this.binding.vault)) {
      throw new Error('Original Vault, agent or owner binding changed');
    }
    return config;
  }
  private async lease(runId: string) {
    const evidence = await this.client.sessionLease(runId), body = evidence.lease.body;
    if (evidence.controllerKey !== this.controllerKey || this.hostKeys.get(evidence.hostId) !== body.hostKey
      || !addressSame(body.owner, this.binding.vault) || body.runId !== runId
      || evidence.leaseHash !== hostMessageHash(evidence.lease)
      || !verifyHostMessage(this.controllerKey, 'lease', evidence.lease)) {
      throw new Error('Paid Cell original lease differs from independently reviewed controller or host keys');
    }
    return evidence;
  }
  private async notice(runId: string) {
    const [lease, evidence] = await Promise.all([this.lease(runId), this.client.preemptionNotice(runId)]);
    const body = evidence.notice.body;
    if (evidence.hostId !== lease.hostId || evidence.leaseHash !== lease.leaseHash
      || !same(evidence.lease, lease.lease) || body.runId !== runId
      || body.hostKey !== lease.lease.body.hostKey || body.leaseHash !== lease.leaseHash
      || !addressSame(body.owner, lease.lease.body.owner)
      || body.image !== lease.lease.body.image || !verifyHostMessage(body.hostKey, 'paid-preemption', evidence.notice)) {
      throw new Error('Host notice changed its reviewed original paid lease');
    }
    const opted = evidence.optIn.body;
    if (!verifyHostMessage(this.controllerKey, 'paid-preemption-optin', evidence.optIn)
      || body.optInHash !== hostMessageHash(evidence.optIn)
      || opted.hostKey !== body.hostKey || !addressSame(opted.owner, body.owner)
      || opted.runId !== body.runId || opted.leaseHash !== body.leaseHash
      || opted.image !== body.image || opted.expiresAt > lease.lease.body.expiresAt
      || body.interruptAt > opted.expiresAt) {
      throw new Error('Signed host notice lacks the original owner opt-in authority');
    }
    const terminalTick = evidence.terminalTick;
    if (terminalTick && (!verifyHostMessage(body.hostKey, 'tick', terminalTick)
      || terminalTick.body.hostKey !== body.hostKey || terminalTick.body.owner !== body.owner
      || terminalTick.body.runId !== runId
      || terminalTick.body.leaseHash !== hostMessageHash({ body: lease.lease.body, signature: '' }))) {
      throw new Error('Paid source terminal tick changed its signed original lease');
    }
    return { lease, notice: evidence.notice, terminalTick };
  }
  private checkRun(run: Awaited<ReturnType<PlatformVaultRuntimeClient['get']>>, runId: string) {
    if (run.id !== runId || !addressSame(run.quote.payer, this.binding.vault)
      || run.quote.leashId !== this.binding.leashId || !run.admissionTx) {
      throw new Error('Paid run differs from the original agent Vault and Leash');
    }
  }
  /** The reviewed guest checkpoint hook must freeze/flush application state
   * until source removal. A host notice alone cannot make arbitrary code safe. */
  async capture(sourceRunIdValue: string, maxSpendValue: string, deadline: number): Promise<PaidPreemptionCapture> {
    const sourceRunId = bytes32Schema.parse(sourceRunIdValue), maxSpend = moneySchema.parse(maxSpendValue);
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid preemption deadline');
    await this.config();
    const source = await this.client.get(sourceRunId); this.checkRun(source, sourceRunId);
    const { lease, notice } = await this.notice(sourceRunId), body = notice.body;
    if (source.quote.hostId !== lease.hostId || body.interruptAt > lease.lease.body.expiresAt
      || body.issuedAt > this.time() + 5000) throw new Error('Signed host notice changed its source Cell');
    const allowed = source.status === 'running' && BigInt(source.ceiling) <= BigInt(maxSpend)
      && body.interruptAt > this.time() && deadline > Math.floor(this.time() / 1000);
    await this.intent(captureIntentSchema.parse({ protocol: 'telomere-paid-preemption-intent-v1',
      owner: this.binding.owner, agent: this.binding.agentWallet, agentId: this.binding.agentId,
      vault: this.binding.vault, leashId: this.binding.leashId, applicationSchema: this.applicationSchema,
      sourceRunId, sourceHostId: lease.hostId, sourceLeaseHash: lease.leaseHash,
      notice, maxSpend, deadline }), allowed);
    const captured = await this.handoff.snapshotForPreemption(sourceRunId, body.noticeId, body.issuedAt);
    if (captured.completedAtMs > body.interruptAt) {
      throw new Error('Application checkpoint missed the signed host preemption deadline');
    }
    return captureSchema.parse({ protocol: 'telomere-paid-preemption-capture-v1', sourceRunId,
      sourceHostId: lease.hostId, sourceLeaseHash: lease.leaseHash, notice,
      checkpointOperationId: captured.operationId, checkpointId: captured.checkpoint.id,
      checkpointCompletedAtMs: captured.completedAtMs, maxSpend, deadline });
  }
  private journalScope() {
    return { owner: this.binding.owner, agent: this.binding.agentWallet,
      applicationSchema: 'paid.preempt.' + sha256(JSON.stringify(['telomere-paid-preemption-v1',
        this.binding.agentId])).slice(0, 51) };
  }
  private journalId(operationId: string) {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-preemption-operation-v1', operationId]));
  }
  private intentId(runId: string, noticeId: string) {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-preemption-intent-v1', runId, noticeId]));
  }
  private targetClaimId(runId: string, noticeId: string) {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-preemption-one-target-v1', runId, noticeId]));
  }
  /** Bind the owner's budget and deadline before the first checkpoint call. */
  private async intent(value: z.infer<typeof captureIntentSchema>, allowCreate: boolean): Promise<boolean> {
    const scope = this.journalScope(), id = this.intentId(value.sourceRunId, value.notice.body.noticeId);
    return this.vault.exclusive(scope, async journal => {
      let record = await journal.checkpoint(id), created = false;
      if (!record) {
        if (!allowCreate) throw new Error('No original owner-approved preemption capture intent exists');
        const bytes = Buffer.from(JSON.stringify(value));
        let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try { encrypted = await encryptCheckpoint(bytes, scope); await journal.saveCheckpoint(id, encrypted); }
        finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
        record = await journal.checkpoint(id); created = true;
      }
      if (!record) throw new Error('Owner vault did not durably bind preemption capture intent');
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const original = captureIntentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (!same(original, value)) throw new Error('Preemption capture changed its original owner budget, deadline or notice');
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
      return created;
    });
  }
  /** Immutable per-agent operation binding precedes any target command. */
  private async bind(value: z.infer<typeof bindingSchema>, allowCreate: boolean): Promise<boolean> {
    const scope = this.journalScope(), id = this.journalId(value.restoreOperationId);
    return this.vault.exclusive(scope, async journal => {
      let record = await journal.checkpoint(id), created = false;
      if (!record) {
        if (!allowCreate) throw new Error('New preemption restore requires a live target and approved deadline');
        const bytes = Buffer.from(JSON.stringify(value));
        let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try { encrypted = await encryptCheckpoint(bytes, scope); await journal.saveCheckpoint(id, encrypted); }
        finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
        record = await journal.checkpoint(id); created = true;
      }
      if (!record) throw new Error('Owner vault did not durably bind the preemption restore');
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const original = bindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (!same(original, value)) throw new Error('Restore operation is bound to a different notice, settlement or target');
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
      return created;
    });
  }
  /** One notice can claim only one target and one restore command. A changed
   * operation ID cannot buy an independent second target under the same cap. */
  private async claim(value: z.infer<typeof targetClaimSchema>, allowCreate: boolean): Promise<void> {
    const scope = this.journalScope(), id = this.targetClaimId(value.capture.sourceRunId,
      value.capture.notice.body.noticeId);
    await this.vault.exclusive(scope, async journal => {
      let record = await journal.checkpoint(id);
      if (!record) {
        if (!allowCreate) throw new Error('No original live-target claim exists for this host notice');
        const bytes = Buffer.from(JSON.stringify(value));
        let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try { encrypted = await encryptCheckpoint(bytes, scope); await journal.saveCheckpoint(id, encrypted); }
        finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
        record = await journal.checkpoint(id);
      }
      if (!record) throw new Error('Owner vault did not durably claim one preemption target');
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const original = targetClaimSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (!same(original, value)) throw new Error('Host notice already claimed a different target or restore operation');
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }
  /** Resume only after source host cleanup and canonical fee-inclusive
   * settlement. The separate target must be Vault-paid and admitted now. */
  async restore(raw: unknown) {
    const input = restoreInputSchema.parse(raw), capture = input.capture;
    await this.config();
    const { lease: sourceLease, notice, terminalTick } = await this.notice(capture.sourceRunId);
    if (!same(notice, capture.notice) || sourceLease.leaseHash !== capture.sourceLeaseHash
      || sourceLease.hostId !== capture.sourceHostId
      || capture.checkpointCompletedAtMs < notice.body.issuedAt
      || capture.checkpointCompletedAtMs > notice.body.interruptAt) {
      throw new Error('Captured source or host notice differs from the durable original');
    }
    if (!terminalTick || terminalTick.body.state !== 'STOPPED'
      || terminalTick.body.timestamp < notice.body.issuedAt
      || terminalTick.body.timestamp > notice.body.interruptAt + WATCHDOG_CLEANUP_TOLERANCE_MS) {
      throw new Error('Signed source cleanup missed the host notice deadline');
    }
    await this.intent(captureIntentSchema.parse({ protocol: 'telomere-paid-preemption-intent-v1',
      owner: this.binding.owner, agent: this.binding.agentWallet, agentId: this.binding.agentId,
      vault: this.binding.vault, leashId: this.binding.leashId, applicationSchema: this.applicationSchema,
      sourceRunId: capture.sourceRunId, sourceHostId: capture.sourceHostId,
      sourceLeaseHash: capture.sourceLeaseHash, notice: capture.notice,
      maxSpend: capture.maxSpend, deadline: capture.deadline }), false);
    const originalCheckpoint = await this.handoff.verifiedPreemptionCapture(capture.sourceRunId,
      notice.body.noticeId, notice.body.issuedAt);
    if (capture.checkpointOperationId !== originalCheckpoint.operationId
      || capture.checkpointId !== originalCheckpoint.checkpointId
      || capture.checkpointCompletedAtMs !== originalCheckpoint.completedAtMs) {
      throw new Error('Captured source checkpoint differs from its immutable owner-vault marker');
    }
    const source = await this.client.get(capture.sourceRunId); this.checkRun(source, capture.sourceRunId);
    if (source.status !== 'completed' || !source.settlement || !source.settlementTx
      || source.charged === null || source.refund === null || !source.result) {
      throw new Error('Canonical source cleanup and financial settlement are still pending');
    }
    const outcome = validateCpuResult(source.result, source.id, source.quote.maxSeconds);
    if (outcome.status !== 'cancelled' || source.settlement.billableSeconds > outcome.billableSeconds
      || source.settlement.endedAt < Math.floor(notice.body.issuedAt / 1000)
      || BigInt(source.charged) + BigInt(source.refund) !== BigInt(source.ceiling)) {
      throw new Error('Source did not close as a confirmed, conservatively billed stopped Cell');
    }
    if (input.targetRunId === source.id) throw new Error('Preemption target must differ from source');
    const target = await this.client.get(input.targetRunId); this.checkRun(target, input.targetRunId);
    const targetLease = await this.lease(input.targetRunId);
    if (target.quote.hostId !== targetLease.hostId || targetLease.hostId === sourceLease.hostId
      || targetLease.lease.body.image !== sourceLease.lease.body.image
      || BigInt(source.charged) + BigInt(target.ceiling) > BigInt(capture.maxSpend)) {
      throw new Error('Separately paid target differs in host, image, or total budget');
    }
    const value = bindingSchema.parse({ protocol: 'telomere-paid-preemption-restore-v1',
      owner: this.binding.owner, agent: this.binding.agentWallet, agentId: this.binding.agentId,
      vault: this.binding.vault, leashId: this.binding.leashId, applicationSchema: this.applicationSchema,
      capture, sourceSettlementTx: source.settlementTx, sourceCharged: source.charged,
      targetRunId: target.id, targetHostId: targetLease.hostId, targetLeaseHash: targetLease.leaseHash,
      targetCeiling: target.ceiling, targetImage: targetLease.lease.body.image,
      restoreOperationId: input.restoreOperationId });
    if (target.status !== 'running' && target.status !== 'completed') {
      throw new Error('Target paid Cell is neither live nor a completed exact retry');
    }
    // Existing exact same-ID replay is allowed after terminal cleanup; a new
    // operation requires the target still alive and enough time for the hook.
    const newAllowed = target.status === 'running' && targetLease.lease.body.expiresAt > this.time() + 5000
      && Math.floor(this.time() / 1000) + target.quote.maxSeconds <= capture.deadline;
    await this.claim(targetClaimSchema.parse({ ...value, protocol: 'telomere-paid-preemption-target-claim-v1' }), newAllowed);
    const newOperation = await this.bind(value, newAllowed);
    const latestSource = await this.client.get(capture.sourceRunId);
    if (latestSource.status !== 'completed' || latestSource.settlementTx !== source.settlementTx) {
      throw new Error('Source settlement changed immediately before target dispatch');
    }
    if (newOperation) {
      const latestTarget = await this.client.get(input.targetRunId), latestLease = await this.lease(input.targetRunId);
      if (latestTarget.status !== 'running' || latestLease.leaseHash !== targetLease.leaseHash
        || latestLease.hostId !== targetLease.hostId || latestLease.lease.body.expiresAt <= this.time() + 5000) {
        throw new Error('Target changed immediately before the new restore command');
      }
    }
    const result = await this.handoff.restore({ sourceRunId: capture.sourceRunId, targetRunId: target.id,
      checkpointOperationId: capture.checkpointOperationId, checkpointId: capture.checkpointId,
      restoreOperationId: input.restoreOperationId });
    return { ...result, noticeId: notice.body.noticeId, sourceSettlementTx: source.settlementTx,
      sourceCharged: source.charged, targetCeiling: target.ceiling };
  }
}
