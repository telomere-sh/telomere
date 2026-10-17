# CPU price bands and replacement planning

The placement rule from Backend §3 now accepts finite reviewed CPU offers in both `standard` and `interruptible` lanes. `src/scheduling/planner.ts` filters hardware, Leash-equivalent scope, lane, availability, deadline and complete liability before ranking. It computes effective price as an exact rational value: `postedPrice × (100 + 10 × strikes) / reliabilityBps`. No money or effective-price comparison passes through floating point.

The eligible band includes offers whose effective price is at most exactly 105% of the cheapest feasible offer. Optional TLMR scheduling weights rank within that band; they cannot admit another class, prohibited lane, missed deadline or over-budget offer. The controller reads these weights from the pinned staking contract, where queued unstaking no longer contributes and strikes reduce the weight. USDC collateral remains separate and capped at 25,000 USDC for its existing secondary tie-break. Final ties retain the existing host-ID order and use a stable offer identity for multiple lanes on one host.

## Controller integration

`capacityIdentity(capacity)` identifies one host/class/region/image/sealing/lane scope. A host can publish distinct lane offers; duplicate entries for the same scope, including conflicting posted prices, are rejected.

`selectCapacity(request, capacities, options)` accepts optional controller-only inputs:

```ts
{
  schedulingWeights: [{ hostId, schedulingWeight: "..." }],
  chargeCeilings: [{ capacityId: capacityIdentity(capacity), ceiling: "..." }]
}
```

Weights are uint256 decimal integers; charge ceilings are six-decimal USDC units. If either set is supplied, every scope-eligible offer must have its corresponding entry. Duplicate entries, missing entries and liability ceilings below posted price multiplied by duration fail closed. Filtering uses the complete liability including applicable fees. The returned `ceiling` remains the CPU base for compatibility; `liabilityCeiling` is the complete reviewed charge. Without optional inputs, existing collateral ranking and base-ceiling behavior remain.

The runtime must obtain options from its own pinned contract readers and fee calculation. An HTTP caller cannot choose staking weights or override liability ceilings. Actual host admission remains authoritative: a free-capacity hint never reserves a slot. Reliability is the reviewed catalogue's supplied observation, not a new independently measured fleet statistic.

## CPU replacement decisions

`src/scheduling/cpu-replacement.ts` exports `cpuReplacementInputSchema`, `planCpuReplacement` and `assertCpuReplacementApproval`. A replacement plan binds the original job request, original source quote, source receipt, checkpoint, remaining execution, restore duration, original budget and deadline. It accepts controller-confirmed cleanup and settlement facts; the helper itself does not verify an arbitrary caller's receipt against a chain.

The planner waits for physical source cleanup, a conservation-valid confirmed settlement and an available checkpoint. It subtracts all earlier settled charges and the full ceilings of other still funded reservations from the original maximum spend. It never adds the confirmed source refund a second time. Restore time occupies the new reservation and contributes to both its possible charge and completion deadline. The source host is excluded in every lane after preemption.

An already missed deadline produces cancellation even if cleanup, checkpointing or the source receipt is still pending. The complete unconfirmed source ceiling stays at risk in that response; no pending refund is reported as confirmed.

The result is one of:

- `wait`: source cleanup, settlement or checkpoint remains incomplete.
- `cancel`: no safe remaining budget, deadline or reviewed capacity; stopping and refunding remains a required controller/chain action. Pending refunds are explicitly unconfirmed.
- `proposal`: a deterministic, hashed target snapshot that reserves no funds and requires separate owner approval.

`assertCpuReplacementApproval(proposal, approvedDecisionHash, currentCapacity, currentLiabilityCeiling, expectedOriginalIntentHash, now)` rejects changed approval, another original intent, modified checkpoint or settlement scope, changed target terms or charge ceiling, and an elapsed deadline. The controller must still check current balances, pending reservations, Leash state and host availability before creating a separate immutable quote. This helper cannot sign, fund or execute a replacement, and cannot rewrite an admitted quote.

The existing durable `InterruptibleService` uses exact offer identities when refreshing an already owner-approved target. A target host advertising another lane no longer makes that approved offer ambiguous. The same service continues to permit only one separately funded target per physical host, preserving its original reservation and replay rules.

## Validation and limits

Focused tests cover exact five-percent boundaries, very large integer prices and staking weights, fee-inclusive budgets, multiple lane offers, catalogue permutation stability, timestamp overflow, cancellation with outstanding reservations, source conservation, restore deadlines and immutable approval. Existing paid deadline and durable interruptible regressions cover the actual checkpoint/stop/settlement/wake path, including a separately approved standard-lane target on a host that also advertises interruptible capacity.

14 October 2026 local verification: **20/20** scheduler/collateral tests and **44/44** deadline/interruptible tests passed. Machine-readable reports are `.local/cpu-price-band-focused-20261014.json` and `.local/cpu-price-band-regression-20261014.json`. These results establish the tested local paths, not independent infrastructure or public funded acceptance.

The catalogue is bounded to 1,000 supplied offers and contains only actual reviewed inventory. This does not create supplier leases, establish market-wide prices, supply arbitrary GPU Cells or prove real two-host recovery. The public settled-receipt price board retains its separate `marketWide: false` limitation. Live supplier acceptance and a mounted owner-approved paid replacement remain deployment acceptance tasks.
