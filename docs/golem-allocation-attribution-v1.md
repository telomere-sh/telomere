# Golem native allocation attribution

This opt-in, unmounted integration connects the existing authenticated Yagna HTTP transport to the existing financial lifecycle. It reconstructs a missing payment allocation ID from the original local Yagna SQLite records. It creates no allocation, provider activity, payment, financial ledger, chain-finality authority or physical-stop authority.

The source profile is pinned to Yagna `c256fce68c50c141a51d4bd2ca18292e4b006f15`. [Retained primary sources and license](evidence/golem-allocation-upstream-20261015/manifest.json) include its processor, DAO, models, schema and original SQL definitions.

## Why the public payment response is insufficient

The native processor finds `pay_batch_order_item` by the driver's original `payment_id`, joins its document rows using `owner_id/order_id/payee_addr/allocation_id`, and creates the public payment from that mapping. The API mapper subsequently emits allocation IDs as `None`.

The allocation `orders` endpoint does not repair this omission: its actual `DbAgreementBatchOrderItem` projection does not expose `payment_id`, the payer or the platform. An order with the same amount is insufficient evidence of which transfer funded it.

## Supported integration

`GolemFinanceHttpProtocol.wirePayment()` performs the existing bounded authenticated GET without inventing omitted fields. The original `payment()` method still refuses unattributed responses. `GolemAttributedFinanceProtocol` composes `wirePayment()` with `GolemAllocationAttributionReader` and returns the existing strict payment DTO only after the native proof succeeds. The original financial lifecycle continues to enforce its retained run, allocation, caps, independent finality and global settlement-reference checks.

The initial supported payment has one requestor, one provider, one agreement or activity share, and one original allocation. Several native order components may contribute only when every component has this exact allocation and original scope, each item's documents conserve that item, and all items/documents conserve the public payment. Mixed allocations, mixed shares, deposits, missing or ambiguous joins, duplicate native documents and mismatched source fields are refused.

The reader checks the native payment's ID, requestor/provider, role, payer, payee, platform, amount, timestamp and raw transaction-hash bytes. It independently joins the native order, allocation, agreement/activity and payment-document rows. A supplied API allocation ID must agree with that proof. No ID is inferred from amount, public status or a successful HTTP mutation.

In this pinned revision, `PaymentDao` writes both payment-document `invoice_id` and `debit_note_id` as `None` for activity and agreement shares ([retained DAO](evidence/golem-allocation-upstream-20261015/core/payment/src/dao/payment.rs)). The reader requires both fields to remain `NULL`; a populated field refuses attribution. The corresponding batch-order component must still identify its actual invoice or debit note. These are different native rows with different source invariants.

## Installed trust and limits

The operator must explicitly review and install the local database path, original file/directory device and inode, exact eight-table schema hash, requestor and payer. The reader does not discover or enroll a database. This is trust in the installed requestor's local accounting database, not a provider signature, blockchain consensus proof or protection against an administrator rolling back all local state.

The worker opens SQLite with `readOnly:true`, extension loading disabled, `query_only`, `trusted_schema=OFF`, zero busy timeout, a small cache and no memory mapping. All external values use prepared parameters. A single read transaction supplies the accounting snapshot. Queries select only the required public accounting fields; they do not read signing keys, application keys, payment signatures or the whole database.

Private directory/file ownership and POSIX modes, ancestor symlinks, hard links, the original source identities and source sizes are checked. Windows ACLs remain an operator responsibility. A hot journal, incomplete WAL/SHM pair, changed database/WAL observation or changed identities cause refusal. WAL mode requires existing WAL and SHM files, avoiding implicit sidecar creation. SQLite may use read-lock metadata in the existing SHM file; DB and WAL are opened for reads.

The supported POSIX WAL profile runs under the same non-root service UID that owns the reviewed Yagna database and its private directory. In Node 22.23.3's [bundled SQLite implementation](https://github.com/nodejs/node/blob/v22.23.3/deps/sqlite/sqlite3.c#L39918), opening an existing WAL as root can invoke `fchown` and change its ctime even when its bytes, permissions and ownership stay equal. The unchanged-source guard deliberately refuses that observation. Root execution with WAL is unsupported; this is not an exception to the source-integrity checks. The retained Linux diagnostic reproduces the ctime change without enabling the integration on staging.

Reviewed maxima are 256 MiB database, 64 MiB WAL, 1 MiB SHM, 128 order items and 128 component documents. A worker has a finite 100–5000 ms operation budget, constrained V8 resources and no retained output logs. At most two workers exist per reader; cancellation requests termination and retains the slot until the worker exits. The control-plane thread performs no synchronous SQLite calls and queues no unbounded work. No retries or writes follow uncertainty.

`tsx` is used only by the source-mode worker bootstrap to resolve this project's ESM TypeScript imports. Compiled production workers use Node and its built-in `node:sqlite` without a new dependency. This module is not mounted in `main` or enabled on staging.

## Verification boundary

The focused fixture uses actual SQLite tables created from unchanged retained upstream DDL, an authenticated native HTTP server, and the existing financial controller/ledger. It checks missing API allocation reconstruction, rollback-journal and WAL reads, source byte preservation, exact join failures, private identity/limits, cancellation, concurrent-reader quota, retained mutation intent and reconciliation after reopening. Independent finality in the composed lifecycle test is explicitly a local fixture. It does not demonstrate a live Yagna daemon, Polygon settlement, provider execution, physical shutdown or a complete M6 adapter.

The [original focused local validation](golem-allocation-attribution-validation-2026-10-15.json) records 24 passed checks, zero failures and one explicit Windows filesystem-symlink skip (25 total). It includes the completed source inventory. Earlier failed development attempts are retained under `.local`; this document does not claim a clean full regression or a public deployment.

The later [Linux acceptance](evidence/golem-native-payment-doc-linux-20261015/acceptance.json) pins source revision `079bb31fa76217df9d3d3d0e309293bf4f58e89c` and passes all 27 checks with zero skips, including both populated payment-document ID refusals, actual WAL reads and the POSIX symlink refusal. Type checking also passes. Node and the observed SQLite fixtures run under the same non-root UID/GID 65534; the strict source checks remain unchanged. The initial root/WAL refusal and the failed identity preflight are preserved alongside the successful run. The 708 runtime files, 12 retained upstream fixture files, original source copy and both dependency copies retain their pinned bytes; staging services retain their process identities and healthy status.

Runtime-only acceptance archives must include the separately pinned upstream fixture supplement: the tests read both original SQL migrations from `docs/evidence/golem-allocation-upstream-20261015/`. The frozen full-run archive omitted that tree; its resulting setup failures remain preserved, while the complete corrected 27-case run supplies all 12 original Git blobs with before/after hashes. The test UID is an isolated acceptance identity, not a production account recommendation.

## Erratum: allocation release observations

Earlier protocol research distinguished the API's nominal `410 Gone` branch from `404 NotFound`. The retained implementation's `AllocationDao.get()` first filters `released=false`, making its later `Gone` branch unreachable for released records. Consequently a released allocation can produce `404` in this exact source revision. Neither `404` nor a nominal `410` alone proves independent physical stop, final invoice settlement or an on-chain refund. This correction does not alter historical source artifacts or authorize reserve release.
