# CPU queue, rollback and scaled recovery, 17 October 2026

Scope: the bounded CPU backend on Base/native USDC. All paid acceptance jobs below used newly generated accounts, separate PostgreSQL and local chain 31337. No mainnet signer, owner transaction, GPU Cell or second human wallet was used. Production remains immutable application release `ef6436151e2d098c21a46e1512a140e6f0cbf548`, with all 749 runtime pins verified. Website files and the production controller were unchanged.

## Queue and overload passed

Nine funded local owners filled **64 paid queue slots**. The ninth quote from one owner, a quote at global capacity, and admission of an already-opened excess reservation returned 429. The excess reservation stayed on-chain and later executed using the original run ID and transaction hash, without another payment. Repeating admission preserved the original settlement hash.

A waiting job was cancelled with zero charge. All **65 receipts** in the queue/overflow phase were canonical and verified. One CPU job ran at a time; all owners drained in 173.735 seconds. Maximum observed queue wait was 172.492 seconds. Five hundred Workspace reads during full admission had p95 **171.036 ms**; another 84 reads succeeded during actual queue drain. Per-owner available/reserved/charged balances and the independent local treasury conserved every test token.

This measures one worker with the bounded shipped CPU tasks, on loopback. It does not establish a general public Internet throughput SLA or concurrent execution of 64 jobs.

## Code rollback passed

Two disposable app clones differ by an acceptance-only HTTP release marker. The A-to-B transition applies a representative compatible additive database column. The B version writes a newer Workspace document and settles a paid CPU job. Returning to A preserves that document, the extra column's data, every newer financial record and every byte of the signed transaction journals. The signer nonce does not increase during rollback.

The application database was preserved during this code rollback. This rehearsal covers compatible additive changes; each actual future release, especially a destructive migration, needs its own compatibility and rollback acceptance.

## Stale database recovery passed

The test captures a database dump after the exact signed settlement journal is durable but before broadcast. The transaction is then mined. After restoring the older database, the worker recovers the canonical receipt and original transaction hash, without a second signer nonce or charge.

A second reservation is created after that dump. A read-only scan of canonical `RunOpened` events detects its missing database row and reports operator reconciliation as required. Its admission returns 404 rather than inventing execution evidence; the owner successfully obtains the contract's timeout refund. This time-advanced refund probe runs on a disposable local-chain branch, reverted before the later capacity test. Missing execution records are not automatically reconstructed.

New real backups retain a chain cursor observed before opening the repeatable-read database snapshot, so recovery scans overlap the snapshot boundary. RPC failure preserves the database backup with a null cursor and requires manual review of a canonical starting block. The operator recovery audit opens a read-only database transaction, compares chain/escrow and block hashes, pages at 1,000 blocks, refuses gaps above 10,000 blocks, and sends no transaction. A clean missing-reservation report is not a substitute for full financial/asset/role reconciliation before mainnet activation.

## Scaled database passed

The fixture adds **400,000 synthetic records**: 250,000 expired unpaid quotes, 50,000 Workspace documents and 100,000 sessions. These are capacity fixtures, not claimed historical paid runs. Database size was **466.8 MB**. Thirty owner API reads had p95 **12.660 ms**; an actual gVisor CPU job then admitted, settled and returned a canonical receipt with exact balance conservation.

A consistent dump and restore matched every fingerprint across **45 tables / 400,254 rows**. Dump/fingerprint preparation took 18.906 seconds, the database restore 10.651 seconds; the compressed dump was 26.23 MB. The restored application retained the newer Workspace write and verified the real fixture receipt. These timings exclude replacement-VPS provisioning, public TLS/DNS cutover and Internet latency.

This exposed two capacity hazards in backup verification: retaining complete table output in Node/Python memory and storing the entire scratch PostgreSQL database in a 512 MiB tmpfs. Node now uses a cursor with 256-row pages; server and hosted Python verifiers spool output to disk and hash 1 MiB chunks. The psql clients also use `FETCH_COUNT=256`: spooling Python stdout alone did not bound libpq result buffering. The first adapted hosted scale run hit the 512 MiB cgroup limit under the dedicated daemonРІР‚в„ўs default gVisor runtime; its failure and OOM event are retained separately. Scratch PostgreSQL uses a labelled disposable disk volume, remains limited to 512 MiB memory, checks 4 GiB free disk and retains timeouts/label-checked cleanup. Archive and dump size caps remain unchanged.

## Operational restore implementations passed

The actual server restore verifier restored all **45 tables / 400,254 rows in 28.503 seconds**. The hosted restore implementation restored the same synthetic data in **87.374 seconds** on the VPS through a local age-encrypted store adapter and the dedicated Docker socket. That daemon defaults to gVisor, which adds overhead compared with the GitHub runnerвЂ™s default Docker runtime. Both ran with 512 MiB database-container limits, networking disabled and no restored mainnet controller. The one-use fixture identity and labelled scratch resources were removed. These are separate from the 10.651-second integrated fixture restore and from the hosted verification of the current real encrypted backup.

## Verification and limits

The focused Linux suites passed **34 server operations tests, 18 cloud operations tests and nine Node cursor/recovery-audit tests**. The final integrated acceptance passed; two earlier harness failures are retained: a fixture route registered after the application's catch-all and an isolated chain time-advance that expired subsequent wall-clock quotes. Both were corrected; neither failure involved production payments. Exact attempted and final sources accompany the evidence.

The financial bridge still requires archival review when more than 2,000 earlier signed settlement journals exist. Monitoring now warns at **1,500 rows** with `SETTLEMENT_HISTORY_REVIEW_DUE`. This work preserves that financial guard; unlimited settlement-history operation still requires a reviewed archival/scaling change. Do not discard raw signed journal provenance to bypass the guard.

The twelve-hour soak remains a separate running acceptance, not a twelve-hour pass. The independent real second-wallet payment-to-distinct-treasury acceptance, independent security audit and a fresh-machine/DNS disaster rehearsal remain separate gates. Evidence and intermediate observations are in [the retained record](evidence/cpu-resilience-20261017/manifest.json); operational commands are in [the runbook](../ops/cpu-launch/README.md).

The final independent GitHub-hosted run **39063729206** succeeded on operations source `4a1eea0b9794b628c37d277163c1339291d18670`. It authenticated and stored the current encrypted snapshot `backup-20261017T194329Z-e5099221` and exact runtime bundle `runtime-ef6436151e2d098c21a46e1512a140e6f0cbf548-7a5e94a011f1a07c`, verified storage readback, and restored the real **45 tables / 24 rows** in 13.737 seconds. The final server monitor is healthy, including the current off-host runtime receipt. The original owner USDC, empty escrow and operator ETH are unchanged. No new mainnet transaction was sent.
