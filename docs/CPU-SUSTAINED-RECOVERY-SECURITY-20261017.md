# CPU sustained acceptance, recovery and security, 17 October 2026

Scope: the deployed bounded CPU backend on Base/native USDC. GPU Cells are excluded. No second human wallet, production payment, new contract deployment or production controller restart was used. The application remains the frozen release `ef6436151e2d098c21a46e1512a140e6f0cbf548` with 749 runtime pins. Website assets were not changed.

## Sustained run is in progress

The final twelve-hour run started at **18:44:59 UTC, 17 October** and targets **06:44:59 UTC, 18 October** (09:44:59 Moscow). Its unit is `telomere-cpu-soak-0edc56ed5ba346ae`. It runs independently on the VPS. The retained `soak-progress.json` is a dated intermediate observation, not a twelve-hour pass.

The fixture has 50 independently signed generated users, a separate PostgreSQL database and Anvil chain 31337. It sends concurrent batches of ten Workspace reads/second, conditional writes, and a real gVisor hash-chain job every five minutes. Reads continue during running CPU work. Every job checks its receipt, settlement, treasury payment and unused-funds return using disposable test tokens. Sessions renew every four hours. Request history and latency histograms have bounded memory; progress and worker RSS are saved every minute. Acceptance requires the complete duration, zero errors, at least seven reads/second overall, p95 at most two seconds, CPU/read overlap and RSS below the production 768 MiB ceiling.

The final harness's accelerated 70-second smoke passed: 700 reads, 70 writes, one charged CPU job, 100 session renewals and 20 reads overlapping running CPU. A separately forced SIGKILL exercised `ExecStopPost`: its two labelled containers and scratch volume were removed. Cleanup is restricted to the exact test namespace. The earlier preliminary sustained unit was deliberately stopped after the improved concurrent harness passed; its partial observation is retained separately and is not counted as a completed twelve-hour run.

The production monitor watches this run for failure, invalid observations and stale progress. Existing Telegram paging covers those incidents from both the VPS and the independent hosted checker. Healthy progress and completion remain quiet. Private hosted run reports retain numeric test counters; GitHub scheduler delays remain possible. A reboot interrupts the transient run and stale progress raises an incident.

## Recovery acceptance passed

The final application recovery rehearsal completed in **87.919 seconds** on the existing Linux host. Both encrypted archives authenticated; all members and 749 application pins matched. PostgreSQL restored **45 tables and 23 rows** using the production image digest with networking disabled.

The archived API read the two original completed production jobs, receipts and owner Workspace through a separate restored database Unix socket in a new network namespace without interfaces/routes. No worker or mainnet signer was started against this database. Temporary synthetic sessions were removed; every original table fingerprint remained unchanged. A second controller database connection was correctly rejected by the archived application's advisory lock.

The extracted Node/application then booted with an empty scratch PostgreSQL database, generated keys and local contracts. Fifty users completed a 1,000-read burst, followed by a 60-second concurrent workload and an actual paid gVisor CPU job with valid settlement/receipt. Application pins remained unchanged. Recovery executables are retained under a separate root-owned parent and run as UID 995; the live application cannot replace this executable tree. Root recovery reports remain in private/. Numeric loopback validation prevents progress-file values becoming privileged nginx directives, and bounded no-follow descriptor reads reject symlinks, hardlinks, FIFOs and oversized progress records. A separate loopback TLS nginx loaded the retained website, site configuration and CSP include with a temporary test certificate. HTML bytes matched, API authentication worked and private paths returned 404. Scratch runtime/database/proxy resources were removed.

This exposed and fixed one backup-completeness gap: the nginx site referenced a CSP snippet that had not been retained. The CSP snippet and HTTP/ACME site now accompany the encrypted configuration snapshot. Hosted copy, authenticated decryption, storage readback and an independent PostgreSQL restore passed after this change.

This is application/database/website/proxy recovery on the existing host. **Provisioning a fresh VPS, installing its OS/Docker, issuing a public TLS certificate and switching DNS have not been rehearsed.** The measured time is not a complete-machine RTO. Production chain reconciliation is still required before activating a mainnet controller from an older snapshot.

## Internal security checks passed

- 62 existing escrow/worker/service/RPC/auth tests and eight additional public-launch security tests passed. Checks include signature domain/replay, session fixation/expiry/cookie flags, owner boundaries, CSRF/Origin, malformed/oversized input, proxy identity spoofing and disabled public demo signing.
- Storage/runtime suites passed 39 tests. Their one Windows-skipped POSIX case was separately executed against the frozen Linux runtime as UID 995: private modes and rejection of public-mode blobs, symlink blobs, symlink roots and symlink temporary files all passed.
- 31 Linux backup/monitor/archive tests and 17 hosted operations tests passed. TypeScript typecheck passed. Full dependency audit, including development dependencies, reported zero known vulnerabilities at check time.
- Nineteen bounded checks against the real public HTTPS API passed, including unauthenticated owner routes, secret/source paths, exact Origin, input parsing and demo-login denial. No valid public login challenge or payment was created by that probe.
- Read-only mainnet verification retained two completed jobs, zero available/reserved/total escrow USDC, the prior withdrawal and unchanged operator gas. This work sent zero mainnet transactions.

This is an internal review and regression exercise, not an independent security audit. The controller/receipt signer remains trusted for usage attestations, the dedicated Docker control boundary is privileged, and private backup repository administrators are trusted with cloud recovery. The real-money distinct payer-to-treasury acceptance still requires another independently controlled wallet because the current mainnet owner is also the treasury.

Evidence is retained under [`evidence/cpu-sustained-20261017/`](evidence/cpu-sustained-20261017/). Earlier operational acceptance remains in [the launch record](CPU-LAUNCH-READINESS-20261017.md) and [the independent operations follow-up](CPU-CLOUD-OPERATIONS-20261017.md). Commands and recovery precautions are in [the operations runbook](../ops/cpu-launch/README.md).
