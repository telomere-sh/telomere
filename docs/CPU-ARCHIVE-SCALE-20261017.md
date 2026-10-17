# Archive-release concurrency and financial-history acceptance, 17 October 2026 UTC

The deployed application remains immutable release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4`, with 758 verified runtime pins. This work adds isolated operator acceptance profiles and concurrent-soak monitoring. It does not change the production application or website and sends no mainnet transaction. All generated owners, signatures, contracts, payments and RPC fault injection belong to loopback chain 31337 and separate labelled PostgreSQL containers/volumes.

## Two independent twelve-hour tests

The original unit `telomere-cpu-soak-0edc56ed5ba346ae.service` remains running against its original physical release `ef6436151e2d098c21a46e1512a140e6f0cbf548`. Its PID and original start timestamp are retained in the concurrent status evidence. No stop or restart was issued for this test.

The new unit `telomere-cpu-journal-soak-ee847b083532475b.service` pins the physical archive release. Its workload started at **20:35:01.961 UTC on 17 October** and targets 43,200 seconds, ending around **08:35 UTC / 11:35 Moscow on 18 October**. The original workload targets **06:45 UTC / 09:45 Moscow on 18 October**. These are projected finish times; neither running observation is a completed twelve-hour pass.

Both profiles use 50 signed generated users, continuous Workspace reads, conditional writes, genuine gVisor CPU work every five minutes and session renewal every four hours. The archive profile first creates 256 distinct genuine local contract settlements with synthetic metering history. These are historical fixtures, not 256 claimed CPU executions. It then requires real automatic archival during the running HTTP/CPU workload while retaining every original signed record. A separate 70-second smoke passed 700 reads, 70 writes, one CPU execution, 100 session renewals and eight automatically archived originals.

The root watch configuration preserves its original namespace and additionally watches the new archive run. VPS and independent GitHub-hosted monitoring handle failed, stale or invalid observations. Healthy running/completed observations remain quiet. The hosted report retains bounded numeric counters for both tests. Launching another acceptance profile now replaces its Docker wrapper atomically, avoiding truncation of a file used by a running test.

## History, queue and RPC failure method

The large profile seeds 10,000 separately signed canonical contract settlements. Bounded FIFO batches mine 32 reservation/settlement pairs per block and check every receipt before inserting the corresponding immutable financial rows. Historical metering is synthetic; its local contract payments are real. Archival retains all original bytes and leaves 256 active rows before restarting the actual API/worker. Startup checks both current and peak RSS against the production worker's 768 MiB ceiling.

Nine distinct generated owners exercise 64 paid queue slots plus a retained overflow reservation. Per-owner quote capacity, global quote capacity and paid admission reject excess work with 429. A finalized-block RPC failure and a receipt RPC failure must leave the archive/journal unchanged and preserve the first measured CPU result. The proxy then forwards a genuine settlement but drops its acknowledgement. Recovery must return the original canonical hash with exactly one additional nonce and no second CPU result.

Complete controller-RPC failure returns 503 after the bounded server receipt wait, preserves the paid overflow reservation and permits 20 Workspace reads. On recovery, the same reservation is admitted without another payment. Queue drain adds 10 ms to each forwarded RPC, continues HTTP reads, permits at most one running CPU job and requires 65 anchored receipts, exact owner/treasury token conservation and precisely 65 additional signer nonces. Original history bytes are fingerprinted before and after automatic archival.

The restore phase captures every table fingerprint and a pg_dump from the same repeatable-read exported snapshot, replaces only the scratch schema, restores the dump, compares every table and original signed journal, restarts the actual application and replays an existing request. Replay must return its original hash without another signer nonce.

The final large run passed at **21:08:11 UTC**. Creating 10,000 genuine historical settlements took **73.976 seconds**; archiving 9744 and verifying the retained history took **74.621 seconds**. A fresh application boot took **2.509 seconds**, with both current and peak worker RSS **147,472 KiB**. The queued workload produced **65 genuine CPU receipts** with exactly **65 broadcasts / 65 new signer nonces**, including one recovered lost acknowledgement. All 10,065 original records remain: **9944 archived, 121 active, 64 signed archive batches**. Nine owners and their distinct treasury conserved every local token; the final signer nonce was exactly **10,065**.

Queue drain took **403.646 seconds** with the injected RPC delay. Its 398 successful concurrent Workspace reads had **p95 5.957 ms**; at most one CPU job ran at a time. These are loopback measurements for this profile. Dump/restore and startup checks passed for **47 tables / 20,303 rows** with identical fingerprints, retained original signed bytes and no replay transaction. The restore phase took **5.457 seconds**, including a fresh boot measured separately at **2.429 seconds**.

The retained attempts include fixture failures: immediate automined receipt visibility, an outage probe sharing the server's 15-second deadline, and a bulk Anvil finality call exceeding its test-client deadline after all 10,000 transactions had mined. The final harness uses bounded direct receipt polling, a 30-second intentional-outage probe, FIFO seed batches and individually mined finality blocks. The 256-history fault/queue/restore profile passed both before and after FIFO batching. These changes apply to the acceptance harness; production settlement behavior is unchanged.

## Backups, monitoring and production funds

The final encrypted production snapshot restores **47 tables / 28 rows** on the VPS in **4.235 seconds**. Independent GitHub-hosted run **39069363371** authenticated the snapshot and its exact runtime bundle, verified 758 pins and independent storage readback, and restored the same 47 tables / 28 rows in **19.325 seconds**. No mainnet controller started against either restored database. The hosted implementation runs independently of the owner's PC and reports no alerts.

The production financial audit retains the original journal SHA-256 `d26dcd891a949f492e0457fb8bc94f06ded34993caf1724dc27389098143593e`, two completed settlements, signer nonce 2, operator ETH 98,462,564,567,330 wei, owner balance 2.422567 USDC and empty escrow. The VPS monitor reports a verified production archive checkpoint, no invalid financial rows, a ready API, matching off-host runtime verification and no alerts.

Focused verification includes **38 Linux operations tests, 20 hosted-operations tests and one RPC-proxy test**. Evidence contains source snapshots, raw logs, failed attempts, final results, concurrent progress, backup/hosted reports and a SHA-256 manifest. Source provenance distinguishes earlier loaded soak modules and failed fixture variants from the final stress reproducer.

At **21:08 UTC**, the uninterrupted original soak had **85,650 reads / 8560 writes / 29 CPU runs**; the new archive soak had **19,950 reads / 1990 writes / seven CPU runs**, retaining 263 journals with 56 automatically archived originals. Both reported zero errors and zero restarts. These counters are intermediate observations, not final twelve-hour totals.

These measurements describe one VPS with one CPU worker and controlled loopback clients. Historical fixture volume is separate from genuine CPU throughput. Public Internet load, capacity on another host, a completed twelve-hour archive-release run and acceptance with a second human mainnet wallet are separate measurements. GPU Cells are outside this CPU acceptance scope.

See the [operator runbook](../ops/cpu-launch/README.md) and [retained evidence manifest](evidence/cpu-archive-scale-20261017/manifest.json).
