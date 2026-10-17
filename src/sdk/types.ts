import type { Address, Hex } from "viem";
import type { CpuTask } from "../runtime/types.js";

export type DeploymentPins = { chainId: 31337 | 8453 | 84532; escrowAddress: Address; tokenAddress: Address; receiptSigner: Address;
  tokenCodeHash?: Hex; assetImplementation?: { address: Address; codeHash: Hex } };
export type PilotConfig = {
  mode: "demo" | "testnet" | "mainnet";
  chain: { id: number; name: string; rpcUrl: string; explorerUrl?: string | undefined };
  token: { address: Address; symbol: string; decimals: number; codeHash?: Hex | undefined;
    implementation?: { address: Address; codeHash: Hex } | undefined };
  escrowAddress: Address; receiptSigner: Address;
  prices: { cpuPerSecond: string; inferenceFixed: string; maxSeconds: number; maxTokens: number };
  workload: { nearModel: string | null };
  nearAvailable: boolean; cpuMode: "demo" | "docker" | "hostkit";
  cystsAvailable?: boolean;
};
export type QuoteRequest = { leashId: Hex; task: CpuTask; maxSeconds: number; nearPrompt?: string | undefined };
export type WireQuote = { runId: Hex; leashId: Hex; payer: Address; workloadHash: Hex; maxSeconds: number;
  pricePerSecond: string; inferencePrice: string; quoteExpiry: number };
export type WalletTransaction = { to: Address; data: Hex; value: "0x0" };
export type WalletIntent = { chainId: number; transaction: WalletTransaction; summary: string };
export type WalletActionPlan = {
  planId: string; purpose: "deposit" | "withdraw" | "leash" | "leash_update" | "open" | "stop" | "kill" | "refund";
  requiresWallet: true; intents: readonly WalletIntent[]; nextStep: string; runId?: Hex; leashId?: Hex; expiresAt?: number;
};
export type QuotedRun = { quote: WireQuote; signature: Hex; ceiling: string; walletAction: WalletActionPlan; idempotencyKey: string };
export type RunView = { id: Hex; owner: string; status: string; ceiling: string; charged: string | null; refund: string | null;
  billableSeconds: number; receipt?: unknown; output?: string | null | undefined; refundAt?: number | undefined; [key: string]: unknown };
export interface OwnerWallet {
  address: Address;
  getChainId(): Promise<number>;
  signMessage(input: { message: string }): Promise<Hex>;
  sendTransaction(input: { account: Address; chainId: number; to: Address; data: Hex; value: bigint }): Promise<Hex>;
  waitForTransaction(input: { hash: Hex; chainId: number }): Promise<{ status: "success" | "reverted" }>;
}
export type WalletConfirmation = (intent: WalletIntent, index: number) => Promise<boolean>;
export type WalletExecution = { planId: string; confirmed: readonly { index: number; txHash: Hex }[] };
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;
