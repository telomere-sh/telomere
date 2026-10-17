# CPU launch hardening, 17 October 2026

Scope: the deployed bounded CPU service on Base mainnet with native USDC, public wallet authentication and isolated workspaces. GPU Cells are excluded. This record supplements the earlier real-wallet deposit, paid execution, settlement and complete withdrawal tests; it does not replace the broader Telomere specification assessment.

The production application remains release `ef6436151e2d098c21a46e1512a140e6f0cbf548`. The website design and assets were not edited. Only the private RPC transport and operations layer changed.

## Completed operational work

- Read RPC recovery supports historical log ranges through a dedicated public upstream. Exact receipt-block logs and contract state checks retain their appropriate upstreams. Signed transaction broadcasts still make one upstream attempt, with no automatic failover or repeat. Response/request sizes and concurrent requests are bounded.
- Actual gVisor recovery exercises cover process death during CPU execution, orphan removal, persisted metering, death after journal persistence, original-byte settlement recovery, repeated restart without duplicate execution/charge, and contract timeout refund.
- HTTP acceptance uses independently signed generated accounts, separate PostgreSQL, real gVisor jobs and an isolated local chain. It checks account isolation, concurrent revision conflicts, rate limits, quote capacity, RPC failure after reservation, original-hash recovery, owner stop, Leash revocation, expired quotes, conservation of charges/refunds and over-withdrawal rejection.
- Hourly encrypted database/configuration/Cyst backups include an isolated PostgreSQL restore rehearsal. A separate encrypted bundle retains the pinned runtime, website, operator files and required binaries. Off-host copies are decrypted and verified on the Windows PC before acknowledgment.
- A two-minute observer checks service, financial, settlement, backup, off-host, disk, TLS and operator-gas conditions. Backup and monitoring timers are installed and enabled on the VPS.

Measured load results are retained in `evidence/cpu-launch-20261017/`. These are loopback application measurements on this VPS with 50 concurrent readers, not internet latency or a promise of 50 parallel CPU jobs. The deployed worker executes one CPU task at a time. Existing admission controls remain: 8 outstanding quotes per owner, 64 globally, and the existing daily limits. CPU work remains bounded to the four exposed algorithms and at most 120 seconds per task.

| Check | Observed result |
| --- | --- |
| PostgreSQL HTTP burst | 50 signed users, 1,000 reads, zero errors; p95 132 ms in the sustained-run fixture and 192 ms in the final restart fixture |
| Sustained reads during CPU work | 180 seconds, 1,798 requests, p95 4.49 ms, zero errors |
| Admission boundaries | Per owner: 8 accepted / 4 refused; global: 64 accepted / 1 refused; per IP: 240 accepted / next 20 refused |
| Real isolated gVisor execution | 11 local-chain paid runs; receipts, stop/kill refunds and token conservation verified |
| Database outage | Requests fail closed; PostgreSQL and controller restart preserves sessions, job records, settlement hashes and balances |
| Crash recovery | CPU SIGKILL, orphan cleanup, journal-before-broadcast SIGKILL, unchanged settlement bytes, no duplicate charge and full timeout refund passed |
| Focused automated checks | 35 RPC/auth/Workspace tests and 14 backup/monitor tests passed; TypeScript typecheck passed |
| Production dependency audit | Zero reported production dependency vulnerabilities at check time |

The three-minute sustained test and the final database restart test are separate retained runs. The final fault-focused rerun uses `--soak-seconds 0`; it does not claim a second three-minute measurement. Earlier failed harness setup attempts and their corrections are recorded in the evidence instead of being discarded.

The consistent database restore compares 45 tables and 22 rows from the live snapshot. The approximately four-second restore measurement covers the scratch database rehearsal only. Complete VPS rebuild time has not been measured.

## Remaining launch boundaries

The operational tests require no second human wallet and send no mainnet transactions. The earlier mainnet tests used the owner wallet, which is also the treasury recipient. A second independent payer is still needed to accept the distinct payer-to-treasury real-money flow. This work does not constitute an independent smart-contract/security audit.

Off-host automation currently depends on this Windows PC being awake and signed in. Its identity is protected by current-user DPAPI. Independent always-on storage, offline key escrow and an outbound incident paging destination are additional operational decisions. The installed monitor reports stale backups locally; it cannot wake an offline PC or send an unconfigured notification.

The service is prepared for a bounded CPU launch with its present queue and worker limits. Additional compute hosts or broader unbounded workloads require a new capacity test. GPU Cells and the broader multi-host platform are outside this launch record.

Operational commands and recovery precautions are in [the CPU operations runbook](../ops/cpu-launch/README.md).

The later [independent cloud operations follow-up](CPU-CLOUD-OPERATIONS-20261017.md) supersedes this record's initial PC-dependent backup and missing outbound paging boundaries.
