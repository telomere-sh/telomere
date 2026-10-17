import { parseAbi, serializeTransaction, type PublicClient } from 'viem';
import type { CanonicalBlockState } from '../payments/circle-usdc.js';
import type { OwnerWalletPlan } from './owner-wallet-types.js';

export const baseGasPriceOracle = '0x420000000000000000000000000000000000000F' as const;
export const ownerWalletOracleAbi = parseAbi([
  'function getL1FeeUpperBound(uint256) view returns(uint256)',
  'function getOperatorFee(uint256) view returns(uint256)',
]);
/** Estimate every Base fee component for the exact unsigned EIP-1559 creation.
 * The oracle adds the signature allowance to this unsigned byte length itself.
 * This canonical snapshot estimate cannot cap a future L1 fee onchain. */
export async function ownerWalletFeeBudget(client: PublicClient, state: CanonicalBlockState, plan: OwnerWalletPlan,
  gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) {
  const unsigned = serializeTransaction({ type: 'eip1559', chainId: 8453, nonce: plan.transaction.nonce,
    gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n, data: plan.transaction.data });
  const unsignedTransactionBytes = (unsigned.length - 2) / 2;
  const [l1DataFeeUpperBound, operatorFee] = await Promise.all([
    client.readContract({ address: baseGasPriceOracle, abi: ownerWalletOracleAbi, functionName: 'getL1FeeUpperBound',
      args: [BigInt(unsignedTransactionBytes)], ...state }),
    client.readContract({ address: baseGasPriceOracle, abi: ownerWalletOracleAbi, functionName: 'getOperatorFee', args: [gas], ...state }),
  ]);
  if (typeof l1DataFeeUpperBound !== 'bigint' || l1DataFeeUpperBound < 0n || typeof operatorFee !== 'bigint' || operatorFee < 0n) {
    throw new Error('Base fee oracle returned invalid fee components');
  }
  return Object.freeze({ unsignedTransactionBytes, l1DataFeeUpperBoundWei: l1DataFeeUpperBound.toString(),
    operatorFeeWei: operatorFee.toString(), totalGasBudgetWei: (gas * maxFeePerGas + l1DataFeeUpperBound + operatorFee).toString(),
    includesL1DataFee: true as const, futureL1FeeHardCap: false as const });
}
