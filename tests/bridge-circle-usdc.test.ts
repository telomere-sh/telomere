import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainSeparator, encodeFunctionData, keccak256, padHex, type Address, type Hex,
  type TransactionSerialized } from 'viem';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { escrowAbi } from '../src/chain/abi.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { jobs, openStore, transactions } from '../src/store.js';
import { hashJson } from '../src/common.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT } from '../src/payments/circle-usdc.js';

const implementation = '0x1111111111111111111111111111111111111111' as Address;
const escrow = '0x2222222222222222222222222222222222222222' as Address;
const proxyCode = '0x6001600055' as Hex, implementationCode = '0x6002600055' as Hex;
const blockHash = `0x${'a'.repeat(64)}` as Hex, parentHash = `0x${'b'.repeat(64)}` as Hex;
const key = `0x${'11'.repeat(32)}` as Hex;
const demo = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: key,
  DEMO_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  ESCROW_ADDRESS: escrow, TOKEN_ADDRESS: '0x3333333333333333333333333333333333333333' });
const config = { ...demo, MODE: 'testnet' as const, CHAIN_ID: 84532, TOKEN_ADDRESS: baseSepoliaUsdc,
  TOKEN_CODE_HASH: keccak256(proxyCode), TOKEN_IMPLEMENTATION_ADDRESS: implementation,
  TOKEN_IMPLEMENTATION_CODE_HASH: keccak256(implementationCode), RPC_URL: 'http://127.0.0.1:1',
  DEMO_PRIVATE_KEY: undefined };

function stubAsset(bridge: ChainBridge, pointer: Address | (() => Address) = implementation) {
  vi.spyOn(bridge.public, 'getChainId').mockResolvedValue(84532);
  vi.spyOn(bridge.public, 'getBlock').mockImplementation(async request => {
    const number = request && 'blockNumber' in request ? request.blockNumber : 200n;
    return { number, hash: number === 199n ? parentHash : blockHash, timestamp: 30_000n } as never;
  });
  vi.spyOn(bridge.public, 'getCode').mockImplementation(async request => request.address.toLowerCase()
    === baseSepoliaUsdc.toLowerCase() ? proxyCode : implementationCode);
  vi.spyOn(bridge.public, 'getStorageAt').mockImplementation(async request => request.slot
    === CIRCLE_PROXY_IMPLEMENTATION_SLOT
      ? padHex(typeof pointer === 'function' ? pointer() : pointer, { size: 32 })
      : padHex('0x', { size: 32 }));
  vi.spyOn(bridge.public, 'readContract').mockImplementation(async request => {
    switch (request.functionName) {
      case 'name': case 'symbol': return 'USDC';
      case 'version': return '2';
      case 'decimals': return 6;
      case 'DOMAIN_SEPARATOR': return domainSeparator({ domain: { name: 'USDC', version: '2', chainId: 84532,
        verifyingContract: baseSepoliaUsdc } });
      default: throw new Error('Unexpected contract call');
    }
  });
  vi.spyOn(bridge.public, 'getLogs').mockResolvedValue([]);
}

async function insertFixtureJob(db: Awaited<ReturnType<typeof openStore>>['db']): Promise<void> {
  const input = { leashId: parentHash, task: { kind: 'sha256' as const, text: 'fixture' }, maxSeconds: 1 };
  await db.insert(jobs).values({ id: blockHash, owner: escrow.toLowerCase(), leashId: parentHash,
    idemKey: 'retained-circle-scope', inputHash: hashJson(input), input,
    quote: { runId: blockHash, leashId: parentHash, payer: escrow, workloadHash: hashJson(input),
      maxSeconds: 1, pricePerSecond: '1', inferencePrice: '0', quoteExpiry: 30_000 },
    signature: `0x${'ab'.repeat(65)}`, ceiling: '1', status: 'settling' });
}

describe('legacy ChainBridge Circle USDC guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses a public signer without proxy and implementation pins', () => {
    expect(() => new ChainBridge({ ...config, TOKEN_IMPLEMENTATION_CODE_HASH: undefined })).toThrow('pins are required');
  });

  it('checks the Circle slot and code before producing a public quote signature', async () => {
    const bridge = new ChainBridge(config);
    stubAsset(bridge);
    const quote = { runId: blockHash, leashId: parentHash, payer: escrow, workloadHash: blockHash,
      maxSeconds: 1n, pricePerSecond: 1n, inferencePrice: 0n, quoteExpiry: 30_000n };
    await expect(bridge.signQuote(quote)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    vi.restoreAllMocks();
    stubAsset(bridge, escrow);
    await expect(bridge.signQuote(quote)).rejects.toThrow('deployment differs');
  });

  it('rejects a retained signed settlement to another destination before any broadcast', async () => {
    const bridge = new ChainBridge(config);
    stubAsset(bridge);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const settlement = { runId: blockHash, billableSeconds: 1n, inferenceCharge: 0n, receiptHash: parentHash };
      await insertFixtureJob(store.db);
      const raw = await bridge.account.signTransaction({ chainId: 84532, to: implementation,
        data: '0x', nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
      await store.db.insert(transactions).values({ runId: settlement.runId, raw, hash: keccak256(raw), nonce: 0 });
      const broadcast = vi.spyOn(bridge.public, 'sendRawTransaction').mockRejectedValue(new Error('Unexpected broadcast'));
      vi.spyOn(bridge.public, 'waitForTransactionReceipt').mockRejectedValue(new Error('Unexpected receipt wait'));
      await expect(bridge.settle(store.db, settlement, '0x')).rejects.toThrow('reviewed scope');
      expect(broadcast).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('refuses a new Base settlement while an old out-of-scope signer journal is retained', async () => {
    const bridge = new ChainBridge(config);
    stubAsset(bridge);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      await insertFixtureJob(store.db);
      const raw = await bridge.account.signTransaction({ chainId: 46630, to: escrow,
        data: '0x', nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
      await store.db.insert(transactions).values({ runId: blockHash, raw, hash: keccak256(raw), nonce: 0 });
      vi.spyOn(bridge.public, 'getTransactionCount').mockResolvedValue(1);
      const broadcast = vi.spyOn(bridge.public, 'sendRawTransaction').mockRejectedValue(new Error('Unexpected broadcast'));
      vi.spyOn(bridge.public, 'waitForTransactionReceipt').mockRejectedValue(new Error('Unexpected receipt wait'));
      await expect(bridge.settle(store.db, { runId: parentHash, billableSeconds: 1n,
        inferenceCharge: 0n, receiptHash: blockHash }, '0x')).rejects.toThrow('Prior settlement journal differs');
      expect(broadcast).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('rechecks Circle pins after a new settlement is signed and stored, before broadcast', async () => {
    const bridge = new ChainBridge(config);
    let currentPointer: Address = implementation;
    stubAsset(bridge, () => currentPointer);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const settlement = { runId: blockHash, billableSeconds: 1n, inferenceCharge: 0n, receiptHash: parentHash };
      const signature = '0x' as Hex;
      await insertFixtureJob(store.db);
      const data = encodeFunctionData({ abi: escrowAbi, functionName: 'settleRun', args: [settlement, signature] });
      const raw = await bridge.account.signTransaction({ chainId: 84532, to: escrow, data,
        nonce: 0, gas: 140_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
      type Prepared = Awaited<ReturnType<typeof bridge.wallet.prepareTransactionRequest>>;
      // REASON: the prepared request is local fixture data; the test verifies the real durable journal and pin ordering.
      vi.spyOn(bridge.wallet, 'prepareTransactionRequest').mockResolvedValue({ to: escrow, data, nonce: 0,
        gas: 100_000n } as Prepared);
      // REASON: the local account signed an explicit EIP-1559 request, so its hex is serialized transaction bytes.
      const sign = vi.spyOn(bridge.wallet, 'signTransaction').mockResolvedValue(raw as TransactionSerialized);
      vi.spyOn(bridge.public, 'getTransactionReceipt').mockImplementation(async () => {
        const saved = await store.db.select().from(transactions);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ runId: settlement.runId, raw, hash: keccak256(raw), nonce: 0 });
        currentPointer = escrow;
        const missing = new Error('Receipt not found');
        missing.name = 'TransactionReceiptNotFoundError';
        throw missing;
      });
      const broadcast = vi.spyOn(bridge.public, 'sendRawTransaction').mockRejectedValue(new Error('Unexpected broadcast'));
      vi.spyOn(bridge.public, 'waitForTransactionReceipt').mockRejectedValue(new Error('Unexpected receipt wait'));
      await expect(bridge.settle(store.db, settlement, signature)).rejects.toThrow('deployment differs');
      expect(sign).toHaveBeenCalledOnce();
      expect(broadcast).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('does not rebroadcast a mined settlement when its receipt block contains a Circle upgrade', async () => {
    const bridge = new ChainBridge(config);
    stubAsset(bridge);
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const settlement = { runId: blockHash, billableSeconds: 1n, inferenceCharge: 0n, receiptHash: parentHash };
      await insertFixtureJob(store.db);
      const signature = '0x' as Hex;
      const data = encodeFunctionData({ abi: escrowAbi, functionName: 'settleRun', args: [settlement, signature] });
      const raw = await bridge.account.signTransaction({ chainId: 84532, to: escrow, data,
        nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
      const hash = keccak256(raw);
      await store.db.insert(transactions).values({ runId: settlement.runId, raw, hash, nonce: 0 });
      vi.spyOn(bridge.public, 'getTransactionReceipt').mockResolvedValue({ status: 'success',
        transactionHash: hash, from: bridge.account.address, to: escrow, blockHash, blockNumber: 200n,
        logs: [] } as never);
      vi.spyOn(bridge.public, 'getLogs').mockResolvedValue([{ transactionHash: hash }] as never);
      const broadcast = vi.spyOn(bridge.public, 'sendRawTransaction').mockRejectedValue(new Error('Unexpected broadcast'));
      vi.spyOn(bridge.public, 'waitForTransactionReceipt').mockRejectedValue(new Error('Unexpected receipt wait'));
      await expect(bridge.settle(store.db, settlement, signature)).rejects.toThrow('changed in transaction block');
      expect(broadcast).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
