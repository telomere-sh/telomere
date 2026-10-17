import { decodeEventLog, decodeFunctionData, getAbiItem, keccak256, parseAbi, type Hex } from 'viem';
import { bytes32Schema, Problem, sameAddress } from '../common.js';
import { platformFinancialLeaf } from '../receipts/platform-merkle.js';
import { verifyReceiptPath } from '../receipts/merkle.js';
import { platformReceiptRootAbi } from '../receipts/platform-service.js';
import type { PlatformBridge } from './bridge.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformSettlementSchema } from './types.js';
import { readPlatformFeeDiscount } from '../economics/profile.js';

const settlementCalls = parseAbi([
  'struct Settlement { bytes32 runId; uint64 billableSeconds; uint64 endedAt; uint96 inferenceCharge; bytes32 receiptHash; }',
  'struct SettlementInput { Settlement settlement; uint64 hour; bytes32[] proof; }',
  'function settleRun(Settlement settlement,uint64 hour,bytes32[] proof)',
  'function settleBatch(SettlementInput[] batch)',
  'function refundRun(bytes32 runId)',
]);

type Reader = Pick<PlatformBridge, 'pins' | 'public' | 'check' | 'canonicalReceipt'>;
const failure = (code: string, message: string): never => { throw new Problem(409, code, message); };
const PRICE_BOARD_SECONDS = { '1h': 3600n, '24h': 86_400n, '7d': 604_800n } as const;
const PRICE_BOARD_LOG_CHUNK = 8192n;
const PRICE_BOARD_MAX_BLOCKS = 1_048_576n;
const PRICE_BOARD_MAX_SETTLEMENTS = 128;
const PRICE_BOARD_MAX_WALL_MS = 30_000;
const priceLimit = (message: string): never => { throw new Problem(503, 'platform_price_board_limit', message); };

function priceDistribution(prices: bigint[]) {
  const sorted = prices.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (sorted.length === 0) return { count: 0, p10MicroUsdcPerSecond: null, medianMicroUsdcPerSecond: null,
    p90MicroUsdcPerSecond: null };
  const nearest = (percent: number) => sorted[Math.ceil(sorted.length * percent / 100) - 1]!.toString();
  const middle = sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!;
  return { count: sorted.length, p10MicroUsdcPerSecond: nearest(10),
    medianMicroUsdcPerSecond: middle % 2n === 0n ? (middle / 2n).toString() : `${middle / 2n}.5`,
    p90MicroUsdcPerSecond: nearest(90) };
}

/** Public financial evidence only. Host ticks and work correctness need a separate evidence bundle. */
export class PlatformPublicFinancialReader {
  private rateBusy = false;
  private priceBoardBusy = false;
  constructor(private readonly bridge: Reader, private readonly minConfirmations = 12,
    private readonly cpuLane?: (runId: Hex) => Promise<{ lane: 'standard' | 'interruptible'; hostId: Hex; workloadHash: Hex } | null>) {
    if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
      throw new Error('Invalid public financial confirmation depth');
    }
  }

  private async finalizedHead(): Promise<bigint> {
    const head = await this.bridge.public.getBlockNumber({ cacheTime: 0 });
    if (head + 1n < BigInt(this.minConfirmations)) failure('platform_financial_unconfirmed', 'The chain has insufficient confirmation depth.');
    return head - BigInt(this.minConfirmations - 1);
  }

  private async pinnedCode(blockHash: Hex): Promise<void> {
    const { public: rpc, pins } = this.bridge;
    for (const [address, expected] of [
      [pins.escrowAddress, pins.escrowCodeHash], [pins.receiptRootAddress, pins.receiptRootCodeHash],
      [pins.feeRouterAddress, pins.feeRouterCodeHash],
    ] as const) {
      const code = await rpc.getCode({ address, blockHash, requireCanonical: true });
      if (!code || keccak256(code) !== expected) failure('platform_financial_pin_changed', 'Historical financial contract code differs from reviewed pins.');
    }
  }

  async verify(runValue: string, hashValue: string) {
    const runId = bytes32Schema.parse(runValue), hash = bytes32Schema.parse(hashValue);
    await this.bridge.check();
    return this.verifyChecked(runId, hash);
  }

  private async verifyChecked(runValue: string, hashValue: string) {
    const runId = bytes32Schema.parse(runValue), hash = bytes32Schema.parse(hashValue);
    const { public: rpc, pins } = this.bridge;
    const receipt = await this.bridge.canonicalReceipt(hash, pins.escrowAddress);
    const finalized = await this.finalizedHead();
    if (receipt.blockNumber > finalized) failure('platform_financial_unconfirmed', 'The finalization transaction has insufficient confirmations.');
    await this.pinnedCode(receipt.blockHash);
    const transaction = await rpc.getTransaction({ hash });
    if (transaction.hash !== hash || transaction.blockHash !== receipt.blockHash || !transaction.to
      || !sameAddress(transaction.to, pins.escrowAddress) || transaction.chainId !== pins.chainId || transaction.value !== 0n) {
      failure('platform_financial_transaction', 'The canonical transaction does not call the reviewed escrow.');
    }
    let call: ReturnType<typeof decodeFunctionData<typeof settlementCalls>>;
    try { call = decodeFunctionData({ abi: settlementCalls, data: transaction.input }); }
    catch { return failure('platform_financial_transaction', 'The transaction is not a supported Platform finalization.'); }
    const run = await rpc.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun',
      args: [runId], blockHash: receipt.blockHash, requireCanonical: true });
    const common = { chainId: pins.chainId, escrowAddress: pins.escrowAddress, runId,
      transactionHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      payer: run.payer, ceiling: run.ceiling.toString(),
      verification: 'chain-financial-only' as const, tickSignaturesVerified: false as const };
    if (call.functionName === 'refundRun') {
      if (call.args[0] !== runId || run.status !== 3) failure('platform_financial_refund', 'The escrow does not contain this finalized timeout refund.');
      const refunds = receipt.logs.flatMap(log => {
        if (!sameAddress(log.address, pins.escrowAddress)) return [];
        try { const decoded = decodeEventLog({ abi: platformEscrowAbi, data: log.data, topics: log.topics });
          return decoded.eventName === 'RunRefunded' ? [decoded.args] : []; }
        catch { return []; }
      }).filter(event => event.runId === runId);
      if (refunds.length !== 1 || !sameAddress(refunds[0]!.payer, run.payer) || refunds[0]!.amount !== run.ceiling) {
        failure('platform_financial_refund', 'The canonical timeout refund event differs from escrow state.');
      }
      const confirmations = await this.recheck(receipt.blockNumber, receipt.blockHash);
      return { ...common, confirmations: confirmations.toString(), kind: 'timeout-refund' as const,
        charged: '0', returnedAmount: run.ceiling.toString() };
    }
    const inputs = call.functionName === 'settleRun'
      ? [{ settlement: call.args[0], hour: call.args[1], proof: call.args[2] }]
      : call.functionName === 'settleBatch' ? call.args[0] : [];
    const matches = inputs.filter(item => item.settlement.runId === runId);
    if (matches.length !== 1 || run.status !== 2 || !run.hostReleased) {
      failure('platform_financial_settlement', 'The transaction has no unique finalized settlement for this run.');
    }
    const input = matches[0]!;
    const settlement = platformSettlementSchema.parse({ runId: input.settlement.runId,
      billableSeconds: Number(input.settlement.billableSeconds), endedAt: Number(input.settlement.endedAt),
      inferenceCharge: input.settlement.inferenceCharge.toString(), receiptHash: input.settlement.receiptHash });
    const hour = Number(input.hour);
    if (!Number.isSafeInteger(hour) || hour !== Math.floor(settlement.endedAt / 3600)
      || input.proof.length > 12 || settlement.receiptHash === PLATFORM_ZERO
      || run.receiptHash !== settlement.receiptHash || run.billableSeconds !== input.settlement.billableSeconds
      || run.inferenceCharge !== input.settlement.inferenceCharge) {
      failure('platform_financial_settlement', 'The settlement fields differ from the finalized escrow run.');
    }
    const root = await rpc.readContract({ address: pins.receiptRootAddress, abi: platformReceiptRootAbi,
      functionName: 'getRoot', args: [input.hour], blockHash: receipt.blockHash, requireCanonical: true });
    const leaf = platformFinancialLeaf(pins.chainId, pins.escrowAddress, run, settlement);
    if (root.root === PLATFORM_ZERO || root.count < 1 || !verifyReceiptPath(leaf, input.proof, root.root)) {
      failure('platform_financial_proof', 'The financial leaf is absent from the canonical receipt root.');
    }
    const base = input.settlement.billableSeconds * run.pricePerSecond + input.settlement.inferenceCharge;
    const discount = await readPlatformFeeDiscount(rpc, pins, runId, receipt.blockHash);
    const fee = (base * ((run.sealedHost ? 1200n : 900n) - BigInt(discount)) + 9999n) / 10000n;
    if (base + fee > run.ceiling) failure('platform_financial_amount', 'The calculated charge exceeds the original reservation.');
    const returned = run.ceiling - base - fee;
    const settlements = receipt.logs.flatMap(log => {
      if (!sameAddress(log.address, pins.escrowAddress)) return [];
      try { const decoded = decodeEventLog({ abi: platformEscrowAbi, data: log.data, topics: log.topics });
        return decoded.eventName === 'RunSettled' ? [decoded.args] : []; }
      catch { return []; }
    }).filter(event => event.runId === runId);
    if (settlements.length !== 1 || settlements[0]!.receiptHash !== settlement.receiptHash
      || settlements[0]!.receiptLeaf !== leaf || settlements[0]!.hostAmount !== base
      || settlements[0]!.platformFee !== fee || settlements[0]!.returnedAmount !== returned) {
      failure('platform_financial_amount', 'The canonical settlement event differs from the leaf or calculated amounts.');
    }
    const confirmations = await this.recheck(receipt.blockNumber, receipt.blockHash);
    return { ...common, confirmations: confirmations.toString(), kind: 'settlement' as const, receiptHash: settlement.receiptHash,
      ...(pins.financialProfile ? { feeDiscountBps: discount } : {}),
      receiptRootAddress: pins.receiptRootAddress, receiptRoot: root.root, receiptLeaf: leaf, hour,
      billableSeconds: settlement.billableSeconds, endedAt: settlement.endedAt,
      hwClass: run.hwClass, sealedHost: run.sealedHost, pricePerSecond: run.pricePerSecond.toString(),
      inferenceCharge: settlement.inferenceCharge,
      hostAmount: base.toString(), platformFee: fee.toString(), charged: (base + fee).toString(),
      returnedAmount: returned.toString(), proofVerified: true as const };
  }

  /** Restricted unsealed CPU prices; standard lane attribution is controller policy, not onchain evidence. */
  async cpuPriceBoard() {
    if (this.priceBoardBusy) throw new Problem(429, 'platform_price_board_busy', 'A public price window is already being verified.');
    this.priceBoardBusy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.calculateCpuPriceBoard();
    void work.finally(() => { this.priceBoardBusy = false; if (timer) clearTimeout(timer); }).catch(() => undefined);
    return Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Problem(503, 'platform_price_board_limit',
        'The public price window exceeded its verification time limit.')), PRICE_BOARD_MAX_WALL_MS);
      timer.unref?.();
    })]);
  }

  private async calculateCpuPriceBoard() {
    const deadline = Date.now() + PRICE_BOARD_MAX_WALL_MS;
    const withinBudget = () => {
      if (Date.now() > deadline) priceLimit('The public price window exceeded its verification time limit.');
    };
    await this.bridge.check();
    const { public: rpc, pins } = this.bridge;
    const finalized = await this.finalizedHead();
    const anchor = await rpc.getBlock({ blockNumber: finalized });
    const oldest = anchor.timestamp - PRICE_BOARD_SECONDS['7d'];
    // Block timestamps are monotonic for the reviewed EVM chain. Find the first block
    // whose finalization time is strictly inside the seven-day window.
    let low = 0n, high = finalized + 1n;
    while (low < high) {
      withinBudget();
      const middle = (low + high) / 2n;
      const block = await rpc.getBlock({ blockNumber: middle });
      if (block.timestamp <= oldest) low = middle + 1n;
      else high = middle;
    }
    const from = low;
    if (from > finalized || finalized - from + 1n > PRICE_BOARD_MAX_BLOCKS) {
      priceLimit('Seven days of finalized blocks exceed the reviewed public scan limit.');
    }
    const event = getAbiItem({ abi: platformEscrowAbi, name: 'RunSettled' });
    const blockTimes = new Map<bigint, bigint>();
    const seenRuns = new Set<Hex>();
    const samples: { finalizedAt: bigint; price: bigint; lane: 'standard' | 'interruptible' | 'unattributed' }[] = [];
    let verifiedSettlements = 0;
    for (let start = from; start <= finalized; start += PRICE_BOARD_LOG_CHUNK) {
      withinBudget();
      const end = start + PRICE_BOARD_LOG_CHUNK - 1n < finalized ? start + PRICE_BOARD_LOG_CHUNK - 1n : finalized;
      const logs = await rpc.getLogs({ address: pins.escrowAddress, event, fromBlock: start, toBlock: end, strict: true });
      if (verifiedSettlements + logs.length > PRICE_BOARD_MAX_SETTLEMENTS) {
        priceLimit('Seven days of settlements exceed the reviewed public verification limit.');
      }
      for (const log of logs) {
        withinBudget();
        if (!log.transactionHash || !log.blockHash || log.blockNumber < start || log.blockNumber > end
          || seenRuns.has(log.args.runId)) failure('platform_price_board_log', 'A settlement event is missing, duplicated or outside its canonical block range.');
        seenRuns.add(log.args.runId);
        let timestamp = blockTimes.get(log.blockNumber);
        if (timestamp === undefined) {
          const block = await rpc.getBlock({ blockNumber: log.blockNumber });
          if (block.hash !== log.blockHash || block.timestamp <= oldest || block.timestamp > anchor.timestamp) {
            failure('platform_price_board_reorg', 'A settlement event differs from the canonical price window.');
          }
          timestamp = block.timestamp;
          blockTimes.set(log.blockNumber, timestamp);
        } else if ((await rpc.getBlock({ blockNumber: log.blockNumber })).hash !== log.blockHash) {
          failure('platform_price_board_reorg', 'A settlement event differs from its canonical block.');
        }
        const proof = await this.verifyChecked(log.args.runId, log.transactionHash);
        if (proof.kind !== 'settlement') throw new Problem(409, 'platform_price_board_log', 'A settlement event has no financial proof.');
        if (proof.receiptHash !== log.args.receiptHash || proof.receiptLeaf !== log.args.receiptLeaf
          || proof.hostAmount !== log.args.hostAmount.toString()
          || proof.platformFee !== log.args.platformFee.toString()
          || proof.returnedAmount !== log.args.returnedAmount.toString()) {
          failure('platform_price_board_log', 'A settlement event differs from its verified financial proof.');
        }
        verifiedSettlements++;
        if (proof.hwClass === 0 && !proof.sealedHost && proof.inferenceCharge === '0'
          && proof.billableSeconds > 0 && BigInt(proof.pricePerSecond) > 0n) {
          let lane: 'standard' | 'interruptible' | 'unattributed' = 'unattributed';
          if (this.cpuLane) {
            const attributed = await this.cpuLane(log.args.runId);
            if (attributed) {
              const original = await rpc.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi,
                functionName: 'getRun', args: [log.args.runId], blockNumber: finalized });
              if (original.hostId !== attributed.hostId || original.workloadHash !== attributed.workloadHash) {
                failure('platform_price_board_lane_changed', 'Controller lane attribution differs from its canonical signed workload.');
              }
              lane = attributed.lane;
            }
          }
          samples.push({ finalizedAt: timestamp, price: BigInt(proof.pricePerSecond), lane });
        }
      }
    }
    withinBudget();
    await this.recheck(finalized, anchor.hash);
    await this.bridge.check();
    await this.recheck(finalized, anchor.hash);
    const windows = Object.fromEntries(Object.entries(PRICE_BOARD_SECONDS).map(([label, seconds]) => [label,
      { startExclusive: (anchor.timestamp - seconds).toString(), endInclusive: anchor.timestamp.toString(),
        ...priceDistribution(samples.filter(sample => sample.finalizedAt > anchor.timestamp - seconds).map(sample => sample.price)) },
    ]));
    return { chainId: pins.chainId, escrowAddress: pins.escrowAddress, tokenAddress: pins.tokenAddress,
      coverage: 'restricted-reviewed-platform-cpu-unsealed-settlements' as const, marketWide: false as const,
      standardLaneOnchainVerified: false as const, laneAttribution: 'reviewed-controller-policy-only' as const,
      rpcLogEnumerationAssumed: true as const,
      unit: 'micro-USDC-per-billable-second-before-platform-fee' as const,
      windowBasis: 'canonical-finalization-block-time' as const,
      quantiles: 'nearest-rank-p10-p90-exact-middle-pair-median' as const,
      anchorBlock: finalized.toString(), anchorBlockHash: anchor.hash, anchorTimestamp: anchor.timestamp.toString(),
      confirmations: this.minConfirmations, fromBlock: from.toString(), toBlock: finalized.toString(),
      settledEventsVerified: verifiedSettlements, eligibleCpuSettlements: samples.length, windows,
      laneScope: 'original-controller-workload-matched-to-canonical-run' as const,
      hardwareClass: 'cpu' as const,
      lanes: Object.fromEntries((['standard', 'interruptible', 'unattributed'] as const).map(lane => [lane,
        Object.fromEntries(Object.entries(PRICE_BOARD_SECONDS).map(([label, seconds]) => [label,
          priceDistribution(samples.filter(sample => sample.lane === lane && sample.finalizedAt > anchor.timestamp - seconds)
            .map(sample => sample.price))]))])) };
  }

  /** Rate of timeout refunds among finalizations in a bounded canonical block interval. */
  async refundRate(fromValue?: string, toValue?: string) {
    if (this.rateBusy) throw new Problem(429, 'platform_refund_reader_busy', 'A public refund window is already being verified.');
    this.rateBusy = true;
    try { return await this.calculateRefundRate(fromValue, toValue); }
    finally { this.rateBusy = false; }
  }

  private async calculateRefundRate(fromValue?: string, toValue?: string) {
    if ((fromValue === undefined) !== (toValue === undefined)) throw new Problem(422, 'platform_refund_window', 'Specify both block bounds or neither.');
    if (fromValue !== undefined && (!/^(0|[1-9][0-9]{0,15})$/.test(fromValue)
      || !/^(0|[1-9][0-9]{0,15})$/.test(toValue!))) {
      throw new Problem(422, 'platform_refund_window', 'Block bounds must be bounded decimal integers.');
    }
    await this.bridge.check();
    const { public: rpc, pins } = this.bridge;
    const finalized = await this.finalizedHead();
    const from = fromValue === undefined ? (finalized > 255n ? finalized - 255n : 0n) : BigInt(fromValue);
    const to = toValue === undefined ? finalized : BigInt(toValue);
    if (from > to || to > finalized || to - from >= 256n || finalized - from > 65_536n) {
      throw new Problem(422, 'platform_refund_window', 'Use at most 256 finalized blocks within the latest 65,536.');
    }
    const [settled, refunded] = await Promise.all([
      rpc.getLogs({ address: pins.escrowAddress, event: getAbiItem({ abi: platformEscrowAbi, name: 'RunSettled' }), fromBlock: from, toBlock: to, strict: true }),
      rpc.getLogs({ address: pins.escrowAddress, event: getAbiItem({ abi: platformEscrowAbi, name: 'RunRefunded' }), fromBlock: from, toBlock: to, strict: true }),
    ]);
    const logs = [...settled, ...refunded];
    if (logs.length > 512) failure('platform_refund_window_dense', 'The finalized window exceeds the public read bound.');
    const blocks = new Map<bigint, Hex>();
    const runs = new Set<Hex>();
    for (const log of logs) {
      const newBlock = !blocks.has(log.blockNumber);
      const block = blocks.get(log.blockNumber) ?? (await rpc.getBlock({ blockNumber: log.blockNumber })).hash;
      blocks.set(log.blockNumber, block);
      if (block !== log.blockHash || runs.has(log.args.runId)) failure('platform_refund_log', 'A finalized event is orphaned or duplicated.');
      runs.add(log.args.runId);
      if (newBlock) await this.pinnedCode(log.blockHash);
    }
    const anchor = await rpc.getBlock({ blockNumber: to });
    await this.recheck(to, anchor.hash);
    const total = logs.length;
    return { chainId: pins.chainId, escrowAddress: pins.escrowAddress,
      fromBlock: from.toString(), toBlock: to.toString(), toBlockHash: anchor.hash,
      confirmations: this.minConfirmations, finalizedRuns: total, settledRuns: settled.length,
      timeoutRefundedRuns: refunded.length, timeoutRefundRateBps: total ? Math.floor(refunded.length * 10_000 / total) : null,
      definition: 'timeout-refunded finalizations / all finalizations whose escrow event is in this block window' as const };
  }

  private async recheck(number: bigint, hash: Hex): Promise<bigint> {
    const head = await this.bridge.public.getBlockNumber({ cacheTime: 0 });
    if (head < number || head - number + 1n < BigInt(this.minConfirmations)) {
      failure('platform_financial_unconfirmed', 'The financial block has lost its required confirmation depth.');
    }
    if ((await this.bridge.public.getBlock({ blockNumber: number })).hash !== hash) {
      failure('platform_financial_reorg', 'The observed financial block is no longer canonical.');
    }
    return head - number + 1n;
  }
}
