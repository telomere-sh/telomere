import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson, randomId } from '../src/common.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeService, type PlatformV2ReceiptPort } from '../src/platform-runtime/service.js';
import { platformHostSchema, platformQuoteSchema, platformWorkloadHash, validatedPlatformQuoteInputSchema } from '../src/platform-runtime/types.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { platformReceiptBatches, platformReceiptEntries } from '../src/receipts/platform-schema.js';
import { openStore } from '../src/store.js';

describe('Platform v2 evidence availability before shared financial root broadcast', () => {
  it('checks completed and active recorded leaves, including replay of an already sealed batch, without repairing copies', async () => {
    const store = await openStore({ DATA_DIR: ':memory:' });
    const owner = '0x1111111111111111111111111111111111111111', key = randomId(), signer = privateKeyToAccount(key);
    const address = (digit: string) => `0x${digit.repeat(40)}` as const;
    const pins = { chainId: 31337 as const, escrowAddress: address('2'), tokenAddress: address('3'),
      quoteSigner: signer.address, receiptRootAddress: address('4'), hostRegistryAddress: address('5'), feeRouterAddress: address('6'),
      tokenCodeHash: randomId(), reviewedTokenKind: 'immutable' as const, escrowCodeHash: randomId(),
      receiptRootCodeHash: randomId(), hostRegistryCodeHash: randomId(), feeRouterCodeHash: randomId() };
    const bridge = new PlatformBridge(store.db, { pins, rpcUrl: 'http://127.0.0.1:1', signerPrivateKey: key });
    vi.spyOn(bridge.public, 'request').mockRejectedValue(new Error('Unexpected network request in v2 shared seal fixture'));
    const closedHour = 472222, endedAt = closedHour * 3600 + 5, blockHash = randomId();
    const client = new Proxy(bridge.public, { get(target, property, receiver) {
      if (property === 'getChainId') return async () => pins.chainId;
      if (property === 'getBlock') return async () => ({ hash: blockHash, number: 100n, timestamp: BigInt((closedHour + 1) * 3600 + 1) });
      if (property !== 'readContract') return Reflect.get(target, property, receiver);
      return async (args: Parameters<PublicClient['readContract']>[0]) => {
        if (args.functionName === 'receiptRoot') return pins.receiptRootAddress;
        if (args.functionName === 'signerSet') return address('7');
        if (args.functionName === 'currentSigner') return signer.address;
        throw new Error(`Unexpected shared seal contract read ${args.functionName}`);
      };
    } });
    const broadcast = vi.fn(async () => { throw new Error('Fixture reached allowed root broadcast boundary'); });
    let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: pins.chainId, escrowAddress: pins.escrowAddress,
      receiptRootAddress: pins.receiptRootAddress, publicClient: client, submitTransaction: broadcast,
      canSeal: hour => service.canSeal(hour) });
    const available = new Map<string, boolean>(), readRows: string[] = [];
    const issuer: PlatformV2ReceiptPort = { initialize: vi.fn(async () => undefined),
      prepare: vi.fn(async () => { throw new Error('Root guard cannot issue replacement evidence'); }),
      assertPublished: vi.fn(async () => { throw new Error('Root guard cannot repair publication copies'); }),
      assertReadable: vi.fn(async row => {
        readRows.push(row.id);
        if (available.get(row.id) !== true) throw new Error('One configured immutable copy is unavailable');
      }) };
    const image = `fixture/cpu@sha256:${'a'.repeat(64)}`, hostId = randomId();
    const host = platformHostSchema.parse({ hostId, hostKey: new Ed25519Identity().publicKey, hardwareClass: 'cpu',
      region: 'local-test', image, imageDigest: image.split('@')[1], sealed: false, lane: 'standard',
      pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    service = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map()),
      receipts, undefined, undefined, issuer);
    const chainRuns = new Map<Hex, Awaited<ReturnType<PlatformBridge['run']>>>();
    vi.spyOn(bridge, 'run').mockImplementation(async runId => {
      const run = chainRuns.get(runId); if (!run) throw new Error('Unknown original fixture run'); return run;
    });
    try {
      await receipts.initialize();
      const ids: Hex[] = [];
      for (const status of ['completed', 'receipt_pending'] as const) {
        const input = validatedPlatformQuoteInputSchema.parse({ leashId: randomId(), task: { kind: 'sha256', text: status },
          maxSeconds: 20, deadline: endedAt + 300, maxSpend: '10000' });
        const quote = platformQuoteSchema.parse({ runId: randomId(), leashId: input.leashId, hostId, payer: owner,
          hwClass: 0, regionHash: keccak256(toHex('local-test')), imageHash: keccak256(toHex(image.split('@')[1]!)),
          workloadHash: platformWorkloadHash(input), maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: endedAt + 300 });
        const settlement = { runId: quote.runId, billableSeconds: 1, endedAt, inferenceCharge: '0', receiptHash: randomId() };
        const run = { payer: quote.payer, hostOperator: quote.payer, leashId: quote.leashId, hostId,
          hwClass: 0, regionHash: quote.regionHash, imageHash: quote.imageHash, workloadHash: quote.workloadHash,
          sealedHost: false, openedAt: BigInt(endedAt - 5), acceptedExpiry: BigInt(endedAt + 300), maxSeconds: 20n,
          stopAt: 0n, pricePerSecond: 100n, inferencePrice: 0n, ceiling: 2000n,
          status: status === 'completed' ? 2 : 1, billableSeconds: status === 'completed' ? 1n : 0n,
          inferenceCharge: 0n, receiptHash: settlement.receiptHash, hostReleased: status === 'completed' };
        chainRuns.set(quote.runId, run);
        ids.push(quote.runId); available.set(quote.runId, true);
        await store.db.insert(platformRuns).values({ id: quote.runId, owner, agent: owner, idemKey: randomId(),
          inputHash: hashJson(input), input, quote, signature: await bridge.signQuote(quote), ceiling: '2000',
          imageProof: [], regionProof: [], status, receiptVersion: 2, admissionTx: randomId(), settlement });
        const leafRun = { hostId, payer: quote.payer, hwClass: 0, regionHash: quote.regionHash,
          imageHash: quote.imageHash, workloadHash: quote.workloadHash };
        await store.db.insert(platformReceiptEntries).values({ scope: receipts.scope, runId: quote.runId,
          owner, hour: closedHour, receiptHash: settlement.receiptHash, settlement, run: leafRun,
          leaf: platformFinancialLeaf(pins.chainId, pins.escrowAddress, leafRun, settlement) });
      }
      const [completedId, activeId] = ids;
      if (!completedId || !activeId) throw new Error('Missing original fixture rows');
      available.set(completedId, false);
      expect(await service.canSeal(closedHour)).toBe(false);
      await receipts.publish(closedHour);
      expect(broadcast).not.toHaveBeenCalled();
      expect(await store.db.select().from(platformReceiptBatches)).toHaveLength(0);
      available.set(completedId, true);
      expect(await service.canSeal(closedHour)).toBe(true);
      const sealed = await receipts.seal(closedHour);
      expect(sealed?.count).toBe(2);
      available.set(completedId, false);
      await receipts.publish(closedHour);
      expect(broadcast).not.toHaveBeenCalled();
      available.set(completedId, true); available.set(activeId, false);
      await receipts.publish(closedHour);
      expect(broadcast).not.toHaveBeenCalled();
      available.set(activeId, true);
      expect(await service.canSeal(closedHour)).toBe(true);
      await expect(receipts.publish(closedHour)).rejects.toThrow('allowed root broadcast boundary');
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(readRows).toContain(completedId); expect(readRows).toContain(activeId);
      expect(issuer.assertPublished).not.toHaveBeenCalled();
      expect(issuer.prepare).not.toHaveBeenCalled();
      expect(await store.db.select().from(platformReceiptBatches)).toEqual([sealed]);
    } finally { await store.close(); vi.restoreAllMocks(); }
  });
});
