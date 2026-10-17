import type { ClientLifecycleControl } from './client.js';
import { ClientAgentCoordinator } from './client.js';
import type { AgentLifecycleService } from './service.js';
import type { AgentMode } from './types.js';
import { z } from 'zod';

export interface ClientLifelineControl extends ClientLifecycleControl {
  evaluate(owner: string, agent: string, metabolismVersion?: 2): ReturnType<AgentLifecycleService['evaluate']>;
  plan(owner: string, agent: string, value: unknown, idempotencyKey: string): ReturnType<AgentLifecycleService['plan']>;
}
/** The owner explicitly runs this loop on their client. Target selection only returns an already funded reservation. */
export class ClientLifeline {
  private readonly metabolismVersion: 2 | undefined;
  constructor(private readonly control: ClientLifelineControl, private readonly coordinator: ClientAgentCoordinator,
    private readonly approvedTarget: (owner: string, agent: string, mode?: Exclude<AgentMode, 'cyst'>) => Promise<string | undefined>,
    options: { metabolismVersion?: 2 } = {}) {
    this.metabolismVersion = z.literal(2).optional().parse(options.metabolismVersion);
  }
  async tick(owner: string, agent: string): Promise<{ status: 'idle' | 'transition_completed' | 'reservation_required' | 'checkpoint_required' }> {
    const current = await this.control.get(owner, agent);
    if (current.intent) { await this.coordinator.finish(owner, agent); return { status: 'transition_completed' }; }
    if (current.agent.killedAt) return { status: 'idle' };
    const evaluation = await this.control.evaluate(owner, agent, this.metabolismVersion);
    if (this.metabolismVersion === 2 && (!('metabolismVersion' in evaluation) || evaluation.metabolismVersion !== 2)) {
      throw new Error('Current-rate Metabolism cannot downgrade to the trailing-burn policy');
    }
    if (!current.agent.currentRunId && current.agent.wakeAt && !evaluation.scheduledWakeDue) return { status: 'idle' };
    if (current.agent.mode === evaluation.mode && !evaluation.rollDue && !evaluation.scheduledWakeDue) return { status: 'idle' };
    let targetRunId: string | undefined;
    const paidModeChange = current.policy.maximumLeaseSeconds === 120 && !!current.agent.currentRunId && current.agent.mode !== evaluation.mode;
    if (evaluation.mode !== 'cyst' && (!current.agent.currentRunId || evaluation.rollDue || paidModeChange)) {
      if (!current.agent.currentRunId && !current.agent.checkpointId) return { status: 'checkpoint_required' };
      targetRunId = await this.approvedTarget(owner, agent, evaluation.mode);
      if (!targetRunId && !evaluation.rollDue) return { status: 'reservation_required' };
    }
    const planned = await this.control.plan(owner, agent, { action: 'evaluate', expectedVersion: current.agent.version,
      ...(this.metabolismVersion === 2 ? { metabolismVersion: 2 } : {}),
      ...(targetRunId === undefined ? {} : { targetRunId }) }, 'agent-lifeline-' + agent.toLowerCase().slice(2) + '-' + current.agent.version);
    if (this.metabolismVersion === 2 && (planned.intent.metabolismVersion !== 2
      || !planned.evaluation || !('metabolismVersion' in planned.evaluation) || planned.evaluation.metabolismVersion !== 2)) {
      throw new Error('Current-rate Metabolism transition cannot downgrade its original policy');
    }
    await this.coordinator.finish(owner, agent); return { status: 'transition_completed' };
  }
}
