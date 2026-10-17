import { cystAddressSchema, cystHeaderSchema } from '../cysts/types.js';
import { ClientAgentCoordinator, type ClientAgentRunner } from './client.js';
import { ClientLifeline, type ClientLifelineControl } from './lifeline.js';
import type { PaidLifecycleClientVault } from './paid-lifecycle-runner.js';
import { PAID_AGENT_POLICY, type AgentMode } from './types.js';

type State = Awaited<ReturnType<ClientLifelineControl['get']>>;
export type PaidLifelineIntent = NonNullable<State['intent']>;
export type PaidLifelineResult = Awaited<ReturnType<ClientLifeline['tick']>>;

/** Owner-side continuous logical lifespan over separately approved bounded leases.
 * The controller has no recovery keys and this loop has no wallet signer.
 * A runner is constructed for each immutable intent, including after restart.
 */
export class PaidAgentLifeline {
  private readonly owner: string;
  private readonly agent: string;
  private readonly control: ClientLifelineControl;
  private readonly lifeline: ClientLifeline;
  private readonly pollMs: number;
  private readonly checkpointCadence: { tick(): Promise<unknown> } | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onStatus: ((result: PaidLifelineResult) => void) | undefined;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<PaidLifelineResult> | undefined;

  constructor(options: { owner: string; agent: string; applicationSchema: string;
    control: ClientLifelineControl; vault: PaidLifecycleClientVault;
    /** Must return a runner bound to this original intent and durable owner vault. */
    runner: (intent: PaidLifelineIntent) => Promise<ClientAgentRunner>;
    /** Already funded reservations only. Any optional funding adapter must have its own durable wallet journal. */
    approvedTarget: (owner: string, agent: string, mode?: Exclude<AgentMode, 'cyst'>) => Promise<string | undefined>;
    checkpointCadence?: { tick(): Promise<unknown> };
    metabolismVersion?: 2;
    pollMs?: number; onError?: (error: unknown) => void; onStatus?: (result: PaidLifelineResult) => void }) {
    this.owner = cystAddressSchema.parse(options.owner); this.agent = cystAddressSchema.parse(options.agent);
    const applicationSchema = cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    if (options.vault.scope.owner !== this.owner || options.vault.scope.agent !== this.agent
      || options.vault.scope.applicationSchema !== applicationSchema) throw new Error('Paid Lifeline private vault scope changed');
    this.control = options.control;
    this.pollMs = options.pollMs ?? 5000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1000 || this.pollMs > 15_000) {
      throw new Error('Paid Lifeline must poll before the thirty-second rollover window');
    }
    this.checkpointCadence = options.checkpointCadence; this.onError = options.onError; this.onStatus = options.onStatus;
    // No in-memory intent cache: a restarted process reconstructs the same
    // immutable runner from control state and its encrypted durable journal.
    const runner = async (operationId: string) => {
      const state = await this.checkedState(), intent = state.intent;
      if (!intent || !(operationId === intent.id + ':' + intent.phase
        || intent.kind === 'kill' && operationId === intent.id + ':stop:target')) {
        throw new Error('Paid Lifeline operation does not belong to the current original intent');
      }
      return options.runner(intent);
    };
    const adapter: ClientAgentRunner = {
      checkpoint: async (run, op) => (await runner(op)).checkpoint(run, op),
      stop: async (run, op) => (await runner(op)).stop(run, op),
      attach: async (run, op) => (await runner(op)).attach(run, op),
      resume: async (run, state, mode, op) => (await runner(op)).resume(run, state, mode, op),
      profile: async (run, mode, op) => (await runner(op)).profile(run, mode, op),
    };
    const coordinator = new ClientAgentCoordinator(options.control, options.vault, adapter, applicationSchema);
    this.lifeline = new ClientLifeline(options.control, coordinator, options.approvedTarget,
      options.metabolismVersion === 2 ? { metabolismVersion: 2 } : {});
  }

  private async checkedState(): Promise<State> {
    const state = await this.control.get(this.owner, this.agent);
    if (state.agent.owner !== this.owner || state.agent.agent !== this.agent
      || state.policy.maximumLeaseSeconds !== PAID_AGENT_POLICY.maximumLeaseSeconds
      || state.policy.rollBeforeSeconds !== PAID_AGENT_POLICY.rollBeforeSeconds
      || state.intent && (state.intent.owner !== this.owner || state.intent.agent !== this.agent)) {
      throw new Error('Paid Lifeline registration, owner or bounded lease policy changed');
    }
    return state;
  }

  /** Coalesces local polls. Durable API/runner operations supply crash recovery. */
  tick(): Promise<PaidLifelineResult> {
    if (this.flight) return this.flight;
    const flight = (async () => {
      await this.checkedState();
      const result = await this.lifeline.tick(this.owner, this.agent);
      // Lifecycle first: a due rollover or sleep must finish before a cadence capture.
      if (result.status === 'idle') await this.checkpointCadence?.tick();
      return result;
    })().finally(() => { if (this.flight === flight) this.flight = undefined; });
    this.flight = flight; return flight;
  }

  private async cycle(): Promise<void> {
    try { this.onStatus?.(await this.tick()); }
    catch (error) {
      try { this.onError?.(error); } catch { process.emitWarning('Paid Lifeline error handler failed'); }
    } finally {
      if (this.started) this.timer = setTimeout(() => { void this.cycle(); }, this.pollMs);
    }
  }
  async start(): Promise<void> {
    if (this.started) throw new Error('Paid Lifeline already started');
    if (!this.onError) throw new Error('Background paid Lifeline requires an error handler');
    this.started = true; await this.cycle();
  }
  /** Awaits an original in-flight operation. It never kills or refuels the agent. */
  async close(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; await this.flight?.catch(() => undefined);
  }
}
