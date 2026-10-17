import { createPublicClient, http, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { baseMainnet, baseSepolia, baseUsdcForChainId } from '../src/chain/chains.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, type CircleImplementationPins } from '../src/payments/circle-usdc.js';

export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine(value => !/^0x0{64}$/i.test(value))
  .transform(value => value.toLowerCase() as Hex);
export const implementationPinsSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value))
    .transform(value => value as Address),
  codeHash: hashSchema,
}).strict();
export const publicBaseChainIdSchema = z.union([z.literal(8453), z.literal(84532)]);
export type PublicBaseChainId = z.infer<typeof publicBaseChainIdSchema>;

export function baseChainIdForNetwork(network: string | undefined): PublicBaseChainId {
  if (network === 'base-mainnet') return 8453;
  if (network === 'base-sepolia') return 84532;
  throw new Error('Explicit --network base-mainnet or --network base-sepolia is required');
}

export function safeDeploymentRpcUrl(chainId: PublicBaseChainId, override: string | undefined): string {
  const defaultUrl = chainId === 8453 ? baseMainnet.rpcUrls.default.http[0] : baseSepolia.rpcUrls.default.http[0];
  const url = new URL(override ?? defaultUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !['https:', ...(loopback ? ['http:'] : [])].includes(url.protocol)) {
    throw new Error('Deployment RPC URL must be HTTPS, or loopback HTTP, without credentials or fragment');
  }
  return url.toString();
}

export function publicBaseClient(chainId: PublicBaseChainId, rpcUrl: string) {
  return createPublicClient({ chain: chainId === 8453 ? baseMainnet : baseSepolia,
    transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
}

/** Check one canonical block. All expected hashes must come from the operator's reviewed profile. */
export async function verifyReviewedBaseUsdc(client: PublicClient, chainId: PublicBaseChainId,
  expectedProxyCodeHash: Hex, implementationPins: CircleImplementationPins) {
  const asset = baseUsdcForChainId(chainId)!;
  if (await client.getChainId() !== chainId) throw new Error('Deployment RPC chain differs from selected Base network');
  const block = await client.getBlock();
  const state = { blockHash: block.hash, requireCanonical: true } as const;
  const [proxyCode, proxyMatches, metadataMatches] = await Promise.all([
    client.getCode({ address: asset, ...state }),
    matchesCircleProxyPins(client, asset, implementationPins, state),
    matchesNativeBaseUsdcMetadata(client, chainId, asset, state),
  ]);
  if (!proxyCode || proxyCode === '0x' || keccak256(proxyCode).toLowerCase() !== expectedProxyCodeHash.toLowerCase()
    || !proxyMatches || !metadataMatches || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
    throw new Error('Canonical Circle native USDC differs from reviewed proxy, implementation or metadata');
  }
  return { asset, block, proxyCode };
}
