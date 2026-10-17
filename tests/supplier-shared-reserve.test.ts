import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytes32Schema } from '../src/common.js';
import { FileSupplierLedger, type SupplierRecord } from '../src/suppliers/ledger.js';
import { FileNosanaLedger, type NosanaReservation } from '../src/suppliers/nosana-ledger.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';

const owner = '0x1111111111111111111111111111111111111111';
const hash = (character: string) => bytes32Schema.parse('0x' + character.repeat(64));
const runA = hash('a'), runB = hash('b');
const solana = (character: string) => character.repeat(43);
function akashRecord(amount: string, state: SupplierRecord['state'] = 'planned'): SupplierRecord {
  return { id: hash('1'), owner, runId: runA, idemKey: 'a', requestHash: hash('2'),
    akashOwner: 'akash1' + 'o'.repeat(38), dseq: '1234567', gseq: 1, oseq: 1,
    provider: 'akash1' + 'p'.repeat(38), deploymentHash: 'manifest', pricePerBlockUact: '1', runtimeHours: 1,
    reservedUact: '1', reservedUsdcMicros: amount, quoteSource: 'fixture', quoteAsOfMs: 1,
    usdcMicrosPerMillionUact: '1', maxBlocksPerHour: 3600, state, version: 0,
    createdAt: 1, updatedAt: 1, lastObservedAt: null, reason: null };
}
function nosanaRecord(amount: string): NosanaReservation {
  return { id: hash('3'), owner, runId: runB, idemKey: 'b', requestHash: hash('4'),
    jobAddress: solana('E'), payer: solana('A'), market: solana('B'), node: solana('C'),
    ipfsJob: 'Qm' + 'a'.repeat(44), priceNosBaseUnitsPerSecond: '1', timeoutSeconds: 1,
    timeStartSeconds: 1, reservedNosBaseUnits: '1', reservedUsdcMicros: amount,
    quoteSource: 'fixture', quoteAsOfMs: 1, usdcMicrosPerMillionNosBaseUnits: '1',
    state: 'active_observed', reason: null, version: 0, createdAt: 1, updatedAt: 1, lastObservedAt: 1 };
}

describe('shared Akash and Nosana supplier reserve', () => {
  let directory: string, akash: FileSupplierLedger, nosana: FileNosanaLedger;
  let lockPath: string;
  const gate = (ceiling = '1500000') => new FileSupplierSharedReserve({ lockPath, akash, nosana,
    maxOpenReservedUsdcMicros: ceiling });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-supplier-shared-'));
    lockPath = join(directory, 'shared.lock');
    akash = new FileSupplierLedger(join(directory, 'akash.json'));
    nosana = new FileNosanaLedger(join(directory, 'nosana.json'));
    await akash.initializeFresh(); await nosana.initializeFresh(); await gate().initializeFresh();
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('rejects cross-network USDC oversubscription after a durable Akash admission and restart', async () => {
    await gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1000000' },
      () => akash.transact(file => { file.records.push(akashRecord('1000000')); }));
    const reopened = new FileSupplierSharedReserve({ lockPath,
      akash: new FileSupplierLedger(join(directory, 'akash.json')),
      nosana: new FileNosanaLedger(join(directory, 'nosana.json')),
      maxOpenReservedUsdcMicros: '1500000' });
    let committed = false;
    await expect(reopened.admit({ network: 'nosana', owner, runId: runB, reservedUsdcMicros: '600000' },
      async () => { committed = true; })).rejects.toMatchObject({ code: 'supplier_shared_budget_exceeded' });
    expect(committed).toBe(false);
    expect((await nosana.read()).records).toHaveLength(0);
  });

  it('rejects reuse of one run on the other network even with spare budget', async () => {
    await akash.transact(file => { file.records.push(akashRecord('100')); });
    await expect(gate().admit({ network: 'nosana', owner, runId: runA, reservedUsdcMicros: '100' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_run_already_reserved' });
  });

  it('counts a Nosana commitment before admitting Akash and permits the exact ceiling', async () => {
    await nosana.transact(file => { file.records.push(nosanaRecord('400000')); });
    await expect(gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1100001' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_shared_budget_exceeded' });
    let admitted = false;
    await gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1100000' },
      async () => { admitted = true; });
    expect(admitted).toBe(true);
  });

  it('lets the original journal verify an exact retry after its optimistic read raced a full-ceiling commit', async () => {
    const original = akashRecord('1500000');
    await akash.transact(file => { file.records.push(original); });
    const replayed = await gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1500000' },
      () => akash.transact(file => {
        const previous = file.records.find(record => record.id === original.id);
        if (!previous || previous.requestHash !== original.requestHash) throw new Error('Original reservation changed');
        return previous.id;
      }));
    expect(replayed).toBe(original.id);
    expect((await akash.read()).records).toHaveLength(1);
  });

  it('retains the full reserve for closed or quarantined external work', async () => {
    await akash.transact(file => { file.records.push(akashRecord('1000000', 'closed_unsettled')); });
    await nosana.transact(file => { file.records.push(nosanaRecord('400000')); });
    await expect(gate().admit({ network: 'nosana', owner, runId: '0x' + 'c'.repeat(64), reservedUsdcMicros: '100001' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_shared_budget_exceeded' });
  });

  it('excludes a canceled unsubmitted Akash plan from the cross-network ceiling but retains its run claim', async () => {
    await akash.transact(file => { file.records.push(akashRecord('1000000', 'canceled_unsubmitted')); });
    let committed = false;
    await gate().admit({ network: 'nosana', owner, runId: runB, reservedUsdcMicros: '1500000' },
      async () => { committed = true; });
    expect(committed).toBe(true);
    await expect(gate().admit({ network: 'nosana', owner, runId: runA, reservedUsdcMicros: '1' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_run_already_reserved' });
  });

  it('serializes concurrent admissions and requires inspection of a stale lock', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const first = gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1000000' },
      async () => { entered(); await hold; await akash.transact(file => { file.records.push(akashRecord('1000000')); }); });
    await inside;
    await expect(gate().admit({ network: 'nosana', owner, runId: runB, reservedUsdcMicros: '600000' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_shared_reserve_locked' });
    release(); await first;
    await expect(gate().admit({ network: 'nosana', owner, runId: runB, reservedUsdcMicros: '600000' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_shared_budget_exceeded' });
    await writeFile(lockPath, 'previous writer', { flag: 'wx' });
    await expect(gate().admit({ network: 'nosana', owner, runId: runB, reservedUsdcMicros: '1' },
      async () => true)).rejects.toMatchObject({ code: 'supplier_shared_reserve_locked' });
  });

  it('fails closed on a corrupt peer journal', async () => {
    await writeFile(join(directory, 'nosana.json'), '{');
    let committed = false;
    await expect(gate().admit({ network: 'akash', owner, runId: runA, reservedUsdcMicros: '1' },
      async () => { committed = true; })).rejects.toThrow();
    expect(committed).toBe(false);
    expect((await akash.read()).records).toHaveLength(0);
  });
});
