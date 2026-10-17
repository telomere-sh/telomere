import { keccak256, toHex, type Hex } from 'viem';
import { addressSchema, bytes32Schema, sameAddress } from '../common.js';
import type { PlatformRuntimeService } from '../platform-runtime/service.js';
import { platformEscrowAbi, platformHostRegistryAbi } from '../platform-runtime/types.js';
import type { platformRuns } from '../platform-runtime/schema.js';
import { receiptPair } from '../receipts/merkle.js';
import { paidBillingUnavailable } from './paid-billing.js';
import { paidMetabolismRate, paidMetabolismSnapshotSchema, type PaidMetabolismSnapshot } from './metabolism-v2.js';

type RunRow = typeof platformRuns.$inferSelect;
const zero = `0x${'0'.repeat(64)}`;
/** Trusted adapters supply only the original registered payer/agent row and verify its canonical
 * admission. Public lifecycle requests have no rate, price, or host override.
 */
export function createPaidMetabolismReader(runtime: PlatformRuntimeService, dependencies: {
  original(owner: string, agent: string, currentRunId: string | null): Promise<RunRow | undefined>;
  verify(owner: string, agent: string, row: RunRow): Promise<void>;
  balanceAt(owner: string, agent: string, blockNumber: bigint): Promise<string>;
}) {
  return async (owner: string, agent: string, currentRunId: string | null): Promise<PaidMetabolismSnapshot> => {
    const bridge = runtime.bridge;
    try {
      await bridge.check();
      const row = await dependencies.original(owner, agent, currentRunId);
      if (currentRunId !== null && (!row || row.id !== currentRunId)) throw paidBillingUnavailable();
      if (row) await dependencies.verify(owner, agent, row);
      const head = await bridge.public.getBlock({ blockTag: 'latest' });
      const now = Math.floor(Date.now() / 1000);
      // A leading or stale chain cannot authorize a current affordability decision.
      if (head.timestamp > BigInt(now + 5) || head.timestamp + 120n < BigInt(now)) throw paidBillingUnavailable();
      const result: PaidMetabolismSnapshot = { version: 2, observedAt: now, blockNumber: head.number.toString(),
        blockHash: head.hash, availableBalance: await dependencies.balanceAt(owner, agent, head.number),
        contextRunId: row ? bytes32Schema.parse(row.id) : null, current: null, projections: [] };
      if (row) {
        if (!row.admissionTx || row.id !== row.quote.runId || row.input.maxSeconds !== row.quote.maxSeconds) throw paidBillingUnavailable();
        const [run, leash, host] = await Promise.all([
          bridge.public.readContract({ address: bridge.pins.escrowAddress, abi: platformEscrowAbi,
            functionName: 'getRun', args: [row.quote.runId], blockNumber: head.number }),
          bridge.public.readContract({ address: bridge.pins.escrowAddress, abi: platformEscrowAbi,
            functionName: 'getLeash', args: [row.quote.leashId], blockNumber: head.number }),
          bridge.public.readContract({ address: bridge.pins.hostRegistryAddress, abi: platformHostRegistryAbi,
            functionName: 'getHost', args: [row.quote.hostId], blockNumber: head.number }),
        ]);
        if (!bridge.matches(row.quote, run) || run.status === 0 || run.openedAt > head.timestamp) throw paidBillingUnavailable();
        const feeBps = 900 - await bridge.feeDiscountBps(row.quote.runId, head.number);
        const profile = row.input.task.kind === 'session' ? row.input.task.resourceProfile ?? 'full' : 'full';
        const original = { runId: row.id, hostId: row.quote.hostId, resourceProfile: profile,
          leaseSeconds: row.quote.maxSeconds, cpuPricePerSecond: row.quote.pricePerSecond,
          fixedInferencePrice: row.quote.inferencePrice, feeBps };
        const until = [run.openedAt + run.maxSeconds, run.acceptedExpiry, leash.expiry,
          BigInt(row.input.deadline)].reduce((a, b) => a < b ? a : b);
        if (currentRunId === row.id && run.status === 1 && run.stopAt === 0n && !leash.killed
          && until > head.timestamp && ['queued', 'running', 'near_dispatching'].includes(row.status)) {
          result.current = paidMetabolismRate(original);
        }
        const config = runtime.publicConfig(), originalLane = row.input.cpuScheduling?.lane ?? 'standard';
        const offer = config.capacity.find(value => value.hostId === row.quote.hostId && value.lane === originalLane);
        // A historical admission supplies identity only. These are freshly checked planning prices,
        // never a reused expired quote; actual wake/replace still requires a new canonical reservation.
        const allow = (root: `0x${string}`, hash: string, proof: string[]) => root === zero
          || proof.reduce<Hex>((node, sibling) => receiptPair(node, bytes32Schema.parse(sibling)),
            keccak256(keccak256(bytes32Schema.parse(hash)))) === root;
        const eligible = offer && offer.lane === originalLane && offer.hardwareClass === 'cpu'
          && keccak256(toHex(offer.imageDigest)) === row.quote.imageHash && keccak256(toHex(offer.region)) === row.quote.regionHash
          && host.active && host.unbondAt === 0n && host.kind !== 2 && !leash.killed
          && sameAddress(leash.owner, row.quote.payer) && sameAddress(leash.agent, addressSchema.parse(row.agent))
          && leash.expiry >= head.timestamp + BigInt(row.quote.maxSeconds) && (leash.classMask & 1n) !== 0n && !leash.sealedOnly
          && allow(leash.imageAllowRoot, row.quote.imageHash, row.imageProof) && allow(leash.regionAllowRoot, row.quote.regionHash, row.regionProof);
        if (eligible) {
          const near = row.input.near, nearConfig = config.near;
          if (near && (!nearConfig || near.model !== nearConfig.model || near.maxTokens !== nearConfig.maxTokens
            || near.policySha256 !== nearConfig.policySha256)) throw paidBillingUnavailable();
          const prices = row.input.task.kind === 'session'
            ? offer.sessionEnabled ? offer.sessionPrices ?? { full: offer.pricePerSecond } : undefined
            : { full: offer.pricePerSecond };
          if (prices) for (const prospectiveProfile of ['full', 'lean', 'torpor'] as const) {
            if (!(prospectiveProfile in prices)) continue;
            const price = prospectiveProfile === 'full' ? prices.full
              : 'lean' in prices && prospectiveProfile === 'lean' ? prices.lean
                : 'torpor' in prices ? prices.torpor : undefined;
            if (price === undefined) continue;
            result.projections.push(paidMetabolismRate({ ...original, resourceProfile: prospectiveProfile,
              cpuPricePerSecond: price, fixedInferencePrice: near ? nearConfig!.inferencePrice : '0',
              // Future holdings and discount can change before admission. Full fee is the reviewed upper bound.
              feeBps: 900 }));
          }
        }
      }
      if ((await bridge.public.getBlock({ blockNumber: head.number })).hash !== head.hash) throw paidBillingUnavailable();
      return paidMetabolismSnapshotSchema.parse(result);
    } catch { throw paidBillingUnavailable(); }
  };
}
