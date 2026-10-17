import { keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { incomeAddressSchema, incomeHashSchema } from '../selection/income-endpoints/types.js';

// Historical USDG-only helper retained for parsing archived test evidence.
const robinhoodTestnetUsdg = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address;

/** The USDG proxy delegates these three EIP-3009 operations through mutable facet routes. */
const usdAuthorizationSelectors = ['0xe3ee160e', '0xef55bec6', '0xe94a0102'] as const;
const facetAbi = parseAbi(['function getFacet(bytes4 selector) view returns(address)']);
const facetUpdateEvent = parseAbiItem('event FacetUpdate(bytes4 indexed selector, address indexed facet)');
const upgradedEvent = parseAbiItem('event Upgraded(address indexed implementation)');
export const assetFacetPinsSchema = z.object({ address: incomeAddressSchema, codeHash: incomeHashSchema }).strict();
export type AssetFacetPins = { address: Address; codeHash: Hex };
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function requiresUsdAuthorizationFacet(chainId: number, asset: Address): boolean {
  return chainId === 46630 && equal(asset, robinhoodTestnetUsdg);
}

/** All reads use one canonical block when supplied. A changed route or bytecode fails closed. */
export async function matchesAssetFacetPins(client: PublicClient, asset: Address, pins: AssetFacetPins,
  state: { blockHash: Hex; requireCanonical: true } | Record<string, never> = {}): Promise<boolean> {
  const [routes, code] = await Promise.all([
    Promise.all(usdAuthorizationSelectors.map(selector => client.readContract({ address: asset,
      abi: facetAbi, functionName: 'getFacet', args: [selector], ...state }))),
    client.getCode({ address: pins.address, ...state }),
  ]);
  return routes.every(route => equal(route, pins.address)) && !!code && equal(keccak256(code), pins.codeHash);
}

/** Reject a receipt block with normal manager route updates or proxy upgrades.
 * This complements end-of-block pins; it does not replace transaction tracing
 * against a malicious delegatecall that silently writes manager storage. */
export async function stableAssetFacetReceiptBlock(client: PublicClient, asset: Address, pins: AssetFacetPins,
  blockHash: Hex, blockNumber: bigint): Promise<boolean> {
  if (blockNumber === 0n) return false;
  const parent = await client.getBlock({ blockNumber: blockNumber - 1n });
  if (!await matchesAssetFacetPins(client, asset, pins, { blockHash: parent.hash, requireCanonical: true })) return false;
  const updates = await client.getLogs({ address: asset, blockHash, events: [facetUpdateEvent, upgradedEvent], strict: true });
  if (updates.length > 0) return false;
  return equal((await client.getBlock({ blockNumber })).hash, blockHash);
}
