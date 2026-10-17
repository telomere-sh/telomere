import { createPublicClient, createWalletClient, domainSeparator, http, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { chainForId } from '../chain/chains.js';
import type { Config } from '../config.js';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { RpcIncomeEndpointReader } from '../selection/income-endpoints/reader.js';
import { incomeAddressSchema, incomeEndpointPinsSchema, incomeHashSchema } from '../selection/income-endpoints/types.js';
import { paymentJournal } from './schema.js';
import { X402PaymentService } from './service.js';
import { EvmVaultIncomeChain } from './vault-income-chain.js';
import { privateVaultIncomeText } from './vault-income-private-file.js';
import { vaultIncomeRpcFetch } from './vault-income-rpc.js';
import { assetFacetPinsSchema, matchesAssetFacetPins } from './asset-facets.js';
import { assertCircleUsdcArchiveHistory } from './circle-usdc-archive.js';
import { isNativeBaseUsdc, matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, nativeBaseUsdcName } from './circle-usdc.js';

export const VAULT_INCOME_RESOURCE_PATH = '/x402/vault-income';
export const VAULT_INCOME_ADMIN_PATH = '/api/payments/vault-income';
export const vaultIncomeProfileSchema = z.object({
  pins: z.object({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), asset: incomeAddressSchema,
    tokenCodeHash: incomeHashSchema, payTo: incomeAddressSchema, facilitator: incomeAddressSchema,
    reviewedTokenKind: z.enum(['immutable', 'eip1967', 'circle_proxy']),
    assetImplementation: z.object({ address: incomeAddressSchema, codeHash: incomeHashSchema }).strict().optional(),
    assetFacet: assetFacetPinsSchema.optional(),
    archiveAnchor: z.object({ number: z.string().regex(/^[1-9][0-9]{0,19}$/), hash: incomeHashSchema,
      timestamp: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().optional(),
    confirmations: z.number().int().min(1).max(64),
    exact: z.object({ reviewedEip3009: z.literal(true), name: z.string().min(1).max(100), version: z.string().min(1).max(30) }).strict(),
    selection: incomeEndpointPinsSchema, agentId: incomeHashSchema, treasury: incomeAddressSchema,
  }).strict(), facilitatorKeyFile: z.string().min(1).max(4096), resourceUrl: z.string().min(1).max(2048),
  grossAmount: z.string().regex(/^[1-9][0-9]{0,28}$/).refine(value => BigInt(value) < 2n ** 96n),
  maximumChallenges: z.number().int().min(1).max(10_000).default(10_000), localFixture: z.boolean().default(false),
}).strict().superRefine((profile, context) => {
  const pins = profile.pins;
  if (![31337, 8453, 84532].includes(pins.chainId)
    || pins.reviewedTokenKind !== 'immutable' && !pins.assetImplementation
    || pins.reviewedTokenKind === 'immutable' && (!!pins.assetImplementation || !!pins.assetFacet)
    || pins.reviewedTokenKind === 'circle_proxy' && !!pins.assetFacet
    || pins.chainId === 31337 && !!pins.archiveAnchor
    || pins.chainId !== 31337 && (!isNativeBaseUsdc(pins.chainId, pins.asset)
      || pins.reviewedTokenKind !== 'circle_proxy' || !pins.assetImplementation || !!pins.assetFacet
      || !pins.archiveAnchor || pins.exact.name !== nativeBaseUsdcName(pins.chainId) || pins.exact.version !== '2')) {
    context.addIssue({ code: 'custom', message: 'Reviewed Circle USDC proxy and archive pins required.' });
  }
});
export type VaultIncomeProfile = z.infer<typeof vaultIncomeProfileSchema>;
const registryAbi = parseAbi(['function controller() view returns(address)', 'function treasury() view returns(address)']);
const tokenAbi = parseAbi(['function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)']);
const vaultAbi = parseAbi(['function usedIncomeAuthorization(bytes32) view returns(bool)']);
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const loopback = (url: URL) => ['127.0.0.1', '[::1]'].includes(url.hostname);
const zero = `0x${'0'.repeat(64)}` as const;

/** Optional, fixed-price inbound receipt. No agent work or endpoint-control claim is made. */
export async function configuredVaultIncome(config: Config, db: Database, otherSigners: readonly string[] = []) {
  if (!config.VAULT_INCOME_CONFIG) return undefined;
  try {
    const profile = vaultIncomeProfileSchema.parse(incomeStrictJson(await privateVaultIncomeText(config.VAULT_INCOME_CONFIG, 8192)));
    const resource = new URL(profile.resourceUrl), rpc = new URL(config.RPC_URL);
    if (profile.resourceUrl !== config.PUBLIC_ORIGIN + VAULT_INCOME_RESOURCE_PATH || resource.href !== profile.resourceUrl
      || resource.username || resource.password || resource.search || resource.hash || rpc.username || rpc.password || rpc.hash
      || profile.pins.chainId !== config.CHAIN_ID || !equal(profile.pins.asset, config.TOKEN_ADDRESS)) throw new Error('Profile environment differs');
    if (profile.localFixture) {
      if (config.MODE !== 'demo' || config.CHAIN_ID !== 31337 || !loopback(resource) || !loopback(rpc)
        || resource.protocol !== 'http:' || rpc.protocol !== 'http:') throw new Error('Local-only fixture differs');
    } else if (!['testnet', 'mainnet'].includes(config.MODE)
      || config.CHAIN_ID !== (config.MODE === 'mainnet' ? 8453 : 84532)
      || resource.protocol !== 'https:' || rpc.protocol !== 'https:') throw new Error('Reviewed HTTPS Base profile required');
    const key = await privateVaultIncomeText(profile.facilitatorKeyFile, 80);
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Private signer encoding differs');
    const account = privateKeyToAccount(key as `0x${string}`);
    const denied = [privateKeyToAccount(config.SIGNER_PRIVATE_KEY).address, ...otherSigners,
      ...(config.DEMO_PRIVATE_KEY ? [privateKeyToAccount(config.DEMO_PRIVATE_KEY).address] : [])];
    if (!equal(account.address, profile.pins.facilitator) || denied.some(value => equal(value, account.address))) throw new Error('Dedicated signer differs');
    const chainDefinition = chainForId(config.CHAIN_ID), transport = http(config.RPC_URL, { retryCount: 0, timeout: 10_000, fetchFn: vaultIncomeRpcFetch });
    const client = createPublicClient({ chain: chainDefinition, transport, cacheTime: 0 });
    const wallet = createWalletClient({ account, chain: chainDefinition, transport });
    // Constructor also validates native-only pins and rejects Permit2/up-to profiles.
    const { assetImplementation, assetFacet, ...basePins } = profile.pins;
    const chain = new EvmVaultIncomeChain(client, wallet, { ...basePins, ...(assetImplementation ? { assetImplementation } : {}),
      ...(assetFacet ? { assetFacet } : {}) }, { rpcUrl: config.RPC_URL });
    if (chain.pins.chainId !== 31337) await assertCircleUsdcArchiveHistory(client, chain.pins);
    const reader = new RpcIncomeEndpointReader({ rpcUrl: config.RPC_URL, pins: chain.pins.selection, asset: chain.pins.asset });
    async function check() {
      const snapshot = await reader.snapshot(chain.pins.agentId), state = { blockHash: snapshot.block.hash, requireCanonical: true } as const;
      const [controller, treasury, tokenCode, signerCode, decimals, separator] = await Promise.all([
        client.readContract({ address: chain.pins.selection.selectionRegistryAddress, abi: registryAbi, functionName: 'controller', ...state }),
        client.readContract({ address: chain.pins.selection.selectionRegistryAddress, abi: registryAbi, functionName: 'treasury', ...state }),
        client.getCode({ address: chain.pins.asset, ...state }), client.getCode({ address: account.address, ...state }),
        client.readContract({ address: chain.pins.asset, abi: tokenAbi, functionName: 'decimals', ...state }),
        client.readContract({ address: chain.pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
        client.readContract({ address: chain.pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization', args: [zero], ...state }),
      ]);
      if (!equal(snapshot.binding.vault, chain.pins.payTo) || !equal(treasury, chain.pins.treasury)
        || [controller, treasury, snapshot.binding.owner, snapshot.binding.agentWallet, ...denied].some(value => equal(value, account.address))
        || signerCode && signerCode !== '0x' || !tokenCode || keccak256(tokenCode) !== chain.pins.tokenCodeHash || decimals !== 6
        || separator !== domainSeparator({ domain: { name: chain.pins.exact.name, version: chain.pins.exact.version,
          chainId: chain.pins.chainId, verifyingContract: chain.pins.asset } })) throw new Error('Reviewed ingress authority differs');
      if (chain.pins.reviewedTokenKind === 'eip1967') {
        const implementation = chain.pins.assetImplementation; if (!implementation) throw new Error('Reviewed implementation missing');
        const [slot, code] = await Promise.all([
          client.getStorageAt({ address: chain.pins.asset, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ...state }),
          client.getCode({ address: implementation.address, ...state }),
        ]);
        if (!slot || !equal(`0x${slot.slice(-40)}`, implementation.address) || !code || keccak256(code) !== implementation.codeHash) throw new Error('Reviewed implementation differs');
      }
      if (chain.pins.reviewedTokenKind === 'circle_proxy') {
        const implementation = chain.pins.assetImplementation;
        if (!implementation || !await matchesCircleProxyPins(client, chain.pins.asset, implementation, state)
          || chain.pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(client,
            chain.pins.chainId, chain.pins.asset, state)) throw new Error('Reviewed Circle USDC asset differs');
      }
      if (chain.pins.assetFacet && !await matchesAssetFacetPins(client, chain.pins.asset, chain.pins.assetFacet, state)) throw new Error('Reviewed facet differs');
      if (chain.pins.assetFacet || chain.pins.reviewedTokenKind === 'circle_proxy') {
        // The confirmed selection snapshot can lag an asset route change by the
        // confirmation window. Challenge intake must also check the current head.
        const head = await client.getBlock({ blockTag: 'latest' });
        const current = { blockHash: head.hash, requireCanonical: true } as const;
        const implementation = chain.pins.assetImplementation, facet = chain.pins.assetFacet;
        const [currentCode, currentDecimals, currentDomain, currentImplementation, currentFacet, currentMetadata] = await Promise.all([
          client.getCode({ address: chain.pins.asset, ...current }),
          client.readContract({ address: chain.pins.asset, abi: tokenAbi, functionName: 'decimals', ...current }),
          client.readContract({ address: chain.pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...current }),
          chain.pins.reviewedTokenKind === 'circle_proxy' && implementation
            ? matchesCircleProxyPins(client, chain.pins.asset, implementation, current) : true,
          facet ? matchesAssetFacetPins(client, chain.pins.asset, facet, current) : true,
          chain.pins.reviewedTokenKind === 'circle_proxy' && chain.pins.chainId !== 31337
            ? matchesNativeBaseUsdcMetadata(client, chain.pins.chainId, chain.pins.asset, current) : true,
        ]);
        if (!currentCode || keccak256(currentCode) !== chain.pins.tokenCodeHash || currentDecimals !== 6
          || currentDomain !== domainSeparator({ domain: { name: chain.pins.exact.name, version: chain.pins.exact.version,
            chainId: chain.pins.chainId, verifyingContract: chain.pins.asset } })
          || !currentImplementation || !currentFacet || !currentMetadata
          || !equal((await client.getBlock({ blockNumber: head.number })).hash, head.hash)) throw new Error('Current payment asset deployment differs');
      }
      await reader.canonical(snapshot.block); return snapshot;
    }
    await check();
    // A dedicated signer must not share a retained nonce journal with another payment destination.
    const retained = await db.select().from(paymentJournal).where(sql`lower(${paymentJournal.signer}) = ${account.address.toLowerCase()}`).limit(10_001);
    if (retained.length > 10_000) throw new Error('Dedicated signer journal capacity differs');
    for (const row of retained) {
      if (!row.raw || !row.hash || row.nonce === null) throw new Error('Dedicated signer journal has no native transaction');
      if (!/^0x[0-9a-fA-F]+$/.test(row.raw)) throw new Error('Dedicated signer journal encoding differs');
      const transaction = parseTransaction(row.raw as Hex);
      if (!transaction.to || !equal(transaction.to, chain.pins.payTo) || transaction.chainId !== chain.pins.chainId
        || row.network !== `eip155:${chain.pins.chainId}`) throw new Error('Signer journal belongs to another ingress');
    }
    const payments = new X402PaymentService(db, chain, Date.now, { maximumChallenges: profile.maximumChallenges });
    await payments.initialize();
    return { profile, payments, check, async authorize(principal: string): Promise<void> {
      const snapshot = await check();
      if (!equal(principal, snapshot.binding.owner) && !equal(principal, snapshot.binding.agentWallet)) throw new Problem(403, 'vault_income_principal_required', 'Use the registered owner or agent session.');
    } };
  } catch { throw new Error('Vault income configuration or reviewed deployment is unavailable'); }
}
export type ConfiguredVaultIncome = NonNullable<Awaited<ReturnType<typeof configuredVaultIncome>>>;
