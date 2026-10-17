import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bytes32Schema, canonical } from '../common.js';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema, cystMetadataSchema } from '../cysts/types.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import type { PlatformRuntimeClient } from '../platform-runtime/client.js';
import { CystCheckpointCoordinator, type CystCheckpointResult, type CystCheckpointTrigger,
  type CystCheckpointState, type CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import { CystClient, decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import { PaidSessionCheckpointRunner } from './paid-session-checkpoint.js';

/** JSON/base64 restore input must fit the paid command's 8 KiB stdin bound. */
export const PAID_SESSION_HANDOFF_MAX_BYTES = 4096;

const operationIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const captureOperationIdSchema = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const handoffInputSchema = z.object({ sourceRunId: bytes32Schema, targetRunId: bytes32Schema,
  checkpointOperationId: captureOperationIdSchema, checkpointId: cystIdSchema,
  restoreOperationId: operationIdSchema }).strict();
const bindingSchema = handoffInputSchema.extend({ protocol: z.literal('telomere-paid-app-handoff-v1'),
  owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema,
  stateSha256: digestSchema, restoreCommandSpecSha256: digestSchema }).strict();
const restoreOutputSchema = handoffInputSchema.extend({ protocol: z.literal('telomere-paid-app-restore-v1'),
  stateSha256: digestSchema }).strict();
const preemptionMarkerSchema = z.object({ protocol: z.literal('telomere-paid-preemption-capture-marker-v1'),
  sourceRunId: bytes32Schema, noticeId: bytes32Schema, issuedAtMs: z.number().int().nonnegative().safe(),
  operationId: captureOperationIdSchema, checkpoint: cystMetadataSchema,
  completedAtMs: z.number().int().nonnegative().safe() }).strict();

export type PaidSessionHandoffInput = z.infer<typeof handoffInputSchema>;
export type PaidSessionHandoffReceipt = z.infer<typeof restoreOutputSchema> & { commandId: string };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }

/** Opt-in, owner-side handoff of application bytes between two separately
 * admitted paid Cells. The reviewed restore executable must durably apply an
 * operation once and report the exact binding; no process/Cell is migrated.
 */
export class PaidSessionStateHandoff {
  private readonly owner: string;
  private readonly agent: string;
  private readonly applicationSchema: string;
  private readonly client: Pick<PlatformRuntimeClient, 'command'>;
  private readonly cysts: CystClient;
  private readonly vault: CystCheckpointVault;
  private readonly captureRunner: PaidSessionCheckpointRunner;
  private readonly restoreArgvPrefix: readonly string[];
  private readonly restoreCommandSpecSha256: string;

  constructor(options: { owner: string; agent: string; applicationSchema: string;
    client: Pick<PlatformRuntimeClient, 'command'>; cysts: CystClient; vault: CystCheckpointVault;
    checkpointArgvPrefix: readonly string[]; restoreArgvPrefix: readonly string[] }) {
    this.owner = cystAddressSchema.parse(options.owner);
    this.agent = cystAddressSchema.parse(options.agent);
    this.applicationSchema = cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    if (!options.client || typeof options.client.command !== 'function' || !options.cysts
      || typeof options.cysts.download !== 'function' || typeof options.cysts.upload !== 'function'
      || !options.vault || typeof options.vault.exclusive !== 'function') {
      throw new Error('Supply authenticated paid/Cyst clients and a durable private owner vault');
    }
    this.client = options.client; this.cysts = options.cysts; this.vault = options.vault;
    this.captureRunner = new PaidSessionCheckpointRunner({ client: options.client,
      argvPrefix: options.checkpointArgvPrefix, maxBytes: PAID_SESSION_HANDOFF_MAX_BYTES });
    this.restoreArgvPrefix = Object.freeze([...options.restoreArgvPrefix]);
    sessionCommandSchema.parse({ commandId: 'restore-validation',
      argv: [...this.restoreArgvPrefix, '0x' + '0'.repeat(64), '0x' + '1'.repeat(64),
        'cyst-hook-' + '0'.repeat(64), '0x' + '2'.repeat(64), 'restore-validation', '0'.repeat(64)] });
    this.restoreCommandSpecSha256 = sha256(JSON.stringify(['telomere-paid-app-restore-command-v1', this.restoreArgvPrefix]));
  }

  private captureScope(sourceRunId: string) {
    return { owner: this.owner, agent: this.agent,
      applicationSchema: 'paid.run.' + sha256(JSON.stringify(['telomere-paid-app-capture-v1',
        this.applicationSchema, sourceRunId])).slice(0, 55) };
  }
  private bindingScope() {
    return { owner: this.owner, agent: this.agent,
      applicationSchema: 'paid.handoff.' + sha256(JSON.stringify(['telomere-paid-app-handoff-v1',
        this.applicationSchema])).slice(0, 51) };
  }
  private coordinator(sourceRunId: string, fixedOperationId?: string): CystCheckpointCoordinator {
    const runId = bytes32Schema.parse(sourceRunId);
    return new CystCheckpointCoordinator({ ...this.captureScope(runId), cysts: this.cysts, vault: this.vault,
      ...(fixedOperationId ? { fixedOperationId } : {}),
      onCyst: ({ operationId }) => this.captureRunner.checkpoint(runId, operationId) });
  }
  private preemptionMarkerScope(sourceRunId: string, noticeId: string) {
    return { owner: this.owner, agent: this.agent,
      applicationSchema: 'paid.preempt.lock.' + sha256(JSON.stringify([
        'telomere-paid-preemption-capture-lock-v1', this.applicationSchema, sourceRunId, noticeId])).slice(0, 44) };
  }
  private preemptionMarkerId(sourceRunId: string, noticeId: string) {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-preemption-marker-v1', sourceRunId, noticeId]));
  }
  private preemptionOperationId(sourceRunId: string, noticeId: string) {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-preemption-capture-v1',
      this.owner, this.agent, this.applicationSchema, sourceRunId, noticeId]));
  }
  private async readPreemptionMarker(sourceRunId: string, noticeId: string, issuedAtMs: number) {
    const scope = this.preemptionMarkerScope(sourceRunId, noticeId), id = this.preemptionMarkerId(sourceRunId, noticeId);
    return this.vault.exclusive(scope, async journal => {
      const record = await journal.checkpoint(id);
      if (!record) return undefined;
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const marker = preemptionMarkerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (marker.sourceRunId !== sourceRunId || marker.noticeId !== noticeId || marker.issuedAtMs !== issuedAtMs) {
            throw new Error('Durable preemption marker changed its original host notice');
          }
          return marker;
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }

  /** Captures the exact source Cell through the existing durable Cyst flow. */
  snapshot(sourceRunId: string, reason: CystCheckpointTrigger = 'owner_request'): Promise<CystCheckpointResult> {
    return this.coordinator(sourceRunId).snapshot(reason);
  }
  /** After a lost capture/upload response, retry the original pending operation. */
  retryCapture(sourceRunId: string): Promise<CystCheckpointResult> {
    return this.coordinator(sourceRunId).retryPending();
  }
  /** A host notice has one capture for its original source run. This separate
   * owner-vault lock recovers a completed upload after a lost client response
   * instead of making a second, potentially different application snapshot. */
  async snapshotForPreemption(sourceRunIdValue: string, noticeIdValue: string, issuedAtMs: number) {
    const sourceRunId = bytes32Schema.parse(sourceRunIdValue), noticeId = bytes32Schema.parse(noticeIdValue);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) throw new Error('Invalid signed preemption issue time');
    const lockScope = this.preemptionMarkerScope(sourceRunId, noticeId);
    return this.vault.exclusive(lockScope, async journal => {
      const markerId = this.preemptionMarkerId(sourceRunId, noticeId);
      const operationId = this.preemptionOperationId(sourceRunId, noticeId);
      const prior = await journal.checkpoint(markerId);
      if (prior) {
        try {
          const bytes = await decryptCheckpoint(prior.envelope, prior.recoveryKey);
          try {
            const marker = preemptionMarkerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            if (marker.sourceRunId !== sourceRunId || marker.noticeId !== noticeId || marker.issuedAtMs !== issuedAtMs
              || marker.operationId !== operationId) {
              throw new Error('Durable preemption marker changed its original host notice');
            }
            return { status: 'uploaded' as const, operationId: marker.operationId,
              checkpoint: marker.checkpoint,
              completedAtMs: marker.completedAtMs, replayed: true };
          } finally { bytes.fill(0); }
        } finally { prior.recoveryKey.fill(0); }
      }
      const scope = this.captureScope(sourceRunId);
      const read = () => this.vault.exclusive(scope, journal => journal.load());
      const accepted = (state: CystCheckpointState | undefined) => state?.latest?.trigger === 'preemption'
        && state.latest.operationId === operationId
        && state.latest.completedAtMs >= issuedAtMs && same(state.scope, scope) ? state.latest : undefined;
      let state = await read(), latest = accepted(state);
      if (state?.pending && (state.pending.trigger !== 'preemption' || state.pending.operationId !== operationId
        || state.pending.startedAtMs < issuedAtMs)) {
        throw new Error('A different source checkpoint is pending before this host notice');
      }
      let replayed = true;
      if (!latest) {
        const coordinator = this.coordinator(sourceRunId, operationId);
        const result = state?.pending ? await coordinator.retryPending() : await coordinator.snapshot('preemption');
        if (result.status !== 'uploaded' || result.operationId !== operationId) {
          throw new Error('The notice-bound preemption checkpoint did not upload');
        }
        replayed = result.replayed;
        state = await read(); latest = accepted(state);
      }
      if (!latest) {
        throw new Error('The completed preemption checkpoint changed in the owner vault');
      }
      const marker = preemptionMarkerSchema.parse({ protocol: 'telomere-paid-preemption-capture-marker-v1',
        sourceRunId, noticeId, issuedAtMs, operationId: latest.operationId,
        checkpoint: latest.checkpoint, completedAtMs: latest.completedAtMs });
      const bytes = Buffer.from(JSON.stringify(marker));
      let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
      try { encrypted = await encryptCheckpoint(bytes, lockScope); await journal.saveCheckpoint(markerId, encrypted); }
      finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
      return { status: 'uploaded' as const, operationId: latest.operationId,
        checkpoint: latest.checkpoint, completedAtMs: latest.completedAtMs, replayed };
    });
  }

  /** Read-only recovery of the one locally journaled capture for this notice.
   * A caller-supplied checkpoint ID or completion timestamp is never evidence. */
  async verifiedPreemptionCapture(sourceRunIdValue: string, noticeIdValue: string, issuedAtMs: number) {
    const sourceRunId = bytes32Schema.parse(sourceRunIdValue), noticeId = bytes32Schema.parse(noticeIdValue);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) throw new Error('Invalid signed preemption issue time');
    const marker = await this.readPreemptionMarker(sourceRunId, noticeId, issuedAtMs);
    if (!marker) throw new Error('No matching durable preemption capture marker exists');
    if (marker.operationId !== this.preemptionOperationId(sourceRunId, noticeId)) {
      throw new Error('Durable preemption marker changed its notice-bound operation');
    }
    const scope = this.captureScope(sourceRunId);
    const record = await this.vault.exclusive(scope, journal => journal.checkpoint(marker.operationId));
    if (!record) throw new Error('Durable preemption capture recovery record is missing');
    try {
      if (record.envelope.id !== marker.checkpoint.id || record.envelope.owner !== this.owner
        || record.envelope.agent !== this.agent || record.envelope.applicationSchema !== scope.applicationSchema
        || marker.completedAtMs < issuedAtMs) throw new Error('Durable preemption capture differs from its marker');
    } finally { record.recoveryKey.fill(0); }
    return { operationId: marker.operationId, checkpointId: marker.checkpoint.id,
      completedAtMs: marker.completedAtMs };
  }

  private async state(input: PaidSessionHandoffInput): Promise<Uint8Array> {
    const scope = this.captureScope(input.sourceRunId);
    const record = await this.vault.exclusive(scope, journal => journal.checkpoint(input.checkpointOperationId));
    if (!record) throw new Error('Owner vault has no matching source checkpoint');
    try {
      const envelope = record.envelope;
      if (envelope.id !== input.checkpointId || envelope.owner !== this.owner || envelope.agent !== this.agent
        || envelope.applicationSchema !== scope.applicationSchema) {
        throw new Error('Source checkpoint changed run, owner or operation');
      }
      const downloaded = await this.cysts.download(input.checkpointId, { owner: this.owner, agent: this.agent });
      if (!same(downloaded, envelope)) throw new Error('Source checkpoint differs from the durable Cyst record');
      const state = await decryptCheckpoint(downloaded, record.recoveryKey);
      if (state.byteLength < 1 || state.byteLength > PAID_SESSION_HANDOFF_MAX_BYTES) {
        state.fill(0); throw new Error('Paid handoff state exceeds the reviewed restore bound');
      }
      return state;
    } finally { record.recoveryKey.fill(0); }
  }

  private async bind(value: z.infer<typeof bindingSchema>): Promise<void> {
    const scope = this.bindingScope();
    // The record ID omits run/state data intentionally. Reusing one restore
    // operation ID with a different binding must conflict before dispatch.
    const recordId = 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-app-handoff-record-v1', value.restoreOperationId]));
    await this.vault.exclusive(scope, async journal => {
      let record = await journal.checkpoint(recordId);
      if (!record) {
        const plaintext = Buffer.from(JSON.stringify(value));
        let generated: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try {
          generated = await encryptCheckpoint(plaintext, scope);
          await journal.saveCheckpoint(recordId, generated);
        } finally { plaintext.fill(0); generated?.recoveryKey.fill(0); }
        record = await journal.checkpoint(recordId);
      }
      if (!record) throw new Error('Owner vault did not retain the paid handoff binding');
      try {
        const plaintext = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const saved = bindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
          if (!same(saved, value)) throw new Error('Restore operation is already bound to different run, state or command spec');
        } finally { plaintext.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }

  /** The target run must already be funded and admitted. Retrying with the
   * same input sends the exact same command ID, argv and stdin to Host Kit.
   */
  async restore(raw: PaidSessionHandoffInput): Promise<PaidSessionHandoffReceipt> {
    const input = handoffInputSchema.parse(raw);
    if (input.sourceRunId === input.targetRunId) throw new Error('Paid handoff needs a separate target Cell');
    const state = await this.state(input);
    try {
      const stateSha256 = sha256(state);
      const binding = bindingSchema.parse({ ...input, protocol: 'telomere-paid-app-handoff-v1',
        owner: this.owner, agent: this.agent, applicationSchema: this.applicationSchema,
        stateSha256, restoreCommandSpecSha256: this.restoreCommandSpecSha256 });
      await this.bind(binding);
      const commandId = 'rs' + sha256(JSON.stringify(['telomere-paid-app-restore-v1', this.owner, this.agent,
        this.applicationSchema, input.restoreOperationId])).slice(0, 62);
      const payload = { ...input, protocol: 'telomere-paid-app-restore-v1' as const,
        stateSha256, stateBase64: Buffer.from(state).toString('base64') };
      const command = sessionCommandSchema.parse({ commandId,
        argv: [...this.restoreArgvPrefix, input.sourceRunId, input.targetRunId,
          input.checkpointOperationId, input.checkpointId, input.restoreOperationId, stateSha256],
        stdin: JSON.stringify(payload) });
      const result = checkedSessionCommand(await this.client.command(input.targetRunId, command), command);
      if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== '') {
        throw new Error('Paid application restore command did not complete cleanly');
      }
      let output: z.infer<typeof restoreOutputSchema>;
      try { output = restoreOutputSchema.parse(JSON.parse(result.stdout)); }
      catch { throw new Error('Paid application restore output is invalid'); }
      if (!same(output, { ...input, protocol: 'telomere-paid-app-restore-v1', stateSha256 })) {
        throw new Error('Paid application restore output changed the handoff binding');
      }
      return { ...output, commandId };
    } finally { state.fill(0); }
  }
}
