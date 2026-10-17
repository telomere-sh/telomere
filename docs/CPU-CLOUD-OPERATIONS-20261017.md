# Independent CPU operations, 17 October 2026

This follow-up moves primary backup verification and external incident detection off the owner's PC. The original CPU mainnet release and frontend remain unchanged. GPU Cells are outside this scope.

The private `telomere-sh/telomere-ops-backups` repository contains hosted verification/paging workflows and encrypted release assets. It has a separate restricted SSH export key, pinned server host key, cloud age recovery identity and the explicitly authorized Telegram destination. The production monitor selects the cloud receipt rather than the Windows receipt.

The server retains hourly consistent snapshots and local isolated restore checks. Hosted checks run twice hourly; a daily hosted restore uses the same PostgreSQL image digest and verifies all table hashes/counts without starting a restored application. The cloud can notify Telegram while the VPS or the original PC is offline. GitHub scheduler delays remain an external operational limitation.

Acceptance records, including the corrected initial timestamp-tag validation failure, are retained under `docs/evidence/cpu-cloud-20261017/`. The SSH acceptance refuses path traversal and overrides requested shell commands. Focused Linux tests exercise retention across paginated inventories, failed-delivery retries, incident/recovery deduplication, private-only storage, credential stripping on redirects, recipient rotation, archive authentication, manifest checksums and a snapshot advancing during transfer.

Recovery of the cloud age identity is available through a manual workflow that encrypts it to a new owner-supplied public age recipient. This avoids making recovery depend on the original PC's DPAPI state. Repository administrators remain trusted with this recovery capability.

Verified results:

- The final independent copy authenticated 18 snapshot members and 22,131 runtime files, with 749 production runtime pins retained. GitHub storage readback matched the published ciphertext hashes.
- Hosted PostgreSQL restoration matched all 45 tables and 23 rows in 12.45 seconds. This is a database rehearsal, not a measured complete VPS rebuild time.
- A synthetic lost SSH connection on the hosted runner delivered a real Telegram incident; the next normal run delivered recovery. The VPS remained online. Local incident/recovery delivery and duplicate suppression were also exercised with the real Telegram API and isolated test state.
- Cloud key recovery to a fresh independent identity passed. Decryption did not use the original Windows age identity, require a VPS connection or write the recovered plaintext identity to disk.
- The Windows watcher process and login startup entry were removed. The production monitor reports `offhostSource: github-actions`, a matching verified runtime and no alerts.
- 15 cloud/export/pager tests and 14 monitor/backup tests passed on Linux. Mainnet still has the same two completed CPU jobs, zero escrow funds and unchanged operator ETH; this work submitted no mainnet transactions.

See the [independent operations runbook](../ops/cpu-cloud/README.md) for schedules, key custody, notification behavior and recovery commands. The earlier [CPU launch record](CPU-LAUNCH-READINESS-20261017.md) remains the historical record for the initial load/crash acceptance; its PC-dependency and notification gaps are superseded by this follow-up.
