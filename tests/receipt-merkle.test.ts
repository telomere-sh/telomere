import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import solc from 'solc';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, decodeFunctionData, http, parseAbi, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { escrowDomain, settlementTypes } from '../src/chain/typed-data.js';
import { localChain } from '../src/chain/chains.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { hashJson, Problem, type StoredQuote } from '../src/common.js';
import { jobs, openStore } from '../src/store.js';
import { HourReceiptService, MAX_HOUR_RECEIPTS, RECEIPT_TREE_ALGORITHM, ZERO_RECEIPT_ROOT,
  createReceiptRoutes, receiptHourBatches, receiptHourEntries, receiptLeaf, receiptTree,
  createReceiptRootReader, verifyHourlyReceipt, verifyReceiptPath, verifySignedReceipt, type ReceiptProof, type ReceiptRootReader } from '../src/receipts/index.js';
import type { SignedReceipt } from '../src/service.js';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const escrow = '0x3333333333333333333333333333333333333333';
const token = '0x4444444444444444444444444444444444444444';
const roots = '0x5555555555555555555555555555555555555555';
const id = (number: number) => `0x${number.toString(16).padStart(64, '0')}` as Hex;
const publicationHour = 497_628;
const close = (publicationHour + 1) * 3_600_000;
const signer = privateKeyToAccount(generatePrivateKey());
const execFileAsync = promisify(execFile);
const pins = { chainId: 31337, escrowAddress: escrow, tokenAddress: token, receiptSigner: signer.address,
  receiptRootAddress: roots } as const;

describe('persistent hourly receipt snapshots and independent verification', () => {
  let store: Awaited<ReturnType<typeof openStore>>, service: HourReceiptService, clock: number;
  let directory: string | undefined;
  async function receipt(number: number, payer: Address = owner, overrides: Record<string, unknown> = {}): Promise<{ receipt: SignedReceipt; quote: StoredQuote }> {
    const quote: StoredQuote = { runId: id(number), leashId: id(50), payer, workloadHash: id(60), maxSeconds: 10,
      pricePerSecond: '10', inferencePrice: '50', quoteExpiry: Math.floor(close / 1000) - 300 };
    const body = { version: 1, runId: quote.runId, payer, leashId: quote.leashId, workloadHash: quote.workloadHash,
      status: 'completed', cpu: { billableSeconds: 3, measuredSeconds: 4, pricePerSecond: '10', ticks: [] }, near: null,
      billing: { token, ceiling: '150', charged: '30', refund: '120' }, issuedAt: new Date(close - 2_000).toISOString(), ...overrides };
    const receiptHash = hashJson(body), settlement = { runId: quote.runId, billableSeconds: 3n, inferenceCharge: 0n, receiptHash };
    const signature = await signer.signTypedData({ domain: escrowDomain(31337, escrow), types: settlementTypes, primaryType: 'Settlement', message: settlement });
    return { quote, receipt: { body, receiptHash, settlement: { ...settlement, billableSeconds: '3', inferenceCharge: '0' },
      signature, signer: signer.address, domain: escrowDomain(31337, escrow) } };
  }
  async function insert(number: number, payer: Address = owner, updatedAt = close - 1_000, overrides: Partial<typeof jobs.$inferInsert> = {}) {
    const signed = await receipt(number, payer);
    await store.db.insert(jobs).values({ id: id(number), owner: payer.toLowerCase(), leashId: id(50), idemKey: `receipt-${number}`,
      inputHash: id(70), input: { leashId: id(50), task: { kind: 'primes', limit: 100 }, maxSeconds: 10 },
      quote: signed.quote, signature: signed.receipt.signature, ceiling: '150', status: 'completed',
      receipt: signed.receipt, charged: '30', refund: '120', billableSeconds: 3, settlementTxHash: id(80 + number),
      updatedAt: new Date(updatedAt), ...overrides });
    return signed.receipt;
  }
  function reader(proof: ReceiptProof, overrides: Partial<Awaited<ReturnType<ReceiptRootReader['root']>>> = {}): ReceiptRootReader {
    return { chainId: async () => 31337, root: async (address, hour) => {
      expect(address.toLowerCase()).toBe(roots); expect(hour).toBe(proof.hour);
      return { root: proof.root, count: proof.leafCount, signer: signer.address, postedAt: 1n, ...overrides };
    } };
  }
  beforeEach(async () => {
    clock = close + 30_000; store = await openStore({ DATA_DIR: ':memory:' });
    service = new HourReceiptService(store.db, pins, () => clock); await service.initialize();
  });
  afterEach(async () => { await store.close(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

  it('seals completed signed receipts from two owners with deterministic private proofs', async () => {
    const first = await insert(1); await insert(2, other); await insert(3);
    const batch = await service.seal(publicationHour);
    expect(batch).toMatchObject({ hour: publicationHour, leafCount: 3, algorithm: RECEIPT_TREE_ALGORITHM });
    const proof = await service.proof(owner, id(1));
    expect(proof.receipt).toEqual(first); expect(verifyReceiptPath(proof.leaf, proof.proof, batch.root)).toBe(true);
    expect(await verifyHourlyReceipt(proof, pins)).toMatchObject({ valid: true, onchain_verified: false, evidence: 'local_only' });
    const listed = await service.list(owner); expect(listed.receipts.map(item => item.runId)).toEqual([id(1), id(3)]);
    expect(JSON.stringify(listed)).not.toContain(other); expect(JSON.stringify(proof)).not.toContain(other);
    await expect(service.proof(other, id(1))).rejects.toMatchObject({ status: 404, code: 'receipt_proof_not_found' });
    await expect(service.proof(owner, id(404))).rejects.toMatchObject({ status: 404, code: 'receipt_proof_not_found' });
  });
  it('freezes the original root and assigns late finalizations to a later publication hour', async () => {
    await insert(1); const batch = await service.seal(publicationHour);
    await insert(2, owner, close + 1_000);
    expect(await service.seal(publicationHour)).toEqual(batch);
    await expect(service.proof(owner, id(2))).rejects.toMatchObject({ status: 404 });
    clock += 3_600_000;
    expect(await service.seal(publicationHour + 1)).toMatchObject({ leafCount: 1 });
    expect((await service.proof(owner, id(1))).hour).toBe(publicationHour);
    expect((await service.proof(owner, id(2))).hour).toBe(publicationHour + 1);
  });
  it('bounds a batch and carries overflow into later hours without duplicate assignments', async () => {
    service = new HourReceiptService(store.db, pins, () => clock, 2);
    await insert(1); await insert(2); await insert(3);
    expect((await service.seal(publicationHour)).leafCount).toBe(2); clock += 3_600_000;
    expect((await service.seal(publicationHour + 1)).leafCount).toBe(1);
    expect(await store.db.select().from(receiptHourEntries)).toHaveLength(3);
    expect((await service.list(owner)).receipts.map(item => item.hour)).toEqual([publicationHour, publicationHour, publicationHour + 1]);
  });
  it('serializes concurrent seals and returns the same durable batch', async () => {
    await insert(1); await insert(2);
    const second = new HourReceiptService(store.db, pins, () => clock);
    const batches = await Promise.all([service.seal(publicationHour), second.seal(publicationHour), service.seal(publicationHour)]);
    expect(batches[0]).toEqual(batches[1]); expect(batches[1]).toEqual(batches[2]);
    expect(await store.db.select().from(receiptHourEntries)).toHaveLength(2);
    expect(await store.db.select().from(receiptHourBatches)).toHaveLength(1);
  });
  it('recovers immutable receipt snapshots after the original job changes and after a real database restart', async () => {
    await store.close(); directory = await mkdtemp(join(tmpdir(), 'telomere-hour-receipts-'));
    store = await openStore({ DATA_DIR: directory }); service = new HourReceiptService(store.db, pins, () => clock); await service.initialize();
    const original = await insert(1); const batch = await service.seal(publicationHour);
    await store.db.update(jobs).set({ receipt: { broken: true }, updatedAt: new Date(close + 5_000) }).where(eq(jobs.id, id(1)));
    await store.close(); store = await openStore({ DATA_DIR: directory });
    service = new HourReceiptService(store.db, pins, () => clock); await service.initialize();
    expect(await service.seal(publicationHour)).toEqual(batch); expect((await service.proof(owner, id(1))).receipt).toEqual(original);
  });
  it('does not publish open, unsigned, refunded, or pending settlements', async () => {
    await insert(1, owner, close - 1_000, { status: 'receipt_pending' });
    await insert(2, owner, close - 1_000, { status: 'settling' });
    await insert(3, owner, close - 1_000, { status: 'refunded' });
    await insert(4, owner, close - 1_000, { receipt: null });
    await insert(5, owner, close - 1_000, { settlementTxHash: null });
    expect(await service.seal(publicationHour)).toMatchObject({ leafCount: 0, root: ZERO_RECEIPT_ROOT });
    expect(await service.preparePublication(publicationHour)).toBeNull();
  });
  it('includes settled failed, cancelled, and timed out runs', async () => {
    await insert(1, owner, close - 1_000, { status: 'failed' });
    await insert(2, owner, close - 1_000, { status: 'cancelled' });
    await insert(3, owner, close - 1_000, { status: 'timed_out' });
    expect((await service.seal(publicationHour)).leafCount).toBe(3);
  });
  it('rejects open hours, backdated new roots, invalid limits, and malformed owners', async () => {
    await expect(service.seal(publicationHour + 1)).rejects.toMatchObject({ code: 'receipt_hour_open' });
    await service.seal(publicationHour);
    await expect(service.seal(publicationHour - 1)).rejects.toMatchObject({ code: 'receipt_hour_out_of_order' });
    expect(() => new HourReceiptService(store.db, pins, () => clock, MAX_HOUR_RECEIPTS + 1)).toThrow('limit');
    await expect(service.list('not-an-address')).rejects.toThrow();
  });
  it('prepares a reviewed unsigned root call without broadcasting or owning a signing key', async () => {
    await insert(1); const batch = await service.seal(publicationHour);
    const prepared = await service.preparePublication(publicationHour); expect(prepared?.transaction.to.toLowerCase()).toBe(roots);
    expect(decodeFunctionData({ abi: parseAbi(['function postRoot(uint64 hour,bytes32 root,uint32 count)']), data: prepared!.transaction.data }))
      .toMatchObject({ functionName: 'postRoot', args: [BigInt(publicationHour), batch.root, 1] });
    const unconfigured = new HourReceiptService(store.db, { chainId: 31337, escrowAddress: escrow, tokenAddress: token, receiptSigner: signer.address }, () => clock);
    await expect(unconfigured.preparePublication(publicationHour)).rejects.toMatchObject({ code: 'receipt_root_unconfigured' });
  });
  it.each(['charged', 'refund', 'billableSeconds', 'owner', 'quote'] as const)('rejects mismatched durable %s atomically', async field => {
    await insert(1); await insert(2);
    const bad = field === 'charged' ? { charged: '31' } : field === 'refund' ? { refund: '119' }
      : field === 'billableSeconds' ? { billableSeconds: 4 } : field === 'owner' ? { owner: other }
        : { quote: { ...(await receipt(2)).quote, pricePerSecond: '11' } };
    await store.db.update(jobs).set(bad).where(eq(jobs.id, id(2)));
    await expect(service.seal(publicationHour)).rejects.toMatchObject({ code: 'receipt_batch_invalid' });
    expect(await store.db.select().from(receiptHourBatches)).toHaveLength(0);
    expect(await store.db.select().from(receiptHourEntries)).toHaveLength(0);
  });
  it('rejects tampered receipt bytes, signatures, domains, token pins, and conservation even after re-signing', async () => {
    const original = (await receipt(1)).receipt;
    expect((await verifySignedReceipt(original, pins)).valid).toBe(true);
    expect((await verifySignedReceipt({ ...original, body: { ...original.body, status: 'tampered' } }, pins)).valid).toBe(false);
    expect((await verifySignedReceipt({ ...original, signature: `0x${'00'.repeat(65)}` }, pins)).valid).toBe(false);
    expect((await verifySignedReceipt(original, { ...pins, chainId: 84532 })).valid).toBe(false);
    expect((await verifySignedReceipt(original, { ...pins, escrowAddress: other })).valid).toBe(false);
    expect((await verifySignedReceipt(original, { ...pins, tokenAddress: other })).valid).toBe(false);
    const forged = (await receipt(2, owner, { billing: { token, ceiling: '150', charged: '30', refund: '121' } })).receipt;
    expect(await verifySignedReceipt(forged, pins)).toMatchObject({ hashValid: true, signatureValid: true, valid: false, conservationValid: false });
  });
  it('verifies sorted pairs for odd and full trees and rejects sibling, leaf, root, and count tampering', async () => {
    for (let size = 1; size <= 17; size++) {
      const tree = receiptTree(Array.from({ length: size }, (_, index) => receiptLeaf(id(index + 1))));
      tree.leaves.forEach((leaf, index) => expect(verifyReceiptPath(leaf, tree.proof(index), tree.root)).toBe(true));
    }
    await insert(1); await insert(2); await service.seal(publicationHour); const proof = await service.proof(owner, id(1));
    for (const changed of [{ ...proof, leaf: id(444) }, { ...proof, root: id(555) },
      { ...proof, proof: [id(666)] }, { ...proof, leafCount: 1 }, { ...proof, proof: Array(13).fill(id(777)) }]) {
      expect((await verifyHourlyReceipt(changed, pins)).valid).toBe(false);
    }
    expect(() => receiptTree([id(1), id(1)])).toThrow('unique');
    expect(() => receiptTree(Array(MAX_HOUR_RECEIPTS + 1).fill(id(1)))).toThrow('limit');
  });
  it('never turns API assertions or a mismatched/unavailable RPC into onchain verification', async () => {
    await insert(1); await service.seal(publicationHour); const proof = await service.proof(owner, id(1));
    expect(await verifyHourlyReceipt(proof, pins, reader(proof))).toMatchObject({ valid: true, onchain_verified: true, evidence: 'chain_root_verified' });
    for (const mismatch of [{ root: id(42) }, { count: 2 }, { postedAt: 0n }]) {
      expect(await verifyHourlyReceipt(proof, pins, reader(proof, mismatch))).toMatchObject({ valid: true, onchain_verified: false, evidence: 'chain_root_mismatch' });
    }
    expect(await verifyHourlyReceipt(proof, pins, { ...reader(proof), chainId: async () => 84532 }))
      .toMatchObject({ onchain_verified: false, evidence: 'chain_root_mismatch' });
    expect(await verifyHourlyReceipt(proof, pins, { ...reader(proof), root: async () => { throw new Error('RPC offline'); } }))
      .toMatchObject({ onchain_verified: false, evidence: 'chain_unavailable' });
    expect(await verifyHourlyReceipt({ ...proof, onchain_verified: true }, pins)).toMatchObject({ valid: false, onchain_verified: false });
  });
  it('detects durable snapshot or root corruption when retrieving a proof', async () => {
    await insert(1); await service.seal(publicationHour);
    await store.db.update(receiptHourEntries).set({ leaf: id(99) }).where(eq(receiptHourEntries.runId, id(1)));
    await expect(service.proof(owner, id(1))).rejects.toMatchObject({ code: 'receipt_batch_corrupt' });
  });
  it('authenticates every route and hides another owner with the same missing-proof response', async () => {
    await insert(1); await insert(2, other); await service.seal(publicationHour); let sessionOwner = '';
    const app = new Hono(); app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : 422));
    app.route('/api/receipt-hours', createReceiptRoutes(service, async () => {
      if (!sessionOwner) throw new Problem(401, 'unauthorized', 'Sign in.'); return sessionOwner;
    }));
    expect((await app.request('/api/receipt-hours')).status).toBe(401);
    expect((await app.request(`/api/receipt-hours/${id(1)}/proof`)).status).toBe(401);
    expect((await app.request('/api/receipt-hours/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    sessionOwner = owner; const owned = await app.request(`/api/receipt-hours/${id(1)}/proof`); expect(owned.status).toBe(200);
    const foreign = await app.request(`/api/receipt-hours/${id(2)}/proof`), missing = await app.request(`/api/receipt-hours/${id(404)}/proof`);
    expect(foreign.status).toBe(404); expect(await foreign.json()).toEqual(await missing.json());
    expect((await app.request(`/api/receipt-hours?owner=${other}`)).status).toBe(422);
    const verified = await app.request('/api/receipt-hours/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof: await owned.json() }) });
    expect(await verified.json()).toMatchObject({ valid: true, onchain_verified: false });
  });
  it('enforces one receipt/run assignment at the database boundary', async () => {
    await insert(1); await service.seal(publicationHour); const [entry] = await store.db.select().from(receiptHourEntries);
    expect(entry).toBeDefined();
    await expect(store.db.insert(receiptHourEntries).values({ ...entry!, position: 1 })).rejects.toThrow();
    expect(await store.db.select().from(receiptHourEntries).where(and(eq(receiptHourEntries.owner, owner), eq(receiptHourEntries.runId, id(1))))).toHaveLength(1);
    expect(await store.db.execute(sql`SELECT count(*) AS count FROM receipt_hour_entries`)).toBeDefined();
  });
  it('paginates only the authenticated owner and rejects oversized finalized receipt bodies', async () => {
    const oversized = (await receipt(1, owner, { padding: 'x'.repeat(196_608) })).receipt;
    await insert(1, owner, close - 1_000, { receipt: oversized });
    await expect(service.seal(publicationHour)).rejects.toMatchObject({ code: 'receipt_batch_invalid' });
    await store.db.delete(jobs).where(eq(jobs.id, id(1)));
    for (let number = 1; number <= 101; number++) await insert(number);
    await insert(102, other); await service.seal(publicationHour);
    const first = await service.list(owner); expect(first.receipts).toHaveLength(100); expect(first.nextCursor).toBe(id(100));
    expect(await service.list(owner, first.nextCursor!)).toEqual({ receipts: [{ runId: id(101), receiptHash: (await service.proof(owner, id(101))).receipt.receiptHash, hour: publicationHour }], nextCursor: null });
  });
  it('runs the standalone verifier without the API, RPC, wallet, or receipt disclosure', async () => {
    await insert(1); await service.seal(publicationHour); const proof = await service.proof(owner, id(1));
    directory = await mkdtemp(join(tmpdir(), 'telomere-receipt-verifier-'));
    const proofPath = join(directory, 'proof.json'), pinsPath = join(directory, 'pins.json');
    await writeFile(proofPath, JSON.stringify(proof), { mode: 0o600 }); await writeFile(pinsPath, JSON.stringify(pins), { mode: 0o600 });
    const args = ['--import', 'tsx', 'scripts/receipt-proof.ts', '--proof', proofPath, '--pins', pinsPath];
    const result = await execFileAsync(process.execPath, args, { cwd: projectRoot, windowsHide: true });
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, onchain_verified: false, evidence: 'local_only' });
    expect(result.stdout).not.toContain(owner); expect(result.stdout).not.toContain(proof.receipt.signature);
    await writeFile(proofPath, JSON.stringify({ ...proof, leaf: id(77) }), { mode: 0o600 });
    await expect(execFileAsync(process.execPath, args, { cwd: projectRoot, windowsHide: true })).rejects.toMatchObject({ code: 1 });
  });
  it('publishes the actual persisted tree to ReceiptRoot and independently verifies it over a real local EVM RPC', async () => {
    const source = 'contracts/ReceiptRoot.sol';
    const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
      sources: { [source]: { content: readFileSync(resolve(projectRoot, source), 'utf8') } },
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    }), { import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported import' } })) as {
      errors?: { severity: string; formattedMessage: string }[];
      contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    };
    const failures = output.errors?.filter(error => error.severity === 'error') ?? [];
    if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
    const local = await startLocalChain();
    try {
      const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
      await test.setBalance({ address: signer.address, value: parseEther('10') });
      const wallet = createWalletClient({ account: signer, chain: localChain, transport: http(local.rpcUrl) });
      async function deploy(name: string, args: readonly unknown[]) {
        const artifact = output.contracts[source]?.[name]; if (!artifact) throw new Error(`Missing ${name}`);
        const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, args });
        const result = await local.publicClient.waitForTransactionReceipt({ hash });
        if (!result.contractAddress || result.status !== 'success') throw new Error('Root deployment failed');
        return result.contractAddress;
      }
      const signerSet = await deploy('SignerSet', [signer.address, signer.address]);
      const receiptRootAddress = await deploy('ReceiptRoot', [signerSet]);
      const chainHour = Number((await local.publicClient.getBlock()).timestamp / 3_600n) - 1;
      clock = (chainHour + 1) * 3_600_000 + 30_000;
      const actualPins = { ...pins, receiptRootAddress };
      service = new HourReceiptService(store.db, actualPins, () => clock);
      for (let number = 1; number <= 5; number++) await insert(number, number === 2 ? other : owner, (chainHour + 1) * 3_600_000 - 1_000);
      const batch = await service.seal(chainHour), proof = await service.proof(owner, id(1));
      const chainReader = createReceiptRootReader(local.rpcUrl);
      expect(await verifyHourlyReceipt(proof, actualPins, chainReader)).toMatchObject({ valid: true, onchain_verified: false, evidence: 'chain_root_mismatch' });
      const prepared = await service.preparePublication(chainHour); expect(prepared).not.toBeNull();
      const hash = await wallet.sendTransaction({ to: receiptRootAddress, data: prepared!.transaction.data });
      expect((await local.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
      expect(await verifyHourlyReceipt(proof, actualPins, chainReader)).toMatchObject({ valid: true, onchain_verified: true, evidence: 'chain_root_verified' });
      const rootAbi = parseAbi(['function verify(bytes32 leaf,bytes32[] proof,uint64 hour) view returns (bool)']);
      for (const run of [1, 3, 4, 5]) {
        const item = await service.proof(owner, id(run));
        expect(await local.publicClient.readContract({ address: receiptRootAddress, abi: rootAbi, functionName: 'verify', args: [item.leaf, item.proof, BigInt(chainHour)] })).toBe(true);
      }
      expect(batch.leafCount).toBe(5);
      const wrongAddress = { ...actualPins, receiptRootAddress: escrow as Address };
      expect(await verifyHourlyReceipt(proof, wrongAddress, chainReader)).toMatchObject({ onchain_verified: false, evidence: 'chain_unavailable' });
    } finally { await local.close(); }
  }, 60_000);
});
