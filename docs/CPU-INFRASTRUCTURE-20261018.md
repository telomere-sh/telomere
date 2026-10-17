# Public HTTPS, physical storage failure and recovery preparation, 18 October 2026 Moscow

The deployed backend remains immutable release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4`, with 758 verified runtime pins. The frontend, production contract and application source are unchanged. All paid historical fixtures and archive operations use generated accounts on loopback chain 31337. No second human wallet or mainnet transaction was used. Both twelve-hour soak units retained their original PIDs/start times and zero restarts.

## Public HTTPS acceptance

An external Windows client used ordinary trusted HTTPS to a temporary protected path on `review.telomere.sh`, through the actual public nginx and a separate instance of the exact backend release. The fixture had its own database, local contracts and wallets. It was not an SSH tunnel, a loopback HTTP measurement or a claim that test users wrote to production accounts. The public domain in the authentication messages/cookies was `review.telomere.sh`.

Fifty generated wallets completed message-signature login while respecting the 30-auth-requests/minute/IP limit. All 50 saved a distinct Workspace. A burst of **150 authenticated reads, concurrency 50**, retained exact owner/document isolation with zero errors: **p95 482.402 ms**, p99 487.229 ms, burst duration 0.756 seconds. Two conflicting revision writes produced one 200 and one 409. Secure/HttpOnly/SameSite Strict session cookies, Origin enforcement and the request-size bound passed. The client deliberately reached 429, then all 20 requests with forged forwarding headers were still rejected. A later request succeeded after the rate window reset. The full profile, including authentication pacing and cooldown, took 252.507 seconds.

The location required an unlogged private credential, permitted only fixture methods and forwarded to a validated numeric loopback port. nginx replaced client IP headers with the real remote address. A missing credential returned 404. There was an independent 25-minute expiry; the route was removed immediately after the client finished. The exact original review configuration was restored and nginx validation passed. Neither the apex website nor the normal review gate was replaced.

A separate modest, read-only burst targeted the actual **`https://telomere.sh/api/me`**: **100 requests, concurrency 50**, all expected **401**, zero unexpected responses, p95 **499.652 ms**, p99 516.402 ms. It created no authentication challenge, Workspace write or financial transaction. This checks the real apex edge/authentication boundary; it is not authenticated production-account throughput or a distributed Internet capacity benchmark.

## PostgreSQL faults inside real archive transactions

The accepted fault profile mined 256 distinct local contract settlements with synthetic historical metering, retained their signed bytes and began archive attempts against the deployed compiled bridge. These are 256 historical contract-payment fixtures, not 256 claimed CPU executions. Four injected failures passed:

| Fault | Actual observation |
| --- | --- |
| Journal-lock contention | Held row lock; production pool statement timeout returned SQLSTATE **57014** after 5.489 seconds. |
| Connection termination during membership update | SQL sleep barrier proved the archive had reached its uncommitted membership update; `pg_terminate_backend` aborted it. |
| PostgreSQL SIGKILL at that barrier | Only the labelled scratch PostgreSQL container was killed/restarted. WAL recovery retained the original history and rolled back the uncommitted archive. The archive process exited 1. |
| Physical tablespace exhaustion | A dedicated **16 MiB tmpfs** was filled. A trigger performed a real tablespace write during the archive's membership update, returning SQLSTATE **53100**. This was a kernel/storage error, not a mocked SQL response. |

After each failed attempt, the entire original journal hash, row count, signer nonce and checkpoint/membership counts matched the baseline. The disk-full trigger failed after checkpoint insertion in the same SQL transaction, verifying rollback across both writes. After the faults were removed, the same bridge successfully archived **eight originals in one signed batch**, retained all 256 original rows and kept signer nonce **256**, with no new transaction. A fresh application started ready and verified the retained archive.

The first integrated attempt completed the public HTTPS work and two PostgreSQL fault checks, then its coordinator rejected the missing IPC reply from the archive process after PostgreSQL SIGKILL. The corrected coordinator accepts an abrupt archive-process exit only for this explicit, already-reached hard-crash barrier, then independently verifies database recovery and unchanged financial state. The accepted fault-only rerun uses a separate namespace and explicitly retains the first fixture's public HTTPS result. It does not claim the second instance received that external traffic. Both attempt logs and cleanup outcomes are retained.

## Physical Cyst filesystem exhaustion

A separate **16 MiB host tmpfs**, owned by the application UID, contained a real encrypted existing checkpoint. The fixture filled it until the kernel returned **ENOSPC**, then attempted another real Cyst upload. The failed upload remained **pending**; its metadata/quota reservation was durable, its temporary file was removed and the earlier checkpoint remained readable with identical ciphertext.

After deleting only the fixture filler, retrying the original envelope/idempotency key completed the same record. Owner byte/checkpoint counters were identical before and after retry, demonstrating one quota reservation. The recovered **524,288-byte** checkpoint decrypted successfully. No financial journal byte or nonce changed. Labelled scratch containers/volumes and both bounded storage mounts were cleaned up; production disk space was not exhausted.

## Clean-host recovery kit

[The recovery runbook](../ops/cpu-launch/CLEAN-SERVER-RECOVERY.md) accompanies a guarded Debian 12/amd64 dependency bootstrap, host preflight, authenticated data/runtime staging and a generated ordered install plan. The bootstrap refuses an existing Telomere installation before package operations. Executing this guard on the current VPS left the package inventory unchanged; the shell syntax check passed. The source host correctly fails `--require-fresh` because Telomere already exists (and its current PATH does not contain certbot). No dependency installation was attempted there.

The staging command was exercised with the **actual latest encrypted data snapshot and exact referenced runtime bundle**. It authenticated both age archives, checked manifest members and every file hash, enforced their snapshot/runtime binding and matched all **758 reviewed runtime pins**. It retained the real **47-table / 28-row** snapshot and generated the install/cutover plan in a new root-only staging directory. The age identity travelled over SSH stdin, was never an argument/log/file on the VPS, and no restored executable or controller was started.

The plan covers immutable files, binaries, private modes, writable data, image digests, network/Docker units, offline database verification, canonical chain reconciliation, old-worker fencing, one-controller activation, independent SSH host-key verification, hosted export/backups, fresh TLS and DNS cutover. The backup contains the runtime and configuration, not the OS or Docker image contents; exact pinned images must be pulled or supplied as verified offline exports. The kit is preparation and authenticated staging, not a completed fresh-VPS/OS/TLS/DNS recovery rehearsal or a measured full-machine RTO.

## Final verification

Eight recovery-kit and ten route/control boundary tests passed on Linux. They cover changed bytes, wrong runtime/chain, invalid image/table/pin paths, unsafe ports/work paths, oversized or symlink progress files, preservation of foreign nginx edits and cleanup despite route reconciliation. Reusing an earlier HTTPS report additionally checks a bounded nonblocking file descriptor, rejecting FIFO, symlink and oversized inputs before reading. The first Windows unit pass exposed a path-separator mismatch in the Linux-directory assertion; the portable comparison was corrected and all eight then passed on Windows and Linux.

The final encrypted snapshot restored **47 tables / 28 rows in 4.476 seconds** on the VPS. GitHub-hosted run **39071246037** independently authenticated the current snapshot/runtime bundle, verified storage readback and restored the same tables/rows in **13.992 seconds**, without starting a mainnet controller. The final production monitor has no alerts. The original two real mainnet settlements, journal fingerprint, signer nonce **2**, operator gas, owner **2.422567 USDC** and empty escrow remain unchanged.

The retained intermediate soak observation has **96,520 reads / 9650 writes / 33 CPU runs** in the original run and **30,210 reads / 3020 writes / 11 CPU runs** in the archive-aware run, both with zero errors. Neither is a completed twelve-hour pass. Expected finish times remain **09:45 and 11:35 Moscow, 18 October**.

See the [evidence manifest](evidence/cpu-infrastructure-20261018/manifest.json), [generated install plan](evidence/cpu-infrastructure-20261018/clean-server-install-plan.json) and [operations runbook](../ops/cpu-launch/README.md).
