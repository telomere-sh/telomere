import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, http, keccak256, parseEventLogs, parseTransaction,
  recoverTransactionAddress, ContractFunctionRevertedError, BaseError, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { escrowAbi, tokenAbi } from './chain/abi.js';
import { escrowDomain, quoteTypes, settlementTypes, type Quote, type Settlement } from './chain/typed-data.js';
import { eq, ne } from 'drizzle-orm';
import { transactions, type Database } from './store.js';
import type { Config } from './config.js';
import { Problem, bytes32Schema } from './common.js';
import { baseUsdcForChainId, chainForId } from './chain/chains.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from './payments/circle-usdc.js';

export type WalletTransaction = { to: Address; data: Hex; value: '0x0' };
export class SettlementRejectedError extends Error { constructor() { super('Settlement rejected by the contract'); this.name = 'SettlementRejectedError'; } }
export class ChainBridge {
  readonly account;
  readonly chain;
  readonly public;
  readonly wallet;
  readonly demo;
  readonly domain;
  constructor(readonly config: Config) {
    this.account = privateKeyToAccount(config.SIGNER_PRIVATE_KEY);
    if (config.MODE !== 'demo' && (!config.TOKEN_CODE_HASH || !config.TOKEN_IMPLEMENTATION_ADDRESS
      || !config.TOKEN_IMPLEMENTATION_CODE_HASH || config.TOKEN_ADDRESS.toLowerCase()
        !== baseUsdcForChainId(config.CHAIN_ID)?.toLowerCase())) throw new Error('Reviewed Circle USDC pins are required');
    this.chain = defineChain({ id: config.CHAIN_ID, name: chainForId(config.CHAIN_ID).name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.RPC_URL] } } });
    this.public = createPublicClient({ chain: this.chain, transport: http(config.RPC_URL, { timeout: 10000, retryCount: 0 }) });
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(config.RPC_URL, { timeout: 10000, retryCount: 0 }) });
    this.demo = config.DEMO_PRIVATE_KEY ? createWalletClient({ account: privateKeyToAccount(config.DEMO_PRIVATE_KEY), chain: this.chain, transport: http(config.RPC_URL) }) : undefined;
    this.domain = escrowDomain(config.CHAIN_ID, config.ESCROW_ADDRESS);
  }
  private async assertAssetPins(blockHash: Hex, blockNumber: bigint): Promise<void> {
    if (this.config.MODE === 'demo') return;
    const pins = this.config;
    if (!pins.TOKEN_CODE_HASH || !pins.TOKEN_IMPLEMENTATION_ADDRESS || !pins.TOKEN_IMPLEMENTATION_CODE_HASH) {
      throw new Error('Reviewed Circle USDC pins are required');
    }
    const state = { blockHash, requireCanonical: true } as const;
    const code = await this.public.getCode({ address: pins.TOKEN_ADDRESS, ...state });
    if (!code || code === '0x' || keccak256(code) !== pins.TOKEN_CODE_HASH
      || !await matchesCircleProxyPins(this.public, pins.TOKEN_ADDRESS,
        { address: pins.TOKEN_IMPLEMENTATION_ADDRESS, codeHash: pins.TOKEN_IMPLEMENTATION_CODE_HASH }, state)
      || !await matchesNativeBaseUsdcMetadata(this.public, pins.CHAIN_ID, pins.TOKEN_ADDRESS, state)
      || (await this.public.getBlock({ blockNumber })).hash !== blockHash) throw new Error('Reviewed Circle USDC deployment differs');
  }
  private async assertCurrentAssetPins(): Promise<void> {
    if (this.config.MODE === 'demo') return;
    if (await this.public.getChainId() !== this.config.CHAIN_ID) throw new Error('RPC chain mismatch');
    const block = await this.public.getBlock({ blockTag: 'latest' });
    await this.assertAssetPins(block.hash, block.number);
  }
  private async assertReceiptAssetPins(blockHash: Hex, blockNumber: bigint): Promise<void> {
    if (this.config.MODE === 'demo') return;
    await this.assertAssetPins(blockHash, blockNumber);
    if (!this.config.TOKEN_CODE_HASH || !this.config.TOKEN_IMPLEMENTATION_ADDRESS
      || !this.config.TOKEN_IMPLEMENTATION_CODE_HASH || !await stableCircleProxyReceiptBlock(this.public,
        this.config.TOKEN_ADDRESS, this.config.TOKEN_CODE_HASH,
        { address: this.config.TOKEN_IMPLEMENTATION_ADDRESS, codeHash: this.config.TOKEN_IMPLEMENTATION_CODE_HASH },
        blockHash, blockNumber)) throw new Error('Reviewed Circle USDC changed in transaction block');
  }
  async check(): Promise<void> {
    if (await this.public.getChainId() !== this.config.CHAIN_ID) throw new Error('RPC chain mismatch');
    const block = await this.public.getBlock({ blockTag: 'latest' });
    const state = { blockHash: block.hash, requireCanonical: true } as const;
    await this.assertAssetPins(block.hash, block.number);
    if ((await this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'token', ...state })).toLowerCase() !== this.config.TOKEN_ADDRESS.toLowerCase()) throw new Error('Escrow token mismatch');
    const quoteSigner = await this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'quoteSigner', ...state });
    const receiptSigner = await this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'receiptSigner', ...state });
    if (quoteSigner.toLowerCase() !== this.account.address.toLowerCase() || receiptSigner.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('Configured signer does not match deployed contract');
    if (await this.public.readContract({ address: this.config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'decimals', ...state }) !== 6) throw new Error('Pilot requires 6-decimal payment token');
  }
  async balance(owner: Address) {
    const available = await this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'availableBalance', args: [owner] });
    return { available: available.toString() };
  }
  async leash(id: Hex) { return this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getLeash', args: [id] }); }
  async run(id: Hex) { return this.public.readContract({ address: this.config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getRun', args: [id] }); }
  async signQuote(quote: Quote): Promise<Hex> { await this.assertCurrentAssetPins(); return this.account.signTypedData({ domain: this.domain, types: quoteTypes, primaryType: 'Quote', message: quote }); }
  async signSettlement(settlement: Settlement): Promise<Hex> { await this.assertCurrentAssetPins(); return this.account.signTypedData({ domain: this.domain, types: settlementTypes, primaryType: 'Settlement', message: settlement }); }
  openTransaction(quote: Quote, signature: Hex): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'openRun', args: [quote, signature] }), value: '0x0' }; }
  createLeashTransaction(id: Hex, agent: Address, hour: bigint, day: bigint, expiry: bigint): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'createLeash', args: [id, agent, hour, day, expiry] }), value: '0x0' }; }
  updateLeashTransaction(id: Hex, agent: Address, hour: bigint, day: bigint, expiry: bigint): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash', args: [id, agent, hour, day, expiry] }), value: '0x0' }; }
  stopTransaction(id: Hex): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'requestStop', args: [id] }), value: '0x0' }; }
  killTransaction(id: Hex): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'killLeash', args: [id] }), value: '0x0' }; }
  depositTransactions(amount: bigint): WalletTransaction[] { return [
    { to: this.config.TOKEN_ADDRESS, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [this.config.ESCROW_ADDRESS, amount] }), value: '0x0' },
    { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'deposit', args: [amount] }), value: '0x0' },
  ]; }
  withdrawTransaction(amount: bigint): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'withdraw', args: [amount] }), value: '0x0' }; }
  refundTransaction(id: Hex): WalletTransaction { return { to: this.config.ESCROW_ADDRESS, data: encodeFunctionData({ abi: escrowAbi, functionName: 'refundRun', args: [id] }), value: '0x0' }; }
  async verifyOpened(id: Hex, owner: Address, txHash: Hex): Promise<void> {
    await this.assertCurrentAssetPins();
    const receipt = await this.public.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 15000 });
    if (receipt.status !== 'success') throw new Problem(409, 'transaction_failed', 'The run transaction reverted.');
    if (receipt.transactionHash !== txHash || receipt.to?.toLowerCase() !== this.config.ESCROW_ADDRESS.toLowerCase()) {
      throw new Problem(409, 'wrong_transaction', 'The transaction scope differs.');
    }
    await this.assertReceiptAssetPins(receipt.blockHash, receipt.blockNumber);
    const logs = parseEventLogs({ abi: escrowAbi, eventName: 'RunOpened', logs: receipt.logs.filter(log => log.address.toLowerCase() === this.config.ESCROW_ADDRESS.toLowerCase()) });
    if (!logs.some(log => log.args.runId === id)) throw new Problem(409, 'wrong_transaction', 'This transaction did not open the quoted run.');
    if ((await this.public.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Problem(409, 'chain_reorg', 'The transaction is no longer in the canonical chain.');
    const run = await this.run(id);
    if (run.payer.toLowerCase() !== owner.toLowerCase() || run.status !== 1) throw new Problem(409, 'run_unavailable', 'The run is unavailable.');
  }
  async settle(db: Database, settlement: Settlement, signature: Hex): Promise<Hex> {
    await this.assertCurrentAssetPins();
    const expectedData = encodeFunctionData({ abi: escrowAbi, functionName: 'settleRun', args: [settlement, signature] });
    let journal = (await db.select().from(transactions).where(eq(transactions.runId, settlement.runId)).limit(1))[0];
    if (!journal) {
      const prior = await db.select().from(transactions).where(ne(transactions.runId, settlement.runId)).limit(2001);
      if (prior.length > 2000) throw new Error('Pilot transaction history requires archival review');
      if (prior.length) {
        const chainNonce = await this.public.getTransactionCount({ address: this.account.address, blockTag: 'latest' });
        for (const entry of prior) {
          if (!/^0x[0-9a-fA-F]+$/.test(entry.raw) || entry.raw.length % 2 !== 0 || entry.nonce === null
            || keccak256(entry.raw as Hex) !== bytes32Schema.parse(entry.hash)) {
            throw new Error('Prior settlement journal differs from reviewed scope');
          }
          // REASON: parseTransaction validates the previously persisted signed transaction envelope.
          const serialized = entry.raw as TransactionSerialized, transaction = parseTransaction(serialized);
          const call = transaction.data ? decodeFunctionData({ abi: escrowAbi, data: transaction.data }) : undefined;
          if (transaction.chainId !== this.config.CHAIN_ID
            || transaction.to?.toLowerCase() !== this.config.ESCROW_ADDRESS.toLowerCase()
            || (transaction.value ?? 0n) !== 0n || transaction.nonce !== entry.nonce
            || call?.functionName !== 'settleRun' || call.args[0].runId.toLowerCase() !== entry.runId.toLowerCase()
            || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== this.account.address.toLowerCase()) {
            throw new Error('Prior settlement journal differs from reviewed scope');
          }
          if (entry.nonce >= chainNonce) throw new Error('Signer has an unresolved transaction nonce');
        }
      }
      let request;
      try { request = await this.wallet.prepareTransactionRequest({ to: this.config.ESCROW_ADDRESS, data: expectedData }); }
      catch (error) {
        if (error instanceof BaseError && error.walk(cause => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) throw new SettlementRejectedError();
        throw error;
      }
      if (request.gas) request = { ...request, gas: request.gas * 13n / 10n + 10000n };
      if (request.nonce === undefined) throw new Error('Prepared settlement nonce missing');
      const raw = await this.wallet.signTransaction(request);
      const hash = keccak256(raw);
      await db.insert(transactions).values({ runId: settlement.runId, raw, hash, nonce: request.nonce });
      journal = { runId: settlement.runId, raw, hash, nonce: request.nonce, createdAt: new Date() };
    }
    const hash = bytes32Schema.parse(journal.hash);
    // Retained bytes must still be the exact signed settlement for this chain and run.
    if (!/^0x[0-9a-fA-F]+$/.test(journal.raw) || journal.raw.length % 2 !== 0) {
      throw new Error('Retained settlement transaction encoding differs');
    }
    // REASON: parseTransaction validates the retained signed envelope after this bounded hex check.
    const raw = journal.raw as TransactionSerialized, transaction = parseTransaction(raw);
    if (keccak256(raw) !== hash || transaction.chainId !== this.config.CHAIN_ID
      || transaction.to?.toLowerCase() !== this.config.ESCROW_ADDRESS.toLowerCase()
      || transaction.data?.toLowerCase() !== expectedData.toLowerCase() || (transaction.value ?? 0n) !== 0n
      || journal.nonce === null || transaction.nonce !== journal.nonce
      || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error('Retained settlement transaction differs from reviewed scope');
    }
    try {
      const receipt = await this.public.getTransactionReceipt({ hash });
      await this.verifySettlementReceipt(settlement, receipt);
      return hash;
    } catch (error) {
      // Only an absent receipt permits rebroadcast. A canonicality or asset-pin
      // failure after a receipt read is evidence of a different deployment.
      if (!(error instanceof Error && error.name === 'TransactionReceiptNotFoundError')) throw error;
    }
    await this.assertCurrentAssetPins();
    // REASON: raw transaction bytes are signed and produced locally, then durably stored before broadcast.
    try { await this.public.sendRawTransaction({ serializedTransaction: raw }); }
    catch { /* Duplicate/uncertain broadcast is reconciled by its deterministic hash below. */ }
    const receipt = await this.public.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 15000 });
    await this.verifySettlementReceipt(settlement, receipt);
    return hash;
  }
  async confirmedSettlement(settlement: Settlement, hash: Hex): Promise<Date> {
    const receipt = await this.public.getTransactionReceipt({ hash });
    await this.verifySettlementReceipt(settlement, receipt);
    return new Date(Number((await this.public.getBlock({ blockNumber: receipt.blockNumber })).timestamp) * 1000);
  }
  private async verifySettlementReceipt(settlement: Settlement, receipt: Awaited<ReturnType<typeof this.public.getTransactionReceipt>>): Promise<void> {
    if (receipt.status !== 'success') throw new SettlementRejectedError();
    if (receipt.to?.toLowerCase() !== this.config.ESCROW_ADDRESS.toLowerCase()
      || receipt.from.toLowerCase() !== this.account.address.toLowerCase()) throw new SettlementRejectedError();
    await this.assertReceiptAssetPins(receipt.blockHash, receipt.blockNumber);
    if ((await this.public.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Settlement reorg');
    const logs = parseEventLogs({ abi: escrowAbi, eventName: 'RunSettled', logs: receipt.logs.filter(log => log.address.toLowerCase() === this.config.ESCROW_ADDRESS.toLowerCase()) });
    if (!logs.some(log => log.args.runId === settlement.runId && log.args.receiptHash === settlement.receiptHash && log.args.billableSeconds === settlement.billableSeconds && log.args.inferenceCharge === settlement.inferenceCharge)) throw new SettlementRejectedError();
    const run = await this.run(settlement.runId);
    if (run.status !== 2 || run.receiptHash !== settlement.receiptHash) throw new Error('Settlement state mismatch');
  }
}
