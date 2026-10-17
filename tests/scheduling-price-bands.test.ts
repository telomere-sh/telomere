import { describe, expect, it } from 'vitest';
import { bytes32Schema, hashJson, Problem } from '../src/common.js';
import { capacityIdentity, selectCapacity, type Capacity, type CapacitySelectionOptions, type PlacementRequest } from '../src/scheduling/planner.js';
import { assertCpuReplacementApproval, planCpuReplacement, type CpuReplacementInput } from '../src/scheduling/cpu-replacement.js';

const hash = (id: string) => bytes32Schema.parse(`0x${id.repeat(64)}`);
const image = `sha256:${'11'.repeat(32)}`;
function host(id: string, pricePerSecond: string, overrides: Partial<Capacity> = {}): Capacity {
  return { hostId: hash(id), hardwareClass: 'cpu', region: 'eu-private', imageDigest: image, sealed: false,
    lane: 'standard', pricePerSecond, reliabilityBps: 10000, strikes: 0, stake: '0', availableAt: 100, ...overrides };
}
const request: PlacementRequest = { hardwareClasses: ['cpu'], regions: ['eu-private'], images: [image],
  sealedOnly: false, lanes: ['standard', 'interruptible'], seconds: 10, maxSpend: '1200', deadline: 200, now: 100 };
function weights(rows: Capacity[], values: string[]): CapacitySelectionOptions {
  return { schedulingWeights: rows.map((row, index) => ({ hostId: row.hostId, schedulingWeight: values[index] ?? '0' })) };
}
function replacement(overrides: Partial<CpuReplacementInput> = {}): CpuReplacementInput {
  return { jobId: hash('a'), original: { ...request, seconds: 20, maxSpend: '3000' },
    source: { runId: hash('b'), hostId: hash('1'), quoteHash: hash('c'), ceiling: '1000' },
    now: 120, remainingSeconds: 10, restoreSeconds: 2, checkpointHash: hash('d'), sourceCleanupConfirmed: true,
    sourceSettlement: { receiptHash: hash('e'), charged: '300', refund: '700', confirmed: true },
    priorCharged: '200', outstandingLiability: '500', ...overrides };
}

describe('finite CPU price bands and complete financial ceilings', () => {
  it('ranks standard and interruptible offers from the same host while rejecting conflicting prices in one scope', () => {
    const standard = host('1', '100'), interruptible = host('1', '70', { lane: 'interruptible' });
    expect(selectCapacity(request, [standard, interruptible]).host.lane).toBe('interruptible');
    expect(capacityIdentity(standard)).not.toBe(capacityIdentity(interruptible));
    expect(() => selectCapacity(request, [standard, { ...standard, pricePerSecond: '90' }])).toThrow(/ambiguous/);
  });

  it('keeps the exact five-percent boundary inclusive and excludes stake just beyond it', () => {
    const rows = [host('1', '100'), host('2', '105'), host('3', '106')];
    expect(selectCapacity(request, rows, weights(rows, ['0', '1', (2n ** 255n).toString()])).host.hostId).toBe(hash('2'));
    expect(selectCapacity(request, [rows[0]!, rows[2]!], weights([rows[0]!, rows[2]!], ['0', '999999'])).host.hostId).toBe(hash('1'));
  });

  it('applies reliability and strikes before TLMR priority and never admits a disallowed lane for stake', () => {
    const rows = [host('1', '100'), host('2', '95', { reliabilityBps: 5000 }),
      host('3', '99', { strikes: 1 }), host('4', '1', { lane: 'interruptible' })];
    const priority = weights(rows, ['0', '999999', '999999', '999999']);
    expect(selectCapacity({ ...request, lanes: ['standard'] }, rows, priority).host.hostId).toBe(hash('1'));
  });

  it('filters fee-inclusive liabilities before choosing the price band', () => {
    const rows = [host('1', '90'), host('2', '100')];
    const chargeCeilings = [{ capacityId: capacityIdentity(rows[0]!), ceiling: '1201' },
      { capacityId: capacityIdentity(rows[1]!), ceiling: '1100' }];
    const chosen = selectCapacity(request, rows, { chargeCeilings });
    expect(chosen).toMatchObject({ ceiling: '1000', liabilityCeiling: '1100', host: { hostId: hash('2') } });
    expect(() => selectCapacity({ ...request, maxSpend: '1099' }, rows, { chargeCeilings })).toThrow(/No admitted capacity/);
  });

  it('fails closed for incomplete pinned weights and underestimated total liability', () => {
    const rows = [host('1', '100')];
    expect(() => selectCapacity(request, rows, { schedulingWeights: [] })).toThrow(/pinned scheduling weight/);
    expect(() => selectCapacity(request, rows, { chargeCeilings: [] })).toThrow(/complete charge ceiling/);
    expect(() => selectCapacity(request, rows, { chargeCeilings: [{ capacityId: capacityIdentity(rows[0]!), ceiling: '999' }] })).toThrow(/complete charge ceiling/);
  });

  it('does not overflow safe timestamps when availability and runtime exceed the deadline', () => {
    const late = host('1', '1', { availableAt: Number.MAX_SAFE_INTEGER });
    expect(() => selectCapacity({ ...request, now: Number.MAX_SAFE_INTEGER, deadline: Number.MAX_SAFE_INTEGER }, [late])).toThrow(/No admitted capacity/);
  });

  it('is deterministic over every catalogue permutation, with exact integers beyond floating point', () => {
    const rows = [host('1', '9007199254740993'), host('2', '9457559217478042'), host('3', '9007199254740994')];
    const input = { ...request, maxSpend: '999999999999999999999999999' };
    const priority = weights(rows, ['0', '0', '1']);
    const permutations = [rows, [rows[2]!, rows[1]!, rows[0]!], [rows[1]!, rows[0]!, rows[2]!]];
    for (const catalogue of permutations) {
      const chosen = selectCapacity(input, catalogue, priority);
      expect(chosen.host.hostId).toBe(hash('3'));
      expect(chosen.ceiling).toBe('90071992547409940');
    }
  });
});

describe('CPU cross-lane replacement plans', () => {
  it('switches to a feasible standard offer when interruptible work no longer fits the deadline', () => {
    const input = replacement({ original: { ...replacement().original, deadline: 132 } });
    const source = host('1', '1', { lane: 'interruptible' });
    const interrupted = host('2', '1', { lane: 'interruptible', availableAt: 121 });
    const standard = host('3', '100');
    const result = planCpuReplacement(input, [source, interrupted, standard]);
    expect(result.action).toBe('proposal');
    if (result.action !== 'proposal') throw new Error('Expected a separately approved replacement');
    expect(result.proposal).toMatchObject({ target: { hostId: hash('3'), lane: 'standard' }, charged: '500',
      outstandingLiability: '500', remainingBudget: '2000', ceiling: '1200', liabilityCeiling: '1200',
      reservationSeconds: 12, plannedFinish: 132, requiresSeparateOwnerApproval: true, fundsReserved: false });
  });

  it('can choose an interruptible replacement only when the original intent allowed it', () => {
    const rows = [host('2', '80', { lane: 'interruptible' }), host('3', '100')];
    const mixed = planCpuReplacement(replacement(), rows);
    const standard = planCpuReplacement(replacement({ original: { ...replacement().original, lanes: ['standard'] } }), rows);
    if (mixed.action !== 'proposal' || standard.action !== 'proposal') throw new Error('Expected finite proposals');
    expect(mixed.proposal.target.lane).toBe('interruptible');
    expect(standard.proposal.target.lane).toBe('standard');
  });

  it('does not release an unconfirmed source, use missing state, or propose work before cleanup', () => {
    for (const [update, reason] of [
      [{ sourceSettlement: null }, 'source_settlement'],
      [{ sourceCleanupConfirmed: false }, 'source_cleanup'],
      [{ checkpointHash: null }, 'checkpoint'],
    ] satisfies [Partial<CpuReplacementInput>, string][]) {
      expect(planCpuReplacement(replacement(update), [host('2', '100')])).toMatchObject({ action: 'wait', reason, fundsReserved: false });
    }
  });

  it('counts prior settled charges and still reserved ceilings without spending the source refund twice', () => {
    const result = planCpuReplacement(replacement({ priorCharged: '1400', outstandingLiability: '500' }), [host('2', '100')]);
    expect(result).toMatchObject({ action: 'cancel', reason: 'capacity_infeasible', charged: '1700',
      remainingBudget: '800', confirmedSourceRefund: '700', outstandingRefundConfirmed: false, stopAndRefundRequired: true });
    expect(planCpuReplacement(replacement({ outstandingLiability: '3000' }), [host('2', '1')])).toMatchObject({ action: 'cancel', reason: 'budget_exhausted', remainingBudget: '0' });
  });

  it('rejects a source receipt that does not conserve its immutable ceiling', () => {
    expect(() => planCpuReplacement(replacement({ sourceSettlement: { receiptHash: hash('e'), charged: '300', refund: '701', confirmed: true } }), [host('2', '1')])).toThrow(/conserve/);
  });

  it('cancels before a handoff whose restore plus remaining execution misses the deadline', () => {
    expect(planCpuReplacement(replacement({ original: { ...replacement().original, deadline: 131 } }), [host('2', '1')])).toMatchObject({ action: 'cancel', reason: 'deadline_infeasible' });
  });
  it('reports a final missed deadline while retaining an unconfirmed source reservation at risk', () => {
    expect(planCpuReplacement(replacement({ now: 200, checkpointHash: null, sourceCleanupConfirmed: false,
      sourceSettlement: null }), [host('2', '1')])).toMatchObject({ action: 'cancel', reason: 'deadline_infeasible',
      charged: '200', outstandingLiability: '1500', remainingBudget: '1300', confirmedSourceRefund: null,
      sourceSettlementConfirmed: false, sourceCleanupConfirmed: false, outstandingRefundConfirmed: false,
      stopAndRefundRequired: true, fundsReserved: false });
  });

  it('binds exact original intent, settlement, checkpoint and target terms for separate owner approval', () => {
    const target = host('2', '100'), result = planCpuReplacement(replacement(), [target]);
    if (result.action !== 'proposal') throw new Error('Expected proposal');
    const proposal = result.proposal;
    expect(assertCpuReplacementApproval(proposal, proposal.decisionHash, target, '1200', proposal.originalIntentHash, 121)).toEqual(proposal);
    expect(() => assertCpuReplacementApproval(proposal, hash('0'), target, '1200', proposal.originalIntentHash, 121)).toThrow(/owner-approved/);
    expect(() => assertCpuReplacementApproval(proposal, proposal.decisionHash, target, '1200', hash('0'), 121)).toThrow(/owner-approved/);
    expect(() => assertCpuReplacementApproval(proposal, proposal.decisionHash, { ...target, lane: 'interruptible' }, '1200', proposal.originalIntentHash, 121)).toThrow(/ceiling changed/);
    expect(() => assertCpuReplacementApproval(proposal, proposal.decisionHash, target, '1201', proposal.originalIntentHash, 121)).toThrow(/ceiling changed/);
    expect(() => assertCpuReplacementApproval(proposal, proposal.decisionHash, target, '1200', proposal.originalIntentHash, 189)).toThrow(/scope/);
    expect(() => assertCpuReplacementApproval({ ...proposal, checkpointHash: hash('f') }, proposal.decisionHash, target, '1200', proposal.originalIntentHash, 121)).toThrow(/owner-approved/);
  });

  it('does not mutate the admitted intent and keeps permutation-equivalent decisions stable', () => {
    const input = replacement(), before = hashJson(input), rows = [host('2', '100'), host('3', '102')];
    const first = planCpuReplacement(input, rows), second = planCpuReplacement(input, [...rows].reverse());
    if (first.action !== 'proposal' || second.action !== 'proposal') throw new Error('Expected proposal');
    expect(first.proposal.decisionHash).toBe(second.proposal.decisionHash);
    expect(hashJson(input)).toBe(before);
    expect(first.proposal.originalIntentHash).toBe(second.proposal.originalIntentHash);
  });

  it('rejects malformed catalogues instead of turning validation failures into cancellation', () => {
    try { planCpuReplacement(replacement(), [host('2', '100'), host('2', '101')]); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(Problem); expect(error).toMatchObject({ code: 'duplicate_host' }); }
  });
});
