# CPU v2 backend acceptance, 14 October 2026

The Base/USDC backend now includes opt-in complete CPU receipt issuance and public evidence retrieval. It commits the actual signed HostKit admission and persisted ordered tick/ACK sequence, preserves the original private result and random output salt through publication failures/restart, reads back two configured evidence copies before financial issuance, and verifies the same receipt against canonical opening, financial root and settlement. The default configuration and historical v1 receipts remain unchanged.

Implementation and operator configuration are described in [CPU v2 issuance](platform-v2-issuance.md), [publication and S3 transport](platform-v2-publication.md), and [public API](platform-v2-public-api.md).

## Verified result

The final focused cohorts contain **20 distinct test files, 158 passed tests, zero failed tests and one POSIX-only skipped test on Windows**. Repeated files were counted once. The raw successful reports and production-source fingerprint are recorded in [machine-readable acceptance](platform-v2-acceptance-2026-10-14.json):

- [V2, configuration and migration boundaries](evidence/platform-v2-final-20261014.json): 72 passed, one skipped.
- [Existing runtime, main server and HostKit regression](evidence/platform-v2-runtime-regression-20261014.json): 75 passed.
- [Positive paid issuance, root sealing and financial receipts](evidence/platform-v2-paid-and-seal-final-20261014.json): 13 passed.

`npm run typecheck`, `npm run build` and `git diff --check` passed. The entire Node suite was not repeated; the earlier full migration run and its repaired failures remain in their original acceptance record. Python source is unchanged from `b24b2f1`, so its already recorded acceptance was not repeated.

The actual paid CPU fixture runs for twelve seconds through the HostKit init heartbeat protocol and produces positive acknowledged billing. Canonical test-token settlement verifies the rounded-up 9% fee and charge/refund conservation. A failed second-store write precedes controller disk close/reopen; the first salt, result and receipt hash survive, and physical execution occurs once. Missing or corrupt evidence blocks financial issuance, final verification and root broadcast, including replay of an already sealed batch containing completed and active runs. Availability checks read both copies without repairing them.

Unexecuted and incompletely paired runs retain the original version and no financial receipt, survive restart after confirmed cleanup, and observe their original permissionless full timeout refund. Unknown cleanup still fails closed. Public GET verifies both configured copies and canonical settlement without disclosing private argv/stdin, output or output salt. Native Circle historical/current proxy implementation and authorization-domain changes, same-block upgrade/rollback and noncanonical opening references are rejected in no-network fixtures.

## Scope still outstanding

This acceptance uses disposable local Anvil contracts, loopback HostKit process fixtures and memory/mock storage transports. It does not establish a Base deployment, funded public owner acceptance, live Linux/gVisor v2 rollout, independently reviewed S3 durability/domains/Object Lock, a real TDX CPU Cell or a fresh managed inference completion. Host admission is signed host testimony; the independent historical delegation signing time remains unproven. `independentlyPublished` remains false. The root availability guard scans at most 4096 leaves sequentially with bounded individual storage operations; this is a pilot path, not a throughput benchmark.

A new read-only SSH attempt to `2.27.12.39:22` timed out before authentication. No server files, services, public-chain transactions or external storage objects were changed. The prior approximately 72% functional estimate was not automatically increased from local test counts; remaining live gates are tracked in [release blockers](release-blockers-2026-10-14.md). Wallet testing remains last.
