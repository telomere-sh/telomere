# Golem financial lifecycle v1

This batch adds an **unmounted local financial controller**, not a live Golem supplier adapter. It has no production HTTP writer, signer, wallet, funding/conversion service, configuration, router or main-process mount. Actual HTTP tests contact only a temporary `127.0.0.1` protocol fixture. `meterEligible` is always false and `billableSeconds` is always zero. Telomere's Base/USDC rail is unchanged; Golem payment authority is a separately tracked GLM balance.

The three new modules are `src/suppliers/golem-finance-types.ts`, `golem-finance-ledger.ts` and `golem-finance.ts`. Existing supplier storage and the Golem statistics reader are unchanged. The ledger uses its own `telomere-golem-financial-lifecycle-v1` private-journal identity bound to the immutable policy hash.

## Reviewed protocol facts

Pinned upstream files and original licenses are retained as data in [the provenance manifest](evidence/golem-finance-upstream-20261015/manifest.json); downloaded code is not imported or executed.

- Debit notes describe cumulative activity obligations; an invoice describes the agreement's final total. Accepting successive totals of 1, 2, 2 GLM and an invoice of 2 GLM therefore yields 2 GLM of accepted obligation, not 7 GLM. An invoice closes further debit/activity issuance under the reviewed protocol. [Pinned payment specification](https://raw.githubusercontent.com/golemfactory/ya-client/41e7d99048dc04f8e3de4a8b86273926d71872c9/specs/payment-api.yaml).
- Acceptance is financially consequential. The requestor's implementation checks the allocation, derives the incremental amount from previously accepted cumulative debt and can retain local acceptance before the remote acknowledgement succeeds. A dropped response cannot authorize another attempt. [Pinned debit implementation](https://raw.githubusercontent.com/golemfactory/yagna/c256fce68c50c141a51d4bd2ca18292e4b006f15/core/payment/src/api/debit_notes.rs), [pinned invoice implementation](https://raw.githubusercontent.com/golemfactory/yagna/c256fce68c50c141a51d4bd2ca18292e4b006f15/core/payment/src/api/invoices.rs).
- Allocation is a requestor-side reservation. Current pinned Yagna code schedules allocation timeout/release; that does not establish physical activity termination, final provider debt or payment settlement. The older API schema's timeout comment differs from the newer implementation. Neither is treated here as an external lifetime liability cap. [Pinned allocation implementation](https://raw.githubusercontent.com/golemfactory/yagna/c256fce68c50c141a51d4bd2ca18292e4b006f15/core/payment/src/api/allocations/mod.rs).
- Agreement `validTo` bounds agreement approval, not lifetime execution. Activity destruction, agreement termination, invoice acceptance, payment finality and allocation release remain distinct operations. [Pinned market specification](https://raw.githubusercontent.com/golemfactory/ya-client/41e7d99048dc04f8e3de4a8b86273926d71872c9/specs/market-api.yaml), [pinned activity specification](https://raw.githubusercontent.com/golemfactory/ya-client/41e7d99048dc04f8e3de4a8b86273926d71872c9/specs/activity-api.yaml).

These are source-level protocol observations, not proof of a deployed Yagna version or provider compliance. The official SDK also sends the full cumulative accepted amount and exposes allocation release separately. [Pinned SDK adapter](https://raw.githubusercontent.com/golemfactory/golem-js/615796669b49de0fba55173052252a32d3e7434f/src/shared/yagna/adapters/payment-api-adapter.ts).

## Authority and public methods

All authority ports are injected by trusted composition. An HTTP body cannot create an authority, supply finality or choose a provider URL. Their authenticated implementations are a remaining integration requirement.

| Method | Durable behavior |
| --- | --- |
| `initializeFresh()` | Explicitly creates a new private journal from independently supplied initial inventory; refuses existing/missing-marker reset and expired or more-than-one-day policy. |
| `admit(owner, runId, key)` | Fetches independent original-run authorization and treasury evidence, binds exactly one original allocation/agreement/activity/image/parties, reserves finite GLM and USDC authority. It does not create supplier resources. |
| `acceptDebit(...)`, `acceptInvoice(...)` | Reads the original document, validates immutable scope/economics and cumulative debt, commits a pending logical intent, then separately authorizes at most one mutation. |
| `requestStop(...)` | Commits the irreversible local spend fence, retains one activity-destroy and one agreement-terminate intent, and attempts each once. Acknowledgement alone does not confirm stop. |
| `reconcile(...)` | Only reads documents, scoped payments and independent stop/payment/release evidence. It can resolve retained unknown outcomes without repeating mutations. |
| `releaseAllocation(...)` | Reconciles, retains one original release intent, and rechecks final eligibility under exclusive authorization immediately before its single mutation. |
| `get(...)` | Returns the retained projection and held original reservation; supplies no execution or billing receipt. |

Policy accepts only `erc20-polygon-glm` with exactly 18 token decimals. Decimal parsing uses integer base units and rejects numbers, signs, exponent notation and excess precision. Original nonzero owner/payer/payee/node addresses, allocation/agreement/activity IDs, asset, image digest, approval hash, spend deadline and caps cannot be substituted. A fresh original-run or treasury response must match the pinned authority/profile; freshness permits at most 60 seconds of age and 5 seconds of future clock skew.

Initial GLM and USDC inventory are separate conservative limits supplied by the treasury authority. Admission cannot exceed either the original initial stock or the immutable lifetime policy cap. Paid/settled GLM and the original USDC reservation are tracked separately; this code proves no exchange rate or token conversion. Closure, refunds and later funding never renew the consumed original lifetime allowance.

## Safety transitions

`pending` is persisted before any POST/DELETE. A logical intent is bound to the original run, action, resource and cumulative amount. Another idempotency key, process restart or lost response cannot create a second attempt. A pre-dispatch refusal becomes `aborted_before_send`; after an attempted call, unresolved outcomes stay `unknown`. Acknowledged financial documents become `confirmed` only against the original retained acceptance; `SETTLED` document status alone supplies no payment finality.

Each local journal transaction and final dispatch uses the same bounded serialization gate. A queued stop during an initial source read can commit before the following dispatch section. The final authorization holds the private journal's exclusive writer lock; the current original authority, treasury and deadline are checked again, with no await between the final time fence and initial mutation invocation. An earlier dispatched attempt may finish before a subsequent stop. Other instances/processes fail closed on the journal lock; they do not steal it. This does not make remote revocation and network delivery atomic.

Kill, expiry and independently confirmed physical stop fence new liability. A trusted physical stop persists the irreversible fence even if later evidence is unavailable or no longer confirmed. An invoice at no more than the already accepted cumulative debt can still classify/pay that original debt after stop. A higher final invoice after stop, a total above original authorization, or a regressive final amount stays disputed and held for manual reconciliation. An allocation amount limits this controller's automatic acceptance authority; it does not cap unsolicited external provider claims.

`acceptedBaseUnits` is the maximum of accepted cumulative document totals. `paidBaseUnits` is the sum of uniquely observed scoped payment shares. `settledBaseUnits` includes only independently confirmed payments with the configured minimum confirmations. Batched payments must conserve their full amount, reject duplicate activity/agreement shares, bind the original allocation and parties, and cannot assign the full batch repeatedly across runs. Missing/ambiguous allocation attribution is unsupported.

Release requires a non-disputed, accepted final invoice; independently confirmed original activity stop and agreement termination; exact paid and settled invoice debt; and no pending/unknown accept or stop intent. The full original reservation remains held until independent allocation-release confirmation. Newly observed false stop/payment/release evidence restores the hold. A queued local finality withdrawal before release dispatch prevents the DELETE. No HTTP 200, HTTP 404, allocation expiry or request-supplied `final` field substitutes for those checks. An aborted or unknown release is never automatically retried.

## Bounds, evidence and remaining integration

Each policy permits at most 16 original runs; each run retains at most 32 documents, 32 payments and 64 intents. Journal JSON is capped at 1 MiB. The local queue holds at most 16 operations. Each injected I/O has an abort signal and at most 5 seconds; acceptance/reconciliation also have a 15-second operation deadline. Stale private-journal locks and restored/rolled-back host storage require operator investigation; this is not rollback-proof external accounting.

The normalized document seam deliberately rejects extra/unsupported response fields, multiple-activity invoices and optional payment allocation IDs. A future production reader must validate/normalize the reviewed actual response while preserving these bindings, not silently discard attribution or claim universal Yagna compatibility.

The controlled local HTTP test receipt, source manifest and raw results are linked from `golem-financial-lifecycle-validation-2026-10-15.json`. They do not validate a live supplier, deployable Yagna compatibility, treasury inventory, token acquisition/conversion, original-run authentication, independent chain finality, remote physical stop, provider execution, metering, billing eligibility, Linux behavior or the separate 2% adapter-revenue fault reserve. Those remain distinct gates before mounting or funding an adapter.
