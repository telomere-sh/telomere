import { createPublicClient, createWalletClient, encodeFunctionData, http,
  type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, tokenAbi } from "./abi.js";
import { chainForId } from "./chains.js";
import { quoteTypedData, settlementTypedData, type Quote, type Settlement } from "./typed-data.js";

export type ChainGatewayOptions = {
  chainId: number; rpcUrl: string; escrowAddress: Address; tokenAddress: Address;
  privateKey?: Hex;
};

export function createChainGateway(options: ChainGatewayOptions) {
  // This legacy convenience helper has no durable journal or reviewed public asset pins.
  // Public execution uses ChainBridge or PlatformBridge with their checked SDKs.
  const rpc = new URL(options.rpcUrl);
  if (options.chainId !== 31337 || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname)
    || !['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password || rpc.hash) {
    throw new Error('Legacy ChainGateway is restricted to disposable loopback chain 31337');
  }
  const chain = chainForId(options.chainId);
  const transport = http(options.rpcUrl, { batch: false, retryCount: 0, timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0 });
  const account = options.privateKey ? privateKeyToAccount(options.privateKey) : undefined;
  const walletClient = account ? createWalletClient({ chain, transport, account }) : undefined;
  const escrowAddress = options.escrowAddress;
  async function assertChain(): Promise<void> {
    if (await publicClient.getChainId() !== options.chainId) throw new Error("RPC chain mismatch");
  }
  async function assertDeployment() {
    await assertChain();
    const [token, quoteSigner, receiptSigner, treasury, decimals] = await Promise.all([
      publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "token" }),
      publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "quoteSigner" }),
      publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "receiptSigner" }),
      publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "treasury" }),
      publicClient.readContract({ address: options.tokenAddress, abi: tokenAbi, functionName: "decimals" }),
    ]);
    if (token.toLowerCase() !== options.tokenAddress.toLowerCase()) throw new Error("Escrow token mismatch");
    if (decimals !== 6) throw new Error("Pilot requires a checked token with six decimals");
    if (account && (quoteSigner.toLowerCase() !== account.address.toLowerCase()
      || receiptSigner.toLowerCase() !== account.address.toLowerCase())) throw new Error("Escrow signing identity mismatch");
    return { token, quoteSigner, receiptSigner, treasury, decimals };
  }
  return {
    chain, publicClient, walletClient, account, escrowAddress, tokenAddress: options.tokenAddress,
    assertChain, assertDeployment,
    getBalance: (payer: Address) => publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "availableBalance", args: [payer] }),
    getTokenBalance: (payer: Address) => publicClient.readContract({ address: options.tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [payer] }),
    getLeash: (leashId: Hex) => publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "getLeash", args: [leashId] }),
    getRun: (runId: Hex) => publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "getRun", args: [runId] }),
    getRefundAt: (runId: Hex) => publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "refundAt", args: [runId] }),
    encodeApprove: (amount: bigint) => encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [escrowAddress, amount] }),
    encodeDeposit: (amount: bigint) => encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [amount] }),
    encodeWithdraw: (amount: bigint) => encodeFunctionData({ abi: escrowAbi, functionName: "withdraw", args: [amount] }),
    encodeCreateLeash: (leashId: Hex, agent: Address, maxPerHour: bigint, maxPerDay: bigint, expiry: bigint) =>
      encodeFunctionData({ abi: escrowAbi, functionName: "createLeash", args: [leashId, agent, maxPerHour, maxPerDay, expiry] }),
    encodeUpdateLeash: (leashId: Hex, agent: Address, maxPerHour: bigint, maxPerDay: bigint, expiry: bigint) =>
      encodeFunctionData({ abi: escrowAbi, functionName: "updateLeash", args: [leashId, agent, maxPerHour, maxPerDay, expiry] }),
    encodeKill: (leashId: Hex) => encodeFunctionData({ abi: escrowAbi, functionName: "killLeash", args: [leashId] }),
    encodeOpen: (quote: Quote, signature: Hex) => encodeFunctionData({ abi: escrowAbi, functionName: "openRun", args: [quote, signature] }),
    encodeStop: (runId: Hex) => encodeFunctionData({ abi: escrowAbi, functionName: "requestStop", args: [runId] }),
    encodeRefund: (runId: Hex) => encodeFunctionData({ abi: escrowAbi, functionName: "refundRun", args: [runId] }),
    encodeSettle: (settlement: Settlement, signature: Hex) => encodeFunctionData({ abi: escrowAbi, functionName: "settleRun", args: [settlement, signature] }),
    signQuote: async (quote: Quote) => {
      if (!account) throw new Error("Quote signing is not configured");
      return account.signTypedData(quoteTypedData(options.chainId, escrowAddress, quote));
    },
    signSettlement: async (settlement: Settlement) => {
      if (!account) throw new Error("Receipt signing is not configured");
      return account.signTypedData(settlementTypedData(options.chainId, escrowAddress, settlement));
    },
    // Returns a hash before waiting. The caller must journal/reconcile ambiguous
    // outcomes; a timeout is never permission to create another paid execution.
    submitSettlement: async (settlement: Settlement, signature: Hex) => {
      if (!walletClient) throw new Error("Settlement relay is not configured");
      await assertChain();
      return walletClient.writeContract({ address: escrowAddress, abi: escrowAbi,
        functionName: "settleRun", args: [settlement, signature] });
    },
    waitForTransaction: async (hash: Hex) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("Transaction is not canonical");
      return receipt;
    },
  };
}
export type ChainGateway = ReturnType<typeof createChainGateway>;
