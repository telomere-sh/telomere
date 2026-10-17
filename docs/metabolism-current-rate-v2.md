# Current paid-rate Metabolism, version 2

The original Backend §4.1 uses `vault balance ÷ current burn per hour` for tiers, but explicitly uses trailing-24h burn for the telomere displayed to owners and in Selection. The original shipped evaluator used the trailing denominator for both. This opt-in policy adds the current paid rate and prospective profile affordability without reinterpreting old decisions or settled billing.

`GET /api/agents/:agent/evaluation?metabolismVersion=2` requests the new policy. `POST /api/agents/:agent/transitions` accepts optional `metabolismVersion: 2`. Omission retains version 1, its thresholds, response shape and original request hash. New v2 intents persist nullable additive `metabolism_version` and `metabolism_evaluation` columns. Existing rows remain NULL and their public serialization omits those fields. The stored snapshot is validated during reads and execution acknowledgements; old pending intents keep their original meaning.

Use `new HttpAgentLifecycleControl(transport, { metabolismVersion: 2 })` and `new PaidAgentLifeline({ ..., metabolismVersion: 2 })` for an owner-run loop that requires the new facts. The HTTP client rejects a v1 evaluation/plan response when version 2 is required, recomputes the exact profile decision, and checks the persisted marker. An optional independent `{ cystQuotaVersion: 2 }` selects the negotiated Cyst quota profile. All options are absent by default.

## Authoritative inputs

The EOA and canonical Vault adapters resolve the original registered agent's admitted Platform run. They validate its original input hash, signed quote/domain, canonical confirmed opening and original payer/agent binding. Vault reads additionally require the factory/implementation and immutable logical-agent binding. HTTP callers cannot supply a price, burn amount, host or balance.

The reader pins one current canonical block and reads available EOA escrow balance or Vault `spendableBalance`, run terms, Leash, host and locked admission discount at that block. It then rechecks the block hash. Future opening facts, a leading/stale chain, invalid signatures, changed canonical admission or missing billing provenance fail closed. Owner kill retains its existing independent path.

`pricing.current` describes an active, un-stopped, unexpired original paid reservation. Its conservative recurring cost is:

```
base = signed_price_per_second × original_max_seconds + signed_fixed_inference_price
complete_lease_cost = base + ceil(base × locked_fee_bps / 10000)
current_burn_per_hour = ceil(complete_lease_cost × 3600 / original_max_seconds)
```

The fixed inference amount is counted once for every projected repetition of that original bounded lease. This is a conservative accepted-price planning rate, not a new metered charge, a forecast of inference request frequency, or a claim that queued CPU has consumed billable seconds. Historical billing and settlement use their existing exact confirmed receipts.

## Stable profile selection

Fresh projections use the same reviewed original host, image, region and signed lane consent (`cpuScheduling.lane`, absent means standard). Current HostRegistry and Leash eligibility are rechecked. Full/lean/torpor prices must actually exist in that reviewed session catalogue; a one-shot task has no invented smaller profile. Future fees use the conservative full 900 bps because holdings may change before a new admission. A configured fixed inference price is included when the original workload contains inference.

The evaluator selects the highest affordable available profile using exact fractions: full requires more than 72 hours at the prospective full cost; lean requires at least 24 hours at its prospective lean cost; torpor requires at least two hours at its prospective torpor cost. Otherwise it selects Cyst. Threshold comparisons use the full integer numerator/denominator before division. Changing actual execution from full to lean therefore cannot itself promote the agent back to full: the prospective full denominator remains the same.

`currentBurnPerHour` and `currentRunwaySeconds` are NULL while asleep, stopped or expired. A historical canonical admitted run supplies only pricing identity for a fresh reviewed projection. Its expired quote never authorizes a new run. With no valid pricing context or eligible prospective profile, the policy selects Cyst rather than treating the absence of burn as free full compute. Wake and migration still require a newly admitted, separately approved reservation with the selected resource profile. Scheduled sleep is preserved until due. Outstanding reservations remain excluded from the available balance.

A target reservation carries its own trusted canonical signed price and fixed inference amount. Planning and every attach/resume validation reject a target whose conservative complete cost per second exceeds the selected projection, including a change in lease duration/fixed-cost amortization. This prevents a different, more expensive host from borrowing the source host's cheaper affordability decision. A cheaper target remains within that conservative decision; broader fresh target-host optimization belongs to the separately reviewed replacement planner.

`trailing24hBurn` and the existing `runwaySeconds` display retain their original confirmed rolling-window meaning. `decisionRunwaySeconds` is a separate planning value for the selected profile. No display or Selection history is rewritten.

## Acceptance and remaining limits

The acceptance suite checks exact full/lean/torpor thresholds, zero-history display with positive current paid rate, fixed inference/fee rounding, unavailable pricing, stable lean behavior and HTTP downgrade/tampered-decision rejection. The real local Anvil/HostKit/Vault fixture runs both original v1 and explicit v2 policies through authenticated lifecycle HTTP, actual full→lean execution, encrypted checkpoint/response-loss recovery, sleep, torpor wake and owner kill. V2 affordability is driven by actual token funding and owner withdrawals, with no caller-authored burn.

This completes the bounded CPU policy path. It does not provide a 24-hour supplier lease, autonomous wallet authority, general filesystem/2-GiB paid restore, a GPU Cell or attested CPU key release. Projections are planning prices, not binding offers or proof of future free capacity; admission and canonical funding remain required. The approximately 73% functional assessment in the preceding lifecycle rescore belongs to its earlier source cutoff and is not automatically increased by this implementation or its test count.
