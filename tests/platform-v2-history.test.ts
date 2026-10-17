import { beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { platformEscrowAbi, type PlatformQuote } from '../src/platform-runtime/types.js';
import { recheckPlatformV2Opening, readPlatformV2OpeningAuthority,
  verifyPlatformV2OpeningEvidence } from '../src/receipts/platform-v2-history.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

describe('default-off Platform v2 archive opening authority', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('derives original authority, rejects altered calldata/state, insufficient depth, missing archive and reorg', async () => {
    const local = await deployPlatformRuntime(randomId(), artifacts);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const bridge = new PlatformBridge(store.db, { pins: local.pins,
        rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
      const leashId = randomId();
      const now = await bridge.now();
      const leashCreated = await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
        args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n,
          maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(now + 86_400) }] }));
      const quote: PlatformQuote = { runId: randomId(), leashId, hostId: local.hostId,
        payer: local.accounts.owner.address, hwClass: 0, regionHash: keccak256(toHex('local')),
        imageHash: keccak256(toHex('image')), workloadHash: keccak256(toHex('workload')),
        maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: now + 300 };
      const signature = await bridge.signQuote(quote);
      const beforeOpening = await local.test.snapshot();
      const opened = await local.confirmed(local.owner.sendTransaction({ to: local.pins.escrowAddress,
        data: bridge.openPlan(quote, signature, [], []).data, value: 0n }));
      await expect(readPlatformV2OpeningAuthority(bridge.public, local.pins,
        leashCreated.transactionHash, 1)).rejects.toThrow('calldata cannot be decoded');
      await expect(readPlatformV2OpeningAuthority(bridge.public, local.pins,
        opened.transactionHash, 2)).rejects.toThrow('confirmation depth');
      await local.test.mine({ blocks: 1 });
      const result = await readPlatformV2OpeningAuthority(bridge.public, local.pins,
        opened.transactionHash, 2);
      expect(result.authority).toMatchObject({ runId: quote.runId, hostId: quote.hostId,
        hostKey: (await bridge.host(local.hostId)).hostKey, quoteSigner: local.accounts.signer.address,
        quoteExpiry: quote.quoteExpiry, openedAt: Number((await local.local.publicClient.getBlock({
          blockNumber: opened.blockNumber })).timestamp) });
      expect(result.authority.cutoff).toBe(result.authority.openedAt + quote.maxSeconds);
      expect(result.opening.confirmations).toBeGreaterThanOrEqual(2n);

      const originalTx = await bridge.public.getTransaction({ hash: opened.transactionHash });
      const withTransactionFields = (changed: Partial<typeof originalTx>) => new Proxy(bridge.public, { get(target, key, receiver) {
        return key === 'getTransaction' ? async () => ({ ...originalTx, ...changed }) : Reflect.get(target, key, receiver);
      } }) as PublicClient;
      await expect(readPlatformV2OpeningAuthority(withTransactionFields({ chainId: 84532 }), local.pins,
        opened.transactionHash, 2)).rejects.toThrow('not a successful exact escrow or reviewed Vault call');
      await expect(readPlatformV2OpeningAuthority(withTransactionFields({ value: 1n }), local.pins,
        opened.transactionHash, 2)).rejects.toThrow('not a successful exact escrow or reviewed Vault call');
      await expect(readPlatformV2OpeningAuthority(withTransactionFields({ input: `${originalTx.input}00` }), local.pins,
        opened.transactionHash, 2)).rejects.toThrow('calldata is not canonical');
      const forged = encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun',
        args: [{ ...quote, maxSeconds: BigInt(quote.maxSeconds), pricePerSecond: 100n,
          inferencePrice: 0n, quoteExpiry: BigInt(quote.quoteExpiry) },
        `0x${'0'.repeat(130)}` as Hex, [], []] });
      await expect(readPlatformV2OpeningAuthority(withTransactionFields({ input: forged }), local.pins,
        opened.transactionHash, 2)).rejects.toThrow('quote signature is invalid');
      const expired = encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun',
        args: [{ ...quote, maxSeconds: BigInt(quote.maxSeconds), pricePerSecond: 100n,
          inferencePrice: 0n, quoteExpiry: BigInt(result.authority.openedAt - 1) },
        signature, [], []] });
      await expect(readPlatformV2OpeningAuthority(withTransactionFields({ input: expired }), local.pins,
        opened.transactionHash, 2)).rejects.toThrow('quote expiry');
      await expect(readPlatformV2OpeningAuthority(bridge.public, {
        ...local.pins, escrowCodeHash: randomId() }, opened.transactionHash, 2))
        .rejects.toThrow('historical contract code');
      const withBadHost = new Proxy(bridge.public, { get(target, key, receiver) {
        if (key !== 'readContract') return Reflect.get(target, key, receiver);
        return async (args: Parameters<PublicClient['readContract']>[0]) => {
          const value = await bridge.public.readContract(args);
          return args.functionName === 'getHost' ? { ...value as object, hostKey: randomId() } : value;
        };
      } }) as PublicClient;
      await expect(readPlatformV2OpeningAuthority(withBadHost, local.pins,
        opened.transactionHash, 2)).rejects.toThrow('historical state differs');
      const originalReceipt = await bridge.public.getTransactionReceipt({ hash: opened.transactionHash });
      const withoutRegistryOpen = new Proxy(bridge.public, { get(target, key, receiver) {
        return key === 'getTransactionReceipt' ? async () => ({ ...originalReceipt,
          logs: originalReceipt.logs.filter(log => log.address.toLowerCase()
            !== local.pins.hostRegistryAddress.toLowerCase()) }) : Reflect.get(target, key, receiver);
      } }) as PublicClient;
      await expect(readPlatformV2OpeningAuthority(withoutRegistryOpen, local.pins,
        opened.transactionHash, 2)).rejects.toThrow('opening events or quote expiry');
      const noArchive = new Proxy(bridge.public, { get(target, key, receiver) {
        if (key !== 'readContract') return Reflect.get(target, key, receiver);
        return async (args: Parameters<PublicClient['readContract']>[0]) => {
          if (args.functionName === 'getRun') throw new Error('archive state unavailable');
          return bridge.public.readContract(args);
        };
      } }) as PublicClient;
      await expect(readPlatformV2OpeningAuthority(noArchive, local.pins,
        opened.transactionHash, 2)).rejects.toThrow('archive state unavailable');
      await expect(verifyPlatformV2OpeningEvidence(bridge.public, local.pins,
        opened.transactionHash, {}, randomId(), 2)).rejects.toThrow();

      await local.test.revert({ id: beforeOpening });
      await local.test.mine({ blocks: 3 });
      await expect(recheckPlatformV2Opening(bridge.public, result.opening, 2))
        .rejects.toThrow('reorged or lacks confirmation depth');
    } finally { await store.close(); await local.close(); }
  }, 120_000);

  it('shows the strict v2 opening cutoff can reject a valid later chain settlement', async () => {
    const local = await deployPlatformRuntime(randomId(), artifacts);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const bridge = new PlatformBridge(store.db, { pins: local.pins,
        rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
      const leashId = randomId(), now = await bridge.now();
      await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
        args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n,
          maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(now + 86_400) }] }));
      const quote: PlatformQuote = { runId: randomId(), leashId, hostId: local.hostId,
        payer: local.accounts.owner.address, hwClass: 0, regionHash: keccak256(toHex('local')),
        imageHash: keccak256(toHex('image')), workloadHash: keccak256(toHex('workload')),
        maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: now + 300 };
      const signature = await bridge.signQuote(quote);
      const opened = await local.confirmed(local.owner.sendTransaction({ to: local.pins.escrowAddress,
        data: bridge.openPlan(quote, signature, [], []).data, value: 0n }));
      const authority = (await readPlatformV2OpeningAuthority(bridge.public, local.pins,
        opened.transactionHash, 1)).authority;
      const endedAt = authority.openedAt + quote.maxSeconds + 5;
      expect(endedAt).toBeGreaterThan(authority.cutoff);
      await local.test.setNextBlockTimestamp({ timestamp: BigInt(endedAt) });
      await local.test.mine({ blocks: 1 });
      const settlement = { runId: quote.runId, billableSeconds: 1n, endedAt: BigInt(endedAt),
        inferenceCharge: 0n, receiptHash: randomId() };
      const leaf = await bridge.public.readContract({ address: local.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'receiptLeaf', args: [settlement] });
      const hour = BigInt(Math.floor(endedAt / 3600));
      await local.test.setNextBlockTimestamp({ timestamp: (hour + 1n) * 3600n });
      await local.test.mine({ blocks: 1 });
      await local.confirmed(bridge.wallet.writeContract({ address: local.pins.receiptRootAddress,
        abi: local.artifact('ReceiptRoot').abi, functionName: 'postRoot', args: [hour, leaf, 1] }));
      const settled = await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'settleRun',
        args: [settlement, hour, []] }));
      expect(settled.status).toBe('success');
      const finalRun = await bridge.run(quote.runId);
      expect(finalRun.status).toBe(2);
      expect(finalRun.billableSeconds).toBe(1n);
      expect(endedAt).toBeGreaterThan(authority.cutoff);
    } finally { await store.close(); await local.close(); }
  }, 120_000);
});
