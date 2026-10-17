import { describe, expect, it, vi } from 'vitest';
import { domainSeparator, keccak256, padHex, stringToHex, type Address, type Hex, type PublicClient } from 'viem';
import { baseMainnetUsdc, baseSepoliaUsdc } from '../src/chain/chains.js';
import { assertCircleUsdcArchiveHistory } from '../src/payments/circle-usdc-archive.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT, matchesCircleProxyPins, matchesNativeBaseUsdcMetadata,
  stableCircleProxyReceiptBlock } from '../src/payments/circle-usdc.js';

const implementation = '0x1111111111111111111111111111111111111111' as Address;
const code = '0x6001600055' as Hex, codeHash = keccak256(code);
const proxyCode = '0x6002600055' as Hex, proxyHash = keccak256(proxyCode);
const blockHash = `0x${'a'.repeat(64)}` as Hex, parentHash = `0x${'b'.repeat(64)}` as Hex;
const pins = { address: implementation, codeHash };

function rpc(options: { pointer?: Address; code?: Hex; upgrades?: unknown[]; canonical?: boolean;
  name?: string; chainId?: number; headTimestamp?: bigint } = {}) {
  const chainId = options.chainId ?? 8453, asset = chainId === 8453 ? baseMainnetUsdc : baseSepoliaUsdc;
  const name = options.name ?? (chainId === 8453 ? 'USD Coin' : 'USDC');
  const getStorageAt = vi.fn(async (request: { slot: Hex }) => request.slot === CIRCLE_PROXY_IMPLEMENTATION_SLOT
    ? padHex(options.pointer ?? implementation, { size: 32 }) : padHex('0x', { size: 32 }));
  const getCode = vi.fn(async (request: { address: Address }) => request.address.toLowerCase() === asset.toLowerCase()
    ? proxyCode : options.code ?? code);
  const getBlock = vi.fn(async (request: { blockNumber?: bigint; blockTag?: string }) => {
    if (request.blockTag === 'latest' || request.blockNumber === 200n) {
      return { number: 200n, hash: options.canonical === false && request.blockNumber === 200n ? parentHash : blockHash,
        timestamp: options.headTimestamp ?? 30_000n };
    }
    return { number: 100n, hash: parentHash, timestamp: 1_000n };
  });
  const getLogs = vi.fn(async () => options.upgrades ?? []);
  const readContract = vi.fn(async (request: { functionName: string }) => {
    switch (request.functionName) {
      case 'name': return name;
      case 'symbol': return 'USDC';
      case 'version': return '2';
      case 'decimals': return 6;
      case 'DOMAIN_SEPARATOR': return domainSeparator({ domain: { name, version: '2', chainId, verifyingContract: asset } });
      default: throw new Error('Unexpected metadata call');
    }
  });
  const getChainId = vi.fn(async () => chainId);
  // REASON: Only the viem methods exercised by the verifier are supplied by this deterministic RPC stub.
  const client = { getStorageAt, getCode, getBlock, getLogs, readContract, getChainId } as unknown as PublicClient;
  return { client, getStorageAt, getCode, getBlock, getLogs, readContract };
}

describe('Circle native Base USDC pins', () => {
  it('uses Circle zeppelinos implementation storage rather than EIP-1967', async () => {
    expect(CIRCLE_PROXY_IMPLEMENTATION_SLOT).toBe(keccak256(stringToHex('org.zeppelinos.proxy.implementation')));
    const value = rpc();
    expect(await matchesCircleProxyPins(value.client, baseMainnetUsdc, pins,
      { blockHash, requireCanonical: true })).toBe(true);
    expect(value.getStorageAt).toHaveBeenCalledWith({ address: baseMainnetUsdc,
      slot: CIRCLE_PROXY_IMPLEMENTATION_SLOT, blockHash, requireCanonical: true });
    expect(await matchesCircleProxyPins(rpc({ pointer: baseMainnetUsdc }).client, baseMainnetUsdc, pins)).toBe(false);
    expect(await matchesCircleProxyPins(rpc({ code: '0x6003' }).client, baseMainnetUsdc, pins)).toBe(false);
  });

  it('enforces the distinct Base mainnet and Sepolia EIP-712 names and version', async () => {
    expect(await matchesNativeBaseUsdcMetadata(rpc().client, 8453, baseMainnetUsdc,
      { blockHash, requireCanonical: true })).toBe(true);
    expect(await matchesNativeBaseUsdcMetadata(rpc({ chainId: 84532 }).client, 84532, baseSepoliaUsdc)).toBe(true);
    expect(await matchesNativeBaseUsdcMetadata(rpc({ name: 'USDC' }).client, 8453, baseMainnetUsdc)).toBe(false);
    expect(await matchesNativeBaseUsdcMetadata(rpc().client, 8453, baseSepoliaUsdc)).toBe(false);
  });

  it('rejects an upgrade and rollback in the payment block and a reorged block', async () => {
    const clean = rpc();
    expect(await stableCircleProxyReceiptBlock(clean.client, baseMainnetUsdc, proxyHash, pins, blockHash, 200n)).toBe(true);
    expect(clean.getStorageAt.mock.calls.some(([request]) => request.slot === CIRCLE_PROXY_IMPLEMENTATION_SLOT
      && 'blockHash' in request && request.blockHash === parentHash)).toBe(true);
    const upgraded = rpc({ upgrades: [{ transactionHash: blockHash }] });
    expect(await stableCircleProxyReceiptBlock(upgraded.client, baseMainnetUsdc, proxyHash, pins, blockHash, 200n)).toBe(false);
    expect(upgraded.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: baseMainnetUsdc, blockHash }));
    expect(await stableCircleProxyReceiptBlock(rpc({ canonical: false }).client,
      baseMainnetUsdc, proxyHash, pins, blockHash, 200n)).toBe(false);
  });

  it('requires an old, canonical anchor with the same proxy, implementation and domain as current', async () => {
    const anchor = { number: '100', hash: parentHash, timestamp: '1000' };
    await expect(assertCircleUsdcArchiveHistory(rpc().client, { chainId: 8453, asset: baseMainnetUsdc,
      tokenCodeHash: proxyHash, assetImplementation: pins, archiveAnchor: anchor })).resolves.toBeUndefined();
    await expect(assertCircleUsdcArchiveHistory(rpc({ headTimestamp: 20_000n }).client,
      { chainId: 8453, asset: baseMainnetUsdc, tokenCodeHash: proxyHash,
        assetImplementation: pins, archiveAnchor: anchor })).rejects.toThrow('retention horizon');
    await expect(assertCircleUsdcArchiveHistory(rpc({ pointer: baseSepoliaUsdc }).client,
      { chainId: 8453, asset: baseMainnetUsdc, tokenCodeHash: proxyHash,
        assetImplementation: pins, archiveAnchor: anchor })).rejects.toThrow('deployment differs');
  });
});
