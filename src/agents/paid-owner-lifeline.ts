import { canonical } from '../common.js';
import { cystAddressSchema } from '../cysts/types.js';
import { cystCapabilitiesV2Schema } from '../cysts/quota-types.js';
import type { DurableVaultCompute } from '../integrations/durable-vault-compute.js';
import type { CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import type { CystClient } from '../sdk/cysts.js';
import { RegisteredAgentCheckpointCadence } from './checkpoint-cadence.js';
import type { ClientLifelineControl } from './lifeline.js';
import type { HttpAgentLifecycleControl } from './http-client.js';
import { PaidAgentLifecycleRunnerV2, type PaidAgentLifecycleRunnerV2Options } from './paid-lifecycle-runner-v2.js';
import { PaidLifecycleClientVaultV3 } from './paid-lifecycle-vault-v3.js';
import { PaidAgentLifeline, type PaidLifelineResult } from './paid-lifeline.js';
import { PaidLifelineReservations, type PaidLifelineFundingPolicy, type PaidLifelineFundingPort } from './paid-lifeline-reservations.js';
import { PaidSessionCheckpointRunner } from './paid-session-checkpoint.js';

type Runner = Omit<PaidAgentLifecycleRunnerV2Options, 'intentId' | 'kind' | 'targetMode' | 'sourceRunId' | 'targetRunId' | 'control' | 'vault'>;

/** Reference owner process composition. All keys, journals, checked clients and
 * narrowly approved external wallet ports are supplied by the owner process.
 * The API/controller never receives the recovery keys or a wallet signer. */
export function createPaidOwnerLifeline(options: { runner: Runner;
  control: ClientLifelineControl & Pick<HttpAgentLifecycleControl, 'checkpointQuotaVersion' | 'checkpointStorage'>;
  lifecycleVault: PaidLifecycleClientVaultV3; compute: DurableVaultCompute;
  funding: { policy: PaidLifelineFundingPolicy; journal: PaidLifecycleClientVaultV3; wallet: PaidLifelineFundingPort;
    nowSeconds?: () => number };
  cadence: { cysts: CystClient; journal: CystCheckpointVault; intervalMs?: number; now?: () => number };
  pollMs?: number; onError?: (error: unknown) => void; onStatus?: (result: PaidLifelineResult) => void }) {
  const { applicationSchema, client, checkpointArgvPrefix } = options.runner;
  const owner = cystAddressSchema.parse(options.runner.owner), agent = cystAddressSchema.parse(options.runner.agent);
  if (canonical(options.lifecycleVault.scope) !== canonical({ owner, agent, applicationSchema })
    || options.lifecycleVault.policy.version !== 3 || options.funding.journal.policy.version !== 3) {
    throw new Error('Continuous owner Lifeline requires explicitly reviewed v3 private journals');
  }
  if (options.control.checkpointQuotaVersion !== 2 || options.cadence.cysts.quotaVersion !== 2) {
    throw new Error('Continuous owner Lifeline requires explicit quota2 for both lifecycle and cadence uploads');
  }
  const canFund = async () => {
    const statuses = await Promise.all([options.control.checkpointStorage(), options.cadence.cysts.list()]);
    return statuses.every(status => {
      const caps = cystCapabilitiesV2Schema.parse(status.capabilities);
      return caps.maxOwnerCheckpoints - status.usage.checkpoints >= 4 && caps.maxOwnerBytes - status.usage.bytes >= 4 * (4096 + 16);
    });
  };
  const reservations = new PaidLifelineReservations({ ...options.funding, compute: options.compute, control: options.control, canFund });
  if (reservations.policy.owner !== owner || reservations.policy.agent !== agent
    || reservations.policy.imageDigest !== options.runner.imageDigest) throw new Error('Owner Lifeline funding and application scope changed');
  const cadence = new RegisteredAgentCheckpointCadence({ owner, agent, applicationSchema, control: options.control,
    cysts: options.cadence.cysts, vault: options.cadence.journal,
    runner: new PaidSessionCheckpointRunner({ client, argvPrefix: checkpointArgvPrefix, maxBytes: 4096 }),
    ...(options.cadence.intervalMs === undefined ? {} : { intervalMs: options.cadence.intervalMs }),
    ...(options.cadence.now === undefined ? {} : { now: options.cadence.now }) });
  const lifeline = new PaidAgentLifeline({ owner, agent, applicationSchema, control: options.control,
    vault: options.lifecycleVault, metabolismVersion: 2, checkpointCadence: cadence,
    approvedTarget: (targetOwner, targetAgent, mode) => reservations.approvedTarget(targetOwner, targetAgent, mode),
    runner: async intent => new PaidAgentLifecycleRunnerV2({ ...options.runner, owner, agent, control: options.control, vault: options.lifecycleVault,
      intentId: intent.id, kind: intent.kind, targetMode: intent.targetMode,
      sourceRunId: intent.sourceRunId, targetRunId: intent.targetRunId }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }) });
  return { lifeline, reservations, cadence };
}
