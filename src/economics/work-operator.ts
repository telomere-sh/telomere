import { encodeFunctionData, keccak256, parseAbi, type PublicClient } from 'viem';
import { z } from 'zod';
import { sameAddress } from '../common.js';
import { checkPlatformAsset, checkPlatformDeployment } from '../platform-runtime/read-only.js';
import { platformPinsSchema, type PlatformPins } from '../platform-runtime/types.js';
import { buildWeeklyWorkAllocation, workAllocationPolicySchema, type WorkActivityVerifier,
  type WorkAllocationPolicy } from './work-allocation.js';

const abi = parseAbi(['struct Buckets { uint256 work; uint256 treasury; uint256 stakers; uint256 buyAndBurn; }',
  'function getBuckets(uint64 week) view returns (Buckets)', 'function workAllocator() view returns (address)',
  'function workDistribution(uint64 week) view returns (bytes32 root,uint256 allocated,uint256 claimed)',
  'function postWorkRoot(uint64 week,bytes32 root,uint256 allocated)']);
const zero = `0x${'0'.repeat(64)}`;

/** Read-only weekly operator boundary. Derives the closed week and spendable
 * budget from one confirmed canonical router snapshot, then returns exact
 * unsigned calldata for its immutable allocator. Never posts or signs a root. */
export async function prepareWeeklyWorkAllocation(input: {
  client: PublicClient; pins: PlatformPins; policy: WorkAllocationPolicy; week: number;
  handles: readonly unknown[]; verifier: WorkActivityVerifier; minConfirmations?: number;
}) {
  const pins = platformPinsSchema.parse(input.pins), policy = workAllocationPolicySchema.parse(input.policy);
  const week = z.number().int().nonnegative().safe().parse(input.week);
  const depth = z.number().int().min(1).max(128).parse(input.minConfirmations ?? 12);
  if (policy.chainId !== pins.chainId || !sameAddress(policy.router, pins.feeRouterAddress)) throw new Error('Work allocation policy differs from reviewed financial deployment');
  await checkPlatformDeployment(input.client, pins);
  const head = await input.client.getBlockNumber({ cacheTime: 0 });
  if (head + 1n < BigInt(depth)) throw new Error('Work allocation lacks confirmed chain history');
  const anchor = await input.client.getBlock({ blockNumber: head - BigInt(depth - 1) });
  if (BigInt(week + 1) * 604800n > anchor.timestamp) throw new Error('Work allocation week is not canonically closed');
  const state = { blockHash: anchor.hash, requireCanonical: true } as const;
  await checkPlatformAsset(input.client, pins, anchor.hash);
  const code = await input.client.getCode({ address: pins.feeRouterAddress, ...state });
  if (!code || code === '0x' || keccak256(code) !== pins.feeRouterCodeHash) throw new Error('Historical work router differs from reviewed pins');
  const [buckets, distribution, allocator] = await Promise.all([
    input.client.readContract({ address: pins.feeRouterAddress, abi, functionName: 'getBuckets', args: [BigInt(week)], ...state }),
    input.client.readContract({ address: pins.feeRouterAddress, abi, functionName: 'workDistribution', args: [BigInt(week)], ...state }),
    input.client.readContract({ address: pins.feeRouterAddress, abi, functionName: 'workAllocator', ...state }),
  ]);
  const existing = distribution[0] !== zero;
  const budget = existing ? distribution[1] : buckets.work;
  if (budget === 0n) throw new Error('Closed work bucket has no payable budget');
  const plan = await buildWeeklyWorkAllocation({ policy, week, budget: budget.toString(),
    closedWeek: Number(anchor.timestamp / 604800n - 1n), handles: input.handles, verifier: input.verifier });
  if (existing && (distribution[0] !== plan.root || distribution[1] !== BigInt(plan.allocated))) throw new Error('Original weekly work commitment differs; never replace or relabel it');
  if ((await input.client.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw new Error('Weekly work snapshot reorged during preparation');
  return { ...plan, status: existing ? 'already_committed' as const : 'prepared' as const,
    snapshot: { blockNumber: anchor.number.toString(), blockHash: anchor.hash }, allocator,
    transaction: existing ? null : { chainId: pins.chainId, to: pins.feeRouterAddress, value: '0' as const,
      data: encodeFunctionData({ abi, functionName: 'postWorkRoot', args: [BigInt(week), plan.root, BigInt(plan.allocated)] }) } };
}
