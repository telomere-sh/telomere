import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, moneySchema } from '../common.js';
import { platformSettlementSchema, type PlatformSettlement } from '../platform-runtime/types.js';

export const PLATFORM_RECEIPT_ALGORITHM = 'platform-financial-double-keccak-v1';
export type PlatformLeafRun = { hostId: Hex; payer: Address; hwClass: number; regionHash: Hex; imageHash: Hex; workloadHash: Hex };
export type PlatformFinancialSettlement = Omit<PlatformSettlement, 'inferenceCharge'> & { inferenceCharge: string };
const financialSettlementSchema = platformSettlementSchema.extend({ inferenceCharge: moneySchema, billableSeconds: z.number().int().nonnegative().safe() });
/** Exact PlatformRunEscrow.receiptLeaf ABI, independently encoded from the RPC helper. */
export function platformFinancialLeaf(chainId: number, escrowAddress: string, run: PlatformLeafRun, raw: PlatformFinancialSettlement): Hex {
  const settlement = financialSettlementSchema.parse(raw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isInteger(run.hwClass) || run.hwClass < 0 || run.hwClass > 65535) {
    throw new Error('Invalid platform leaf domain or hardware class');
  }
  return keccak256(keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' },
    { type: 'uint16' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' },
    { type: 'uint64' }, { type: 'uint96' }, { type: 'bytes32' },
  ], [BigInt(chainId), addressSchema.parse(escrowAddress), settlement.runId, bytes32Schema.parse(run.hostId),
    addressSchema.parse(run.payer), run.hwClass, bytes32Schema.parse(run.regionHash), bytes32Schema.parse(run.imageHash),
    bytes32Schema.parse(run.workloadHash), BigInt(settlement.billableSeconds), BigInt(settlement.endedAt),
    BigInt(settlement.inferenceCharge), settlement.receiptHash])));
}
