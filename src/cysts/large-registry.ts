import { createHash } from 'node:crypto';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { Problem } from '../common.js';
import { LARGE_CYST_MAX_PACKAGE_BYTES, parseLargeCystManifest,
  type LargeCystStore } from './large-checkpoints.js';
import { CystRegistryUnknownAgentError } from './registry-reader.js';
import { cystRegistryAbi, cystRegistryBindingSchema, cystRegistryHashSchema,
  cystRegistryPinsSchema, cystRegistrySnapshotSchema, cystRegistryStateSchema,
  cystRegistryTransactionSchema, type CystRegistryReader,
  type CystRegistryState } from './registry-types.js';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema } from './types.js';

/** Only a store capable of independently checking every required copy may publish a plan. */
export type DurableLargeCystStore = LargeCystStore & { isDurable(id: string, signal?: AbortSignal): Promise<boolean> };

export const largeCystRegistryDescriptorSchema = z.object({
  version: z.literal(1), format: z.literal('telomere-large-cyst-manifest-v1'),
  id: cystIdSchema, owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema,
  manifestSha256: cystRegistryHashSchema, cystHash: cystRegistryHashSchema,
  sizeBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PACKAGE_BYTES),
  storageRef: cystRegistryHashSchema,
}).strict();
export type LargeCystRegistryDescriptor = z.infer<typeof largeCystRegistryDescriptorSchema>;
export const largeCystRegistryPlanSchema = z.object({
  binding: cystRegistryBindingSchema, checkpoint: largeCystRegistryDescriptorSchema,
  current: cystRegistryStateSchema, transaction: cystRegistryTransactionSchema,
}).strict();
export const largeCystRegistryVerificationSchema = z.object({
  binding: cystRegistryBindingSchema, checkpoint: largeCystRegistryDescriptorSchema,
  current: cystRegistryStateSchema, matches: z.boolean(),
}).strict();

/** A versioned commitment to the canonical manifest and every part SHA-256 within it.
 * The store's isDurable check independently reads and hashes all required part copies.
 * This is not a SHA-256 of concatenated ciphertext bytes and is deliberately distinct
 * from the small-Cyst registry format.
 */
export function largeCystRegistryDescriptor(raw: unknown): LargeCystRegistryDescriptor {
  const manifest = parseLargeCystManifest(raw);
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const headerBytes = Buffer.byteLength(JSON.stringify(manifest.header));
  const sizeBytes = manifest.parts.reduce((sum, part) => sum + part.bytes, bytes.length + headerBytes);
  if (sizeBytes > LARGE_CYST_MAX_PACKAGE_BYTES) throw new Error('Large Cyst ciphertext package exceeds the registry cap');
  const manifestSha256 = `0x${createHash('sha256').update(bytes).digest('hex')}` as Hex;
  const cystHash = `0x${createHash('sha256').update('telomere.large-cyst.registry.v1\0').update(bytes).digest('hex')}` as Hex;
  const { id, owner, agent, applicationSchema } = manifest.header;
  const storageRef = keccak256(toHex(JSON.stringify(['telomere.cyst.large.locator', 1,
    id, owner, agent, applicationSchema, manifestSha256, sizeBytes])));
  return largeCystRegistryDescriptorSchema.parse({ version: 1, format: 'telomere-large-cyst-manifest-v1',
    id, owner, agent, applicationSchema, manifestSha256, cystHash, sizeBytes, storageRef });
}

export function largeCystRegistryMatches(current: CystRegistryState, checkpoint: LargeCystRegistryDescriptor): boolean {
  const state = cystRegistryStateSchema.parse(current), item = largeCystRegistryDescriptorSchema.parse(checkpoint);
  return BigInt(state.revision) > 0n && !state.retired && state.cystHash === item.cystHash
    && state.sizeBytes === String(item.sizeBytes) && state.storageRef === item.storageRef;
}

/** Internal, unsigned large-file publication boundary. No public route or wallet is attached. */
export class LargeCystRegistryPlanner {
  private readonly pins;
  constructor(private readonly storage: DurableLargeCystStore, private readonly reader: CystRegistryReader) {
    if (!storage || typeof storage.isDurable !== 'function') throw new Error('A checked two-copy large Cyst store is required');
    this.pins = cystRegistryPinsSchema.parse(reader.pins);
  }

  private async snapshot(agentId: string) {
    try {
      const value = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(agentId));
      if (value.binding.agentId !== agentId || value.current.agentId !== agentId) {
        throw new Error('Cyst registry identity changed');
      }
      return value;
    } catch (error) {
      if (error instanceof CystRegistryUnknownAgentError) {
        throw new Problem(404, 'cyst_agent_not_found', 'The agent is not registered.');
      }
      throw error;
    }
  }

  private async checked(principalValue: string, agentIdValue: string, checkpointIdValue: string,
    agentOnly: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const principal = cystAddressSchema.parse(principalValue);
    const agentId = cystRegistryHashSchema.parse(agentIdValue);
    const checkpointId = cystIdSchema.parse(checkpointIdValue);
    if (JSON.stringify(cystRegistryPinsSchema.parse(this.reader.pins)) !== JSON.stringify(this.pins)) {
      throw new Error('Cyst registry reader differs from the reviewed deployment pins');
    }
    await this.reader.check();
    signal?.throwIfAborted();
    const before = await this.snapshot(agentId);
    signal?.throwIfAborted();
    if (principal !== before.binding.agentWallet.toLowerCase()
      && (agentOnly || principal !== before.binding.owner.toLowerCase())) {
      throw new Problem(403, 'cyst_agent_forbidden', 'The registered agent key is required for a commit plan.');
    }
    if (agentOnly && before.binding.status === 3) {
      throw new Problem(409, 'cyst_agent_dead', 'A dead Selection agent cannot publish a new checkpoint.');
    }
    const initial = await this.storage.manifest(checkpointId, signal);
    signal?.throwIfAborted();
    if (!initial) throw new Problem(409, 'cyst_pending', 'The large checkpoint is not committed.');
    const checkpoint = largeCystRegistryDescriptor(initial);
    if (checkpoint.owner !== before.binding.owner.toLowerCase()
      || checkpoint.agent !== before.binding.agentWallet.toLowerCase()) {
      throw new Problem(404, 'cyst_not_found', 'The checkpoint is unavailable for this registered agent.');
    }
    if (!await this.storage.isDurable(checkpointId, signal)) {
      throw new Problem(409, 'cyst_not_durable', 'Both large checkpoint copies must be verified before publication.');
    }
    signal?.throwIfAborted();
    const confirmed = await this.storage.manifest(checkpointId, signal);
    signal?.throwIfAborted();
    if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(initial)) {
      throw new Error('Large checkpoint manifest changed during the durability check');
    }
    const after = await this.snapshot(agentId);
    signal?.throwIfAborted();
    // Each RPC snapshot independently establishes a canonical block. A new
    // otherwise unrelated block during a multi-GiB audit is normal; only the
    // Selection binding or registry state may invalidate the unsigned plan.
    const beforeState = { ...before.current, block: undefined };
    const afterState = { ...after.current, block: undefined };
    if (JSON.stringify(after.binding) !== JSON.stringify(before.binding)
      || JSON.stringify(afterState) !== JSON.stringify(beforeState)) {
      throw new Problem(409, 'cyst_revision_changed', 'The canonical registry state changed while preparing the checkpoint.');
    }
    return { checkpoint, snapshot: after };
  }

  async commitPlan(principal: string, agentId: string, checkpointId: string, signal?: AbortSignal) {
    const { checkpoint, snapshot } = await this.checked(principal, agentId, checkpointId, true, signal);
    if (BigInt(snapshot.current.revision) === 2n ** 64n - 1n) {
      throw new Problem(409, 'cyst_revision_exhausted', 'Checkpoint revision requires review.');
    }
    const transaction = cystRegistryTransactionSchema.parse({ chainId: this.pins.chainId,
      from: snapshot.binding.agentWallet, to: this.pins.registryAddress, value: '0',
      data: encodeFunctionData({ abi: cystRegistryAbi, functionName: 'commitChecked', args: [
        snapshot.binding.agentId, checkpoint.cystHash, BigInt(checkpoint.sizeBytes), checkpoint.storageRef,
        BigInt(snapshot.current.revision),
      ] }),
    });
    return largeCystRegistryPlanSchema.parse({ binding: snapshot.binding, checkpoint,
      current: snapshot.current, transaction });
  }

  async verify(principal: string, agentId: string, checkpointId: string, signal?: AbortSignal) {
    const { checkpoint, snapshot } = await this.checked(principal, agentId, checkpointId, false, signal);
    return largeCystRegistryVerificationSchema.parse({ binding: snapshot.binding, checkpoint,
      current: snapshot.current, matches: largeCystRegistryMatches(snapshot.current, checkpoint) });
  }
}
