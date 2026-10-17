import { keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const nonzeroAddress = address.refine(value => value !== '0x' + '00'.repeat(20));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const base = z.object({ reviewed: z.literal(true), chainId: z.number().int().positive().max(2 ** 31 - 1),
  identityAddress: nonzeroAddress, identityCodeHash: hash, reputationAddress: nonzeroAddress, reputationCodeHash: hash,
  publisherAddress: nonzeroAddress });

/** Direct bytecode is accepted only for the explicit, disposable local fixture. */
export const selectionReputationTargetProfileSchema = z.discriminatedUnion('deploymentKind', [
  base.extend({ deploymentKind: z.literal('direct') }).strict(),
  base.extend({ deploymentKind: z.literal('erc1967'), identityImplementationAddress: nonzeroAddress,
    identityImplementationCodeHash: hash, reputationImplementationAddress: nonzeroAddress,
    reputationImplementationCodeHash: hash }).strict(),
]);
export type SelectionReputationTargetProfile = z.input<typeof selectionReputationTargetProfileSchema>;
export type ReviewedSelectionReputationTargetProfile = z.output<typeof selectionReputationTargetProfileSchema>;

/** EIP-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1). */
export const erc1967ImplementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
export interface SelectionReputationImplementationState {
  identityImplementationAddress: string | null; identityImplementationCodeHash: string | null;
  reputationImplementationAddress: string | null; reputationImplementationCodeHash: string | null;
}

function implementation(value: Hex | undefined): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Unverified ERC-1967 implementation slot');
  if (BigInt(value) === 0n) return null;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new Error('Malformed ERC-1967 implementation slot');
  return '0x' + value.slice(-40).toLowerCase();
}

/** Callbacks must use the same EIP-1898 canonical block hash for storage and code.
 * An unsupported historical storage read fails rather than falling back to latest.
 */
export async function verifySelectionReputationImplementations(profile: ReviewedSelectionReputationTargetProfile,
  readSlot: (address: Address) => Promise<Hex | undefined>, readCode: (address: Address) => Promise<Hex | undefined>)
  : Promise<SelectionReputationImplementationState> {
  const [identitySlot, reputationSlot] = await Promise.all([
    readSlot(profile.identityAddress as Address), readSlot(profile.reputationAddress as Address),
  ]);
  const identityImplementationAddress = implementation(identitySlot), reputationImplementationAddress = implementation(reputationSlot);
  if (profile.deploymentKind === 'direct') {
    if (profile.chainId !== 31337 || identityImplementationAddress || reputationImplementationAddress) {
      throw new Error('Direct reputation fixtures cannot conceal an ERC-1967 proxy');
    }
    return { identityImplementationAddress: null, identityImplementationCodeHash: null,
      reputationImplementationAddress: null, reputationImplementationCodeHash: null };
  }
  if (identityImplementationAddress !== profile.identityImplementationAddress
    || reputationImplementationAddress !== profile.reputationImplementationAddress
    || identityImplementationAddress === profile.identityAddress || reputationImplementationAddress === profile.reputationAddress) {
    throw new Error('Reviewed ERC-1967 implementation address changed');
  }
  // REASON: the slot parser proved these are nonzero 20-byte EVM addresses.
  const [identityCode, reputationCode] = await Promise.all([
    readCode(identityImplementationAddress as Address), readCode(reputationImplementationAddress as Address),
  ]);
  if (!identityCode || identityCode === '0x' || !reputationCode || reputationCode === '0x') {
    throw new Error('Reviewed ERC-1967 implementation code is unavailable');
  }
  const identityImplementationCodeHash = keccak256(identityCode), reputationImplementationCodeHash = keccak256(reputationCode);
  if (identityImplementationCodeHash !== profile.identityImplementationCodeHash
    || reputationImplementationCodeHash !== profile.reputationImplementationCodeHash) {
    throw new Error('Reviewed ERC-1967 implementation code changed');
  }
  return { identityImplementationAddress, identityImplementationCodeHash,
    reputationImplementationAddress, reputationImplementationCodeHash };
}
