import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { PublicReceiptVerifier, publicReceiptInputSchema, type PublicReceiptReader, type PublicReceiptReport } from '../src/receipts/public-verifier.js';
import { createPublicReceiptRoutes, PUBLIC_RECEIPT_MAX_BYTES } from '../src/receipts/public-routes.js';
import { hashJson } from '../src/common.js';
import { escrowDomain, settlementTypes } from '../src/chain/typed-data.js';
import { RunMeter } from '../src/runtime/meter.js';
import { receiptSettlement, type SignedReceipt } from '../src/service.js';
import { receiptLeaf, RECEIPT_TREE_ALGORITHM } from '../src/receipts/merkle.js';

const signer = privateKeyToAccount(generatePrivateKey());
const address = '0x1111111111111111111111111111111111111111';
const escrow = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const pins = { chainId: 8453, escrowAddress: escrow, tokenAddress: token, receiptSigner: signer.address } as const;
async function fixture() {
  const meter = new RunMeter(id(1), 60); await meter.emit('completed', 2500, 'PRIVATE_OUTPUT');
  const body = { version: 1, runId: id(1), payer: address, leashId: id(2), workloadHash: id(3), status: 'completed',
    cpu: { billableSeconds: 2, measuredSeconds: 2, pricePerSecond: '100', ticks: meter.ticks }, near: null,
    billing: { token, ceiling: '6000', charged: '200', refund: '5800' }, privatePayload: 'PRIVATE_INPUT' };
  const receiptHash = hashJson(body), settlement = { runId: id(1), billableSeconds: '2', inferenceCharge: '0', receiptHash };
  const receipt: SignedReceipt = { body, settlement, receiptHash, signer: signer.address,
    domain: escrowDomain(8453, escrow), signature: '0x' + '00'.repeat(65) as Hex };
  receipt.signature = await signer.signTypedData({ domain: receipt.domain, types: settlementTypes, primaryType: 'Settlement', message: receiptSettlement(receipt) });
  const run: Awaited<ReturnType<PublicReceiptReader['run']>> = { payer: address, leashId: id(2), workloadHash: id(3), openedAt: 1n, acceptedExpiry: 1000n,
    maxSeconds: 60n, pricePerSecond: 100n, inferencePrice: 0n, ceiling: 6000n, stopAt: 0n,
    status: 2, billableSeconds: 2n, inferenceCharge: 0n, receiptHash };
  const reader: PublicReceiptReader = { check: vi.fn(async () => undefined), run: vi.fn(async () => run),
    record: vi.fn(async () => ({ receipt, settlementTxHash: id(9) })),
    settlement: vi.fn(async () => ({ matches: true, canonical: true, confirmations: 12n, blockNumber: 100n })) };
  return { receipt, run, reader, verifier: new PublicReceiptVerifier(pins, reader) };
}
const resultStep = (report: PublicReceiptReport, id: string) => report.steps.find(step => step.id === id);

describe('public receipt verification without private record disclosure', () => {
  it('verifies an actual EIP-712 signature, meter chain and settlement with exact atomic amounts', async () => {
    const f = await fixture(), result = await f.verifier.verify({ receipt: f.receipt });
    expect(result.outcome).toBe('verified');
    expect(result.summary).toMatchObject({ charged: '200', refund: '5800', ceiling: '6000', billableSeconds: 2, settlementTxHash: id(9) });
    expect(resultStep(result, 'host_signatures')?.status).toBe('not_applicable');
    expect(resultStep(result, 'hourly_root')?.status).toBe('not_applicable');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|privatePayload|"ticks":|"signature":|"payer":/);
  });
  it('accepts a run ID, reads only a settled record and never returns its private receipt', async () => {
    const f = await fixture(), result = await f.verifier.verify({ runId: id(1) });
    expect(result.outcome).toBe('verified'); expect(f.reader.check).toHaveBeenCalledOnce();
    expect(f.reader.record).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not query the private store for nonexistent, active or refunded run IDs', async () => {
    for (const status of [0, 1, 3]) {
      const f = await fixture(); f.run.status = status;
      expect((await f.verifier.verify({ runId: id(1) })).outcome).toBe('incomplete');
      expect(f.reader.record).not.toHaveBeenCalled();
    }
  });
  it('does not treat an unavailable signed receipt as a verified on-chain record', async () => {
    const f = await fixture(); f.reader.record = async () => undefined;
    const result = await f.verifier.verify({ runId: id(1) });
    expect(result.outcome).toBe('incomplete'); expect(result.summary).toBeUndefined();
  });
  it('supports execution-record exports but returns only a redacted summary', async () => {
    const f = await fixture();
    const result = await f.verifier.verify({ receipt: { receipt: f.receipt, settlementTxHash: id(9), output: 'SECRET' } });
    expect(result.outcome).toBe('verified'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects changed bodies before issuing RPC requests', async () => {
    const f = await fixture(); f.receipt.body.privatePayload = 'tampered';
    const result = await f.verifier.verify({ receipt: f.receipt });
    expect(result.outcome).toBe('invalid'); expect(resultStep(result, 'hash')?.status).toBe('failed');
    expect(f.reader.check).not.toHaveBeenCalled(); expect(f.reader.record).not.toHaveBeenCalled();
  });
  it('rejects wrong network, escrow and operator identity', async () => {
    for (const field of ['chain', 'escrow', 'signer']) {
      const f = await fixture();
      if (field === 'chain') f.receipt.domain.chainId = 1;
      if (field === 'escrow') f.receipt.domain.verifyingContract = address;
      if (field === 'signer') f.receipt.signer = address;
      const result = await f.verifier.verify({ receipt: f.receipt });
      expect(result.outcome).toBe('invalid'); expect(resultStep(result, 'domain')?.status).toBe('failed');
      expect(f.reader.check).not.toHaveBeenCalled();
    }
  });
  it('rejects a signature from another account without any chain lookup', async () => {
    const f = await fixture(), other = privateKeyToAccount(generatePrivateKey());
    f.receipt.signature = await other.signTypedData({ domain: f.receipt.domain, types: settlementTypes,
      primaryType: 'Settlement', message: receiptSettlement(f.receipt) });
    const result = await f.verifier.verify({ receipt: f.receipt });
    expect(resultStep(result, 'signature')?.status).toBe('failed'); expect(result.outcome).toBe('invalid');
    expect(f.reader.check).not.toHaveBeenCalled();
  });
  it('rejects operator-signed inconsistent arithmetic and corrupt meter chains', async () => {
    for (const meter of [false, true]) {
      const f = await fixture();
      const body = f.receipt.body;
      if (meter) body.cpu = { billableSeconds: 2, measuredSeconds: 2, pricePerSecond: '100', ticks: [] };
      else body.billing = { token, charged: '201', ceiling: '6000', refund: '5799' };
      f.receipt.receiptHash = hashJson(body); f.receipt.settlement.receiptHash = f.receipt.receiptHash;
      f.receipt.signature = await signer.signTypedData({ domain: f.receipt.domain, types: settlementTypes,
        primaryType: 'Settlement', message: receiptSettlement(f.receipt) });
      const result = await f.verifier.verify({ receipt: f.receipt });
      expect(result.outcome).toBe('invalid'); expect(resultStep(result, meter ? 'meter' : 'billing')?.status).toBe('failed');
    }
  });
  it('rejects a valid signature bound to a different on-chain workload', async () => {
    const f = await fixture(); f.run.workloadHash = id(4);
    expect(resultStep(await f.verifier.verify({ receipt: f.receipt }), 'chain')?.status).toBe('failed');
  });
  it('does not give a full pass before settlement or confirmations', async () => {
    const f = await fixture(); f.run.status = 1;
    expect((await f.verifier.verify({ receipt: f.receipt })).outcome).toBe('incomplete');
    f.run.status = 2; f.reader.settlement = async () => ({ matches: true, canonical: true, confirmations: 11n, blockNumber: 1n });
    expect((await f.verifier.verify({ receipt: f.receipt })).outcome).toBe('incomplete');
    f.reader.settlement = async () => ({ matches: true, canonical: false, confirmations: 100n, blockNumber: 1n });
    expect((await f.verifier.verify({ receipt: f.receipt })).outcome).toBe('incomplete');
  });
  it('rejects a wrong event or wrong transaction; RPC errors stay unavailable', async () => {
    const f = await fixture(); f.reader.settlement = async () => ({ matches: false, canonical: true, confirmations: 20n, blockNumber: 1n });
    expect((await f.verifier.verify({ receipt: f.receipt })).outcome).toBe('invalid');
    f.reader.settlement = async () => { throw new Error('secret RPC URL'); };
    const result = await f.verifier.verify({ receipt: f.receipt });
    expect(result.outcome).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('reports missing event hash as incomplete and accepts an explicitly supplied hash', async () => {
    const f = await fixture(); f.reader.record = async () => ({ receipt: f.receipt, settlementTxHash: null });
    expect((await f.verifier.verify({ receipt: f.receipt })).outcome).toBe('incomplete');
    expect((await f.verifier.verify({ runId: id(1), settlementTxHash: id(9) })).outcome).toBe('verified');
  });
  it('verifies a supplied hourly proof only against the configured root', async () => {
    const f = await fixture(), leaf = receiptLeaf(f.receipt.receiptHash);
    const proof = { version: 1 as const, algorithm: RECEIPT_TREE_ALGORITHM, hour: 10, root: leaf,
      leafCount: 1, leaf, proof: [], receipt: f.receipt };
    const verifier = new PublicReceiptVerifier({ ...pins, receiptRootAddress: address }, f.reader,
      { chainId: async () => 8453, root: async () => ({ root: leaf, count: 1, signer: signer.address, postedAt: 1n }) });
    expect(resultStep(await verifier.verify({ receipt: proof }), 'hourly_root')?.status).toBe('passed');
    proof.root = id(8);
    expect((await verifier.verify({ receipt: proof })).outcome).toBe('invalid');
    expect((await f.verifier.verify({ receipt: { ...proof, proof: ['bad'] } })).outcome).toBe('invalid');
  });
});

describe('bounded public read-only verification HTTP surface', () => {
  const report: PublicReceiptReport = { outcome: 'invalid', checkedAt: new Date().toISOString(), steps: [] };
  const post = (body: unknown) => new Request('http://localhost/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('requires exactly one input and does not accept remote URLs or owner selectors', () => {
    for (const value of [{}, { runId: id(1), receipt: {} }, { runId: id(1), owner: address }, { url: 'http://internal' }]) expect(publicReceiptInputSchema.safeParse(value).success).toBe(false);
  });
  it('works without a wallet session and sends no private input back', async () => {
    const verify = vi.fn(async () => report), routes = createPublicReceiptRoutes({ verify });
    const response = await routes.request(post({ receipt: { secret: 'NOT_RETURNED' } }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(report); expect(verify).toHaveBeenCalledOnce();
  });
  it('rejects oversized, deeply nested, malformed and invalid UTF-8 bodies before verification', async () => {
    const verify = vi.fn(async () => report), routes = createPublicReceiptRoutes({ verify });
    expect((await routes.request(post({ receipt: 'x'.repeat(PUBLIC_RECEIPT_MAX_BYTES) }))).status).toBe(413);
    let deep: unknown = {}; for (let i = 0; i < 30; i++) deep = { next: deep };
    expect((await routes.request(post({ receipt: deep }))).status).toBe(422);
    expect((await routes.request(new Request('http://localhost/verify', { method: 'POST', body: '{bad' }))).status).toBe(400);
    expect((await routes.request(new Request('http://localhost/verify', { method: 'POST', body: new Uint8Array([0xff]) }))).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });
  it('retains concurrency slots after HTTP timeout until underlying work finishes', async () => {
    const resolvers: ((value: PublicReceiptReport) => void)[] = [];
    const routes = createPublicReceiptRoutes({ verify: () => new Promise(resolve => resolvers.push(resolve)) }, 15);
    const first = routes.request(post({ runId: id(1) })), second = routes.request(post({ runId: id(2) }));
    expect((await first).status).toBe(503); expect((await second).status).toBe(503);
    expect((await routes.request(post({ runId: id(3) }))).status).toBe(429);
    resolvers.forEach(resolve => resolve(report)); await Promise.resolve(); await Promise.resolve();
    expect((await routes.request(post({}))).status).toBe(422);
  });
});
