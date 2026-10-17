import { createPublicClient, custom, getContractAddress, keccak256, toHex, type EIP1193Provider } from 'viem';
import { legacyDeploymentPlanDigest } from '../../scripts/deployment-approval.js';
import { verifyReviewedBaseUsdc } from '../../scripts/base-usdc-deployment.js';
import { baseMainnet, baseMainnetUsdc } from '../chain/chains.js';
import { ownerWalletReviewSchema, type OwnerWalletReview } from './owner-wallet-types.js';
import { ownerWalletFeeBudget } from './owner-wallet-fees.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireFact(test: unknown, message: string): asserts test { if (!test) throw new Error(message); }
export function isOwnerWalletProvider(value: unknown): value is EIP1193Provider {
  return typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'function';
}
export function checkOwnerWalletReview(raw: unknown, expectedDigest: string, nowMs = Date.now(), requireFunding = true): OwnerWalletReview {
  const review = ownerWalletReviewSchema.parse(raw), { plan, trust, gas } = review;
  requireFact(same(plan.reviewDigest, expectedDigest) && same(trust.reviewDigest, expectedDigest)
    && same(legacyDeploymentPlanDigest(plan), expectedDigest), 'The reviewed deployment identity changed');
  requireFact(same(plan.reviewedAsset.address, baseMainnetUsdc) && same(plan.transaction.from, trust.owner)
    && same(plan.quoteSigner, trust.signer) && same(plan.receiptSigner, trust.signer) && same(plan.treasury, trust.treasury)
    && same(keccak256(plan.transaction.data), plan.creationCodeHash)
    && same(getContractAddress({ from: trust.owner, nonce: BigInt(plan.transaction.nonce) }), plan.predictedEscrowAddress),
  'The reviewed creation bytes, roles or predicted address changed');
  requireFact(review.reviewedAtMs <= nowMs && nowMs < review.expiresAtMs
    && review.expiresAtMs - review.reviewedAtMs <= 30_000, 'Deployment review expired; refresh the read-only checks');
  requireFact(BigInt(gas.limit) >= BigInt(gas.estimated) && BigInt(gas.limit) <= BigInt(trust.maxGas)
    && BigInt(gas.maxFeePerGasWei) <= BigInt(trust.maxFeePerGasWei)
    && BigInt(gas.maxPriorityFeePerGasWei) <= BigInt(gas.maxFeePerGasWei)
    && BigInt(gas.l2GasBudgetWei) === BigInt(gas.limit) * BigInt(gas.maxFeePerGasWei)
    && BigInt(gas.totalGasBudgetWei) === BigInt(gas.l2GasBudgetWei) + BigInt(gas.l1DataFeeUpperBoundWei) + BigInt(gas.operatorFeeWei)
    && BigInt(gas.totalGasBudgetWei) <= BigInt(trust.maxTotalGasBudgetWei), 'Reviewed gas bounds changed');
  if (requireFunding) requireFact(review.status === 'ready_for_owner_wallet' && !gas.balanceOverrideUsed
    && BigInt(gas.nativeBalanceWei) >= BigInt(gas.totalGasBudgetWei), 'Owner funding is not ready');
  return review;
}
/** Read-only wallet RPCs only. The caller must separately and explicitly invoke
 * eth_sendTransaction; this helper never requests a signature or sends a tx. */
export async function prepareOwnerWalletRequest(raw: unknown, provider: EIP1193Provider, expectedDigest: string,
  now: () => number = Date.now) {
  const review = checkOwnerWalletReview(raw, expectedDigest, now()), { plan, trust, gas } = review;
  const accounts = await provider.request({ method: 'eth_accounts' });
  requireFact(accounts.length === 1 && same(accounts[0]!, trust.owner), 'Select only the exact reviewed owner account');
  const client = createPublicClient({ chain: baseMainnet, transport: custom(provider, { retryCount: 0 }) });
  requireFact(await client.getChainId() === 8453, 'Wallet must already be on Base mainnet 8453');
  requireFact(same((await client.getBlock({ blockNumber: BigInt(plan.referenceBlock) })).hash, plan.referenceHash),
    'Wallet RPC disagrees with the original reviewed block');
  const { block } = await verifyReviewedBaseUsdc(client, 8453, plan.reviewedAsset.proxyCodeHash, plan.reviewedAsset.implementation);
  const state = { blockHash: block.hash, requireCanonical: true } as const;
  const [code, vacant, latest, pending, balance, estimated, fees] = await Promise.all([
    client.getCode({ address: trust.owner, ...state }), client.getCode({ address: plan.predictedEscrowAddress, ...state }),
    client.getTransactionCount({ address: trust.owner, blockNumber: block.number }),
    client.getTransactionCount({ address: trust.owner, blockTag: 'pending' }), client.getBalance({ address: trust.owner, blockNumber: block.number }),
    client.estimateGas({ account: trust.owner, data: plan.transaction.data, value: 0n, nonce: plan.transaction.nonce,
      maxFeePerGas: BigInt(gas.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(gas.maxPriorityFeePerGasWei) }),
    ownerWalletFeeBudget(client, state, plan, BigInt(gas.limit), BigInt(gas.maxFeePerGasWei), BigInt(gas.maxPriorityFeePerGasWei)),
  ]);
  requireFact((!code || code === '0x') && (!vacant || vacant === '0x') && latest === plan.transaction.nonce
    && pending === plan.transaction.nonce, 'Wallet owner code, nonce or deployment vacancy changed');
  requireFact(estimated > 0n && estimated <= BigInt(gas.limit) && balance >= BigInt(gas.totalGasBudgetWei)
    && fees.unsignedTransactionBytes === gas.unsignedTransactionBytes
    && BigInt(fees.l1DataFeeUpperBoundWei) <= BigInt(gas.l1DataFeeUpperBoundWei)
    && BigInt(fees.operatorFeeWei) <= BigInt(gas.operatorFeeWei)
    && BigInt(fees.totalGasBudgetWei) <= BigInt(gas.totalGasBudgetWei),
    'Wallet gas estimate, total Base fee or ETH balance changed; refresh review');
  const [canonical, finalNonce, finalPending] = await Promise.all([
    client.getBlock({ blockNumber: block.number }), client.getTransactionCount({ address: trust.owner, blockTag: 'latest' }),
    client.getTransactionCount({ address: trust.owner, blockTag: 'pending' }),
  ]);
  requireFact(same(canonical.hash, block.hash) && finalNonce === plan.transaction.nonce && finalPending === plan.transaction.nonce,
    'Wallet snapshot or nonce changed during checks');
  checkOwnerWalletReview(review, expectedDigest, now());
  const finalAccounts = await provider.request({ method: 'eth_accounts' });
  requireFact(finalAccounts.length === 1 && same(finalAccounts[0]!, trust.owner) && await client.getChainId() === 8453,
    'Wallet account or chain changed immediately before deployment');
  return Object.freeze({ from: trust.owner, chainId: '0x2105' as const, type: '0x2' as const,
    data: plan.transaction.data, value: '0x0' as const, nonce: toHex(plan.transaction.nonce),
    gas: toHex(BigInt(gas.limit)), maxFeePerGas: toHex(BigInt(gas.maxFeePerGasWei)),
    maxPriorityFeePerGas: toHex(BigInt(gas.maxPriorityFeePerGasWei)) });
}
