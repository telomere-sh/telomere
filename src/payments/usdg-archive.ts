import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock, type AssetFacetPins } from './asset-facets.js';

// Historical USDG anchor is kept for archived evidence, never selected by the Base payment profile.
const robinhoodTestnetUsdg = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address;

/** Reviewed Robinhood testnet state used before the USDG payment rail is enabled.
 * A profile with new token/facet code needs a new reviewed historical anchor. */
export const usdgArchiveAnchor = {
  number: 133666836n,
  hash: '0xeabd25353444b167061be6432f1b7ccacfe8b95989a4520190b0efbec87867fd' as Hex,
  timestamp: 1791814724n,
} as const;
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const sixHours = 21_600n;
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export type ArchiveAnchor = { number: bigint; hash: Hex; timestamp: bigint };

/** A real EIP-1898 code read at a known old canonical block, plus a second
 * canonicality read. This is a bounded capability probe, not proof that a
 * provider will retain every future state or remain available. */
export async function assertHistoricalCodeState(client: PublicClient, options: {
  anchor: ArchiveAnchor; asset: Address; codeHash: Hex; minimumAgeSeconds: bigint;
}): Promise<void> {
  const { anchor, asset, codeHash, minimumAgeSeconds } = options;
  if (anchor.number <= 0n || anchor.timestamp <= 0n || minimumAgeSeconds < 0n) throw new Error('Historical RPC anchor is invalid');
  const head = await client.getBlock({ blockTag: 'latest' });
  if (head.number <= anchor.number || head.timestamp < anchor.timestamp + minimumAgeSeconds) {
    throw new Error('Historical RPC retention horizon is unproven');
  }
  const reviewed = await client.getBlock({ blockNumber: anchor.number });
  if (!equal(reviewed.hash, anchor.hash) || reviewed.timestamp !== anchor.timestamp) throw new Error('Historical RPC anchor differs');
  const code = await client.getCode({ address: asset, blockHash: anchor.hash, requireCanonical: true });
  if (!code || !equal(keccak256(code), codeHash)
    || !equal((await client.getBlock({ blockNumber: anchor.number })).hash, anchor.hash)) {
    throw new Error('Historical RPC code is unavailable or changed');
  }
}

/** Canonical USDG requires six-hour-old proxy, implementation, mutable
 * authorization facet and receipt-block event history before public intake. */
export async function assertUsdArchiveHistory(client: PublicClient, pins: {
  chainId: number; asset: Address; tokenCodeHash: Hex;
  assetImplementation?: { address: Address; codeHash: Hex };
  assetFacet?: AssetFacetPins | undefined;
}): Promise<void> {
  if (pins.chainId !== 46630 || !equal(pins.asset, robinhoodTestnetUsdg)
    || !pins.assetImplementation || !pins.assetFacet) throw new Error('Reviewed USDG archive pins are required');
  if (await client.getChainId() !== 46630) throw new Error('Historical RPC chain differs');
  await assertHistoricalCodeState(client, { anchor: usdgArchiveAnchor, asset: pins.asset,
    codeHash: pins.tokenCodeHash, minimumAgeSeconds: sixHours });
  const state = { blockHash: usdgArchiveAnchor.hash, requireCanonical: true } as const;
  const [slot, implementationCode, facetMatches] = await Promise.all([
    client.getStorageAt({ address: pins.asset, slot: implementationSlot, ...state }),
    client.getCode({ address: pins.assetImplementation.address, ...state }),
    matchesAssetFacetPins(client, pins.asset, pins.assetFacet, state),
  ]);
  if (!slot || !equal(`0x${slot.slice(-40)}`, pins.assetImplementation.address)
    || !implementationCode || !equal(keccak256(implementationCode), pins.assetImplementation.codeHash)
    || !facetMatches || !await stableAssetFacetReceiptBlock(client, pins.asset, pins.assetFacet,
      usdgArchiveAnchor.hash, usdgArchiveAnchor.number)) throw new Error('Historical USDG implementation or facet differs');
  if (!equal((await client.getBlock({ blockNumber: usdgArchiveAnchor.number })).hash, usdgArchiveAnchor.hash)) {
    throw new Error('Historical USDG block is no longer canonical');
  }
}
