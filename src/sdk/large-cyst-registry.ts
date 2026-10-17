import { timingSafeEqual } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import { cystAddressSchema, cystIdSchema } from '../cysts/types.js';
import { verifyLargeCystManifestKey, type LargeCystStore } from '../cysts/large-checkpoints.js';
import { largeCystRegistryDescriptor, largeCystRegistryPlanSchema } from '../cysts/large-registry.js';
import { cystRegistryAbi, cystRegistryHashSchema, cystRegistryPinsSchema,
  cystRegistrySnapshotSchema, type CystRegistryReader } from '../cysts/registry-types.js';
import { unwrapCystRecoveryKey, type CystWrappingIdentity } from './cyst-key-wrap.js';

/** Independent agent-side acceptance. Invoke immediately before asking the
 * wallet to sign; this function never signs or broadcasts a transaction.
 */
export async function checkedLargeCystCommitPlan(options: { plan: unknown; agentWallet: string;
  agentId: string; checkpointId: string; recoveryKey: Uint8Array;
  agentIdentity?: CystWrappingIdentity;
  manifestStore: Pick<LargeCystStore, 'manifest'>; reader: CystRegistryReader }) {
  const plan = largeCystRegistryPlanSchema.parse(options.plan);
  const agentWallet = cystAddressSchema.parse(options.agentWallet);
  const agentId = cystRegistryHashSchema.parse(options.agentId);
  const checkpointId = cystIdSchema.parse(options.checkpointId);
  const pins = cystRegistryPinsSchema.parse(options.reader.pins);
  if (plan.binding.agentId !== agentId || plan.binding.agentWallet.toLowerCase() !== agentWallet
    || plan.checkpoint.id !== checkpointId || plan.transaction.from.toLowerCase() !== agentWallet
    || plan.transaction.to !== pins.registryAddress || plan.transaction.chainId !== pins.chainId
    || plan.transaction.value !== '0') throw new Error('Publication plan differs from the agent or reviewed deployment');
  const raw = await options.manifestStore.manifest(checkpointId);
  if (!raw) throw new Error('Original large checkpoint manifest is unavailable');
  const manifest = verifyLargeCystManifestKey(raw, options.recoveryKey,
    { id: checkpointId, owner: plan.binding.owner, agent: agentWallet });
  if (manifest.wrappedKey) {
    if (!options.agentIdentity) throw new Error('The agent wrapping identity is required for this checkpoint');
    const agentKey = await unwrapCystRecoveryKey(manifest.wrappedKey,
      { owner: plan.binding.owner, agent: agentWallet, checkpointId }, 'agent', options.agentIdentity);
    try {
      if (!timingSafeEqual(agentKey, options.recoveryKey)) {
        throw new Error('The agent wrap differs from the authenticated checkpoint key');
      }
    } finally { agentKey.fill(0); }
  }
  if (JSON.stringify(largeCystRegistryDescriptor(manifest)) !== JSON.stringify(plan.checkpoint)) {
    throw new Error('Publication plan differs from the original authenticated manifest');
  }
  await options.reader.check();
  const snapshot = cystRegistrySnapshotSchema.parse(await options.reader.snapshot(agentId));
  if (snapshot.binding.status === 3 || snapshot.binding.agentId !== agentId
    || JSON.stringify(snapshot.binding) !== JSON.stringify(plan.binding)
    || JSON.stringify({ ...snapshot.current, block: undefined }) !== JSON.stringify({ ...plan.current, block: undefined })) {
    throw new Error('Publication plan differs from the current canonical registry state');
  }
  const data = encodeFunctionData({ abi: cystRegistryAbi, functionName: 'commitChecked', args: [
    agentId, plan.checkpoint.cystHash, BigInt(plan.checkpoint.sizeBytes), plan.checkpoint.storageRef,
    BigInt(plan.current.revision),
  ] });
  if (data !== plan.transaction.data) throw new Error('Publication calldata differs from the reviewed commit method');
  return plan.transaction;
}
