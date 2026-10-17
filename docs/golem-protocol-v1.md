# Golem protocol components, 15 October 2026

The supplier library now has an opt-in Yagna HTTP transport, a read-only direct ERC-20 transfer observer and durable settlement-reference deduplication. These components are **unmounted**. They do not complete M6, approve a supplier account or enable paid requests. Telomere's customer settlement remains Base/native Circle USDC; GLM is a supplier-side inventory requirement, with conversion and its financial limits still separate.

## HTTP transport

`GolemFinanceHttpProtocol` implements the existing financial lifecycle's trusted protocol interface. The constructor accepts a fixed reviewed HTTPS origin and private Yagna application key. Literal loopback HTTP requires `allowLocalHttp:true`. Public request bodies cannot select an endpoint or bearer key.

The transport implements these exact operations from the retained official API:

| Operation | Request | Expected success |
| --- | --- | --- |
| Read debit note/invoice/payment | `GET /payment-api/v1/{debitNotes,invoices,payments}/{id}` | 200 |
| Accept debit note/invoice | `POST .../{id}/accept`, exact `totalAmountAccepted` and original `allocationId` | 200 |
| Destroy original activity | `DELETE /activity-api/v1/activity/{id}` | 200 |
| Terminate original agreement | `POST /market-api/v1/agreements/{id}/terminate` | 200 or 204 |
| Release original allocation | `DELETE /payment-api/v1/allocations/{id}` | 200 |

Every request has a complete-response deadline and bounded headers/body. The native transport follows no redirects, performs no automatic retry and returns sanitized errors. A failed or lost mutation acknowledgement remains an unknown durable lifecycle intent; repeating an API call is not its reconciliation. Stop and release acknowledgements never establish physical stop, final accounting or refund.

The terminate route accepts both success statuses because the pinned Yagna implementation returns 200 while the retained client specification declares 204. This compatibility rule applies only to that route and adds no stop or finality authority.

Wire DTOs explicitly project the financial fields. Optional debit predecessor/due-date fields normalize to null. Official extra fields, including payment signature metadata, do not become verified evidence. Bounded scientific decimal strings such as `1E-18` expand exactly to canonical 18-decimal amounts; JSON numbers, rounding and unrepresentable amounts are refused. Core financial DTOs remain canonical decimal only.

## Allocation attribution is still required

Pinned Yagna reconstructs payment shares without allocation IDs, including ordinary requestor `GET` responses. `parseGolemFinanceWirePayment` preserves that omission for observation. The financial transport's `payment()` deliberately refuses an unattributed payment rather than filling its allocation from the current run. Thus a normal Yagna payment cannot yet settle through this lifecycle.

An original accept request plus a later `ACCEPTED` status is insufficient allocation provenance. Yagna can return success for an already accepted document before executing allocation checks; another local writer could have accepted it first. A reviewed independent attribution source must bind the immutable original run, accepted liability, payment and allocation before this accounting path can be mounted.

## Direct transfer observations

`GolemPaymentChainObserver` reads an explicitly configured RPC. It decodes Yagna's `details` as canonical standard base64 of exactly 32 raw transaction-hash bytes. The supported observation is deliberately narrow: one original agreement or activity share, one exact token `transfer` call and one matching token `Transfer` event. Missing allocation metadata remains explicitly unestablished. Mixed batches, indirect calls, duplicate events and mismatched parties/amounts are not attributed heuristically.

The observer checks chain ID, exact calldata/value, receipt success, transaction membership, canonical block identity, configured runtime-code hash, 18 decimals, confirmation depth and final rereads. Historical code/metadata reads use canonical block-hash selectors. Whole-inspection and streamed-response budgets cover stalled RPC bodies and caller cancellation. Actual disposable Anvil tests exercise transfer, revert and reorg behavior.

Every result states `observationOnly:true`, `settlementAuthorityEligible:false` and `allocationAttribution:'not-established'`. It exposes no `confirmed:true` authority result. Polygon GLM's official address alone, or its outer proxy runtime hash, does not establish the implementation, storage and historical deployment policy. That review remains a hard boundary. The observer cannot release a financial reserve or authorize supplier settlement.

## Permanent transfer identity

A trusted confirmed financial proof must now provide `settlementReference`. For the narrow one-transfer mode its identity hashes the domain `telomere.golem.direct-erc20-settlement.v1`, chain ID, lowercase token address and transaction hash. It excludes block hash and global log index, which can change when a transaction is mined again after a reorg.

The private financial journal retains this reference after loss of finality and across restart. A different payment ID cannot reuse it in any original run in that journal. A previously referenced payment cannot replace its reference. Existing same-ID batch conservation remains bounded by its original total. This is a conservative refusal of payment aliases, not support for general Yagna multisend attribution.

Legacy unconfirmed private records without a reference read as null. Legacy confirmed records without one are refused and require reconciliation; no reference is invented. The index is local to this bounded journal. Rollback-proof external accounting and shared cross-policy authority remain separate work.

## Remaining integration gates

Authenticated original-run/treasury readers, independently attributable supplier payments and allocation closure, reviewed Polygon token implementation/history, workload creation/execution, signed in-cell metering, full external obligation limits, conversion and the specified 2% adapter-revenue fault reserve remain required. No public transaction, paid provider request, main route or deployment profile is enabled by this change.

The [protocol validation record](golem-protocol-validation-2026-10-15.json) retains source provenance and measured acceptance: fresh Linux install/build and **181/181** supplier checks, zero failures or skips, on commit `5b31957bce5c2dabc50a2ca23d43906a1612fc13`. Its 689 inputs remained unchanged; the original services, PIDs, profile and health checks matched before and after. Windows passed 179 cases with two existing POSIX skips; Linux executed both. The initial integration fixture failure remains retained with its correction. Earlier full-suite, Linux and staging reports retain their original source cutoffs; this component work does not retroactively update their deployed source.
