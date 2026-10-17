import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { CYST_CAPABILITIES, cystMetadataSchema, type CystMetadata } from './types.js';

export const cystRegistryAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
export const cystRegistryHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => {
  // REASON: The boundary expression establishes exactly 32 hexadecimal bytes.
  return value.toLowerCase() as Hex;
});
export const cystRegistryUint64Schema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) < 2n ** 64n);
const nonzeroAddress = cystRegistryAddressSchema.refine(value => !/^0x0{40}$/i.test(value));
const nonzeroHash = cystRegistryHashSchema.refine(value => !/^0x0{64}$/i.test(value));
export const cystRegistryPinsSchema = z.object({ chainId: z.number().int().positive().safe(),
  registryAddress: nonzeroAddress, registryCodeHash: nonzeroHash,
  selectionRegistryAddress: nonzeroAddress, selectionRegistryCodeHash: nonzeroHash,
  confirmations: z.number().int().min(0).max(10_000),
}).strict().refine(value => value.registryAddress !== value.selectionRegistryAddress);
export type CystRegistryPins = z.infer<typeof cystRegistryPinsSchema>;
export const cystRegistryConfigSchema = z.object({ protocol: z.literal('telomere-cyst-registry-v1'),
  pins: cystRegistryPinsSchema, storageRefVersion: z.literal(1),
  maxCheckpointBytes: z.literal(CYST_CAPABILITIES.maxCiphertextBytes),
  maxRegistryBytes: z.literal(2_147_483_648),
}).strict();
export type CystRegistryConfig = z.infer<typeof cystRegistryConfigSchema>;
export const cystRegistryBindingSchema = z.object({ agentId: nonzeroHash, owner: nonzeroAddress,
  agentWallet: nonzeroAddress, vault: nonzeroAddress, status: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  frozen: z.boolean(),
}).strict();
export type CystRegistryBinding = z.infer<typeof cystRegistryBindingSchema>;
export const cystRegistryStateSchema = z.object({ agentId: nonzeroHash, cystHash: cystRegistryHashSchema,
  sizeBytes: cystRegistryUint64Schema.refine(value => BigInt(value) <= 2_147_483_648n),
  storageRef: cystRegistryHashSchema, revision: cystRegistryUint64Schema,
  committedAt: cystRegistryUint64Schema, retired: z.boolean(),
  block: z.object({ number: cystRegistryUint64Schema, hash: cystRegistryHashSchema }).strict(),
}).strict();
export type CystRegistryState = z.infer<typeof cystRegistryStateSchema>;
export const cystRegistrySnapshotSchema = z.object({ binding: cystRegistryBindingSchema, current: cystRegistryStateSchema }).strict()
  .refine(value => value.binding.agentId === value.current.agentId);
export type CystRegistrySnapshot = z.infer<typeof cystRegistrySnapshotSchema>;
export interface CystRegistryReader {
  readonly pins: CystRegistryPins;
  check(): Promise<void>;
  snapshot(agentId: string): Promise<CystRegistrySnapshot>;
}
export const cystRegistryTransactionSchema = z.object({ chainId: z.number().int().positive().safe(),
  from: nonzeroAddress, to: nonzeroAddress, value: z.literal('0'),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(2050),
}).strict();
export const cystRegistryCommitPreparedSchema = z.object({ binding: cystRegistryBindingSchema,
  checkpoint: cystMetadataSchema, current: cystRegistryStateSchema, transaction: cystRegistryTransactionSchema,
}).strict();
export const cystRegistryRetirePreparedSchema = z.object({ binding: cystRegistryBindingSchema,
  current: cystRegistryStateSchema, transaction: cystRegistryTransactionSchema,
}).strict();
export const cystRegistryVerificationSchema = z.object({ binding: cystRegistryBindingSchema,
  checkpoint: cystMetadataSchema, current: cystRegistryStateSchema, matches: z.boolean(),
}).strict();
export const cystRegistryDownloadSchema = z.object({ binding: cystRegistryBindingSchema,
  checkpoint: cystMetadataSchema, current: cystRegistryStateSchema,
  ciphertext: z.string().min(24).max(Math.ceil(CYST_CAPABILITIES.maxCiphertextBytes / 3) * 4),
}).strict();
export type CystRegistryCommitPrepared = z.infer<typeof cystRegistryCommitPreparedSchema>;
export type CystRegistryRetirePrepared = z.infer<typeof cystRegistryRetirePreparedSchema>;
export type CystRegistryVerification = z.infer<typeof cystRegistryVerificationSchema>;
export type CystRegistryDownload = z.infer<typeof cystRegistryDownloadSchema>;
export const cystRegistryAbi = parseAbi([
  'struct Cyst { bytes32 cystHash; uint64 sizeBytes; bytes32 storageRef; uint64 revision; uint64 committedAt; bool retired; }',
  'function selectionRegistry() view returns (address)',
  'function MAX_CYST_BYTES() view returns (uint64)',
  'function latest(bytes32 agentId) view returns (Cyst)',
  'function commit(bytes32 agentId,bytes32 cystHash,uint64 sizeBytes,bytes32 storageRef)',
  'function commitChecked(bytes32 agentId,bytes32 cystHash,uint64 sizeBytes,bytes32 storageRef,uint64 expectedRevision)',
  'function retire(bytes32 agentId)',
  'function retireChecked(bytes32 agentId,uint64 expectedRevision)',
]);

/** Opaque locator binds the complete encrypted checkpoint context; it contains no URL or key. */
export function cystRegistryStorageRef(value: CystMetadata): Hex {
  const item = cystMetadataSchema.parse(value);
  return keccak256(toHex(JSON.stringify(['telomere.cyst.locator', 1, item.version, item.algorithm,
    item.id, item.owner, item.agent, item.applicationSchema, item.plaintextBytes, item.nonce, item.sha256, item.ciphertextBytes])));
}
export function cystRegistryMatches(current: CystRegistryState, checkpoint: CystMetadata): boolean {
  return checkpoint.state === 'ready' && BigInt(current.revision) > 0n && !current.retired
    && current.cystHash === '0x' + checkpoint.sha256 && current.sizeBytes === String(checkpoint.ciphertextBytes)
    && current.storageRef === cystRegistryStorageRef(checkpoint);
}
export function cystRegistryCommitTransaction(pins: CystRegistryPins, binding: CystRegistryBinding,
  checkpoint: CystMetadata, revision: string) {
  return cystRegistryTransactionSchema.parse({ chainId: pins.chainId, from: binding.agentWallet,
    to: pins.registryAddress, value: '0', data: encodeFunctionData({ abi: cystRegistryAbi, functionName: 'commitChecked',
      args: [binding.agentId, cystRegistryHashSchema.parse('0x' + checkpoint.sha256), BigInt(checkpoint.ciphertextBytes),
        cystRegistryStorageRef(checkpoint), BigInt(cystRegistryUint64Schema.parse(revision))] }) });
}
export function cystRegistryRetireTransaction(pins: CystRegistryPins, binding: CystRegistryBinding, revision: string) {
  return cystRegistryTransactionSchema.parse({ chainId: pins.chainId, from: binding.agentWallet,
    to: pins.registryAddress, value: '0', data: encodeFunctionData({ abi: cystRegistryAbi, functionName: 'retireChecked',
      args: [binding.agentId, BigInt(cystRegistryUint64Schema.parse(revision))] }) });
}
