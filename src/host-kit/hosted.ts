import { canonical } from '../common.js';
import { HostKitAgent } from './agent.js';
import { HostAdmissionCoordinator, hostScopeSchema, type HostInventory, type HostScope } from './admission.js';
import { DockerHostRuntime } from './docker-runtime.js';
import { inspectHostInventory } from './docker-inventory.js';
import { HostedSessionManager } from './hosted-sessions.js';
import type { HostJournal } from './journal.js';
import type { HostCellRuntime } from './runtime.js';
import { DockerSessionBackend, dockerSessionBackendIdentity } from './sessions/backends.js';
import type { SessionBackend } from './sessions/types.js';
import type { PaidCystInputSpool } from './sessions/cyst-input-spool.js';

/** Low-level fixture/integration seam. Production constructs both concrete
 * runtimes through createDockerHostedHostKit, deriving their exact scope. */
export function createHostedHostKit(options: { journal: HostJournal; runtime: HostCellRuntime; backend?: SessionBackend;
  controlKey: string; reviewedImages: ReadonlySet<string>; scope: HostScope; inventory: () => Promise<HostInventory>; clock?: () => number }) {
  const admission = new HostAdmissionCoordinator(options.journal, options.runtime, options.backend, options.scope, options.inventory);
  const agent = new HostKitAgent(options.journal, options.runtime, options.controlKey, options.reviewedImages, options.clock ?? Date.now, admission);
  const sessions = new HostedSessionManager(admission, options.reviewedImages);
  return { agent, sessions, admission, initialize: () => agent.initialize(), close: async () => {
    admission.closeAdmission();
    const [sessionClose] = await Promise.allSettled([sessions.close()]);
    const [agentClose] = await Promise.allSettled([agent.close()]);
    if (agentClose.status === 'rejected') throw agentClose.reason;
    if (sessionClose.status === 'rejected') throw sessionClose.reason;
  } };
}
/** Derive the exact persisted admission scope without starting Docker or a
 * HostKit service. Operator restore checks use the same scope as production. */
export function dockerHostScope(options: { hostKey: string; controlKey: string;
  isolation: 'gvisor' | 'kata' | 'docker_development'; socketPath: string; dockerBinary?: string; cystInputIdentity?: string }): HostScope {
  const dockerBinary = options.dockerBinary ?? 'docker';
  if (options.isolation === 'docker_development' && options.cystInputIdentity) throw new Error('Development runtime has no paid file ingress');
  const backendIdentity = options.isolation === 'docker_development' ? undefined : dockerSessionBackendIdentity({
    isolation: options.isolation, socketPath: options.socketPath, dockerBinary, hostKey: options.hostKey,
    ...(options.cystInputIdentity ? { cystInputIdentity: options.cystInputIdentity } : {}),
  });
  return hostScopeSchema.parse({ version: 1, hostKey: options.hostKey, controlKey: options.controlKey,
    isolation: options.isolation, runtime: canonical(['docker-hostkit-v1', options.socketPath, dockerBinary, options.isolation]),
    sessionBackend: backendIdentity ?? null });
}
export function createDockerHostedHostKit(options: { journal: HostJournal; controlKey: string; reviewedImages: ReadonlySet<string>;
  isolation: 'gvisor' | 'kata' | 'docker_development'; socketPath: string; dockerBinary?: string; clock?: () => number;
  cystInputs?: PaidCystInputSpool }) {
  if (options.cystInputs && options.isolation !== 'gvisor' && options.isolation !== 'kata') {
    throw new Error('Declared paid Cyst input requires a reviewed gVisor or Kata backend');
  }
  const dockerBinary = options.dockerBinary ?? 'docker', runtime = new DockerHostRuntime({ isolation: options.isolation, socketPath: options.socketPath, dockerBinary });
  const backend = options.isolation === 'docker_development' ? undefined : new DockerSessionBackend({ isolation: options.isolation,
    socketPath: options.socketPath, dockerBinary, hostKey: options.journal.identity.publicKey,
    ...(options.cystInputs ? { cystInputs: options.cystInputs } : {}) });
  return createHostedHostKit({ journal: options.journal, runtime, ...(backend ? { backend } : {}), controlKey: options.controlKey,
    ...(options.clock ? { clock: options.clock } : {}),
    reviewedImages: options.reviewedImages, scope: dockerHostScope({ hostKey: options.journal.identity.publicKey,
      controlKey: options.controlKey, isolation: options.isolation, socketPath: options.socketPath, dockerBinary,
      ...(options.cystInputs ? { cystInputIdentity: options.cystInputs.identity } : {}) }),
    inventory: () => inspectHostInventory({ hostKey: options.journal.identity.publicKey, socketPath: options.socketPath, dockerBinary }) });
}
