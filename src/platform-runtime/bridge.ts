import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAbiItem, http, parseAbi, parseEventLogs,
  type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { addressSchema, Problem, sameAddress } from '../common.js';
import type { Database } from '../store.js';
import { PlatformTransactions } from './transactions.js';
import { canonicalPlatformReceipt, checkPlatformDeployment } from './read-only.js';
import { spendPermissionOpenCall, spendPermissionOpeningSelector, verifySpendPermissionOpening, type SpendPermission } from '../payments/spend-permissions.js';
import { platformEscrowAbi, platformHostRegistryAbi, platformPinsSchema, platformQuoteTypes, typedPlatformQuote,
  typedPlatformSettlement, platformQuoteDomainVersion,
  type PlatformPins, type PlatformQuote, type PlatformSettlement } from './types.js';
import { readTlmrSchedulingWeights } from '../economics/staking-reader.js';
import { readPlatformFeeDiscount } from '../economics/profile.js';
import { verifyX402CpuOpening, x402ExactSelector, x402UptoSelector, type X402CpuReservation } from '../payments/cpu-reservations.js';

const routerAbi = parseAbi(['function token() view returns (address)', 'function controller() view returns (address)',
  'function quoteFee(uint96 hostAmount,bool sealedHost) view returns (uint256)',
  'function quoteFeeDiscounted(uint96 hostAmount,bool sealedHost,uint16 discountBps) view returns (uint256)']);
const rootAbi = parseAbi(['struct Root { bytes32 root; uint32 count; address signer; uint64 postedAt; }',
  'function getRoot(uint64 hour) view returns (Root)', 'function signerSet() view returns (address)']);
const signerSetAbi = parseAbi(['function weeklySigner(uint64 week) view returns (address)']);
export class PlatformBridge {
  readonly pins: PlatformPins;
  readonly public;
  readonly wallet;
  readonly account;
  readonly transactions: PlatformTransactions;
  constructor(db: Database, input: { pins: PlatformPins; rpcUrl: string; signerPrivateKey: Hex }) {
    this.pins = platformPinsSchema.parse(input.pins);
    const url = new URL(input.rpcUrl);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Platform RPC requires HTTPS or loopback');
    if (this.pins.chainId === 31337 && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local platform chain requires loopback');
    const chain = defineChain({ id: this.pins.chainId, name: 'Telomere reviewed platform',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url.href] } } });
    this.account = privateKeyToAccount(input.signerPrivateKey);
    if (!sameAddress(this.account.address, this.pins.quoteSigner)) throw new Error('Platform quote signer differs from the reviewed pin');
    this.public = createPublicClient({ chain, transport: http(url.href, { timeout: 10_000, retryCount: 0 }) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(url.href, { timeout: 10_000, retryCount: 0 }) });
    this.transactions = new PlatformTransactions(db, this.public, this.wallet, this.pins.chainId);
  }
  async check(): Promise<void> {
    await checkPlatformDeployment(this.public, this.pins);
  }
  async now() { return Number((await this.public.getBlock()).timestamp); }
  async publicationReady(endedAt: number): Promise<void> {
    const publicationWeek = BigInt((Math.floor(endedAt / 3600) + 1) * 3600) / 604800n;
    const signerSet = await this.public.readContract({ address: this.pins.receiptRootAddress, abi: rootAbi, functionName: 'signerSet' });
    const signer = await this.public.readContract({ address: signerSet, abi: signerSetAbi, functionName: 'weeklySigner', args: [publicationWeek] });
    if (!sameAddress(signer, this.account.address)) throw new Problem(503, 'platform_receipt_signer_unavailable', 'The financial publication week requires the reviewed dedicated signer before new work.');
  }
  async hourPublished(hour: number) { return (await this.public.readContract({ address: this.pins.receiptRootAddress,
    abi: rootAbi, functionName: 'getRoot', args: [BigInt(hour)] })).count > 0; }
  leash(id: Hex) { return this.public.readContract({ address: this.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getLeash', args: [id] }); }
  run(id: Hex) { return this.public.readContract({ address: this.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun', args: [id] }); }
  host(id: Hex) { return this.public.readContract({ address: this.pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'getHost', args: [id] }); }
  async balance(owner: string) { return { available: (await this.public.readContract({ address: this.pins.escrowAddress,
    abi: platformEscrowAbi, functionName: 'availableBalance', args: [addressSchema.parse(owner)] })).toString() }; }
  ceiling(quote: PlatformQuote, sealedHost: boolean) { return this.public.readContract({ address: this.pins.escrowAddress,
    abi: platformEscrowAbi, functionName: 'quoteCeiling', args: [typedPlatformQuote(quote), sealedHost] }); }
  fee(base: bigint, sealed: boolean) { return this.public.readContract({ address: this.pins.feeRouterAddress, abi: routerAbi,
    functionName: 'quoteFee', args: [base, sealed] }); }
  async feeDiscountBps(runId: Hex, blockNumber?: bigint) {
    if (!this.pins.financialProfile) return 0 as const;
    const block = await this.public.getBlock(blockNumber === undefined ? {} : { blockNumber });
    const discount = await readPlatformFeeDiscount(this.public, this.pins, runId, block.hash);
    if ((await this.public.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Platform discount snapshot became noncanonical');
    return discount;
  }
  async settlementFee(base: bigint, sealed: boolean, runId: Hex, blockNumber?: bigint) {
    if (!this.pins.financialProfile) return this.fee(base, sealed);
    const discount = await this.feeDiscountBps(runId, blockNumber);
    const expected = (base * BigInt((sealed ? 1200 : 900) - discount) + 9999n) / 10000n;
    const fee = await this.public.readContract({ address: this.pins.feeRouterAddress, abi: routerAbi,
      functionName: 'quoteFeeDiscounted', args: [base, sealed, discount], ...(blockNumber === undefined ? {} : { blockNumber }) });
    if (fee !== expected) throw new Error('Platform locked discount fee differs from reviewed arithmetic');
    return fee;
  }
  async schedulingWeights(hostIds: Hex[]) {
    const policy = this.pins.financialProfile;
    if (!policy) return undefined;
    const latest = await this.public.getBlock({ blockTag: 'latest' });
    const depth = this.pins.chainId === 31337 ? 0n : 12n;
    if (latest.number < depth) throw new Error('Confirmed staking state unavailable');
    const block = await this.public.getBlock({ blockNumber: latest.number - depth });
    const hosts = [];
    for (const hostId of hostIds) {
      const host = await this.public.readContract({ address: this.pins.hostRegistryAddress, abi: platformHostRegistryAbi,
        functionName: 'getHost', args: [hostId], blockNumber: block.number });
      if (!host.active || host.unbondAt !== 0n || host.strikes > 100) throw new Error('Confirmed staking host unavailable');
      hosts.push({ hostId, operator: host.operator, strikes: host.strikes });
    }
    const rows = await readTlmrSchedulingWeights(this.public, { stakingAddress: policy.stakingAddress,
      stakingCodeHash: policy.stakingCodeHash, tokenAddress: policy.utilityTokenAddress, tokenCodeHash: policy.utilityTokenCodeHash,
      blockNumber: block.number, blockHash: block.hash, hosts });
    return rows.map(row => ({ hostId: row.hostId, strikes: row.strikes, schedulingWeight: row.schedulingWeight.toString() }));
  }
  signQuote(quote: PlatformQuote) { return this.account.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(this.pins),
    chainId: this.pins.chainId, verifyingContract: this.pins.escrowAddress }, primaryType: 'PlatformQuote', types: platformQuoteTypes,
    message: typedPlatformQuote(quote) }); }
  plan(data: Hex) { return { chainId: this.pins.chainId, to: this.pins.escrowAddress, data, value: '0' as const }; }
  openPlan(quote: PlatformQuote, signature: Hex, imageProof: Hex[], regionProof: Hex[], permission?: SpendPermission) {
    if (permission) {
      if (!this.pins.spendPermissionProfile) throw new Error('Spend permission funding lacks its reviewed deployment');
      return this.plan(spendPermissionOpenCall(quote, signature, imageProof, regionProof, permission));
    }
    return this.plan(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun', args: [typedPlatformQuote(quote), signature, imageProof, regionProof] }));
  }
  async canonicalReceipt(hash: Hex, destination?: Address): Promise<TransactionReceipt> {
    return canonicalPlatformReceipt(this.public, this.pins, hash, destination);
  }
  async verifyAdmission(quote: PlatformQuote, ceiling: string, hash: Hex, funding?: unknown,
    x402?: { reservation: X402CpuReservation; intentHash: Hex }): Promise<void> {
    return this.verifyOpening(quote, ceiling, hash, funding, x402, true);
  }
  /** Runtime callers always retain the originally selected funding method. */
  async verifyOriginalOpening(quote: PlatformQuote, ceiling: string, hash: Hex, funding: unknown | null,
    x402?: { reservation: X402CpuReservation; intentHash: Hex }): Promise<void> {
    return this.verifyOpening(quote, ceiling, hash, funding, x402, false);
  }
  private async verifyOpening(quote: PlatformQuote, ceiling: string, hash: Hex, funding: unknown,
    x402: { reservation: X402CpuReservation; intentHash: Hex } | undefined, requireOpen: boolean): Promise<void> {
    const receipt = await this.canonicalReceipt(hash, this.pins.escrowAddress);
    const events = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened', logs: receipt.logs.filter(log => sameAddress(log.address, this.pins.escrowAddress)) });
    const run = await this.run(quote.runId);
    if (!events.some(log => log.args.runId === quote.runId && log.args.leashId === quote.leashId && log.args.hostId === quote.hostId
      && sameAddress(log.args.payer, quote.payer) && log.args.ceiling.toString() === ceiling && log.args.maxSeconds === BigInt(quote.maxSeconds))
      || (requireOpen ? run.status !== 1 : run.status === 0) || !this.matches(quote, run) || run.ceiling.toString() !== ceiling) throw new Error('Platform reservation differs from the accepted quote');
    if (this.pins.x402CpuProfile) {
      const transaction = await this.public.getTransaction({ hash }), selector = transaction.input.slice(0, 10),
        funded = selector === x402ExactSelector || selector === x402UptoSelector;
      if (!!x402 !== funded || funding) throw new Error('Platform x402 admission changed its original funding method');
      if (x402) await verifyX402CpuOpening(this.public, this.pins, quote, ceiling, hash, x402.reservation, x402.intentHash);
    } else if (x402) throw new Error('X402 CPU admission lacks reviewed domain4 deployment');
    else if (this.pins.spendPermissionProfile) {
      const transaction = await this.public.getTransaction({ hash });
      const funded = transaction.input.slice(0, 10) === spendPermissionOpeningSelector;
      // Undefined is a generic historical inspection. Null explicitly requires
      // the original balance-funded preparation; an object requires its exact
      // permission-funded calldata. Existing lifecycle readers may inspect either.
      if (funding === null && funded || funding !== undefined && funding !== null && !funded) {
        throw new Error('Platform admission changed its original funding method');
      }
      if (funded) await verifySpendPermissionOpening(this.public, this.pins, quote, ceiling, hash, funding ?? undefined);
    } else if (funding) throw new Error('Spend permission admission lacks reviewed deployment pins');
  }
  /** Attribution at RunOpened log order, including Leash edits earlier or later in that same block. */
  async openingLeash(quote: PlatformQuote, hash: Hex) {
    const receipt = await this.canonicalReceipt(hash, this.pins.escrowAddress);
    const opened = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened', logs: receipt.logs.filter(log => sameAddress(log.address, this.pins.escrowAddress)) })
      .find(log => log.args.runId === quote.runId && log.args.leashId === quote.leashId && sameAddress(log.args.payer, quote.payer));
    if (!opened || opened.logIndex === null || receipt.blockNumber === 0n) throw new Error('Original platform agent evidence unavailable');
    const openingLogIndex = opened.logIndex;
    const [created, updated] = await Promise.all([
      this.public.getLogs({ address: this.pins.escrowAddress, event: getAbiItem({ abi: platformEscrowAbi, name: 'LeashCreated' }),
        args: { leashId: quote.leashId }, blockHash: receipt.blockHash, strict: true }),
      this.public.getLogs({ address: this.pins.escrowAddress, event: getAbiItem({ abi: platformEscrowAbi, name: 'LeashUpdated' }),
        args: { leashId: quote.leashId }, blockHash: receipt.blockHash, strict: true }),
    ]);
    if (created.length + updated.length > 2048) throw new Error('Original platform agent history exceeds reviewed capacity');
    const birth = created.find(log => log.logIndex < openingLogIndex);
    let original = birth ? { owner: birth.args.owner, agent: birth.args.agent }
      : await this.public.readContract({ address: this.pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getLeash', args: [quote.leashId], blockNumber: receipt.blockNumber - 1n });
    for (const log of updated.filter(log => log.logIndex < openingLogIndex).sort((a, b) => a.logIndex - b.logIndex)) {
      original = { ...original, agent: log.args.agent };
    }
    await this.canonicalReceipt(hash, this.pins.escrowAddress);
    return { owner: original.owner, agent: original.agent };
  }
  matches(quote: PlatformQuote, run: Awaited<ReturnType<PlatformBridge['run']>>) {
    return sameAddress(run.payer, quote.payer) && run.leashId === quote.leashId && run.hostId === quote.hostId
      && run.hwClass === quote.hwClass && run.regionHash === quote.regionHash && run.imageHash === quote.imageHash
      && run.workloadHash === quote.workloadHash && run.maxSeconds === BigInt(quote.maxSeconds)
      && run.pricePerSecond === BigInt(quote.pricePerSecond)
      && run.inferencePrice === BigInt(quote.inferencePrice) && !run.sealedHost;
  }
  async confirmedSettlement(settlement: PlatformSettlement, transactionHash: Hex) {
    // A permissionless caller can be a contract; the canonical escrow event is the authority.
    const receipt = await this.canonicalReceipt(transactionHash);
    const run = await this.run(settlement.runId);
    const leaf = await this.public.readContract({ address: this.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'receiptLeaf', args: [typedPlatformSettlement(settlement)] });
    const base = BigInt(settlement.billableSeconds) * run.pricePerSecond + BigInt(settlement.inferenceCharge);
    const fee = await this.settlementFee(base, run.sealedHost, settlement.runId, receipt.blockNumber), refund = run.ceiling - base - fee;
    const events = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunSettled', logs: receipt.logs.filter(log => sameAddress(log.address, this.pins.escrowAddress)) });
    if (run.status !== 2 || run.receiptHash !== settlement.receiptHash || run.billableSeconds !== BigInt(settlement.billableSeconds)
      || run.inferenceCharge !== BigInt(settlement.inferenceCharge) || !run.hostReleased
      || !events.some(log => log.args.runId === settlement.runId && log.args.receiptHash === settlement.receiptHash
        && log.args.receiptLeaf === leaf && log.args.hostAmount === base && log.args.platformFee === fee && log.args.returnedAmount === refund)) {
      throw new Error('Platform settlement financial evidence differs');
    }
    return { transactionHash: receipt.transactionHash, charged: (base + fee).toString(), refund: refund.toString() };
  }
  async reconcileSettlement(settlement: PlatformSettlement, publicationHash: Hex) {
    const root = await this.canonicalReceipt(publicationHash, this.pins.receiptRootAddress), latest = await this.public.getBlockNumber({ cacheTime: 0 });
    if (latest < root.blockNumber || latest - root.blockNumber > 65_536n) {
      throw new Problem(409, 'platform_settlement_history_limit', 'Canonical settlement history requires operator reconciliation.');
    }
    const event = getAbiItem({ abi: platformEscrowAbi, name: 'RunSettled' });
    // Bounded chunks also work with RPC providers that limit eth_getLogs ranges.
    for (let fromBlock = root.blockNumber; fromBlock <= latest; fromBlock += 2048n) {
      const toBlock = fromBlock + 2047n < latest ? fromBlock + 2047n : latest;
      const logs = await this.public.getLogs({ address: this.pins.escrowAddress, event,
        args: { runId: settlement.runId, receiptHash: settlement.receiptHash }, fromBlock, toBlock, strict: true });
      for (const log of logs) if (log.transactionHash) return this.confirmedSettlement(settlement, log.transactionHash);
    }
    throw new Problem(409, 'platform_settlement_evidence_missing', 'The canonical financial settlement event is unavailable.');
  }
  async settle(settlement: PlatformSettlement, hour: number, proof: Hex[], publicationHash: Hex) {
    await this.check();
    if ((await this.run(settlement.runId)).status === 2) return this.reconcileSettlement(settlement, publicationHash);
    const data = encodeFunctionData({ abi: platformEscrowAbi, functionName: 'settleRun', args: [typedPlatformSettlement(settlement), BigInt(hour), proof] });
    try {
      const receipt = await this.transactions.submit(`settle:${settlement.runId}`, this.pins.escrowAddress, data);
      return this.confirmedSettlement(settlement, receipt.transactionHash);
    } catch (error) {
      if ((await this.run(settlement.runId)).status === 2) return this.reconcileSettlement(settlement, publicationHash);
      throw error;
    }
  }
}
