import { eq } from 'drizzle-orm';
import { parseEventLogs } from 'viem';
import { jobs } from '../store.js';
import { escrowAbi } from '../chain/abi.js';
import type { Service } from '../service.js';
import { sameAddress } from '../common.js';
import { createReceiptRootReader } from './verifier.js';
import { PublicReceiptVerifier } from './public-verifier.js';

export function configuredPublicReceiptVerifier(service: Service): PublicReceiptVerifier {
  const bridge = service.bridge, pins = { chainId: service.config.CHAIN_ID, escrowAddress: service.config.ESCROW_ADDRESS,
    tokenAddress: service.config.TOKEN_ADDRESS, receiptSigner: bridge.account.address,
    ...(service.config.RECEIPT_ROOT_ADDRESS ? { receiptRootAddress: service.config.RECEIPT_ROOT_ADDRESS } : {}) };
  return new PublicReceiptVerifier(pins, {
    check: () => bridge.check(), run: id => bridge.run(id),
    async record(id) {
      // Deliberately do not select the job's input, output, owner, timestamps or idempotency keys.
      return (await service.db.select({ receipt: jobs.receipt, settlementTxHash: jobs.settlementTxHash })
        .from(jobs).where(eq(jobs.id, id)).limit(1))[0];
    },
    async settlement(receipt, hash) {
      const tx = await bridge.public.getTransactionReceipt({ hash });
      const body = receipt.body;
      const billing = body.billing;
      // REASON: the verifier has already parsed the body, but retains its unknown record type.
      if (!billing || typeof billing !== 'object' || !('charged' in billing) || !('refund' in billing)) throw new Error('Receipt binding missing');
      const logs = parseEventLogs({ abi: escrowAbi, eventName: 'RunSettled', strict: true,
        logs: tx.logs.filter(log => sameAddress(log.address, pins.escrowAddress)) });
      const matching = logs.filter(log => log.args.runId === receipt.settlement.runId);
      const log = matching[0];
      const matches = tx.transactionHash === hash && tx.status === 'success' && tx.to !== null
        && sameAddress(tx.to, pins.escrowAddress) && sameAddress(tx.from, pins.receiptSigner)
        && matching.length === 1 && log !== undefined && !log.removed
        && log.args.receiptHash === receipt.receiptHash
        && log.args.billableSeconds.toString() === receipt.settlement.billableSeconds
        && log.args.inferenceCharge.toString() === receipt.settlement.inferenceCharge
        && log.args.amount.toString() === billing.charged && log.args.returnedAmount.toString() === billing.refund;
      if (!matches) return { matches: false, canonical: false, confirmations: 0n, blockNumber: tx.blockNumber };
      await bridge.assertReceiptAssetPins(tx.blockHash, tx.blockNumber);
      const [block, head, run] = await Promise.all([bridge.public.getBlock({ blockNumber: tx.blockNumber }),
        bridge.public.getBlockNumber({ cacheTime: 0 }), bridge.run(receipt.settlement.runId)]);
      const canonical = block.hash === tx.blockHash && head >= tx.blockNumber && run.status === 2
        && run.receiptHash === receipt.receiptHash && run.billableSeconds.toString() === receipt.settlement.billableSeconds
        && run.inferenceCharge.toString() === receipt.settlement.inferenceCharge;
      return { matches: true, canonical, confirmations: canonical ? head - tx.blockNumber + 1n : 0n, blockNumber: tx.blockNumber };
    },
  }, pins.receiptRootAddress ? createReceiptRootReader(service.config.RPC_URL) : undefined);
}
