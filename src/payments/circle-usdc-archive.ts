import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { assertHistoricalCodeState } from './usdg-archive.js';
import { isNativeBaseUsdc, matchesCircleProxyPins, matchesNativeBaseUsdcMetadata,
  type CircleImplementationPins } from './circle-usdc.js';

export type CircleArchiveAnchor = { number: string; hash: Hex; timestamp: string };
const sixHours = 21_600n;

/** A private reviewed anchor proves the RPC serves old canonical USDC state.
 * It is not a promise of future archival availability. */
export async function assertCircleUsdcArchiveHistory(client: PublicClient, pins: {
  chainId: number; asset: Address; tokenCodeHash: Hex; assetImplementation?: CircleImplementationPins;
  archiveAnchor?: CircleArchiveAnchor | undefined;
}): Promise<void> {
  if (!isNativeBaseUsdc(pins.chainId, pins.asset) || !pins.assetImplementation || !pins.archiveAnchor) {
    throw new Error('Reviewed Circle USDC archive pins are required');
  }
  if (await client.getChainId() !== pins.chainId) throw new Error('Historical RPC chain differs');
  const anchor = { number: BigInt(pins.archiveAnchor.number), hash: pins.archiveAnchor.hash,
    timestamp: BigInt(pins.archiveAnchor.timestamp) };
  await assertHistoricalCodeState(client, { anchor, asset: pins.asset,
    codeHash: pins.tokenCodeHash, minimumAgeSeconds: sixHours });
  const historical = { blockHash: anchor.hash, requireCanonical: true } as const;
  const head = await client.getBlock({ blockTag: 'latest' });
  const current = { blockHash: head.hash, requireCanonical: true } as const;
  const [oldProxy, oldMetadata, currentCode, currentProxy, currentMetadata] = await Promise.all([
    matchesCircleProxyPins(client, pins.asset, pins.assetImplementation, historical),
    matchesNativeBaseUsdcMetadata(client, pins.chainId, pins.asset, historical),
    client.getCode({ address: pins.asset, ...current }),
    matchesCircleProxyPins(client, pins.asset, pins.assetImplementation, current),
    matchesNativeBaseUsdcMetadata(client, pins.chainId, pins.asset, current),
  ]);
  if (!oldProxy || !oldMetadata || !currentCode || currentCode === '0x'
    || keccak256(currentCode) !== pins.tokenCodeHash || !currentProxy || !currentMetadata
    || (await client.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash
    || (await client.getBlock({ blockNumber: head.number })).hash !== head.hash) {
    throw new Error('Historical or current Circle USDC deployment differs');
  }
}
