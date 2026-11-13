import { and, asc, count, eq, gt, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { parseEventLogs, type Hex } from 'viem';
import { bytes32Schema, hashJson, sameAddress } from '../common.js';
import { jobs } from '../store.js';
import type { Service } from '../service.js';
import { receiptBodySchema, signedReceiptSchema } from '../service.js';
import { verifySignedReceipt } from '../receipts/verifier.js';
import { escrowAbi } from '../chain/abi.js';
import { financialFacts, financialReferences } from './financial-schema.js';
import type { FinancialCandidate, FinancialFact, FinancialHistorySource } from './financial-history.js';

const finals = ['completed', 'failed', 'cancelled', 'timed_out', 'refunded'] as const;
function iso(seconds: bigint): string {
  if (seconds < 0n || seconds > 253402300799n) throw new Error('Invalid block timestamp');
  return new Date(Number(seconds) * 1000).toISOString();
}
export function configuredFinancialSource(service: Service): FinancialHistorySource & {
  register(owner: string, runId: Hex, hash: Hex): Promise<void>;
} {
  const { db, bridge, config } = service;
  const pins = { chainId: config.CHAIN_ID, escrowAddress: config.ESCROW_ADDRESS,
    tokenAddress: config.TOKEN_ADDRESS, receiptSigner: bridge.account.address };
  const scope = hashJson(pins), filters = (cutoff: Date) => and(inArray(jobs.status, [...finals]), lte(jobs.updatedAt, cutoff),
    or(isNotNull(jobs.txHash), isNotNull(jobs.receipt), isNotNull(jobs.settlementTxHash), eq(jobs.status, 'refunded')));
  const source = {
    scope, chainId: config.CHAIN_ID, token: config.TOKEN_ADDRESS, escrow: config.ESCROW_ADDRESS,
    async anchor() {
      await bridge.check(); const head = await bridge.public.getBlockNumber({ cacheTime: 0 });
      const height = head >= 11n ? head - 11n : 0n, block = await bridge.public.getBlock({ blockNumber: height });
      return { height: height.toString(), hash: block.hash };
    },
    async canonical(anchor: { height: string; hash: string }) {
      const [block, head, chain] = await Promise.all([bridge.public.getBlock({ blockNumber: BigInt(anchor.height) }),
        bridge.public.getBlockNumber({ cacheTime: 0 }), bridge.public.getChainId()]);
      return chain === config.CHAIN_ID && head >= BigInt(anchor.height) + 11n && block.hash === anchor.hash;
    },
    async count(cutoff: Date) { return (await db.select({ value: count() }).from(jobs).where(filters(cutoff)))[0]!.value; },
    async page(cutoff: Date, after: string | undefined) {
      return db.select({ id: jobs.id, receipt: jobs.receipt, settlementTxHash: jobs.settlementTxHash })
        .from(jobs).where(and(filters(cutoff), ...(after ? [gt(jobs.id, after)] : []))).orderBy(asc(jobs.id)).limit(25);
    },
    async verify(candidate: FinancialCandidate, anchor: { height: string; hash: string }): Promise<FinancialFact | null> {
      const runId = bytes32Schema.parse(candidate.id), run = await bridge.run(runId);
      if (![2, 3].includes(run.status)) return null;
      const saved = candidate.settlementTxHash ?? (await db.select().from(financialReferences)
        .where(and(eq(financialReferences.scope, scope), eq(financialReferences.runId, runId))).limit(1))[0]?.transactionHash;
      if (!saved || !bytes32Schema.safeParse(saved).success) return null;
      const transactionHash = bytes32Schema.parse(saved), tx = await bridge.public.getTransactionReceipt({ hash: transactionHash });
      if (tx.status !== 'success' || tx.transactionHash !== transactionHash || !tx.to || !sameAddress(tx.to, config.ESCROW_ADDRESS)
        || tx.blockNumber > BigInt(anchor.height)) return null;
      await bridge.assertReceiptAssetPins(tx.blockHash, tx.blockNumber);
      const block = await bridge.public.getBlock({ blockNumber: tx.blockNumber });
      if (block.hash !== tx.blockHash) return null;
      const base = { runId, payer: run.payer.toLowerCase(), transactionHash, blockNumber: tx.blockNumber.toString(),
        blockHash: tx.blockHash, openedAt: iso(run.openedAt), returnedAt: iso(block.timestamp), ceiling: run.ceiling.toString(), lane: null } as const;
      if (block.timestamp < run.openedAt) return null;
      const logs = tx.logs.filter(log => sameAddress(log.address, config.ESCROW_ADDRESS));
      if (run.status === 3) {
        const events = parseEventLogs({ abi: escrowAbi, eventName: 'RunRefunded', logs, strict: true }).filter(log => log.args.runId === runId);
        const event = events[0];
        if (events.length !== 1 || !event || event.removed || !sameAddress(event.args.payer, run.payer) || event.args.amount !== run.ceiling) return null;
        return { ...base, kind: 'timeout_refund', outcome: 'timed_out', receiptHash: null, charged: '0', returned: run.ceiling.toString(),
          billableSeconds: 0, pricePerSecond: null, hardware: null };
      }
      const parsed = signedReceiptSchema.safeParse(candidate.receipt);
      if (!parsed.success || !(await verifySignedReceipt(parsed.data, pins)).valid) return null;
      const receipt = parsed.data, body = receiptBodySchema.safeParse(receipt.body);
      if (!body.success) return null;
      const b = body.data;
      if (receipt.settlement.runId !== runId || receipt.receiptHash !== run.receiptHash || !sameAddress(b.payer, run.payer)
        || b.leashId !== run.leashId || b.workloadHash !== run.workloadHash || BigInt(b.billing.ceiling) !== run.ceiling
        || BigInt(b.cpu.pricePerSecond) !== run.pricePerSecond || BigInt(b.cpu.billableSeconds) !== run.billableSeconds
        || BigInt(receipt.settlement.inferenceCharge) !== run.inferenceCharge || BigInt(b.cpu.measuredSeconds) > run.maxSeconds
        || !sameAddress(tx.from, bridge.account.address)) return null;
      const events = parseEventLogs({ abi: escrowAbi, eventName: 'RunSettled', logs, strict: true }).filter(log => log.args.runId === runId);
      const event = events[0];
      if (events.length !== 1 || !event || event.removed || event.args.receiptHash !== receipt.receiptHash
        || event.args.billableSeconds !== run.billableSeconds || event.args.inferenceCharge !== run.inferenceCharge
        || event.args.amount.toString() !== b.billing.charged || event.args.returnedAmount.toString() !== b.billing.refund) return null;
      const outcome = b.status === 'completed' || b.status === 'failed' || b.status === 'cancelled' || b.status === 'timed_out' ? b.status : 'unknown';
      return { ...base, kind: 'settlement', outcome, receiptHash: receipt.receiptHash, charged: b.billing.charged, returned: b.billing.refund,
        billableSeconds: b.cpu.billableSeconds, pricePerSecond: b.cpu.pricePerSecond, hardware: 'CPU' };
    },
    async save(fact: FinancialFact, generation: string) {
      await db.insert(financialFacts).values({ scope, runId: fact.runId, owner: fact.payer, generation,
        returnedAt: new Date(fact.returnedAt), data: fact }).onConflictDoUpdate({ target: [financialFacts.scope, financialFacts.runId],
        set: { owner: fact.payer, generation, returnedAt: new Date(fact.returnedAt), data: fact } });
    },
    async facts(generation: string, after: string | undefined, owner?: string) {
      return (await db.select({ data: financialFacts.data }).from(financialFacts).where(and(eq(financialFacts.scope, scope),
        eq(financialFacts.generation, generation), ...(after ? [gt(financialFacts.runId, after)] : []),
        ...(owner ? [eq(financialFacts.owner, owner.toLowerCase())] : []))).orderBy(asc(financialFacts.runId)).limit(25)).map(row => row.data);
    },
    async register(owner: string, runId: Hex, hash: Hex) {
      const run = await bridge.run(runId);
      if (run.payer.toLowerCase() !== owner.toLowerCase() || run.status !== 3) throw new Error('Refund reference is not owned');
      const anchor = await source.anchor();
      const fact = await source.verify({ id: runId, receipt: null, settlementTxHash: hash }, anchor);
      if (!fact || fact.kind !== 'timeout_refund') throw new Error('Refund event is not confirmed');
      await db.insert(financialReferences).values({ scope, runId, transactionHash: hash })
        .onConflictDoUpdate({ target: [financialReferences.scope, financialReferences.runId], set: { transactionHash: hash } });
    },
  } satisfies FinancialHistorySource & { register(owner: string, runId: Hex, hash: Hex): Promise<void> };
  return source;
}
