import { decodeFunctionData, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { ChainBridge } from '../bridge.js';
import { Problem, sameAddress } from '../common.js';
import { escrowAbi, tokenAbi } from './abi.js';

export async function walletRecoveryState(bridge: ChainBridge, owner: Address) {
  if (await bridge.public.getChainId() !== bridge.config.CHAIN_ID) throw new Problem(503, 'rpc_chain', 'Wallet verification is temporarily unavailable.');
  const [latestNonce, pendingNonce, ethBalanceWei] = await Promise.all([
    bridge.public.getTransactionCount({ address: owner, blockTag: 'latest' }),
    bridge.public.getTransactionCount({ address: owner, blockTag: 'pending' }),
    bridge.public.getBalance({ address: owner }),
  ]);
  if (pendingNonce < latestNonce) throw new Problem(503, 'rpc_state', 'Wallet state changed during verification. Check again.');
  return { owner, chainId: bridge.config.CHAIN_ID, latestNonce: String(latestNonce), pendingNonce: String(pendingNonce), ethBalanceWei: ethBalanceWei.toString() };
}

// Read-only recovery: this path never signs, broadcasts, or retries a transaction.
export async function inspectWalletTransaction(bridge: ChainBridge, owner: Address, hash: Hex) {
  if (await bridge.public.getChainId() !== bridge.config.CHAIN_ID) throw new Problem(503, 'rpc_chain', 'Transaction verification is temporarily unavailable.');
  const tx = await bridge.public.getTransaction({ hash }).catch(error => {
    if (error instanceof TransactionNotFoundError) throw new Problem(409, 'transaction_not_found', 'Transaction not found yet. Check its hash and Base network in your wallet. The journal is retained.');
    throw error;
  });
  const token = tx.to && sameAddress(tx.to, bridge.config.TOKEN_ADDRESS);
  const escrow = tx.to && sameAddress(tx.to, bridge.config.ESCROW_ADDRESS);
  if (!sameAddress(tx.from, owner) || (!token && !escrow) || tx.value !== 0n || tx.chainId !== bridge.config.CHAIN_ID || tx.hash.toLowerCase() !== hash.toLowerCase()) {
    throw new Problem(409, 'transaction_scope', 'This transaction does not match your wallet, Base network, and Telomere contracts.');
  }
  let method: string, leashId: Hex | undefined, runId: Hex | undefined;
  try {
    if (token) {
      const call = decodeFunctionData({ abi: tokenAbi, data: tx.input });
      if (call.functionName !== 'approve' || !sameAddress(call.args[0], bridge.config.ESCROW_ADDRESS)) throw Error('Wrong token action');
      method = call.functionName;
    } else {
      const call = decodeFunctionData({ abi: escrowAbi, data: tx.input });
      method = call.functionName;
      if (call.functionName === 'createLeash' || call.functionName === 'updateLeash' || call.functionName === 'killLeash') leashId = call.args[0];
      else if (call.functionName === 'openRun') {
        if (!sameAddress(call.args[0].payer, owner)) throw Error('Wrong payer');
        runId = call.args[0].runId;
      } else if (call.functionName === 'requestStop' || call.functionName === 'refundRun') runId = call.args[0];
      else if (call.functionName !== 'deposit' && call.functionName !== 'withdraw') throw Error('Unsupported wallet action');
    }
  } catch { throw new Problem(409, 'transaction_action', 'This hash is not a supported Telomere wallet action.'); }
  const result = { hash, owner, chainId: bridge.config.CHAIN_ID, transaction: { to: tx.to!, data: tx.input, value: '0x0' as const }, method, ...(leashId ? { leashId } : {}), ...(runId ? { runId } : {}) };
  const receipt = await bridge.public.getTransactionReceipt({ hash }).catch(error => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });
  if (!receipt) return { ...result, status: 'pending' as const };
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !sameAddress(receipt.from, owner) || !receipt.to || !sameAddress(receipt.to, tx.to!)
    || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Problem(409, 'transaction_receipt', 'Transaction and receipt disagree. The journal is retained.');
  await bridge.assertReceiptAssetPins(receipt.blockHash, receipt.blockNumber);
  const block = await bridge.public.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Problem(409, 'chain_reorg', 'Transaction confirmation changed. Check again before continuing.');
  return { ...result, status: receipt.status === 'success' ? 'confirmed' as const : 'reverted' as const, blockNumber: receipt.blockNumber.toString() };
}
