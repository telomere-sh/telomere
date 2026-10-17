import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson } from '../common.js';

export const workKindSchema = z.enum(['cpu', 'probe', 'verification', 'storage']);
export type WorkKind = z.infer<typeof workKindSchema>;
const integer = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < (1n << 256n));
const positive = integer.refine(value => BigInt(value) > 0n);
export const workAllocationPolicySchema = z.object({
  protocol: z.literal('telomere-weekly-work-policy-v1'), chainId: z.number().int().positive().safe(),
  router: addressSchema, policyApproval: bytes32Schema,
  // Weights and units are explicit approved policy, never inferred from token price.
  weights: z.object({ cpu: integer, probe: integer, verification: integer, storage: integer }).strict(),
}).strict().refine(policy => Object.values(policy.weights).some(value => BigInt(value) > 0n), 'At least one work weight is required');
export const verifiedWorkActivitySchema = z.object({
  kind: workKindSchema, receiptId: bytes32Schema, recipient: addressSchema, units: positive,
  week: z.number().int().nonnegative().safe(), chainId: z.number().int().positive().safe(),
  blockNumber: integer, blockHash: bytes32Schema, evidenceDigest: bytes32Schema,
}).strict();
export type VerifiedWorkActivity = z.infer<typeof verifiedWorkActivitySchema>;
export interface WorkActivityVerifier {
  /** Must retrieve and verify accepted immutable receipts. HTTP caller assertions
   * about completion, units, timestamps or signatures are not a verifier. */
  read(handle: unknown): Promise<VerifiedWorkActivity>;
  /** Repeat canonicality/provenance checks immediately before posting a plan. */
  recheck(activity: VerifiedWorkActivity): Promise<void>;
}
/** Routes explicit approved producers; the request cannot install a verifier or
 * turn a probe/storage observation into CPU execution evidence. */
export class CompositeWorkActivityVerifier implements WorkActivityVerifier {
  constructor(private readonly sources: Partial<Record<WorkKind, WorkActivityVerifier>>) {}
  async read(raw: unknown): Promise<VerifiedWorkActivity> {
    const item = z.object({ kind: workKindSchema, handle: z.unknown() }).strict().parse(raw);
    const source = this.sources[item.kind];
    if (!source) throw new Error('No approved receipt producer is configured for this work kind');
    const activity = verifiedWorkActivitySchema.parse(await source.read(item.handle));
    if (activity.kind !== item.kind) throw new Error('Work receipt kind differs from its approved producer');
    return activity;
  }
  async recheck(activity: VerifiedWorkActivity): Promise<void> {
    const source = this.sources[activity.kind];
    if (!source) throw new Error('Original work receipt producer is unavailable');
    await source.recheck(activity);
  }
}
export type WorkAllocationPolicy = z.infer<typeof workAllocationPolicySchema>;
export type WorkClaim = { recipient: Address; amount: string; weight: string; leaf: Hex; proof: Hex[] };
const pair = (a: Hex, b: Hex): Hex => keccak256(`0x${[a, b].sort().map(value => value.slice(2)).join('')}`);

export function weeklyWorkLeaf(chainId: number, router: Address, week: number, recipient: Address, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' },
    { type: 'address' }, { type: 'uint256' }], [BigInt(chainId), router, BigInt(week), recipient, amount])));
}

/** Reads actual accepted activities first; largest-remainder allocation conserves
 * the entire explicit budget, deterministic on address ties. One claim per host. */
export async function buildWeeklyWorkAllocation(input: {
  policy: WorkAllocationPolicy; week: number; budget: string; closedWeek: number;
  handles: readonly unknown[]; verifier: WorkActivityVerifier;
}) {
  const policy = workAllocationPolicySchema.parse(input.policy);
  const week = z.number().int().nonnegative().safe().parse(input.week);
  const closedWeek = z.number().int().nonnegative().safe().parse(input.closedWeek);
  const budget = BigInt(positive.parse(input.budget));
  if (week > closedWeek || input.handles.length === 0 || input.handles.length > 4096) throw new Error('Work week is open or receipt count is invalid');
  const activities: VerifiedWorkActivity[] = [];
  const identities = new Set<string>();
  const byRecipient = new Map<Address, bigint>();
  for (const handle of input.handles) {
    const activity = verifiedWorkActivitySchema.parse(await input.verifier.read(handle));
    const identity = activity.receiptId.toLowerCase();
    if (identities.has(identity) || activity.chainId !== policy.chainId || activity.week !== week) {
      throw new Error('Duplicate work receipt or receipt outside the approved chain/week');
    }
    identities.add(identity); activities.push(activity);
    const weight = BigInt(activity.units) * BigInt(policy.weights[activity.kind]);
    if (weight === 0n) throw new Error('Work receipt kind has no approved positive allocation weight');
    const recipient = activity.recipient.toLowerCase() as Address;
    byRecipient.set(recipient, (byRecipient.get(recipient) ?? 0n) + weight);
  }
  const totalWeight = [...byRecipient.values()].reduce((total, weight) => total + weight, 0n);
  const shares = [...byRecipient].map(([recipient, weight]) => ({ recipient, weight,
    amount: budget * weight / totalWeight, remainder: budget * weight % totalWeight }));
  const remainderOrder = [...shares].sort((a, b) => a.remainder !== b.remainder
    ? (a.remainder > b.remainder ? -1 : 1) : a.recipient.localeCompare(b.recipient));
  let leftover = budget - shares.reduce((total, share) => total + share.amount, 0n);
  for (const share of remainderOrder) { if (leftover === 0n) break; share.amount++; leftover--; }
  const paid = shares.filter(share => share.amount > 0n).sort((a, b) => a.recipient.localeCompare(b.recipient));
  const leaves = paid.map(share => weeklyWorkLeaf(policy.chainId, policy.router, week, share.recipient, share.amount));
  const levels: Hex[][] = [leaves];
  while (levels.at(-1)!.length > 1) {
    const prior = levels.at(-1)!, next: Hex[] = [];
    for (let index = 0; index < prior.length; index += 2) {
      next.push(prior[index + 1] ? pair(prior[index]!, prior[index + 1]!) : prior[index]!);
    }
    levels.push(next);
  }
  const claims: WorkClaim[] = paid.map((share, index) => {
    const proof: Hex[] = []; let offset = index;
    for (const level of levels.slice(0, -1)) {
      const sibling = level[offset ^ 1]; if (sibling) proof.push(sibling); offset = Math.floor(offset / 2);
    }
    return { recipient: share.recipient, amount: share.amount.toString(), weight: share.weight.toString(), leaf: leaves[index]!, proof };
  });
  for (const activity of activities) await input.verifier.recheck(activity);
  const plan = { protocol: 'telomere-weekly-work-allocation-v1' as const, policy, policyDigest: hashJson(policy),
    week, allocated: budget.toString(), root: levels.at(-1)![0]!, totalWeight: totalWeight.toString(), claims,
    activities: activities.sort((a, b) => a.receiptId.localeCompare(b.receiptId)) };
  return { ...plan, planDigest: hashJson(plan) };
}
