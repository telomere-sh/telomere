import { z } from 'zod';
import { hashTypedData, type Address, type Hex } from 'viem';
import { hashJson } from '../common.js';
import { cystHeaderSchema, cystMetadataSchema } from '../cysts/types.js';
import { cystRegistryPinsSchema, cystRegistryStateSchema } from '../cysts/registry-types.js';

export const sealedHash = z.string().regex(/^0x[0-9a-f]{64}$/).refine(value => !/^0x0{64}$/.test(value))
  .transform(value => value as Hex);
export const sealedKey = z.string().regex(/^[0-9a-f]{64}$/).refine(value => value !== '00'.repeat(32));
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => !/^0x0{40}$/.test(value)).transform(value => value as Address);
const instant = z.number().int().nonnegative().safe();
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value.toLowerCase() as Hex);
export const sealedPolicyV3Schema = z.object({ version: z.literal(3), registryPins: cystRegistryPinsSchema,
  owner: address, agent: address, agentId: sealedHash, vault: address,
  applicationSchema: cystHeaderSchema.shape.applicationSchema,
  generation: z.number().int().min(1).max(1_000_000), notBeforeMs: instant, expiresAtMs: instant,
  runId: sealedHash, hostId: sealedHash, bootId: sealedHash, leaseHash: sealedHash,
  fenceEpoch: z.number().int().nonnegative().safe(), leaseExpiresAtMs: instant,
  recipientPublicKey: sealedKey, appraiserKeySha256: sealedHash, teeMeasurement: sealedHash, policySha256: sealedHash,
}).strict().refine(value => [31337, 8453, 84532].includes(value.registryPins.chainId)
  && value.expiresAtMs > value.notBeforeMs && value.leaseExpiresAtMs > value.notBeforeMs);
export type SealedPolicyV3 = z.infer<typeof sealedPolicyV3Schema>;
export const sealedContextV3Schema = z.object({ policy: sealedPolicyV3Schema, releaseId: sealedHash,
  operationId: z.string().regex(/^cyst-hook-[a-f0-9]{64}$/),
  checkpoint: cystMetadataSchema.refine(value => value.state === 'ready' && value.plaintextBytes <= 2_097_152),
  current: cystRegistryStateSchema, createdAtMs: instant, expiresAtMs: instant,
}).strict().refine(value => value.expiresAtMs > value.createdAtMs && value.expiresAtMs <= value.createdAtMs + 60_000
  && value.expiresAtMs <= value.policy.expiresAtMs && value.expiresAtMs <= value.policy.leaseExpiresAtMs);
export type SealedContextV3 = z.infer<typeof sealedContextV3Schema>;
export const sealedPacketV2Schema = z.object({ owner: address, agent: address,
  applicationSchema: cystHeaderSchema.shape.applicationSchema, checkpointId: sealedHash,
  runId: sealedHash, hostId: sealedHash, audience: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  teeMeasurement: sealedHash, policySha256: sealedHash, recipientPublicKey: sealedKey,
  version: z.literal(2), algorithm: z.literal('x25519-hkdf-sha256-xchacha20poly1305'),
  attestationRef: sealedHash, challenge: sealedHash, reportData: z.string().regex(/^0x[0-9a-f]{128}$/),
  verifiedAtMs: instant, expiresAtMs: instant, ephemeralPublicKey: sealedKey, salt: sealedKey,
  nonce: z.string().regex(/^[0-9a-f]{48}$/), ciphertext: z.string().regex(/^[0-9a-f]{96}$/),
}).strict();
export type SealedPacketV2 = z.infer<typeof sealedPacketV2Schema>;
export const ownerSignatureSchema = signature;
export const sealedEnvelopeV3Schema = z.object({ version: z.literal(3), context: sealedContextV3Schema,
  ownerIntentSignature: signature, packet: sealedPacketV2Schema, ownerPacketSignature: signature }).strict();
export type SealedEnvelopeV3 = z.infer<typeof sealedEnvelopeV3Schema>;
export const sealedIntentTypes = { SealedReleaseIntent: [{ name: 'contextHash', type: 'bytes32' }] } as const;
export const sealedPacketTypes = { SealedPacketAuthorization: [{ name: 'intentHash', type: 'bytes32' },
  { name: 'packetHash', type: 'bytes32' }] } as const;
export function sealedIntentTypedData(context: SealedContextV3) {
  const value = sealedContextV3Schema.parse(context);
  return { domain: { name: 'TelomereSealedCystHandoff', version: '3', chainId: value.policy.registryPins.chainId,
    verifyingContract: value.policy.registryPins.registryAddress }, types: sealedIntentTypes,
    primaryType: 'SealedReleaseIntent' as const, message: { contextHash: hashJson(value) } };
}
export function sealedPacketTypedData(context: SealedContextV3, packet: SealedPacketV2) {
  return { ...sealedIntentTypedData(context), types: sealedPacketTypes, primaryType: 'SealedPacketAuthorization' as const,
    message: { intentHash: hashTypedData(sealedIntentTypedData(context)), packetHash: hashJson(sealedPacketV2Schema.parse(packet)) } };
}
export function sealedAudienceV3(context: SealedContextV3): string { return 'telomere.sealed-handoff/v3/' + hashJson(context).slice(2); }
export function sealedBindingV3(context: SealedContextV3): Hex {
  const p = context.policy;
  return hashJson(['telomere.sealed-binding.v3', p.owner, p.agent, p.agentId, p.vault, p.applicationSchema,
    p.runId, p.hostId, p.bootId, p.leaseHash, p.fenceEpoch, context.current.revision]);
}
export function sealedScopeV3(policy: SealedPolicyV3): Hex {
  return hashJson(['telomere.sealed-journal-scope.v3', policy.registryPins, policy.owner, policy.agent, policy.agentId,
    policy.vault, policy.applicationSchema]);
}
export const sealedEntryV3Schema = z.object({ context: sealedContextV3Schema,
  phase: z.enum(['intent', 'preparing', 'prepared', 'complete', 'consumed']),
  intentSignature: signature.nullable(), packet: sealedPacketV2Schema.nullable(), packetSignature: signature.nullable(),
  challengeHash: sealedHash.nullable(), bindingHash: sealedHash }).strict();
export type SealedEntryV3 = z.infer<typeof sealedEntryV3Schema>;
export const sealedJournalV3Schema = z.object({ version: z.literal(3), role: z.enum(['owner', 'recipient']), scopeHash: sealedHash,
  policyGeneration: z.number().int().nonnegative(), policyHash: sealedHash.nullable(), policyTransitions: z.number().int().min(0).max(16),
  fences: z.array(z.object({ runId: sealedHash, epoch: instant, bootId: sealedHash, recipientPublicKey: sealedKey }).strict()).max(16),
  activeRecipient: sealedKey.nullable(), activeAppraiser: sealedHash.nullable(),
  retiredRecipients: z.array(sealedKey).max(16), retiredAppraisers: z.array(sealedHash).max(16),
  entries: z.array(sealedEntryV3Schema).max(64), writes: z.number().int().min(0).max(512),
  lifetimeBytes: z.number().int().nonnegative().max(67_108_864),
}).strict();
export type SealedJournalV3State = z.infer<typeof sealedJournalV3Schema>;
