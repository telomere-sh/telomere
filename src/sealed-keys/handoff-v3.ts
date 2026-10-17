import { createHash, createPublicKey } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { hashJson } from '../common.js';
import { cystRegistryMatches, cystRegistrySnapshotSchema, type CystRegistryReader } from '../cysts/registry-types.js';
import type { CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import type { CystMetadata } from '../cysts/types.js';
import { SealedHandoffJournalV3 } from './journal-v3.js';
import { openSealedCystKey, releaseCystKeyToSealedCell, sealedCellReportData,
  type SealedCellEvidenceCollector, type SealedCystKeyRequest } from './release.js';
import { createSignedCellAppraiserVerifier, sealedCellMeasurementDigest, type SignedCellAppraiserConfig } from './signed-appraiser.js';
import { ownerSignatureSchema, sealedAudienceV3, sealedBindingV3, sealedContextV3Schema, sealedEnvelopeV3Schema,
  sealedHash, sealedIntentTypedData, sealedPacketTypedData, sealedPacketV2Schema, sealedPolicyV3Schema, sealedScopeV3,
  type SealedContextV3, type SealedEntryV3, type SealedEnvelopeV3, type SealedJournalV3State, type SealedPolicyV3 } from './protocol-v3.js';

export function sealedAppraiserKeyFingerprint(pem: string) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use a pinned Ed25519 appraiser key');
  return sealedHash.parse('0x' + createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'));
}
type Environment = { policy: SealedPolicyV3; registry: CystRegistryReader; journal: SealedHandoffJournalV3; now?: () => number };
export async function activateSealedPolicyV3(options: Environment, role: 'owner' | 'recipient'): Promise<void> {
  const policy = installed(options, role); await current(options, policy);
  await options.journal.transact(state => { fresh(policy, (options.now ?? Date.now)()); floor(state, policy); });
}
function installed(options: Environment, role: 'owner' | 'recipient') {
  const policy = Object.freeze(sealedPolicyV3Schema.parse(options.policy));
  if (!options.registry || !options.journal || options.journal.role !== role || options.journal.scopeHash !== sealedScopeV3(policy)
    || hashJson(options.registry.pins) !== hashJson(policy.registryPins)) throw new Error('Independently installed sealed policy/registry/journal required');
  return policy;
}
function fresh(policy: SealedPolicyV3, now: number, context?: SealedContextV3): void {
  if (!Number.isSafeInteger(now) || now < policy.notBeforeMs || now >= policy.expiresAtMs || now >= policy.leaseExpiresAtMs
    || context && (hashJson(context.policy) !== hashJson(policy) || now >= context.expiresAtMs || context.createdAtMs > now + 5000)) {
    throw new Error('Sealed policy, lease or release is expired or changed');
  }
}
function floor(state: SealedJournalV3State, policy: SealedPolicyV3): void {
  const digest = hashJson(policy);
  if (state.policyGeneration > policy.generation || state.policyGeneration === policy.generation && state.policyHash !== digest) {
    throw new Error('Sealed policy generation rollback or pin conflict');
  }
  const fence = state.fences.find(item => item.runId === policy.runId);
  if (state.fences.some(item => item.recipientPublicKey === policy.recipientPublicKey
    && (item.runId !== policy.runId || item.bootId !== policy.bootId))) throw new Error('Sealed recipient key cannot cross run/boot contexts');
  if (fence && (fence.epoch > policy.fenceEpoch || fence.epoch === policy.fenceEpoch
    && (fence.bootId !== policy.bootId || fence.recipientPublicKey !== policy.recipientPublicKey))) throw new Error('Sealed boot/recipient fence rollback');
  if (state.retiredRecipients.includes(policy.recipientPublicKey) || state.retiredAppraisers.includes(policy.appraiserKeySha256)) {
    throw new Error('Retired sealed recipient or appraiser key');
  }
  if (state.policyGeneration < policy.generation) {
    if (state.policyTransitions >= 16) throw new Error('Sealed lifetime policy budget exhausted');
    if (!fence && state.fences.length >= 16) throw new Error('Sealed lifetime run-fence capacity exhausted');
    if (state.activeRecipient && state.activeRecipient !== policy.recipientPublicKey) state.retiredRecipients.push(state.activeRecipient);
    if (state.activeAppraiser && state.activeAppraiser !== policy.appraiserKeySha256) state.retiredAppraisers.push(state.activeAppraiser);
    state.activeRecipient = policy.recipientPublicKey; state.activeAppraiser = policy.appraiserKeySha256;
    state.policyTransitions++; state.policyGeneration = policy.generation; state.policyHash = digest;
    const nextFence = { runId: policy.runId, epoch: policy.fenceEpoch, bootId: policy.bootId, recipientPublicKey: policy.recipientPublicKey };
    if (fence) Object.assign(fence, nextFence); else state.fences.push(nextFence);
  }
}
function entry(state: SealedJournalV3State, id: string): SealedEntryV3 {
  const value = state.entries.find(item => item.context.releaseId === id);
  if (!value) throw new Error('Unknown sealed release'); return value;
}
async function current(options: Environment, policy: SealedPolicyV3, context?: SealedContextV3) {
  fresh(policy, (options.now ?? Date.now)(), context);
  if (hashJson(options.registry.pins) !== hashJson(policy.registryPins)) throw new Error('Sealed registry pins changed');
  await options.registry.check();
  const snapshot = cystRegistrySnapshotSchema.parse(await options.registry.snapshot(policy.agentId));
  const binding = snapshot.binding;
  if (binding.owner.toLowerCase() !== policy.owner || binding.agentWallet.toLowerCase() !== policy.agent || binding.agentId !== policy.agentId
    || binding.vault.toLowerCase() !== policy.vault || binding.status !== 1 || binding.frozen) throw new Error('Canonical sealed owner/agent/Vault binding changed');
  if (context && (!cystRegistryMatches(snapshot.current, context.checkpoint) || snapshot.current.revision !== context.current.revision
    || BigInt(snapshot.current.block.number) < BigInt(context.current.block.number)
    || snapshot.current.block.number === context.current.block.number && snapshot.current.block.hash !== context.current.block.hash)) {
    throw new Error('Current sealed Cyst revision or canonical anchor changed');
  }
  floor(await options.journal.read(), policy);
  fresh(policy, (options.now ?? Date.now)(), context); return snapshot;
}
function requestFor(context: SealedContextV3): SealedCystKeyRequest {
  const p = context.policy;
  return { owner: p.owner, agent: p.agent, applicationSchema: p.applicationSchema,
    checkpointId: context.checkpoint.id, operationId: context.operationId, runId: p.runId, hostId: p.hostId,
    audience: sealedAudienceV3(context), teeMeasurement: p.teeMeasurement, policySha256: p.policySha256,
    recipientPublicKey: p.recipientPublicKey };
}
function packetContext(context: SealedContextV3, raw: unknown) {
  const packet = sealedPacketV2Schema.parse(raw), expected = requestFor(context);
  const { operationId: _operation, ...publicRequest } = expected; void _operation;
  for (const [name, value] of Object.entries(publicRequest)) {
    if (packet[name as keyof typeof publicRequest] !== value) throw new Error('Sealed packet context changed');
  }
  if (packet.reportData !== sealedCellReportData({ ...expected, challenge: packet.challenge })) throw new Error('Sealed packet quote binding changed');
  return packet;
}
async function intentSignature(context: SealedContextV3, raw: string) {
  const signature = ownerSignatureSchema.parse(raw);
  if (!await verifyTypedData({ address: context.policy.owner, ...sealedIntentTypedData(context), signature })) throw new Error('Sealed owner intent signature rejected');
  return signature;
}
function envelope(value: SealedEntryV3): SealedEnvelopeV3 {
  return sealedEnvelopeV3Schema.parse({ version: 3, context: value.context, ownerIntentSignature: value.intentSignature,
    packet: value.packet, ownerPacketSignature: value.packetSignature });
}

/** Owner SDK: externally sign the intent first, then authorize the produced
 * ciphertext. No source key, wallet key or ephemeral agreement secret is stored.
 */
export class SealedCystHandoffOwnerV3 {
  private readonly policy: SealedPolicyV3;
  private readonly verify: ReturnType<typeof createSignedCellAppraiserVerifier>;
  constructor(private readonly options: Environment & { checkpointVault: CystCheckpointVault;
    appraiser: SignedCellAppraiserConfig; collectEvidence: SealedCellEvidenceCollector }) {
    this.policy = installed(options, 'owner');
    if (sealedAppraiserKeyFingerprint(options.appraiser.verifierPublicKeyPem) !== this.policy.appraiserKeySha256
      || sealedCellMeasurementDigest(options.appraiser.approvedMeasurements) !== this.policy.teeMeasurement
      || options.appraiser.policySha256 !== this.policy.policySha256) throw new Error('Installed sealed appraiser pins disagree');
    this.verify = createSignedCellAppraiserVerifier(options.appraiser);
  }
  activatePolicy(): Promise<void> { return activateSealedPolicyV3(this.options, 'owner'); }
  async prepareIntent(releaseId: string, completed: { operationId: string; checkpoint: CystMetadata }) {
    const id = sealedHash.parse(releaseId), policy = this.policy;
    const snapshot = await current(this.options, policy);
    const now = (this.options.now ?? Date.now)();
    const candidate = sealedContextV3Schema.parse({ policy, releaseId: id, operationId: completed.operationId,
      checkpoint: completed.checkpoint, current: snapshot.current, createdAtMs: now,
      expiresAtMs: Math.min(now + 60_000, policy.expiresAtMs, policy.leaseExpiresAtMs) });
    // Public metadata only. Even FileVault.load() authenticates source keys;
    // no checkpoint-vault method is invoked before the owner intent signature.
    if (candidate.checkpoint.owner !== policy.owner || candidate.checkpoint.agent !== policy.agent
      || candidate.checkpoint.applicationSchema !== policy.applicationSchema
      || !cystRegistryMatches(snapshot.current, candidate.checkpoint)) throw new Error('No canonical completed sealed checkpoint');
    const result = await this.options.journal.transact(journal => {
      floor(journal, policy);
      const prior = journal.entries.find(item => item.context.releaseId === id);
      if (prior) {
        fresh(policy, now, prior.context);
        if (prior.context.operationId !== candidate.operationId || hashJson(prior.context.checkpoint) !== hashJson(candidate.checkpoint)
          || prior.context.current.revision !== candidate.current.revision) throw new Error('Sealed release id changed checkpoint');
        return { created: false, entry: structuredClone(prior) };
      }
      if (journal.entries.length >= 64 || journal.entries.some(item => item.bindingHash === sealedBindingV3(candidate))) {
        throw new Error('Sealed release binding retained or lifetime capacity exhausted');
      }
      const value: SealedEntryV3 = { context: candidate, phase: 'intent', intentSignature: null, packet: null,
        packetSignature: null, challengeHash: null, bindingHash: sealedBindingV3(candidate) };
      journal.entries.push(value); return { created: true, entry: structuredClone(value) };
    });
    return { ...result, typedData: sealedIntentTypedData(result.entry.context) };
  }
  async preparePacket(releaseId: string, ownerIntentSignature: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = sealedHash.parse(releaseId), prior = entry(await this.options.journal.read(), id);
    await current(this.options, this.policy, prior.context);
    const signature = await intentSignature(prior.context, ownerIntentSignature);
    const begin = await this.options.journal.transact(journal => {
      floor(journal, this.policy); const value = entry(journal, id);
      if (hashJson(value.context) !== hashJson(prior.context)) throw new Error('Sealed release context changed');
      if (value.phase === 'prepared' || value.phase === 'complete') return { created: false, value: structuredClone(value) };
      if (value.phase !== 'intent') throw new Error('Sealed preparation unknown; no automatic recollection or rekey');
      value.intentSignature = signature; value.phase = 'preparing'; return { created: true, value: structuredClone(value) };
    });
    if (!begin.created) {
      if (!begin.value.packet) throw new Error('Prepared sealed packet unavailable');
      if ((this.options.now ?? Date.now)() >= begin.value.packet.expiresAtMs) throw new Error('Prepared sealed appraisal expired');
      return { replayed: true, packet: begin.value.packet, typedData: sealedPacketTypedData(prior.context, begin.value.packet) };
    }
    const context = begin.value.context;
    const wrappedVault: CystCheckpointVault = { exclusive: (scope, operation) => this.options.journal.authorize(journal => {
      floor(journal, this.policy); fresh(this.policy, (this.options.now ?? Date.now)(), context);
    }, () => this.options.checkpointVault.exclusive(scope, async journal => {
      await current(this.options, this.policy, context);
      return operation({ load: async () => {
        const latest = await journal.load();
        if (!latest?.latest || latest.pending || latest.latest.operationId !== context.operationId
          || hashJson(latest.latest.checkpoint) !== hashJson(context.checkpoint)) throw new Error('Sealed source checkpoint metadata changed');
        return latest;
      }, save: value => journal.save(value), saveCheckpoint: (operationId, value) => journal.saveCheckpoint(operationId, value),
      checkpoint: async operationId => {
        await current(this.options, this.policy, context); signal.throwIfAborted();
        if (operationId !== context.operationId) throw new Error('Sealed recovery record changed');
        return journal.checkpoint(operationId);
      } });
    })) };
    const rawPacket = await releaseCystKeyToSealedCell({ request: requestFor(context), vault: wrappedVault, verify: this.verify,
      signal, now: this.options.now ?? Date.now, collectEvidence: async input => {
        await current(this.options, this.policy, context); signal.throwIfAborted();
        await this.options.journal.transact(journal => {
          floor(journal, this.policy); const value = entry(journal, id);
          if (value.phase !== 'preparing' || value.challengeHash !== null) throw new Error('Sealed challenge already exposed');
          value.challengeHash = hashJson(input.challenge);
        });
        return this.options.collectEvidence(input);
      } });
    // Attestation expiry is never extended to accommodate the second signature.
    // Preserve the immutable AEAD header. Every stage enforces both independent
    // deadlines: the original owner intent and the signed appraisal (effective min).
    const packet = packetContext(context, rawPacket);
    await current(this.options, this.policy, context); signal.throwIfAborted();
    await this.options.journal.transact(journal => {
      fresh(this.policy, (this.options.now ?? Date.now)(), context);
      floor(journal, this.policy); const value = entry(journal, id);
      if (value.phase !== 'preparing' || value.packet !== null || !value.challengeHash) throw new Error('Sealed preparation state changed');
      value.packet = packet; value.phase = 'prepared';
    });
    fresh(this.policy, (this.options.now ?? Date.now)(), context);
    if ((this.options.now ?? Date.now)() >= packet.expiresAtMs) throw new Error('Prepared sealed appraisal expired');
    return { replayed: false, packet, typedData: sealedPacketTypedData(context, packet) };
  }
  async complete(releaseId: string, ownerPacketSignature: string): Promise<SealedEnvelopeV3> {
    const id = sealedHash.parse(releaseId), prior = entry(await this.options.journal.read(), id);
    await current(this.options, this.policy, prior.context);
    if (!prior.packet || !prior.intentSignature || !['prepared', 'complete'].includes(prior.phase)) throw new Error('Sealed packet not prepared');
    const packet = packetContext(prior.context, prior.packet), now = (this.options.now ?? Date.now)();
    if (now >= packet.expiresAtMs) throw new Error('Sealed packet appraisal expired');
    await intentSignature(prior.context, prior.intentSignature);
    const signature = ownerSignatureSchema.parse(ownerPacketSignature);
    if (!await verifyTypedData({ address: this.policy.owner, ...sealedPacketTypedData(prior.context, packet), signature })) throw new Error('Sealed owner packet signature rejected');
    await current(this.options, this.policy, prior.context);
    const completed = await this.options.journal.transact(journal => {
      fresh(this.policy, (this.options.now ?? Date.now)(), prior.context);
      if ((this.options.now ?? Date.now)() >= packet.expiresAtMs) throw new Error('Sealed packet appraisal expired');
      floor(journal, this.policy); const value = entry(journal, id);
      if (value.phase !== 'prepared' && value.phase !== 'complete' || hashJson(value.packet) !== hashJson(packet)) throw new Error('Sealed packet changed');
      if (value.phase === 'complete') return envelope(value);
      value.packetSignature = signature; value.phase = 'complete'; return envelope(value);
    });
    fresh(this.policy, (this.options.now ?? Date.now)(), prior.context);
    if ((this.options.now ?? Date.now)() >= packet.expiresAtMs) throw new Error('Sealed packet appraisal expired');
    return completed;
  }
}

/** Recipient policy is installed independently, including its actual boot/key,
 * owner and lease/fence context. Old unsigned v2 packets are never accepted here.
 */
export class SealedCystHandoffRecipientV3 {
  private readonly policy: SealedPolicyV3;
  constructor(private readonly options: Environment & { recipient: { publicKey: string; privateKey: CryptoKey } }) {
    this.policy = installed(options, 'recipient');
    if (options.recipient.publicKey !== this.policy.recipientPublicKey) throw new Error('Installed sealed recipient key differs');
  }
  activatePolicy(): Promise<void> { return activateSealedPolicyV3(this.options, 'recipient'); }
  async accept(raw: unknown, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted(); const value = sealedEnvelopeV3Schema.parse(raw), context = value.context;
    await current(this.options, this.policy, context);
    const packet = packetContext(context, value.packet);
    if ((this.options.now ?? Date.now)() >= packet.expiresAtMs) throw new Error('Sealed packet expired');
    await intentSignature(context, value.ownerIntentSignature);
    if (!await verifyTypedData({ address: this.policy.owner, ...sealedPacketTypedData(context, packet), signature: value.ownerPacketSignature })) {
      throw new Error('Sealed owner packet signature rejected');
    }
    await current(this.options, this.policy, context); signal.throwIfAborted();
    await this.options.journal.transact(journal => {
      floor(journal, this.policy);
      if (journal.entries.some(item => item.context.releaseId === context.releaseId || item.bindingHash === sealedBindingV3(context))
        || journal.entries.length >= 64) throw new Error('Sealed release already consumed or capacity exhausted');
      journal.entries.push({ context, phase: 'consumed', intentSignature: null, packet: null, packetSignature: null,
        challengeHash: null, bindingHash: sealedBindingV3(context) });
    });
    await current(this.options, this.policy, context); signal.throwIfAborted();
    const { operationId: _operation, ...expected } = requestFor(context); void _operation;
    let key: Uint8Array | undefined;
    try {
      const opened = await this.options.journal.authorize(journal => {
        floor(journal, this.policy); fresh(this.policy, (this.options.now ?? Date.now)(), context);
        const consumed = entry(journal, context.releaseId);
        if (consumed.phase !== 'consumed' || hashJson(consumed.context) !== hashJson(context)) throw new Error('Sealed consumption context changed');
      }, async () => {
        signal.throwIfAborted(); key = await openSealedCystKey(packet, expected, this.options.recipient, this.options.now ?? Date.now);
        await current(this.options, this.policy, context); signal.throwIfAborted(); return key;
      });
      fresh(this.policy, (this.options.now ?? Date.now)(), context);
      if ((this.options.now ?? Date.now)() >= packet.expiresAtMs) throw new Error('Sealed packet expired before handoff');
      signal.throwIfAborted(); return opened;
    } catch (error) { key?.fill(0); throw error; }
  }
}

export type SealedHandoffSignerV3 = (typedData: ReturnType<typeof sealedIntentTypedData> | ReturnType<typeof sealedPacketTypedData>) => Promise<string>;
/** One fresh attempt only. A retained/uncertain attempt never triggers a signer,
 * collector or key callback again; explicit stage APIs expose exact recovery.
 */
export async function releaseAuthenticatedSealedCystV3(owner: SealedCystHandoffOwnerV3,
  releaseId: string, completed: { operationId: string; checkpoint: CystMetadata }, sign: SealedHandoffSignerV3, signal: AbortSignal) {
  const intent = await owner.prepareIntent(releaseId, completed);
  if (!intent.created) return { status: 'retained' as const, phase: intent.entry.phase, context: intent.entry.context };
  signal.throwIfAborted(); const first = await sign(intent.typedData);
  const prepared = await owner.preparePacket(releaseId, first, signal);
  signal.throwIfAborted(); const second = await sign(prepared.typedData);
  signal.throwIfAborted(); const envelope = await owner.complete(releaseId, second);
  signal.throwIfAborted(); return { status: 'complete' as const, envelope };
}
