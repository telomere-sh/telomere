import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWalletClient, encodeFunctionData, http, keccak256, toHex, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { openStore } from '../src/store.js';
import { PlatformTransactions } from '../src/platform-runtime/transactions.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformQuoteTypes, typedPlatformQuote, typedPlatformSettlement, type PlatformQuote, type PlatformSettlement } from '../src/platform-runtime/types.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { PlatformReceiptService, platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { platformReceiptBatches, platformReceiptEntries } from '../src/receipts/platform-schema.js';
import { receiptLeaf, verifyReceiptPath } from '../src/receipts/merkle.js';
import { platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const id = (value: string) => keccak256(toHex(value));
describe('full financial platform receipt publication and canonical recovery', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let snapshot: Hex; let count = 0; let canSeal = true;
  let directory: string | undefined;
  const signer = () => createWalletClient({ account: fixture.accounts.signer, chain: localChain, transport: http(fixture.local.rpcUrl, { retryCount: 0 }) });
  const journal = () => new PlatformTransactions(store.db, fixture.local.publicClient, signer(), 31337);
  const service = (submit = journal().submit.bind(journal())) => new PlatformReceiptService(store.db, {
    chainId: 31337, escrowAddress: fixture.pins.escrowAddress, receiptRootAddress: fixture.pins.receiptRootAddress,
    publicClient: fixture.local.publicClient, submitTransaction: submit, canSeal: async () => canSeal,
  });
  const now = async () => Number((await fixture.local.publicClient.getBlock()).timestamp);
  async function advance(timestamp: number) { await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) }); await fixture.test.mine({ blocks: 1 }); }
  async function closed(settlement: PlatformSettlement) { await advance((Math.floor(settlement.endedAt / 3600) + 1) * 3600 + 1); }
  async function open(): Promise<PlatformSettlement> {
    const leashId = id(`leash-${count++}`), timestamp = await now();
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: fixture.accounts.owner.address, maxPerHour: 1_000_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: PLATFORM_ZERO, regionAllowRoot: PLATFORM_ZERO, expiry: BigInt(timestamp + 86_400) }] }));
    const quote: PlatformQuote = { runId: id(`run-${count++}`), leashId, hostId: fixture.hostId, payer: fixture.accounts.owner.address, hwClass: 0,
      regionHash: id('region'), imageHash: id('image'), workloadHash: id('workload'), maxSeconds: 20, pricePerSecond: '1000', inferencePrice: '0', quoteExpiry: timestamp + 300 };
    const signature = await fixture.accounts.signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337, verifyingContract: fixture.pins.escrowAddress },
      primaryType: 'PlatformQuote', types: platformQuoteTypes, message: typedPlatformQuote(quote) });
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'openRun', args: [typedPlatformQuote(quote), signature, [], []] }));
    await advance(await now() + 5);
    return { runId: quote.runId, billableSeconds: 3, endedAt: await now(), inferenceCharge: '0', receiptHash: id(`receipt-${count++}`) };
  }
  async function settle(settlement: PlatformSettlement, proof: { hour: number; proof: Hex[] }) {
    return journal().submit(`test-settle:${settlement.runId}`, fixture.pins.escrowAddress, encodeFunctionData({ abi: platformEscrowAbi, functionName: 'settleRun',
      args: [typedPlatformSettlement(settlement), BigInt(proof.hour), proof.proof] }));
  }
  beforeAll(async () => { fixture = await deployPlatformRuntime(id('financial-host')); snapshot = await fixture.test.snapshot(); }, 120_000);
  beforeEach(async () => {
    await fixture.test.revert({ id: snapshot }); snapshot = await fixture.test.snapshot();
    await advance((Math.floor(await now() / 3600) + 1) * 3600 + 600);
    store = await openStore({ DATA_DIR: ':memory:' }); await service().initialize(); canSeal = true;
  });
  afterEach(async () => { await store.close(); if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; } });
  afterAll(async () => { await fixture.close(); });

  it('independently binds all financial fields and both domain fields to the actual escrow leaf', async () => {
    const settlement = await open(), rpc = fixture.local.publicClient;
    const run = await rpc.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun', args: [settlement.runId] });
    const leaf = platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, settlement);
    expect(leaf).toBe(await rpc.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'receiptLeaf', args: [typedPlatformSettlement(settlement)] }));
    expect(leaf).not.toBe(receiptLeaf(settlement.receiptHash));
    expect(platformFinancialLeaf(84532, fixture.pins.escrowAddress, run, settlement)).not.toBe(leaf);
    expect(platformFinancialLeaf(31337, fixture.accounts.outsider.address, run, settlement)).not.toBe(leaf);
    expect(platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, { ...settlement, inferenceCharge: '1' })).not.toBe(leaf);
    expect(platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, { ...settlement, inferenceCharge: '1' })).toBe(await rpc.readContract({
      address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'receiptLeaf', args: [{ ...typedPlatformSettlement(settlement), inferenceCharge: 1n }],
    }));
    for (const change of [{ hostId: id('other') }, { payer: fixture.accounts.outsider.address }, { hwClass: 1 }, { regionHash: id('other') }, { imageHash: id('other') }, { workloadHash: id('other') }]) {
      expect(platformFinancialLeaf(31337, fixture.pins.escrowAddress, { ...run, ...change }, settlement)).not.toBe(leaf);
    }
    for (const change of [{ runId: id('other') }, { billableSeconds: 2 }, { endedAt: settlement.endedAt - 1 }, { receiptHash: id('other') }]) {
      expect(platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, { ...settlement, ...change })).not.toBe(leaf);
    }
  });

  it('persists exact root nonce before dispatch, recovers a lost response after disk reopen, and conserves real settlement funds', async () => {
    await store.close(); directory = await mkdtemp(join(tmpdir(), 'platform-receipts-'));
    store = await openStore({ DATA_DIR: directory }); await service().initialize();
    const first = await open(), second = await open(), publisher = service();
    await publisher.record(fixture.accounts.owner.address, first); await publisher.record(fixture.accounts.owner.address, second); await closed(first);
    const before = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    const transactions = journal(); let lost = false;
    const crashing = service(async (key, to, data) => { const receipt = await transactions.submit(key, to, data); lost = true; throw new Error(`local lost response ${receipt.transactionHash}`); });
    await expect(crashing.publishClosed()).rejects.toThrow('local lost response'); expect(lost).toBe(true);
    expect(await publisher.proof(fixture.accounts.owner.address, first.runId)).toBeUndefined();
    const [persisted] = await store.db.select().from(platformTransactionJournal); expect(persisted?.nonce).toBe(before);
    await store.close(); store = await openStore({ DATA_DIR: directory });
    const recovered = service(); await recovered.publishClosed(); const proof = await recovered.proof(fixture.accounts.owner.address, first.runId);
    expect(proof?.transactionHash).toBe(persisted?.hash); expect(proof?.proof).toHaveLength(1);
    expect(await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address })).toBe(before + 1);
    if (!proof) throw new Error('Expected canonical proof'); expect(verifyReceiptPath(proof.leaf, proof.proof, proof.root)).toBe(true);
    const receipt = await settle(first, proof); expect((await settle(first, proof)).transactionHash).toBe(receipt.transactionHash);
    await expect(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'settleRun',
      args: [typedPlatformSettlement(first), BigInt(proof.hour), proof.proof] })).rejects.toThrow();
    const run = await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun', args: [first.runId] });
    expect(run.status).toBe(2); expect(run.billableSeconds).toBe(3n);
    const read = (name: string) => fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformRunEscrow').abi, functionName: name }) as Promise<bigint>;
    const tokenBalance = await fixture.local.publicClient.readContract({ address: fixture.pins.tokenAddress, abi: fixture.artifact('MockToken').abi, functionName: 'balanceOf', args: [fixture.pins.escrowAddress] });
    expect(tokenBalance).toBe(await read('totalAvailable') + await read('totalReserved'));
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'availableBalance', args: [fixture.accounts.owner.address] })).toBe(1_000_000n - 3270n - 21800n);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(2);
  }, 30_000);

  it('refuses open-hour roots and pending-outcome sealing, then publishes once', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome);
    await expect(receipts.seal(Math.floor(outcome.endedAt / 3600))).rejects.toMatchObject({ code: 'platform_receipt_hour_open' });
    await closed(outcome); canSeal = false; await receipts.publishClosed(); expect(await store.db.select().from(platformReceiptBatches)).toHaveLength(0);
    canSeal = true; await receipts.publishClosed(); await receipts.publishClosed(); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(1);
  });

  it('keeps the hour unsealed when a known outcome has not entered the durable financial tree', async () => {
    const first = await open(), second = await open();
    const receipts: PlatformReceiptService = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: fixture.pins.escrowAddress,
      receiptRootAddress: fixture.pins.receiptRootAddress, publicClient: fixture.local.publicClient, submitTransaction: journal().submit.bind(journal()),
      canSeal: async (hour): Promise<boolean> => (await Promise.all([first, second].filter(value => Math.floor(value.endedAt / 3600) <= hour)
        .map(value => receipts.hasRecorded(fixture.accounts.owner.address, value)))).every(Boolean) });
    await receipts.record(fixture.accounts.owner.address, first); await closed(first);
    await receipts.publishClosed(); expect(await store.db.select().from(platformReceiptBatches)).toHaveLength(0);
    expect(await receipts.hasRecorded(fixture.accounts.owner.address, second)).toBe(false);
    expect(await receipts.hasRecorded(fixture.accounts.owner.address, { ...first, billableSeconds: 2 })).toBe(false);
    await receipts.record(fixture.accounts.owner.address, second); await receipts.publishClosed();
    expect(await store.db.select().from(platformReceiptBatches)).toMatchObject([{ count: 2 }]);
    expect((await receipts.proof(fixture.accounts.owner.address, second.runId))?.proof).toHaveLength(1);
  });

  it('rejects late outcomes instead of shifting endedAt to another hour or rewriting an immutable root', async () => {
    const first = await open(), late = await open(), receipts = service();
    await receipts.record(fixture.accounts.owner.address, first); await closed(first); await receipts.publishClosed();
    await expect(receipts.record(fixture.accounts.owner.address, late)).rejects.toMatchObject({ code: 'platform_receipt_late' });
    expect(await store.db.select().from(platformReceiptBatches)).toHaveLength(1);
    expect(await receipts.proof(fixture.accounts.owner.address, late.runId)).toBeUndefined();
  });

  it('enforces owner isolation, outcome immutability and receipt-hash replay protection', async () => {
    const first = await open(), second = await open(), receipts = service();
    await expect(receipts.record(fixture.accounts.outsider.address, first)).rejects.toMatchObject({ code: 'platform_receipt_invalid' });
    await receipts.record(fixture.accounts.owner.address, first); await receipts.record(fixture.accounts.owner.address, first);
    await expect(receipts.record(fixture.accounts.owner.address, { ...first, billableSeconds: 2 })).rejects.toMatchObject({ code: 'platform_receipt_conflict' });
    await expect(receipts.record(fixture.accounts.owner.address, { ...second, receiptHash: first.receiptHash })).rejects.toMatchObject({ code: 'platform_receipt_replay' });
    await closed(first); await receipts.publishClosed(); expect(await receipts.proof(fixture.accounts.outsider.address, first.runId)).toBeUndefined();
  });

  it('rejects an orphaned root after Anvil reorg and republishes the exact journaled bytes and nonce', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome); await closed(outcome);
    const beforePublication = await fixture.test.snapshot(); await receipts.publishClosed();
    const proof = await receipts.proof(fixture.accounts.owner.address, outcome.runId); if (!proof) throw new Error('Missing proof');
    const [original] = await store.db.select().from(platformTransactionJournal); await fixture.test.revert({ id: beforePublication });
    await expect(receipts.proof(fixture.accounts.owner.address, outcome.runId)).rejects.toThrow();
    await receipts.publish(proof.hour); expect((await receipts.proof(fixture.accounts.owner.address, outcome.runId))?.transactionHash).toBe(proof.transactionHash);
    expect(await store.db.select().from(platformTransactionJournal)).toEqual([original]);
  });

  it('rejects local leaf tampering and an actual wrong-field settlement on chain', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome); await closed(outcome); await receipts.publishClosed();
    const proof = await receipts.proof(fixture.accounts.owner.address, outcome.runId); if (!proof) throw new Error('Missing proof');
    await expect(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi, functionName: 'settleRun',
      args: [typedPlatformSettlement({ ...outcome, billableSeconds: 2 }), BigInt(proof.hour), proof.proof] })).rejects.toThrow();
    await store.db.update(platformReceiptEntries).set({ leaf: id('tampered') }).where(eq(platformReceiptEntries.runId, outcome.runId));
    await expect(receipts.proof(fixture.accounts.owner.address, outcome.runId)).rejects.toThrow('leaf is corrupted');
  });

  it('rejects an unauthorized publication signature and an unscheduled epoch without controller dispatch', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome);
    await closed(outcome);
    const [entry] = await store.db.select().from(platformReceiptEntries);
    if (!entry) throw new Error('Missing entry');
    const outsider = createWalletClient({ account: fixture.accounts.outsider, chain: localChain, transport: http(fixture.local.rpcUrl) });
    await expect(outsider.writeContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'postRoot',
      args: [BigInt(entry.hour), entry.leaf as Hex, 1] })).rejects.toThrow();
    await advance((Math.floor(await now() / 604800) + 1) * 604800 + 1);
    await expect(receipts.publishClosed()).rejects.toMatchObject({ code: 'platform_receipt_signer_missing' });
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(Math.floor(outcome.endedAt / 3600))] })).toMatchObject({ root: PLATFORM_ZERO });
  });

  it('verifies an earlier root against its historical signer epoch after an approved rotation', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome); await closed(outcome); await receipts.publishClosed();
    const set = await fixture.local.publicClient.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'signerSet' });
    const nextWeek = Math.floor(await now() / 604800) + 1;
    await fixture.confirmed(fixture.owner.writeContract({ address: set, abi: fixture.artifact('SignerSet').abi, functionName: 'scheduleSigner', args: [BigInt(nextWeek), fixture.accounts.outsider.address] }));
    await advance(nextWeek * 604800 + 1);
    expect(await receipts.proof(fixture.accounts.owner.address, outcome.runId)).toMatchObject({ hour: Math.floor(outcome.endedAt / 3600) });
  });

  it('cannot turn fabricated cached publication metadata into a verified wrong-tree proof', async () => {
    const outcome = await open(), receipts = service(); await receipts.record(fixture.accounts.owner.address, outcome); await closed(outcome);
    const hour = Math.floor(outcome.endedAt / 3600); await receipts.seal(hour);
    const transaction = await fixture.confirmed(signer().writeContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi,
      functionName: 'postRoot', args: [BigInt(hour), id('wrong-financial-tree'), 1] }));
    await store.db.update(platformReceiptBatches).set({ transactionHash: transaction.transactionHash }).where(eq(platformReceiptBatches.hour, hour));
    await expect(receipts.proof(fixture.accounts.owner.address, outcome.runId)).rejects.toThrow('not canonical');
  });
});
