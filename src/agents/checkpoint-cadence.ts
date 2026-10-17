import { createHash } from 'node:crypto';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema } from '../cysts/types.js';
import { CystCheckpointCoordinator, DEFAULT_CYST_CHECKPOINT_INTERVAL_MS,
  type CystCheckpointResult, type CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import type { CystClient } from '../sdk/cysts.js';
import type { ClientAgentRunner, ClientLifecycleControl } from './client.js';

export type RegisteredCheckpointResult = CystCheckpointResult | { status: 'inactive' | 'transition_pending' };

/** Runs on the owner's client, where the application snapshot hook and private vault exist.
 * One instance follows the registered agent across run changes. A distinct
 * run-bound vault scope prevents replaying an incomplete capture on a new Cell.
 */
export class RegisteredAgentCheckpointCadence {
  private readonly owner: string;
  private readonly agent: string;
  private readonly applicationSchema: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly cysts: CystClient;
  private readonly vault: CystCheckpointVault;
  private readonly control: Pick<ClientLifecycleControl, 'get'>;
  private readonly runner: Pick<ClientAgentRunner, 'checkpoint'>;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<RegisteredCheckpointResult> | undefined;
  private started = false;

  constructor(options: { owner: string; agent: string; applicationSchema: string; cysts: CystClient;
    vault: CystCheckpointVault; control: Pick<ClientLifecycleControl, 'get'>;
    runner: Pick<ClientAgentRunner, 'checkpoint'>; intervalMs?: number; now?: () => number;
    /** Required for the background loop. Must not throw. */ onError?: (error: unknown) => void }) {
    this.owner = cystAddressSchema.parse(options.owner);
    this.agent = cystAddressSchema.parse(options.agent);
    this.applicationSchema = cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    this.intervalMs = options.intervalMs ?? DEFAULT_CYST_CHECKPOINT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1000 || this.intervalMs > 86_400_000) {
      throw new Error('Checkpoint interval must be between one second and 24 hours');
    }
    if (!options.cysts || !options.vault || !options.control || !options.runner
      || typeof options.control.get !== 'function' || typeof options.runner.checkpoint !== 'function') {
      throw new Error('Supply authenticated lifecycle/Cyst clients, a private vault and a checkpoint-capable runner');
    }
    this.cysts = options.cysts;
    this.vault = options.vault;
    this.control = options.control;
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  private async activeRun(): Promise<{ runId: string | null; pending: boolean }> {
    const { agent, intent } = await this.control.get(this.owner, this.agent);
    if (agent.owner !== this.owner || agent.agent !== this.agent
      || intent && (intent.owner !== this.owner || intent.agent !== this.agent)) {
      throw new Error('Registered agent response changed owner or agent scope');
    }
    if (agent.killedAt || !agent.currentRunId || agent.mode === 'cyst') return { runId: null, pending: false };
    const runId = cystIdSchema.parse(agent.currentRunId);
    return { runId, pending: intent !== null };
  }

  private coordinator(runId: string): CystCheckpointCoordinator {
    // The 240-bit digest binds both the application schema and exact source run
    // within the Cyst 64-character applicationSchema limit.
    const applicationSchema = 'run.' + createHash('sha256')
      .update(JSON.stringify(['telomere.registered-agent-checkpoint', this.applicationSchema, runId]))
      .digest('hex').slice(0, 60);
    return new CystCheckpointCoordinator({ owner: this.owner, agent: this.agent, applicationSchema,
      cysts: this.cysts, vault: this.vault, intervalMs: this.intervalMs, now: this.now,
      onCyst: async ({ operationId }) => {
        const current = await this.activeRun();
        if (current.runId !== runId || current.pending) throw new Error('Registered source run changed before checkpoint capture');
        // The runner must serialize capture with lifecycle stop/migrate and
        // persist its operationId result for an incomplete durable begin.
        return this.runner.checkpoint(runId, operationId);
      } });
  }

  /** Check current registration; an inactive or transitioning Cell is not captured. */
  tick(): Promise<RegisteredCheckpointResult> {
    if (this.flight) return this.flight;
    const flight = (async (): Promise<RegisteredCheckpointResult> => {
      const current = await this.activeRun();
      if (!current.runId) return { status: 'inactive' };
      if (current.pending) return { status: 'transition_pending' };
      return this.coordinator(current.runId).tick();
    })().finally(() => { if (this.flight === flight) this.flight = undefined; });
    this.flight = flight;
    return flight;
  }

  /** Restore a specific historical run's latest completed application state. */
  restoreLatest(runId: string): Promise<Uint8Array> {
    return this.coordinator(cystIdSchema.parse(runId)).restoreLatest();
  }

  private arm(result?: RegisteredCheckpointResult): void {
    if (!this.started) return;
    const pollMs = Math.min(this.intervalMs, 30_000);
    const delay = result && result.status !== 'paused' && 'nextDueAtMs' in result
      ? Math.max(1, Math.min(pollMs, result.nextDueAtMs - this.now())) : pollMs;
    this.timer = setTimeout(() => { void this.cycle(); }, delay);
  }

  private async cycle(): Promise<void> {
    let result: RegisteredCheckpointResult | undefined;
    try { result = await this.tick(); }
    catch (error) {
      // The owner must provide an error sink; a transient failed upload stays
      // pending in the durable coordinator and the next cycle retries it.
      try { this.onError?.(error); }
      catch { process.emitWarning('Registered checkpoint cadence error handler failed'); }
    } finally { this.arm(result); }
  }

  /** Start the live timer with an immediate registration/due check. */
  async start(): Promise<void> {
    if (this.started) throw new Error('Checkpoint cadence already started');
    if (!this.onError) throw new Error('Background checkpoint cadence requires an error handler');
    this.started = true;
    await this.cycle();
  }

  /** Stop scheduling and await an in-flight capture/upload before closing the vault. */
  async close(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flight?.catch(() => undefined);
  }
}
