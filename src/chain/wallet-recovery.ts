import { decodeFunctionData, getAbiItem, zeroAddress, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { ChainBridge } from '../bridge.js';
import { Problem, sameAddress, typedQuote, signatureSchema, bytes32Schema } from '../common.js';
import { escrowAbi, tokenAbi } from './abi.js';
import type { Service } from '../service.js';

// A hashless reservation is releasable only after its exact signed quote has
// expired on the canonical chain and getRun still proves it was never opened.
export async function inspectCpuReservation(service: Service, owner: Address, runId: Hex) {
  const job = await service.requireJob(owner, runId), bridge = service.bridge;
  if (await bridge.public.getChainId() !== bridge.config.CHAIN_ID) throw new Problem(503, 'rpc_chain', 'Reservation verification is temporarily unavailable.');
  const transaction = bridge.openTransaction(typedQuote(job.quote), signatureSchema.parse(job.signature));
  const identity = { owner, chainId: bridge.config.CHAIN_ID, runId, transaction };
  if (job.txHash) {
    const result = await inspectWalletTransaction(bridge, owner, bytes32Schema.parse(job.txHash));
    if (result.runId !== runId || result.method !== 'openRun') throw new Problem(409, 'reservation_scope', 'The saved transaction does not match this CPU reservation.');
    return { ...identity, state: 'transaction_found' as const, hash: result.hash };
  }
  const block = await bridge.public.getBlock({ blockTag: 'latest' });
  if (block.number === null || block.hash === null) throw new Problem(503, 'rpc_state', 'A confirmed Base block is required.');
  const blockNumber = block.number;
  await bridge.assertReceiptAssetPins(block.hash, block.number);
  const run = await bridge.public.readContract({ address: bridge.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getRun', args: [runId], blockNumber: block.number });
  const canonical = async () => {
    if ((await bridge.public.getBlock({ blockNumber })).hash !== block.hash) throw new Problem(409, 'chain_reorg', 'Base confirmation changed. Check the reservation again.');
  };
  if (run.status !== 0 || run.payer !== zeroAddress) {
    if (!sameAddress(run.payer, owner) || run.leashId !== job.leashId || run.workloadHash !== job.quote.workloadHash || run.ceiling.toString() !== job.ceiling) {
      throw new Problem(409, 'reservation_scope', 'The on-chain reservation differs from this signed quote.');
    }
    // RunOpened carries the block timestamp. Locate that exact block with a
    // bounded binary search, instead of an unbounded scan of wallet history.
    let low = 0n, high = block.number;
    for (let steps = 0; low < high && steps < 40; steps++) {
      const middle = (low + high) / 2n;
      const candidate = await bridge.public.getBlock({ blockNumber: middle });
      if (candidate.timestamp < run.openedAt) low = middle + 1n; else high = middle;
    }
    if (low !== high) throw new Problem(503, 'reservation_lookup', 'Reservation lookup is incomplete. Keep the existing request and check again.');
    const opened = await bridge.public.getBlock({ blockNumber: low });
    if (!opened.hash || opened.timestamp !== run.openedAt) throw new Problem(503, 'reservation_lookup', 'The reservation block could not be verified.');
    // Permit adjacent blocks with an equal timestamp (e.g. local EVMs), while
    // keeping the indexed event lookup bounded to 64 blocks.
    const logs = await bridge.public.getLogs({ address: bridge.config.ESCROW_ADDRESS,
      event: getAbiItem({ abi: escrowAbi, name: 'RunOpened' }), args: { runId, payer: owner },
      fromBlock: low, toBlock: low + 63n < block.number ? low + 63n : block.number, strict: true });
    if (logs.length !== 1 || !logs[0]?.transactionHash) throw new Problem(503, 'reservation_lookup', 'The original reservation transaction could not be verified.');
    const result = await inspectWalletTransaction(bridge, owner, logs[0].transactionHash);
    if (result.status !== 'confirmed' || result.method !== 'openRun' || result.runId !== runId) throw new Problem(409, 'reservation_scope', 'The original reservation transaction has not been confirmed.');
    await canonical();
    return { ...identity, state: 'transaction_found' as const, hash: result.hash };
  }
  const wallet = await walletRecoveryState(bridge, owner);
  await canonical();
  const quoteExpiry = BigInt(job.quote.quoteExpiry);
  return { ...identity, state: job.status === 'prepared' && block.timestamp > quoteExpiry ? 'expired_unused' as const : 'awaiting_wallet' as const,
    quoteExpiry: quoteExpiry.toString(), chainTimestamp: block.timestamp.toString(), latestNonce: wallet.latestNonce, pendingNonce: wallet.pendingNonce };
}

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
