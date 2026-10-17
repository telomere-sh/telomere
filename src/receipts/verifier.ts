import { createPublicClient, http, parseAbi, verifyTypedData, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema, sameAddress } from '../common.js';
import { escrowDomain, settlementTypes } from '../chain/typed-data.js';
import { receiptSettlement, signedReceiptSchema, type SignedReceipt } from '../service.js';
import { MAX_HOUR_RECEIPTS, RECEIPT_TREE_ALGORITHM, receiptHourSchema, receiptLeaf, verifyReceiptPath } from './merkle.js';

export type ReceiptVerificationPins = {
  chainId: number; escrowAddress: Address; tokenAddress: Address; receiptSigner: Address;
  receiptRootAddress?: Address;
};
export const receiptProofSchema = z.object({
  version: z.literal(1), algorithm: z.literal(RECEIPT_TREE_ALGORITHM), hour: receiptHourSchema,
  root: bytes32Schema, leafCount: z.number().int().min(1).max(MAX_HOUR_RECEIPTS), leaf: bytes32Schema,
  proof: z.array(bytes32Schema).max(12), receipt: signedReceiptSchema,
}).strict();
export type ReceiptProof = z.infer<typeof receiptProofSchema>;
const bodySchema = z.object({
  version: z.literal(1), runId: bytes32Schema, payer: addressSchema, leashId: bytes32Schema, workloadHash: bytes32Schema,
  cpu: z.object({ billableSeconds: z.number().int().min(0).max(120), measuredSeconds: z.number().int().min(0).max(120),
    pricePerSecond: moneySchema }).passthrough(),
  near: z.object({ inferenceCharge: moneySchema }).passthrough().nullable(),
  billing: z.object({ token: addressSchema, ceiling: moneySchema, charged: moneySchema, refund: moneySchema }).strict(),
}).passthrough();

// A caller explicitly supplies this trusted read-only boundary. API assertions never implement it implicitly.
export interface ReceiptRootReader {
  chainId(): Promise<number>;
  root(address: Address, hour: number): Promise<{ root: Hex; count: number; signer: Address; postedAt: bigint }>;
}
export const receiptRootReadAbi = parseAbi([
  'function getRoot(uint64 hour) view returns (bytes32 root,uint32 count,address signer,uint64 postedAt)',
]);
export function createReceiptRootReader(rpcUrl: string): ReceiptRootReader {
  const url = new URL(rpcUrl);
  if (url.username || url.password || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('Receipt verification requires HTTPS or an explicit loopback RPC');
  }
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }), cacheTime: 0 });
  return { chainId: () => client.getChainId(), async root(address, hour) {
    const [root, count, signer, postedAt] = await client.readContract({ address, abi: receiptRootReadAbi,
      functionName: 'getRoot', args: [BigInt(receiptHourSchema.parse(hour))] });
    return { root, count, signer, postedAt };
  } };
}
function pinsValid(pins: ReceiptVerificationPins): boolean {
  return Number.isSafeInteger(pins.chainId) && pins.chainId > 0
    && [pins.escrowAddress, pins.tokenAddress, pins.receiptSigner,
      ...(pins.receiptRootAddress === undefined ? [] : [pins.receiptRootAddress])].every(value => addressSchema.safeParse(value).success);
}
export async function verifySignedReceipt(value: unknown, pins: ReceiptVerificationPins): Promise<{
  valid: boolean; hashValid: boolean; signatureValid: boolean; conservationValid: boolean;
}> {
  const invalid = { valid: false, hashValid: false, signatureValid: false, conservationValid: false };
  const parsed = signedReceiptSchema.safeParse(value); if (!parsed.success || !pinsValid(pins)) return invalid;
  const receipt = parsed.data, body = bodySchema.safeParse(receipt.body);
  if (!body.success) return invalid;
  const hashValid = hashJson(receipt.body) === receipt.receiptHash && receipt.settlement.receiptHash === receipt.receiptHash;
  const domainValid = receipt.domain.chainId === pins.chainId && sameAddress(receipt.domain.verifyingContract, pins.escrowAddress)
    && sameAddress(receipt.signer, pins.receiptSigner);
  const b = body.data, inference = BigInt(b.near?.inferenceCharge ?? '0');
  const charged = BigInt(b.cpu.billableSeconds) * BigInt(b.cpu.pricePerSecond) + inference;
  const conservationValid = b.runId === receipt.settlement.runId && b.cpu.billableSeconds <= b.cpu.measuredSeconds
    && BigInt(b.cpu.billableSeconds) === BigInt(receipt.settlement.billableSeconds)
    && inference === BigInt(receipt.settlement.inferenceCharge) && charged === BigInt(b.billing.charged)
    && charged <= BigInt(b.billing.ceiling) && charged + BigInt(b.billing.refund) === BigInt(b.billing.ceiling)
    && sameAddress(b.billing.token, pins.tokenAddress);
  let signatureValid = false;
  if (hashValid && domainValid) {
    try { signatureValid = await verifyTypedData({ address: pins.receiptSigner,
      domain: escrowDomain(pins.chainId, pins.escrowAddress), types: settlementTypes, primaryType: 'Settlement',
      message: receiptSettlement(receipt), signature: receipt.signature }); } catch { /* Invalid signatures are a verification result. */ }
  }
  return { valid: hashValid && signatureValid && conservationValid, hashValid, signatureValid, conservationValid };
}
export async function verifyHourlyReceipt(value: unknown, pins: ReceiptVerificationPins, reader?: ReceiptRootReader): Promise<{
  valid: boolean; receiptValid: boolean; merkleValid: boolean; onchain_verified: boolean;
  evidence: 'local_only' | 'chain_root_verified' | 'chain_root_mismatch' | 'chain_unavailable';
}> {
  const invalid = { valid: false, receiptValid: false, merkleValid: false, onchain_verified: false, evidence: 'local_only' as const };
  const parsed = receiptProofSchema.safeParse(value); if (!parsed.success) return invalid;
  const proof = parsed.data, receiptValid = (await verifySignedReceipt(proof.receipt, pins)).valid;
  const merkleValid = proof.proof.length <= Math.ceil(Math.log2(proof.leafCount))
    && proof.leaf === receiptLeaf(proof.receipt.receiptHash) && verifyReceiptPath(proof.leaf, proof.proof, proof.root);
  const local = { valid: receiptValid && merkleValid, receiptValid, merkleValid, onchain_verified: false, evidence: 'local_only' as const };
  if (!local.valid || !reader || !pins.receiptRootAddress) return local;
  try {
    if (await reader.chainId() !== pins.chainId) return { ...local, evidence: 'chain_root_mismatch' };
    const anchored = await reader.root(pins.receiptRootAddress, proof.hour);
    const matches = anchored.root.toLowerCase() === proof.root && anchored.count === proof.leafCount && anchored.postedAt > 0n;
    return { ...local, onchain_verified: matches, evidence: matches ? 'chain_root_verified' : 'chain_root_mismatch' };
  } catch { return { ...local, evidence: 'chain_unavailable' }; }
}
export function receiptOwner(receipt: SignedReceipt): Address { return addressSchema.parse(receipt.body.payer); }
