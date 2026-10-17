import { describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { assetFacetPinsSchema, matchesAssetFacetPins, requiresUsdAuthorizationFacet, stableAssetFacetReceiptBlock } from '../src/payments/asset-facets.js';
import { vaultIncomeClientPinsSchema, vaultIncomePublicProfileSchema } from '../src/sdk/vault-income/types.js';
import { reviewedVaultIncomeProfile } from '../src/sdk/vault-income/integrity.js';
import { vaultIncomeProfileSchema } from '../src/payments/vault-income-configured.js';

const facet = '0x08f560a85db40a7d4ac49b4F44f1D38e5B8aB811' as Address;
const robinhoodTestnetUsdg = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address;
const wrong = '0x0000000000000000000000000000000000000001' as Address;
const code = '0x60016000' as Hex;
const blockHash = `0x${'2'.repeat(64)}` as Hex;
const parentHash = `0x${'1'.repeat(64)}` as Hex;
const selectors = ['0xe3ee160e', '0xef55bec6', '0xe94a0102'];

function client(options: { routed?: Address; code?: Hex; logs?: unknown[] } = {}) {
  const readContract = vi.fn(async (request: { args: readonly [Hex]; blockHash?: Hex }) =>
    request.args[0] === '0xef55bec6' && options.routed ? options.routed : facet);
  const getCode = vi.fn(async (_request: { address: Address }) => options.code ?? code);
  const getBlock = vi.fn(async (request: { blockNumber: bigint }) => ({ hash: request.blockNumber === 9n ? parentHash : blockHash }));
  const getLogs = vi.fn(async (_request: { address: Address; blockHash: Hex }) => options.logs ?? []);
  return { value: { readContract, getCode, getBlock, getLogs } as unknown as PublicClient, readContract, getCode, getBlock, getLogs };
}

describe('reviewed USDG authorization facet', () => {
  it('requires an explicit facet pin for the canonical Robinhood testnet USDG address', () => {
    expect(requiresUsdAuthorizationFacet(46630, robinhoodTestnetUsdg)).toBe(true);
    expect(requiresUsdAuthorizationFacet(46630, wrong)).toBe(false);
    expect(requiresUsdAuthorizationFacet(31337, robinhoodTestnetUsdg)).toBe(false);
    expect(assetFacetPinsSchema.safeParse({ address: facet, codeHash: keccak256(code), extra: true }).success).toBe(false);
  });

  it('rejects old USDG payment profiles and requires native Base USDC archive/proxy pins', () => {
    const hash = keccak256(code), pins = {
      chainId: 46630, asset: robinhoodTestnetUsdg, tokenCodeHash: hash, payTo: facet, facilitator: wrong,
      reviewedTokenKind: 'eip1967' as const, assetImplementation: { address: facet, codeHash: hash }, confirmations: 1,
      exact: { reviewedEip3009: true as const, name: 'Global Dollar', version: '1' },
      selection: { chainId: 46630, selectionRegistryAddress: facet, selectionRegistryCodeHash: hash,
        vaultImplementationAddress: facet, vaultImplementationCodeHash: hash, confirmations: 1 },
      agentId: hash, treasury: wrong,
    };
    expect(vaultIncomeClientPinsSchema.safeParse(pins).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...pins, reviewedTokenKind: 'immutable', assetFacet: { address: facet, codeHash: hash } }).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...pins, assetFacet: { address: facet, codeHash: hash } }).success).toBe(false);
    const profile = { pins, facilitatorKeyFile: 'C:/private/facilitator.key', resourceUrl: 'https://pilot.example/x402/vault-income', grossAmount: '101' };
    expect(vaultIncomeProfileSchema.safeParse(profile).success).toBe(false);
    const basePins = { ...pins, chainId: 84532, asset: baseSepoliaUsdc, reviewedTokenKind: 'circle_proxy' as const,
      exact: { reviewedEip3009: true as const, name: 'USDC', version: '2' },
      archiveAnchor: { number: '100', hash, timestamp: '1000' },
      selection: { ...pins.selection, chainId: 84532 } };
    expect(vaultIncomeClientPinsSchema.safeParse(basePins).success).toBe(true);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...basePins, archiveAnchor: undefined }).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...basePins, assetFacet: { address: facet, codeHash: hash } }).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...basePins, asset: wrong }).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...basePins, exact: { ...basePins.exact, name: 'USD Coin' } }).success).toBe(false);
    expect(vaultIncomeClientPinsSchema.safeParse({ ...basePins, exact: { ...basePins.exact, version: '1' } }).success).toBe(false);
    const clientProfile = { resourceUrl: profile.resourceUrl, grossAmount: profile.grossAmount, pins: basePins };
    expect(vaultIncomePublicProfileSchema.safeParse(clientProfile).success).toBe(true);
    expect(reviewedVaultIncomeProfile(clientProfile).pins.archiveAnchor).toEqual(basePins.archiveAnchor);
    expect(vaultIncomeProfileSchema.safeParse({ ...profile, pins: basePins }).success).toBe(true);
    expect(vaultIncomeProfileSchema.safeParse({ ...profile, pins: { ...basePins, archiveAnchor: undefined } }).success).toBe(false);
    expect(vaultIncomeProfileSchema.safeParse({ ...profile, pins: { ...basePins, assetFacet: { address: facet, codeHash: hash } } }).success).toBe(false);
  });

  it('checks every payment and nonce selector, plus facet code at the same canonical block', async () => {
    const rpc = client(), state = { blockHash, requireCanonical: true } as const;
    expect(await matchesAssetFacetPins(rpc.value, robinhoodTestnetUsdg, { address: facet, codeHash: keccak256(code) }, state)).toBe(true);
    expect(rpc.readContract.mock.calls.map(([request]) => request.args[0])).toEqual(selectors);
    for (const [request] of rpc.readContract.mock.calls) expect(request).toMatchObject(state);
    expect(rpc.getCode.mock.calls[0]?.[0]).toMatchObject({ address: facet, ...state });
  });

  it('refuses a route change even when proxy and implementation bytecode are unchanged', async () => {
    const rpc = client({ routed: wrong });
    expect(await matchesAssetFacetPins(rpc.value, robinhoodTestnetUsdg, { address: facet, codeHash: keccak256(code) })).toBe(false);
  });

  it('refuses changed code at the original facet address', async () => {
    const rpc = client({ code: '0x60026000' });
    expect(await matchesAssetFacetPins(rpc.value, robinhoodTestnetUsdg, { address: facet, codeHash: keccak256(code) })).toBe(false);
  });
  it('rejects receipt-block manager updates even when parent and final routes match', async () => {
    const pins = { address: facet, codeHash: keccak256(code) };
    const changed = client({ logs: [{ transactionHash: blockHash }] });
    expect(await stableAssetFacetReceiptBlock(changed.value, robinhoodTestnetUsdg, pins, blockHash, 10n)).toBe(false);
    expect(changed.readContract.mock.calls.every(([request]) => request.blockHash === parentHash)).toBe(true);
    expect(changed.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: robinhoodTestnetUsdg, blockHash }));
    const clean = client();
    expect(await stableAssetFacetReceiptBlock(clean.value, robinhoodTestnetUsdg, pins, blockHash, 10n)).toBe(true);
    expect(clean.getBlock).toHaveBeenCalledWith({ blockNumber: 10n });
  });
});
