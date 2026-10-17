import { cystEnvelopeSchema, type CystEnvelope, type CystMetadata } from '../cysts/types.js';
import { decryptCheckpoint, encryptCheckpoint, generateCystRecoveryKey } from '../sdk/cysts.js';
import type { AgentLifecycleService } from './service.js';
import type { AgentMode } from './types.js';

export interface ClientAgentRunner {
  /** Every operation must be idempotent for operationId, including after loss of its response. */
  checkpoint(sourceRunId: string, operationId: string): Promise<Uint8Array>;
  stop(sourceRunId: string, operationId: string): Promise<void>;
  attach(targetRunId: string, operationId: string): Promise<void>;
  resume(targetRunId: string, state: Uint8Array, mode: Exclude<AgentMode, 'cyst'>, operationId: string): Promise<void>;
  profile(sourceRunId: string, mode: Exclude<AgentMode, 'cyst'>, operationId: string): Promise<void>;
}
export interface ClientLifecycleVault {
  /** Must durably persist keys/envelopes before returning. These values stay on the owner's client. */
  /** Return a fresh key copy: the coordinator clears its copy after use. */
  getCheckpoint(intentId: string): Promise<{ envelope: CystEnvelope; recoveryKey: Uint8Array } | undefined>;
  putCheckpoint(intentId: string, envelope: CystEnvelope, recoveryKey: Uint8Array): Promise<void>;
  /** Resolve a previously exported/checkpointed key on wake. The server has no matching endpoint. */
  recoveryKey(checkpointId: string): Promise<Uint8Array>;
}
export function lifecycleCheckpointEnvelope(downloaded: { metadata: CystMetadata; ciphertext: string }): CystEnvelope {
  const m = downloaded.metadata;
  return cystEnvelopeSchema.parse({ version: m.version, algorithm: m.algorithm, id: m.id, owner: m.owner,
    agent: m.agent, applicationSchema: m.applicationSchema, plaintextBytes: m.plaintextBytes, nonce: m.nonce,
    sha256: m.sha256, ciphertext: downloaded.ciphertext });
}
export interface ClientLifecycleControl {
  get(owner: string, agent: string): ReturnType<AgentLifecycleService['get']>;
  acknowledge(owner: string, intentId: string, expectedVersion: number, acknowledgment: unknown): ReturnType<AgentLifecycleService['acknowledge']>;
  validateExecution(owner: string, intentId: string, expectedVersion: number, phase: string): ReturnType<AgentLifecycleService['validateExecution']>;
  upload(owner: string, envelope: CystEnvelope, idempotencyKey: string): Promise<unknown>;
  download(owner: string, checkpointId: string): Promise<{ metadata: CystMetadata; ciphertext: string }>;
}

/** Explicit owner-side executor. Neither this adapter nor the lifecycle server has a wallet or signs payments. */
export class ClientAgentCoordinator {
  constructor(private readonly control: ClientLifecycleControl, private readonly vault: ClientLifecycleVault,
    private readonly runner: ClientAgentRunner, private readonly applicationSchema: string) {}
  async step(owner: string, agent: string) {
    const current = await this.control.get(owner, agent), intent = current.intent;
    if (!intent || intent.phase === 'done') return { done: true, phase: 'done' as const };
    const operationId = intent.id + ':' + intent.phase;
    await this.control.validateExecution(owner, intent.id, intent.version, intent.phase);
    if (intent.phase === 'checkpoint') {
      if (!intent.sourceRunId) throw new Error('Checkpoint phase requires an active source');
      let checkpoint = await this.vault.getCheckpoint(intent.id);
      if (!checkpoint) {
        const state = await this.runner.checkpoint(intent.sourceRunId, operationId);
        let key: Uint8Array | undefined;
        try {
          key = generateCystRecoveryKey();
          checkpoint = await encryptCheckpoint(state, { owner, agent, applicationSchema: this.applicationSchema }, key);
          try { await this.vault.putCheckpoint(intent.id, checkpoint.envelope, checkpoint.recoveryKey); }
          catch (error) { checkpoint.recoveryKey.fill(0); throw error; }
        } finally { state.fill(0); key?.fill(0); }
      }
      try {
        await this.control.upload(owner, checkpoint.envelope, 'agent-checkpoint-' + intent.id);
        await this.control.acknowledge(owner, intent.id, intent.version, { phase: 'checkpoint',
          checkpointId: checkpoint.envelope.id, checkpointSha256: checkpoint.envelope.sha256 });
      } finally { checkpoint.recoveryKey.fill(0); }
    } else if (intent.phase === 'stop') {
      if (!intent.sourceRunId) throw new Error('Stop phase requires an active source');
      await this.runner.stop(intent.sourceRunId, operationId);
      if (intent.kind === 'kill' && intent.targetRunId && intent.targetRunId !== intent.sourceRunId) {
        await this.runner.stop(intent.targetRunId, operationId + ':target');
      }
      await this.control.acknowledge(owner, intent.id, intent.version, { phase: 'stop' });
    } else if (intent.phase === 'attach') {
      if (!intent.targetRunId) throw new Error('Attach phase requires an approved reservation');
      await this.runner.attach(intent.targetRunId, operationId);
      await this.control.acknowledge(owner, intent.id, intent.version, { phase: 'attach' });
    } else if (intent.phase === 'resume') {
      if (!intent.targetRunId || !intent.checkpointId || intent.targetMode === 'cyst') throw new Error('Resume phase requires a checkpoint and live target mode');
      const key = await this.vault.recoveryKey(intent.checkpointId);
      let state: Uint8Array | undefined;
      try {
        const downloaded = await this.control.download(owner, intent.checkpointId);
        if (downloaded.metadata.owner !== owner.toLowerCase() || downloaded.metadata.agent !== agent.toLowerCase()
          || downloaded.metadata.id !== intent.checkpointId || intent.checkpointSha256 !== null && downloaded.metadata.sha256 !== intent.checkpointSha256) {
          throw new Error('Downloaded checkpoint differs from the durable transition (agent_checkpoint_scope_mismatch).');
        }
        state = await decryptCheckpoint(lifecycleCheckpointEnvelope(downloaded), key);
        await this.runner.resume(intent.targetRunId, state, intent.targetMode, operationId);
        await this.control.acknowledge(owner, intent.id, intent.version, { phase: 'resume' });
      } finally { key.fill(0); state?.fill(0); }
    } else {
      if (!intent.sourceRunId || intent.targetMode === 'cyst') throw new Error('Profile phase requires an active run');
      await this.runner.profile(intent.sourceRunId, intent.targetMode, operationId);
      await this.control.acknowledge(owner, intent.id, intent.version, { phase: 'profile' });
    }
    const refreshed = await this.control.get(owner, agent);
    return { done: refreshed.intent === null, phase: refreshed.intent?.phase ?? 'done' };
  }
  async finish(owner: string, agent: string) {
    for (let index = 0; index < 8; index++) if ((await this.step(owner, agent)).done) return;
    throw new Error('Lifecycle transition exceeded its bounded number of steps');
  }
}
