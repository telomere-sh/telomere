import { ClientAgentCoordinator, type ClientAgentRunner, type ClientLifecycleControl, type ClientLifecycleVault } from '../../agents/client.js';
import type { InterruptibleService } from './service.js';
import { Problem } from '../../common.js';
import { TelomereApiError } from '../../sdk/transport.js';

export interface InterruptibleClientControl {
  get: InterruptibleService['get']; advance: InterruptibleService['advance']; validateClientStep: InterruptibleService['validateClientStep'];
}
/** Owner-side encrypted checkpoint runner; guard every lifecycle phase before any executor effect. */
export class InterruptibleClientCoordinator {
  constructor(private readonly scheduling: InterruptibleClientControl, private readonly lifecycle: ClientLifecycleControl,
    private readonly vault: ClientLifecycleVault, private readonly runner: ClientAgentRunner, private readonly applicationSchema: string) {}
  async step(owner: string, id: string) {
    const progress = await this.scheduling.advance(owner, id);
    if (progress.action !== 'lifecycle') return progress;
    const guarded: ClientLifecycleControl = { ...this.lifecycle,
      get: (...args) => this.lifecycle.get(...args), acknowledge: (...args) => this.lifecycle.acknowledge(...args),
      upload: (...args) => this.lifecycle.upload(...args), download: (...args) => this.lifecycle.download(...args),
      validateExecution: async (authenticatedOwner, intentId, version, phase) => {
        await this.scheduling.validateClientStep(authenticatedOwner, id, intentId, phase);
        return this.lifecycle.validateExecution(authenticatedOwner, intentId, version, phase);
      } };
    const coordinator = new ClientAgentCoordinator(guarded, this.vault, this.runner, this.applicationSchema);
    try { await coordinator.step(owner, progress.run.agent); }
    catch (error) {
      if (!(error instanceof Problem || error instanceof TelomereApiError) || error.code !== 'interruptible_phase_changed') throw error;
    }
    return this.scheduling.advance(owner, id);
  }
  /** A bounded drain returns on missing settlement/host notice; it never busy-waits or creates funds. */
  async finish(owner: string, id: string) {
    for (let index = 0; index < 12; index++) {
      const progress = await this.step(owner, id);
      if (progress.action !== 'lifecycle') return progress;
    }
    throw new Error('Interruptible transition exceeded its bounded number of client steps');
  }
}
