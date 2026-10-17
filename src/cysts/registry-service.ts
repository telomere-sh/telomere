import { Problem } from '../common.js';
import { CYST_CAPABILITIES, cystAddressSchema, cystIdSchema } from './types.js';
import type { CystService } from './service.js';
import { CystRegistryUnknownAgentError } from './registry-reader.js';
import { cystRegistryCommitPreparedSchema, cystRegistryCommitTransaction, cystRegistryConfigSchema,
  cystRegistryDownloadSchema, cystRegistryHashSchema, cystRegistryMatches, cystRegistryPinsSchema, cystRegistryRetirePreparedSchema,
  cystRegistryRetireTransaction, cystRegistrySnapshotSchema, cystRegistryUint64Schema,
  cystRegistryVerificationSchema, type CystRegistryReader, type CystRegistrySnapshot } from './registry-types.js';

export class CystRegistryService {
  readonly pins;
  constructor(private readonly cysts: CystService, private readonly reader: CystRegistryReader) {
    this.pins = Object.freeze(cystRegistryPinsSchema.parse(reader.pins));
  }
  async initialize(): Promise<void> { await this.reader.check(); }
  publicConfig() {
    return cystRegistryConfigSchema.parse({ protocol: 'telomere-cyst-registry-v1', pins: this.pins,
      storageRefVersion: 1, maxCheckpointBytes: CYST_CAPABILITIES.maxCiphertextBytes, maxRegistryBytes: 2_147_483_648 });
  }
  private async snapshot(principal: string, agentId: string, agentOnly = false): Promise<CystRegistrySnapshot> {
    const actor = cystAddressSchema.parse(principal), id = cystRegistryHashSchema.parse(agentId);
    let result: CystRegistrySnapshot;
    try { result = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(id)); }
    catch (error) {
      if (error instanceof CystRegistryUnknownAgentError) throw new Problem(404, 'cyst_agent_not_found', 'The agent is not registered.');
      throw error;
    }
    if (result.binding.agentId !== id || result.current.agentId !== id) throw new Error('Cyst registry reader changed requested identity');
    if (actor !== result.binding.agentWallet.toLowerCase()
      && (agentOnly || actor !== result.binding.owner.toLowerCase())) {
      throw new Problem(403, 'cyst_agent_forbidden', agentOnly ? 'Only the registered agent key can prepare this transaction.' : 'This agent belongs to another owner.');
    }
    return result;
  }
  private async checkpointBlob(snapshot: CystRegistrySnapshot, checkpointId: string) {
    // Selection authorizes this delegated metadata read. The upload namespace alone does not.
    const value = await this.cysts.download(snapshot.binding.owner, cystIdSchema.parse(checkpointId));
    const checkpoint = value.metadata;
    if (checkpoint.owner !== snapshot.binding.owner.toLowerCase() || checkpoint.agent !== snapshot.binding.agentWallet.toLowerCase()
      || checkpoint.state !== 'ready') throw new Problem(404, 'cyst_not_found', 'The checkpoint is unavailable for this registered agent.');
    return value;
  }
  private async checkpoint(snapshot: CystRegistrySnapshot, checkpointId: string) {
    return (await this.checkpointBlob(snapshot, checkpointId)).metadata;
  }
  async latest(principal: string, agentId: string) { return this.snapshot(principal, agentId); }
  async commitPlan(principal: string, agentId: string, checkpointId: string) {
    const original = await this.snapshot(principal, agentId, true);
    const checkpoint = await this.checkpoint(original, checkpointId);
    const snapshot = await this.snapshot(principal, agentId, true);
    if (snapshot.binding.owner !== original.binding.owner || snapshot.binding.agentWallet !== original.binding.agentWallet) {
      throw new Problem(409, 'cyst_agent_changed', 'The registered owner or agent key changed.');
    }
    if (snapshot.binding.status === 3) throw new Problem(409, 'cyst_agent_dead', 'A dead Selection agent cannot publish a new checkpoint.');
    if (BigInt(snapshot.current.revision) === 2n ** 64n - 1n) throw new Problem(409, 'cyst_revision_exhausted', 'Checkpoint revision requires review.');
    return cystRegistryCommitPreparedSchema.parse({ ...snapshot, checkpoint,
      transaction: cystRegistryCommitTransaction(this.pins, snapshot.binding, checkpoint, snapshot.current.revision) });
  }
  async retirePlan(principal: string, agentId: string, value: string) {
    const revision = cystRegistryUint64Schema.parse(value), snapshot = await this.snapshot(principal, agentId, true);
    if (snapshot.current.revision !== revision) throw new Problem(409, 'cyst_revision_changed', 'Review the current checkpoint revision before retirement.');
    if (revision === '0' || snapshot.current.retired) throw new Problem(409, 'cyst_not_live', 'The agent has no live checkpoint to retire.');
    if (BigInt(revision) === 2n ** 64n - 1n) throw new Problem(409, 'cyst_revision_exhausted', 'Checkpoint revision requires review.');
    return cystRegistryRetirePreparedSchema.parse({ ...snapshot,
      transaction: cystRegistryRetireTransaction(this.pins, snapshot.binding, revision) });
  }
  async verify(principal: string, agentId: string, checkpointId: string) {
    const original = await this.snapshot(principal, agentId), checkpoint = await this.checkpoint(original, checkpointId);
    const snapshot = await this.snapshot(principal, agentId);
    if (snapshot.binding.owner !== original.binding.owner || snapshot.binding.agentWallet !== original.binding.agentWallet) {
      throw new Problem(409, 'cyst_agent_changed', 'The registered owner or agent key changed.');
    }
    return cystRegistryVerificationSchema.parse({ ...snapshot, checkpoint, matches: cystRegistryMatches(snapshot.current, checkpoint) });
  }
  async download(principal: string, agentId: string, checkpointId: string) {
    const original = await this.snapshot(principal, agentId), blob = await this.checkpointBlob(original, checkpointId);
    const snapshot = await this.snapshot(principal, agentId);
    if (snapshot.binding.owner !== original.binding.owner || snapshot.binding.agentWallet !== original.binding.agentWallet) {
      throw new Problem(409, 'cyst_agent_changed', 'The registered owner or agent key changed.');
    }
    if (!cystRegistryMatches(snapshot.current, blob.metadata)) {
      throw new Problem(409, 'cyst_not_current', 'Only the current published live checkpoint is available through this agent route.');
    }
    return cystRegistryDownloadSchema.parse({ ...snapshot, checkpoint: blob.metadata, ciphertext: blob.ciphertext });
  }
}
