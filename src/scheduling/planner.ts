import { z } from 'zod';
import { bytes32Schema, hashJson, moneySchema, Problem } from '../common.js';

export const capacitySchema = z.object({
  hostId: bytes32Schema, hardwareClass: z.enum(['cpu', 'rtx', 'a100', 'h100', 'h200', 'b200']),
  region: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), sealed: z.boolean(),
  lane: z.enum(['standard', 'interruptible']), pricePerSecond: moneySchema,
  reliabilityBps: z.number().int().min(1).max(10000), strikes: z.number().int().min(0).max(100),
  stake: moneySchema, availableAt: z.number().int().safe().nonnegative(),
}).strict();
export type Capacity = z.infer<typeof capacitySchema>;
export const placementSchema = z.object({
  hardwareClasses: z.array(capacitySchema.shape.hardwareClass).min(1).max(6),
  regions: z.array(capacitySchema.shape.region).max(100), images: z.array(capacitySchema.shape.imageDigest).min(1).max(100),
  sealedOnly: z.boolean(), lanes: z.array(capacitySchema.shape.lane).min(1).max(2),
  seconds: z.number().int().min(1).max(86400), maxSpend: moneySchema,
  deadline: z.number().int().safe().positive(), now: z.number().int().safe().nonnegative(),
}).strict();
export type PlacementRequest = z.infer<typeof placementSchema>;

// Backend spec cap for collateral considered during scheduling, in six-decimal
// token units. Actual bonded collateral stays in HostRegistry for slash/refund.
export const MAX_COUNTED_HOST_COLLATERAL = 25_000_000_000n;

function countedCollateral(row: Capacity): bigint {
  const bonded = BigInt(row.stake);
  return bonded > MAX_COUNTED_HOST_COLLATERAL ? MAX_COUNTED_HOST_COLLATERAL : bonded;
}

const uint256Schema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine(value => BigInt(value) < 2n ** 256n, 'Scheduling weight exceeds uint256');
/** Trusted controller inputs read from pinned staking/fee contracts, never request-supplied overrides. */
export const capacitySelectionOptionsSchema = z.object({
  schedulingWeights: z.array(z.object({ hostId: bytes32Schema, schedulingWeight: uint256Schema }).strict()).max(1000).optional(),
  chargeCeilings: z.array(z.object({ capacityId: bytes32Schema, ceiling: moneySchema }).strict()).max(1000).optional(),
}).strict();
export type CapacitySelectionOptions = z.infer<typeof capacitySelectionOptionsSchema>;

/** One host may post distinct class/lane offers. Different prices for one scope are ambiguous. */
export function capacityIdentity(row: Capacity) {
  return hashJson({ hostId: row.hostId, hardwareClass: row.hardwareClass, region: row.region,
    imageDigest: row.imageDigest, sealed: row.sealed, lane: row.lane });
}

function compareIdentity(a: Capacity, b: Capacity): number {
  if (a.hostId !== b.hostId) return a.hostId < b.hostId ? -1 : 1;
  const left = capacityIdentity(a), right = capacityIdentity(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Exact rational ranking; stake influences only an eligible five-percent price band. */
export function selectCapacity(input: PlacementRequest, supplied: Capacity[], rawOptions: CapacitySelectionOptions = {}) {
  const request = placementSchema.parse(input);
  if (supplied.length > 1000) throw new Problem(422, 'capacity_limit', 'The capacity catalogue exceeds its supported bound.');
  const options = capacitySelectionOptionsSchema.parse(rawOptions);
  const priorities = new Map<string, bigint>();
  for (const row of options.schedulingWeights ?? []) {
    if (priorities.has(row.hostId)) throw new Problem(422, 'duplicate_scheduling_weight', 'A host has multiple scheduling weights.');
    priorities.set(row.hostId, BigInt(row.schedulingWeight));
  }
  const liabilities = new Map<string, bigint>();
  for (const row of options.chargeCeilings ?? []) {
    if (liabilities.has(row.capacityId)) throw new Problem(422, 'duplicate_charge_ceiling', 'A capacity offer has multiple charge ceilings.');
    liabilities.set(row.capacityId, BigInt(row.ceiling));
  }
  const unique = new Set<string>();
  const feasible = supplied.map(row => capacitySchema.parse(row)).filter(row => {
    const capacityId = capacityIdentity(row);
    if (unique.has(capacityId)) throw new Problem(422, 'duplicate_host', 'A host has multiple ambiguous capacity entries.');
    unique.add(capacityId);
    const eligible = request.hardwareClasses.includes(row.hardwareClass) && (!request.regions.length || request.regions.includes(row.region))
      && request.images.includes(row.imageDigest) && (!request.sealedOnly || row.sealed) && request.lanes.includes(row.lane)
      && BigInt(Math.max(request.now, row.availableAt)) + BigInt(request.seconds) <= BigInt(request.deadline);
    if (!eligible) return false;
    if (options.schedulingWeights && !priorities.has(row.hostId)) {
      throw new Problem(503, 'scheduling_weight_unavailable', 'Every eligible host requires its original pinned scheduling weight.');
    }
    const base = BigInt(row.pricePerSecond) * BigInt(request.seconds);
    const liability = options.chargeCeilings ? liabilities.get(capacityId) : base;
    if (liability === undefined || liability < base) {
      throw new Problem(503, 'charge_ceiling_unavailable', 'Every eligible capacity offer requires its complete charge ceiling.');
    }
    return liability <= BigInt(request.maxSpend);
  });
  function score(row: Capacity): bigint { return BigInt(row.pricePerSecond) * BigInt(100 + row.strikes * 10); }
  function compare(a: Capacity, b: Capacity): number {
    const left = score(a) * BigInt(b.reliabilityBps), right = score(b) * BigInt(a.reliabilityBps);
    return left === right ? compareIdentity(a, b) : left < right ? -1 : 1;
  }
  feasible.sort(compare);
  const best = feasible[0];
  if (!best) throw new Problem(409, 'deadline_infeasible', 'No admitted capacity can meet this deadline within the budget.');
  const band = feasible.filter(row => score(row) * BigInt(best.reliabilityBps) * 100n <= score(best) * BigInt(row.reliabilityBps) * 105n);
  band.sort((a, b) => {
    const weightLeft = priorities.get(a.hostId) ?? 0n, weightRight = priorities.get(b.hostId) ?? 0n;
    if (weightLeft !== weightRight) return weightLeft > weightRight ? -1 : 1;
    const left = countedCollateral(a), right = countedCollateral(b);
    return left === right ? compare(a, b) : left > right ? -1 : 1;
  });
  const selected = band[0]!;
  const ceiling = BigInt(selected.pricePerSecond) * BigInt(request.seconds), capacityId = capacityIdentity(selected);
  return { host: selected, ceiling: ceiling.toString(), capacityId,
    liabilityCeiling: (liabilities.get(capacityId) ?? ceiling).toString(),
    plannedStart: Math.max(request.now, selected.availableAt), plannedFinish: Math.max(request.now, selected.availableAt) + request.seconds,
    candidates: feasible.length };
}

export function priceQuantiles(prices: bigint[]) {
  if (!prices.length) return { count: 0, p10: null, median: null, p90: null };
  const sorted = [...prices].sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
  const at = (percentile: number) => sorted[Math.floor((sorted.length - 1) * percentile / 100)]!.toString();
  return { count: sorted.length, p10: at(10), median: at(50), p90: at(90) };
}
