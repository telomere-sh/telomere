import { domainSeparator, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { baseUsdcForChainId } from '../chain/chains.js';

// Circle's FiatTokenProxy uses the zeppelinos unstructured storage slot, not EIP-1967.
// https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol
export const CIRCLE_PROXY_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' as const;
const upgradedEvent = parseAbiItem('event Upgraded(address indexed implementation)');
const metadataAbi = parseAbi(['function name() view returns(string)', 'function symbol() view returns(string)',
  'function version() view returns(string)', 'function decimals() view returns(uint8)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)']);
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export type CircleImplementationPins = { address: Address; codeHash: Hex };
export type CanonicalBlockState = { blockHash: Hex; requireCanonical: true };

export function nativeBaseUsdcName(chainId: number): string | undefined {
  if (chainId === 8453) return 'USD Coin';
  if (chainId === 84532) return 'USDC';
  return undefined;
}

export function isNativeBaseUsdc(chainId: number, asset: Address): boolean {
  const canonical = baseUsdcForChainId(chainId);
  return canonical !== undefined && equal(asset, canonical);
}

/** The implementation pointer and bytecode must agree at one canonical state. */
export async function matchesCircleProxyPins(client: PublicClient, asset: Address, pins: CircleImplementationPins,
  state: CanonicalBlockState | Record<string, never> = {}): Promise<boolean> {
  const [slot, code] = await Promise.all([
    client.getStorageAt({ address: asset, slot: CIRCLE_PROXY_IMPLEMENTATION_SLOT, ...state }),
    client.getCode({ address: pins.address, ...state }),
  ]);
  return !!slot && !equal(pins.address, '0x0000000000000000000000000000000000000000')
    && equal(`0x${slot.slice(-40)}`, pins.address) && !!code && code !== '0x' && equal(keccak256(code), pins.codeHash);
}

/** Reject an upgrade and rollback within the receipt block, even if its final state matches. */
export async function stableCircleProxyReceiptBlock(client: PublicClient, asset: Address, tokenCodeHash: Hex,
  pins: CircleImplementationPins, blockHash: Hex, blockNumber: bigint): Promise<boolean> {
  if (blockNumber === 0n) return false;
  const parent = await client.getBlock({ blockNumber: blockNumber - 1n });
  const parentState = { blockHash: parent.hash, requireCanonical: true } as const;
  const [proxyCode, parentMatches, currentMatches, upgrades] = await Promise.all([
    client.getCode({ address: asset, ...parentState }),
    matchesCircleProxyPins(client, asset, pins, parentState),
    matchesCircleProxyPins(client, asset, pins, { blockHash, requireCanonical: true }),
    client.getLogs({ address: asset, blockHash, event: upgradedEvent, strict: true }),
  ]);
  return !!proxyCode && proxyCode !== '0x' && equal(keccak256(proxyCode), tokenCodeHash)
    && parentMatches && currentMatches && upgrades.length === 0
    && equal((await client.getBlock({ blockNumber })).hash, blockHash);
}

/** Circle's two Base deployments have different EIP-712 names, both with version 2. */
export async function matchesNativeBaseUsdcMetadata(client: PublicClient, chainId: number, asset: Address,
  state: CanonicalBlockState | Record<string, never> = {}): Promise<boolean> {
  const name = nativeBaseUsdcName(chainId);
  if (!name || !isNativeBaseUsdc(chainId, asset)) return false;
  const [actualName, symbol, version, decimals, separator] = await Promise.all([
    client.readContract({ address: asset, abi: metadataAbi, functionName: 'name', ...state }),
    client.readContract({ address: asset, abi: metadataAbi, functionName: 'symbol', ...state }),
    client.readContract({ address: asset, abi: metadataAbi, functionName: 'version', ...state }),
    client.readContract({ address: asset, abi: metadataAbi, functionName: 'decimals', ...state }),
    client.readContract({ address: asset, abi: metadataAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
  ]);
  return actualName === name && symbol === 'USDC' && version === '2' && decimals === 6
    && equal(separator, domainSeparator({ domain: { name, version: '2', chainId, verifyingContract: asset } }));
}
