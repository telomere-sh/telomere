import { createPublicClient, defineChain, http, keccak256, parseAbi,
  type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { tokenAbi } from '../chain/abi.js';
import { sameAddress } from '../common.js';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock } from '../payments/asset-facets.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from '../payments/circle-usdc.js';
import { platformEscrowAbi, platformHostRegistryAbi, platformPinsSchema, type PlatformPins } from './types.js';
import { checkPlatformEconomicsAt } from '../economics/profile.js';
import { checkSpendPermissionDeploymentAt } from '../payments/spend-permissions.js';
import { checkX402CpuDeploymentAt } from '../payments/cpu-reservations.js';

const routerAbi = parseAbi(['function controller() view returns (address)']);
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

/** Shared by the financial writer and independent readers; no wallet or store is used. */
export async function checkPlatformAsset(client: PublicClient, pins: PlatformPins, blockHash: Hex): Promise<void> {
  const state = { blockHash, requireCanonical: true } as const;
  const code = await client.getCode({ address: pins.tokenAddress, ...state });
  if (!code || keccak256(code) !== pins.tokenCodeHash) throw new Error('Platform payment asset code pin changed');
  if (pins.reviewedTokenKind === 'eip1967') {
    const implementation = pins.assetImplementation;
    if (!implementation) throw new Error('Platform payment asset implementation pin missing');
    const [slot, implementationCode] = await Promise.all([
      client.getStorageAt({ address: pins.tokenAddress, slot: implementationSlot, ...state }),
      client.getCode({ address: implementation.address, ...state }),
    ]);
    if (!slot || !sameAddress(`0x${slot.slice(-40)}`, implementation.address)
      || !implementationCode || keccak256(implementationCode) !== implementation.codeHash) {
      throw new Error('Platform payment asset implementation pin changed');
    }
  }
  if (pins.reviewedTokenKind === 'circle_proxy') {
    const implementation = pins.assetImplementation;
    if (!implementation || !await matchesCircleProxyPins(client, pins.tokenAddress, implementation, state)) {
      throw new Error('Platform payment asset implementation pin changed');
    }
    if (pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(client, pins.chainId, pins.tokenAddress, state)) {
      throw new Error('Platform payment asset metadata or domain changed');
    }
  }
  if (pins.assetFacet && !await matchesAssetFacetPins(client, pins.tokenAddress, pins.assetFacet, state)) {
    throw new Error('Platform payment asset facet pin changed');
  }
  if (await client.readContract({ address: pins.tokenAddress, abi: tokenAbi,
    functionName: 'decimals', ...state }) !== 6) throw new Error('Platform payment asset decimals changed');
}

export async function checkPlatformDeployment(client: PublicClient, pins: PlatformPins): Promise<void> {
  if (await client.getChainId() !== pins.chainId) throw new Error('Platform chain pin changed');
  const snapshot = await client.getBlock();
  const state = { blockHash: snapshot.hash, requireCanonical: true } as const;
  await checkPlatformAsset(client, pins, snapshot.hash);
  for (const [address, expected] of [[pins.escrowAddress, pins.escrowCodeHash],
    [pins.receiptRootAddress, pins.receiptRootCodeHash], [pins.hostRegistryAddress, pins.hostRegistryCodeHash],
    [pins.feeRouterAddress, pins.feeRouterCodeHash]] as const) {
    const code = await client.getCode({ address, ...state });
    if (!code || code === '0x' || keccak256(code) !== expected) throw new Error('Platform contract code pin changed');
  }
  const read = (functionName: 'token' | 'quoteSigner' | 'receiptRoot' | 'hostRegistry' | 'feeRouter') =>
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName, ...state });
  const [token, signer, roots, hosts, router, decimals, hostController, rootRef, routerController,
    maxRunCeiling, maxLeashDay, maxTotalEscrow] = await Promise.all([
    read('token'), read('quoteSigner'), read('receiptRoot'), read('hostRegistry'), read('feeRouter'),
    client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'decimals', ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'controller', ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'evidenceRoot', ...state }),
    client.readContract({ address: pins.feeRouterAddress, abi: routerAbi, functionName: 'controller', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_RUN_CEILING', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_LEASH_DAY', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_TOTAL_ESCROW', ...state }),
  ]);
  if (![[token, pins.tokenAddress], [signer, pins.quoteSigner], [roots, pins.receiptRootAddress],
    [hosts, pins.hostRegistryAddress], [router, pins.feeRouterAddress], [hostController, pins.escrowAddress],
    [rootRef, pins.receiptRootAddress], [routerController, pins.escrowAddress]].every(([actual, expected]) =>
    actual !== undefined && expected !== undefined && actual.toLowerCase() === expected.toLowerCase()) || decimals !== 6) {
    throw new Error('Platform contract relationships differ from reviewed pins');
  }
  if (maxRunCeiling !== 250_000_000n || maxLeashDay !== 1_000_000_000n
    || maxTotalEscrow !== 500_000_000_000n) throw new Error('Platform escrow limits differ from reviewed policy');
  await checkPlatformEconomicsAt(client, pins, snapshot.hash);
  await checkSpendPermissionDeploymentAt(client, pins, snapshot.hash);
  await checkX402CpuDeploymentAt(client, pins, snapshot.hash);
  if ((await client.getBlock({ blockNumber: snapshot.number })).hash !== snapshot.hash) {
    throw new Error('Platform deployment snapshot is no longer canonical');
  }
}

export async function canonicalPlatformReceipt(client: PublicClient, pins: PlatformPins,
  hash: Hex, destination?: Address): Promise<TransactionReceipt> {
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.transactionHash !== hash || receipt.status !== 'success'
    || (destination && receipt.to?.toLowerCase() !== destination.toLowerCase())
    || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('Platform transaction is not canonical');
  }
  await checkPlatformAsset(client, pins, receipt.blockHash);
  if (pins.assetFacet && !await stableAssetFacetReceiptBlock(client, pins.tokenAddress,
    pins.assetFacet, receipt.blockHash, receipt.blockNumber)) throw new Error('Platform payment asset changed in transaction block');
  if (pins.reviewedTokenKind === 'circle_proxy' && pins.assetImplementation
    && !await stableCircleProxyReceiptBlock(client, pins.tokenAddress, pins.tokenCodeHash,
      pins.assetImplementation, receipt.blockHash, receipt.blockNumber)) {
    throw new Error('Platform payment asset changed in transaction block');
  }
  return receipt;
}

/** Creates only an RPC reader from independently reviewed public deployment pins. */
export function createPlatformReadOnlyBridge(rawPins: unknown, rpcUrl: string, signal?: AbortSignal) {
  const pins = platformPinsSchema.parse(rawPins), url = new URL(rpcUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Platform RPC requires HTTPS or loopback');
  }
  if (pins.chainId === 31337 && !loopback) throw new Error('Local platform chain requires loopback');
  const chain = defineChain({ id: pins.chainId, name: 'Telomere reviewed platform',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url.href] } } });
  const client = createPublicClient({ chain, cacheTime: 0, transport: http(url.href, {
    timeout: 10_000, retryCount: 0,
    ...(signal ? { fetchFn: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init,
      signal: AbortSignal.any(init?.signal ? [signal, init.signal] : [signal]) }) } : {}),
  }) });
  return { pins, public: client, check: () => checkPlatformDeployment(client, pins),
    canonicalReceipt: (hash: Hex, destination?: Address) => canonicalPlatformReceipt(client, pins, hash, destination) };
}
