import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex);
const uint = z.bigint().nonnegative().max((1n << 256n) - 1n);
export const stakingReadPolicySchema = z.object({
  stakingAddress: address, stakingCodeHash: hash, tokenAddress: address, tokenCodeHash: hash,
  blockNumber: uint, blockHash: hash,
  hosts: z.array(z.object({ hostId: hash, operator: address, strikes: z.number().int().min(0).max(0xffff_ffff) }).strict()).max(1024),
}).strict().superRefine((value, context) => {
  if (new Set(value.hosts.map(host => host.hostId.toLowerCase())).size !== value.hosts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate host IDs' });
  }
  if (value.stakingAddress.toLowerCase() === value.tokenAddress.toLowerCase()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Staking and utility token must be distinct' });
  }
});
export type StakingReadPolicy = z.input<typeof stakingReadPolicySchema>;
export type SchedulingWeightRow = {
  hostId: Hex; operator: Address; strikes: number; activeStake: bigint; schedulingWeight: bigint;
  blockNumber: bigint; blockHash: Hex;
};
const abi = parseAbi(['function token() view returns (address)', 'function activeByOwner(address) view returns (uint256)',
  'function schedulingWeight(address,uint32) view returns (uint256)', 'function decimals() view returns (uint8)']);

/** Read-only, exact confirmed-block input. The caller must choose the confirmation
 * depth and approved code hashes; supplied host collateral is never a TLMR stake. */
export async function readTlmrSchedulingWeights(client: PublicClient, input: StakingReadPolicy): Promise<SchedulingWeightRow[]> {
  const policy = stakingReadPolicySchema.parse(input);
  const canonical = await client.getBlock({ blockNumber: policy.blockNumber });
  if (canonical.hash?.toLowerCase() !== policy.blockHash.toLowerCase()) throw new Error('Staking block is no longer canonical');
  const [stakingCode, tokenCode] = await Promise.all([
    client.getCode({ address: policy.stakingAddress, blockNumber: policy.blockNumber }),
    client.getCode({ address: policy.tokenAddress, blockNumber: policy.blockNumber }),
  ]);
  if (!stakingCode || stakingCode === '0x' || keccak256(stakingCode).toLowerCase() !== policy.stakingCodeHash.toLowerCase()
    || !tokenCode || tokenCode === '0x' || keccak256(tokenCode).toLowerCase() !== policy.tokenCodeHash.toLowerCase()) {
    throw new Error('Utility staking or token code does not match the reviewed policy');
  }
  const state = { blockNumber: policy.blockNumber };
  const [actualToken, decimals] = await Promise.all([
    client.readContract({ address: policy.stakingAddress, abi, functionName: 'token', ...state }),
    client.readContract({ address: policy.tokenAddress, abi, functionName: 'decimals', ...state }),
  ]);
  if (actualToken.toLowerCase() !== policy.tokenAddress.toLowerCase() || decimals !== 18) {
    throw new Error('Utility staking token scope mismatch');
  }
  const result: SchedulingWeightRow[] = [];
  // Keep RPC load bounded even when the catalogue reaches its maximum.
  for (const host of policy.hosts) {
    const [activeStake, schedulingWeight] = await Promise.all([
      client.readContract({ address: policy.stakingAddress, abi, functionName: 'activeByOwner', args: [host.operator], ...state }),
      client.readContract({ address: policy.stakingAddress, abi, functionName: 'schedulingWeight', args: [host.operator, host.strikes], ...state }),
    ]);
    if (schedulingWeight !== activeStake / (BigInt(host.strikes) + 1n)) throw new Error('Utility staking priority arithmetic mismatch');
    result.push({ ...host, activeStake, schedulingWeight, blockNumber: policy.blockNumber, blockHash: policy.blockHash });
  }
  const recheck = await client.getBlock({ blockNumber: policy.blockNumber });
  if (recheck.hash?.toLowerCase() !== policy.blockHash.toLowerCase()) throw new Error('Staking block changed during the read');
  return result;
}
