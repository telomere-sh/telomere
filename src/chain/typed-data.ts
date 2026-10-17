import type { Address, Hex } from "viem";

export const quoteTypes = {
  Quote: [
    { name: "runId", type: "bytes32" },
    { name: "leashId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "workloadHash", type: "bytes32" },
    { name: "maxSeconds", type: "uint64" },
    { name: "pricePerSecond", type: "uint96" },
    { name: "inferencePrice", type: "uint96" },
    { name: "quoteExpiry", type: "uint64" },
  ],
} as const;
export const settlementTypes = {
  Settlement: [
    { name: "runId", type: "bytes32" },
    { name: "billableSeconds", type: "uint64" },
    { name: "inferenceCharge", type: "uint96" },
    { name: "receiptHash", type: "bytes32" },
  ],
} as const;

export type Quote = {
  runId: Hex; leashId: Hex; payer: Address; workloadHash: Hex;
  maxSeconds: bigint; pricePerSecond: bigint; inferencePrice: bigint; quoteExpiry: bigint;
};
export type Settlement = {
  runId: Hex; billableSeconds: bigint; inferenceCharge: bigint; receiptHash: Hex;
};
export function escrowDomain(chainId: number, verifyingContract: Address) {
  return { name: "TelomereRunEscrow", version: "1", chainId, verifyingContract } as const;
}
export function quoteTypedData(chainId: number, verifyingContract: Address, quote: Quote) {
  return { domain: escrowDomain(chainId, verifyingContract), types: quoteTypes, primaryType: "Quote", message: quote } as const;
}
export function settlementTypedData(chainId: number, verifyingContract: Address, settlement: Settlement) {
  return { domain: escrowDomain(chainId, verifyingContract), types: settlementTypes, primaryType: "Settlement", message: settlement } as const;
}
export function quoteCeiling(quote: Quote): bigint {
  return quote.maxSeconds * quote.pricePerSecond + quote.inferencePrice;
}
