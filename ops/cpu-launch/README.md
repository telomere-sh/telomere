# CPU mainnet operations

This directory contains the operations layer for the existing Base mainnet USDC CPU service. It does not deploy a new contract, submit owner-wallet transactions, or change the website. Production application code remains the reviewed immutable release. Paths, service names and numeric UID/GID below are specific to this VPS.

## Routine checks

Run as root on the VPS:

```sh
systemctl status telomere-mainnet-pilot telomere-mainnet-rpc --no-pager
systemctl list-timers 'telomere-mainnet-*' --no-pager
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/mainnet-ops.py monitor
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/mainnet-ops.py status
journalctl -u telomere-mainnet-monitor.service -n 20 --no-pager
```

The monitor runs every two minutes. Its private status file is `/opt/telomere-mainnet-pilot/private/cpu-monitor-status.json`. Alerts cover readiness, database/RPC availability, financial row invariants, stalled settlements, reconciliation, queue delay, low operator ETH, disk space, TLS expiry, stale backups and missing verification of the current runtime bundle off the VPS. The server pager delivers Telegram incidents/recovery, and a separate hosted checker covers VPS loss. See [independent cloud operations](../cpu-cloud/README.md).

## Backups

The hourly `telomere-mainnet-backup.timer` runs `mainnet-ops.py backup` without stopping the application. A PostgreSQL repeatable-read exported snapshot binds the dump and table fingerprints. Referenced Cyst ciphertext is copied with size/hash checks; missing ready blobs and symlinks fail the backup. A pending, not-yet-uploaded blob remains pending.

The shared `../cpu-cloud/archive_policy.py` reserves 1024 MiB for Cyst ciphertext, 256 MiB for the dump and separate 16 MiB budgets for snapshot metadata, configuration and other data. Encrypted data archives allow 1536 MiB; reviewed runtime archives keep their separate 512 MiB cap. All data members together allow 1408 MiB and fewer than 50,000 files. A failed capacity check retains the previous successful receipt; oversized encryption output is never published. Restore scratch space must have 8 GiB free; backup service execution is bounded to 30 minutes and 1536 MiB memory. Monitoring warns at 90% of dump/archive capacity and 45,000 files.

The count-aware candidate additionally imports `../cpu-cloud/cyst-capacity.json`: at most 49,000 Cyst references/files and 999 other payload files leave one final slot for the manifest. Controller admission counts pending reservations too, allows an operator to lower its 49,000-record ceiling, and preserves original retries/reads at capacity. The JSON must accompany the Python operator sources and compiled application. `cyst-count-acceptance.py` runs only inside a separately named private candidate clone, using a disposable PostgreSQL database and synthetic encrypted history. It checks concurrent final-slot admission, pending retry and reopen, seals exactly 50,000 members, copies/authenticates/restores the archive, decrypts all 49,000 recovered checkpoints and rejects an additional file without replacing the accepted archive. It does not activate a production application, change its backup receipt or send a mainnet transaction. See [the candidate acceptance](../../docs/CPU-CYST-COUNT-20261018.md) for deployment status and measured results.

`backup-capacity.py` creates a separately labelled disposable PostgreSQL database, fills the frozen Cyst service with 512 real encrypted checkpoints across 32 synthetic owners (exactly 1 GiB), checks the next upload is rejected and an existing checkpoint still decrypts, and adds a large random database fixture. It invokes the actual Cyst copier, database restore verifier and archive producer. The resulting encrypted acceptance archive has no production private configuration and never replaces the production backup receipt. `capacity-restore.py` accepts a recovery identity on stdin and verifies/restores this fixture with the hosted implementation on the VPS, explicitly retaining its local store/socket-adapter provenance. The separate cloud capacity workflow exercises actual restricted SSH and private release upload/readback after publication.

Every successful backup first restores its database dump into an isolated, temporary PostgreSQL container using the production image digest, `--network none`, and no application process. All restored table fingerprints and row counts must match. Failure prevents publication of a new successful backup status. The plaintext staging directory is removed on completion.

Data and private configuration are encrypted with age X25519 before retention. The nginx site, its CSP include and HTTP/ACME configuration are retained together. The separate encrypted runtime bundle contains the exact app release, public website, operator code, systemd units, Node and runsc binaries. Every production runtime pin in the reviewed release manifest is checked before archiving. Data manifests bind the bundle ID and checksum. Do not remove an older runtime bundle while retained data snapshots reference it.

On the VPS, encrypted archives are in `/opt/telomere-mainnet-pilot/backups` with root-only access. Retention keeps the latest 24 data snapshots and one older snapshot for each of seven distinct days. Runtime bundles are retained separately. The recipient is public; the decryption identity is not stored on the VPS.

The private Windows copy lives outside Git:

`C:\Users\Administrator\Documents\Telomere-private-backups\mainnet-cpu`

These are additional manual recovery copies. Primary off-host copies and authenticated verification now run in the private GitHub operations repository with a separate cloud identity. The earlier Windows login watcher is retired after cloud acceptance. An offline PC does not prevent primary backup or paging; the production monitor requires a fresh cloud receipt.

The client verifies ciphertext SHA-256, authenticated age decryption and every archived file checksum before acknowledging the copy. The runtime bundle is also decrypted and verified. Use the installed Python to perform an immediate pull or verify a retained copy:

```powershell
python C:\Users\Administrator\Documents\Telomere-private-backups\mainnet-cpu\offhost.py pull
python C:\Users\Administrator\Documents\Telomere-private-backups\mainnet-cpu\offhost.py verify C:\Users\Administrator\Documents\Telomere-private-backups\mainnet-cpu\backup-<id>.tar.age
```

Keep `identity.dpapi`, Windows recovery credentials and encrypted archives private. DPAPI ties this additional owner identity to the Windows user/device. The separate cloud recovery identity is held in Actions secrets, and a manual recovery workflow can wrap it to a new public age recipient without the original Windows device. No private identity is published unencrypted.

## Recovery procedure

1. Stop the failed production controller before restoring data. Do not run a second controller against the same mainnet escrow or signer. Keep the static website available as appropriate, with compute admission unavailable during recovery.
2. Select a verified data snapshot and its exact runtime bundle from the private cloud releases, or an additional retained local copy. Use the hosted verification/recovery workflow or the existing owner identity. Decrypt only into a private recovery directory. Never put private configuration, transaction journal raw bytes or a decryption key into Git or a public log.
3. Restore the dump into an isolated PostgreSQL container with no network and no Telomere controller. Recompute every table fingerprint using the ordered `to_jsonb(row)::text` query in `mainnet-ops.py restore()`, and compare against `snapshot.json`. Verify Cyst ciphertext checksums and the file manifest. The hourly rehearsal implements this database verification already.
4. For complete VPS loss, rebuild Debian dependencies and the dedicated Docker daemon, recreate UID 995/GID 993, restore the pinned Node/runsc binaries and release layout from the runtime manifest, and obtain the CPU and PostgreSQL images by their reviewed digests. Restore root-only private configuration and ownership, website, nginx and service units. Reissue TLS certificates if needed. Validate paths and permissions before allowing any application process to run. This machine rebuild has no measured automatic recovery time.
5. Before enabling a restored mainnet worker, use read-only RPC checks to confirm chain 8453, native USDC implementation, escrow roles, original transaction hashes, operator nonce and on-chain balances. Reconcile changes after the snapshot against chain receipts/logs and owner transaction hashes. The target schedule is hourly snapshots plus hosted off-site pulls every 30 minutes; provider failures can increase the gap. Check the actual timestamp of the chosen verified snapshot. Never regenerate a settlement or blindly broadcast a journal from a stale snapshot. Reservations absent from the snapshot require explicit reconciliation; the contract's timeout refund remains available to the owner.
6. Run the existing production configuration/activation guards, then start the RPC and exactly one controller. Confirm readiness, inspect reconciliation/settlement states, verify balances and receipts, and run the monitor. Re-enable backup/pager timers and verify the hosted cloud workflow. Do not interpret a database-only rehearsal as proof that an entire VPS was rebuilt.

Rollback of application code must preserve the current database, chain binding and transaction journal. Replacing the live database with an older copy merely to undo a code release can lose newer reservations and settlements.

### Audit a stale database before enabling compute

New snapshots retain `chainCursor`, observed before opening the database snapshot. If RPC is unavailable, the database backup still succeeds with a null cursor; that snapshot requires a separately reviewed canonical starting block. Older snapshots also need that explicit review. The cursor is part of the encrypted, authenticated backup; never accept an arbitrary user-supplied cursor as recovery evidence.

With production compute stopped, a restored scratch database selected explicitly through `TELOMERE_RECOVERY_DATABASE_URL`, and a read-only endpoint selected through `TELOMERE_RECOVERY_RPC_URL`, run:

```sh
node /opt/telomere-mainnet-pilot/operator/cpu-launch/recovery-audit.mjs /private/recovery/snapshot.json
```

The command opens a read-only database transaction and scans canonical `RunOpened` events in pages of at most 1,000 blocks. It checks the snapshot and ending block hashes again, refuses a chain/escrow mismatch or a gap exceeding 10,000 blocks, and reports reservations missing from the restored database. It never creates a wallet client or sends a transaction. Exit 2 requires operator reconciliation; exit 1 means the audit itself failed. An empty missing-reservation report does not replace asset/role/nonce checks, journal reconciliation, receipt verification or the single-controller guard.

An on-chain reservation absent from the snapshot must not be recreated with guessed execution evidence. Keep admission closed while resolving it using verified newer records. If those records are lost, the owner can use the contract's timeout refund. The acceptance fixture verifies that this missing record returns 404, its original reservation remains on-chain, and the owner can recover its full unused reserve. The time-advanced refund probe uses a disposable local-chain branch which is reverted afterwards.

### Bounded queue and settlement history

The reviewed public profile admits at most eight outstanding quotes/runs per owner and 64 globally, with 500 new quote rows per owner per day. It executes one CPU job at a time. A reservation already paid while the queue fills remains available for retry with the same run ID/transaction hash; users must not pay again. Queue capacity is not a claim that 64 CPU jobs execute concurrently. Existing per-IP HTTP rate limits also apply.

The journal archive release removes the 2,000-row preparation limit. Original signed transactions and all jobs/receipts remain in the database and encrypted backups. A partial index separates active records from archived members; this is logical archival, not deletion or moving the only copy off-server. Disk use still grows and the existing backup/dump bounds still apply.

Before signing a new settlement, the bridge serializes nonce selection with a database lock, verifies the signed archive chain and its canonical finalized anchor/nonce floor, and checks every active record in bounded pages. Pending, disputed, refunded or nonfinalized rows remain active. At 128 active records, settlement preparation attempts a batch of at most eight finalized terminal jobs. Each member must match the original signed transaction, saved receipt, canonical settlement event, on-chain terms and exact charge/refund. A locally signed EIP-712 archive checkpoint uses a separate domain from contract settlements; it sends no transaction or USDC. The checkpoint and all membership markers commit together. SQL triggers prohibit changing/deleting original bytes or rewriting/deleting checkpoints.

Startup walks the retained archive in bounded pages. Later settlements check new checkpoints and recheck the head's canonical anchor/nonce floor. Archived retries return the original canonical transaction hash. An unavailable archived receipt or a changed anchor stops reconciliation; it never triggers another archived broadcast. Unarchived retries retain the exact original signed bytes. RPC/finality outages may delay settlement; removing a row limit does not promise unlimited throughput.

The read-only observer checks the signed latest batch, its retained bytes/count and canonical anchor. `SETTLEMENT_ARCHIVE_VERIFICATION_FAILED` pages for a failed check, and `SETTLEMENT_ARCHIVE_BACKLOG` warns at 1,500 active rows. A pre-archive release retains the earlier `SETTLEMENT_HISTORY_REVIEW_DUE` compatibility warning.

For a controlled one-batch maintenance archive, stop the controller first so it releases its exclusive database lock, then run:

```sh
node /opt/telomere-mainnet-pilot/operator/cpu-launch/archive-journal.mjs --archive-finalized
```

The command checks asset/role pins, archives at most eight finalized records, verifies the resulting archive and checks that the signer nonce did not change. Restart exactly one controller and check readiness/monitoring. Automatic archival during normal settlement needs no maintenance downtime. Never delete original rows to speed up an archive. Recovery retains the full chain-cursor and missing-reservation procedure above: archive metadata cannot reconstruct jobs missing from an older snapshot.

The migration is additive and retains every row visible to older code. Rolling code back while preserving the database works within the older release's 2,000-row guard; above that count, that old release stops new settlement preparation. Use an archive-aware compatible release to continue past that count. A rollback must never delete journals or restore an older database to evade the guard.

### Financial archive acceptance

`stage-journal-candidate.py` clones the verified release into a root-owned rehearsal directory and overlays only the five reviewed backend modules and their TypeScript sources. The launcher verifies the candidate's complete runtime pin set and supplies no production keys or database URL:

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py journal --candidate-directory /opt/telomere-mainnet-pilot/rehearsals/journal-<16-hex-id>
```

The fixture mines 2,105 separate local EVM settlements with generated accounts and a distinct treasury. Those historical jobs carry synthetic metering records; they are not 2,105 claimed CPU executions. Anvil keeps bounded historical state snapshots while retaining all tested transaction blocks and receipts. After actual finality, the test kills the archive process inside an uncommitted PostgreSQL membership update, checks complete rollback, archives/reopens/verifies all original bytes and replays old hashes without another signer nonce. It then executes one genuine gVisor CPU job, restores a database dump captured before its settlement broadcast, recovers the original receipt without another CPU execution or transaction, and verifies exact local token conservation. Missing archived RPC receipts and replacement finalized blocks must produce zero broadcasts.

### Extended queue, rollback and scaled-data acceptance

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py resilience
```

This isolated profile funds nine generated local owners, fills 64 paid queue slots, rejects excess quotes/admission with 429, cancels a waiting job, checks API reads during drain, and verifies canonical receipts and per-owner/treasury conservation. It retries the previously paid overflow reservation without a second payment.

Two disposable app clones differ only by a fixture release marker. A representative compatible additive database migration is applied between them. A newer Workspace write, paid job, receipt and signed transaction journal must survive code rollback. This is an A-to-B-to-A rehearsal for compatible additive changes, not certification that an arbitrary future destructive migration can be rolled back.

The stale-copy phase retains a signed settlement journal before broadcast, mines the transaction, restores the older database, and requires recovery of that canonical receipt without another signer nonce. It separately exercises a post-snapshot reservation missing from the database. The scaled phase adds 250,000 expired unpaid historical quote fixtures, 50,000 Workspace documents and 100,000 sessions, then checks HTTP queries, a genuine paid gVisor CPU job, consistent dump/restore and every table's exact fingerprint. Synthetic history rows are not claimed to be real settled payments.

`scale-restore.py http-load-<id>` runs the actual server and hosted restore implementations against the retained synthetic dump. The hosted implementation uses a local one-use age-encrypted fixture and the dedicated Docker socket on the VPS for this capacity exercise; a separate GitHub-hosted run verifies the current real encrypted backup. Both production restore paths now spool table output to disk and hash it in bounded chunks; psql also uses `FETCH_COUNT=256` to avoid buffering the complete result inside its own container. PostgreSQL remains capped at 512 MiB and uses a labelled disposable disk volume rather than placing the entire restored database in memory. Restoration checks at least 8 GiB free disk, retains timeouts and removes only its labelled resources.

## Disposable acceptance

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py load
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py recovery
```

The launcher checks the frozen production pins and passes only the CPU image and dedicated Docker socket. Tests use generated keys, new contracts on loopback Anvil chain 31337 and separate scratch databases. The load harness uses the production PostgreSQL image and real gVisor CPU tasks. It never receives the mainnet signer or production database URL. Resource limits bound the transient unit; container labels restrict cleanup to the acceptance namespace. Never replace the acceptance Docker wrapper with a global cleanup command.

The recovery suite injects SIGKILL during computation and between journal persistence and settlement broadcast, verifies byte-identical recovery and no duplicate charge, and exercises the timeout refund. Its PGlite parent/child harness needs a 3 GiB memory limit; the initial 1 GiB test limit caused an isolated test OOM and was corrected. The live controller keeps its existing 768 MiB limit.

See the dated launch record in `docs/CPU-LAUNCH-READINESS-20261017.md` and its retained evidence for measured results and remaining external acceptance.


## Sustained acceptance

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py soak --duration-seconds 43200
```

This starts a transient systemd unit with 50 generated accounts, a separate PostgreSQL database and chain 31337. The normal profile sends ten Workspace reads per second in concurrent batches, conditional writes, and a genuine gVisor paid CPU job every five minutes. Reads continue during execution. Each job checks its anchored receipt and conservation of the local test tokens. Sessions are renewed every four hours. The accelerated smoke profile uses `--duration-seconds 70 --session-refresh-seconds 30` to exercise renewal without waiting four hours.

Progress is atomically saved once per minute under `data/cpu-launch-acceptance-20261017/soak-<namespace>.json` and in the unit journal. Latency uses fixed histogram buckets and recent request observations are bounded; the harness does not accumulate twelve hours of individual samples. Acceptance requires at least seven Workspace reads/second over the complete duration, zero errors, p95 no higher than two seconds, and reads overlapping a running CPU job. The memory observer compares worker RSS with the production 768 MiB ceiling. These are loopback capacity measurements for one CPU worker.

`ExecStopPost` removes only containers and the volume carrying that acceptance namespace, including after a forced process kill. It does not remove evidence directories. A root-only `private/cpu-soak-watch.json` selects the namespace for the existing two-minute monitor. Failed, invalid or stale observations generate explicit `CPU_SOAK_*` incidents through the existing VPS and independent hosted pagers. Completed and healthy running observations remain quiet. Hosted run reports retain the selected numeric counters. A VPS reboot interrupts the transient test; stale progress is an incident rather than a successful result.

## Concurrent archive soak and history stress

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py journal-soak --duration-seconds 43200
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py journal-stress
```

These profiles pin the physical release directory selected by the root runtime guard. An app-alias change cannot switch the release of an already running profile. They have new systemd units, generated accounts, loopback chains, PostgreSQL containers/volumes and namespace-restricted cleanup. Existing soak units are not stopped or reused.

The archive soak creates 256 genuine local-chain settlements with synthetic metering history before starting its HTTP/CPU workload. Those historical fixtures are dated outside the current daily quote window. The first real CPU settlement triggers the normal automatic eight-row archive batch. The profile then retains every original record while measuring 50 isolated signed users, continuous reads/writes, CPU every five minutes, sessions renewed every four hours, latency and worker memory. The 70-second / 30-second-renewal smoke exercises the same path before a full run.

The large profile creates 10,000 canonical local settlements, archives all but 256, restarts the real API/worker and fills 64 paid slots across eight owners while retaining a ninth owner's overflow reservation. Finality and receipt RPC failures must roll back the attempted archive and retain the already measured CPU result. Losing the acknowledgement after a real forwarded settlement must recover its canonical original hash with exactly one nonce. Complete controller-RPC failure must preserve the paid overflow reservation and Workspace access. Queue drain runs with additional RPC latency and automatic archival; receipts and each owner's balance plus the distinct local treasury must conserve all tokens. A final consistent dump/restore compares every table fingerprint and verifies original signed bytes, startup and replay without another nonce. Historical fixtures are not claimed CPU executions. `journal-stress --soak-seconds 0` selects the 256-history smoke of the same fault/queue path.

The large fixture seeds in FIFO batches of 32 reservations and 32 separately signed settlements per block, checking every successful canonical receipt before inserting its journal row. Batching changes only disposable-chain mining; the 10,000 distinct settlements and all original signed bytes are retained. Finality blocks are mined individually with a bounded test-client deadline. Startup checks both current and peak worker RSS against 768 MiB; queue completion also requires exactly 65 additional settlement nonces. The launcher replaces its Docker wrapper atomically so starting another profile does not truncate a wrapper used by a running soak.

The root watch file keeps its original `namespace` and can add up to eight `additionalNamespaces`. The VPS monitor and independent hosted pager cover failure, stale progress or invalid observations from either run. New hosted reports retain only selected numeric counters and archive totals. Healthy running/completed observations remain quiet. A completed archive soak must also show an actual archived row count above zero.

## External HTTPS and infrastructure failure acceptance

`launch-acceptance.py infrastructure` starts a separate pinned-release fixture with 256 genuine historical local settlements, isolated PostgreSQL and two 16 MiB bounded storage targets. It waits for an external authenticated load result before testing archive lock timeout, backend connection termination, PostgreSQL SIGKILL/restart, actual PostgreSQL tablespace ENOSPC and actual Cyst-filesystem ENOSPC. All failed archive attempts must leave the original journal and checkpoint/membership state unchanged; the recovered archive must retain all 256 records and spend no nonce. Interrupted Cyst upload remains pending and retries with its original key without a second quota reservation.

`infrastructure-control.py expose <namespace> <http-load-directory>` adds only an unpredictable, credential-protected path on `review.telomere.sh` forwarding to the scratch API. Ports, namespaces, owner/mode/size of progress files and work-directory names are validated. nginx overwrites client forwarding headers with the actual remote address. The external `https-load-client.mjs` uses normal trusted TLS, generated wallets and one real client IP, respects authentication limits, checks 50 signed users, 150 reads with concurrency 50, isolated writes/revision conflicts, cookies, Origin/body limits, 429 backpressure, forwarding-header spoof rejection and rate-window recovery. Its access file stays private and is never evidence. Production account records and wallet keys are not used.

The route has an independent 25-minute expiry and namespace-specific root cleanup. `hide` restores the exact prior review configuration and refuses to overwrite a foreign concurrent edit. Cleanup still removes owned fixture resources when review configuration requires manual reconciliation. `--reuse-https-report <retained-result>` permits a fault-only rerun against a separate fixture while explicitly retaining the original HTTPS namespace and separate-fixture provenance; it does not claim the replacement fixture received the external traffic.

## Restore the application from an encrypted snapshot

For replacement-host preparation, see [the clean-server recovery kit](CLEAN-SERVER-RECOVERY.md). It provides a guarded Debian dependency bootstrap, host preflight, authenticated data/runtime staging and an ordered install/cutover plan. Staging is not controller activation or a full-machine recovery rehearsal.

`restore-rehearsal.py` receives an age identity on stdin over the existing SSH channel. The identity is never an argument, environment variable or retained file. It requires a cloud-acknowledged data snapshot and its exact runtime bundle, authenticates both archives, checks every member and all runtime pins, and restores all production database tables in a network-isolated scratch PostgreSQL container. Executable clones stay in a separate root-owned `rehearsals/` tree; the live application UID cannot replace their directories or files. Archived programs, including version and syntax checks, run as UID 995. The root-owned recovery report stays in private/, outside application-writable data/. The TLS proxy accepts only an exact numeric loopback origin from the unprivileged progress record; progress reads use bounded, nonblocking, no-follow file descriptors.

The archived API then reads the actual restored jobs, receipts and Workspace in a new network namespace through a separate scratch PostgreSQL Unix socket. Synthetic local sessions are removed and every original table fingerprint must remain unchanged. No worker starts against that restored production database. A second empty scratch database and loopback chain exercise a complete boot and paid CPU lifecycle using the archived application and Node binary with newly generated keys. A separate loopback TLS nginx loads the retained website/site/CSP configuration with an ephemeral test certificate; HTML bytes, authenticated API routing and private-path denials are checked. The original application files remain byte-identical and the production service, TLS certificates and DNS are not switched.

This rehearses application/data/proxy recovery on the existing Linux host. It does not measure provisioning a replacement VPS, installing the OS/Docker packages, obtaining a public certificate or switching DNS. The complete-machine recovery procedure above still applies. Never start the archived mainnet controller alongside production or enable a signer from an old snapshot before canonical chain reconciliation.

## Interrupted backup recovery

The backup service holds `private/cpu-backup.lock` from stale-attempt recovery through final cleanup. Its private `cpu-backup-work/attempt-<32 hex>` namespace contains plaintext data, runtime packaging and partial age ciphertext. The next lock holder removes abandoned attempts before exporting another snapshot. Recovery checks directory ownership/mode and exact names; it rejects unexpected paths, symlinks at namespace boundaries, foreign Docker labels and an unavailable Docker daemon. It never runs a global container/volume prune. Symlinks inside an owned tree are unlinked by descriptor-safe `rmtree` without following their targets.

Scratch PostgreSQL containers and volumes carry both the attempt identity and a hash of the canonical private root. Recovery includes stopped containers and verifies both labels again before deleting a resource. It removes containers before volumes and preserves the attempt directory if resource cleanup fails, allowing a later retry. Only explicitly selected receipt `.next` files are removed; successful archive/status files remain intact. Legacy `cpu-snapshot-*` or `runtime-snapshot-*` directories from older operators require separately reviewed manual inventory rather than a wildcard deletion.

The service explicitly uses systemd `KillMode=control-group`, a 30-second stop deadline and SIGKILL escalation, so termination includes snapshot/age children. Do not kill only an individual Python PID during operations: use the unit's cgroup. The next timer/manual start performs recovery. Encrypted publication fsyncs the complete ciphertext before rename and its containing directory afterward; JSON receipt publication fsyncs both file and directory. A complete archive published immediately before a crash can remain unacknowledged; the next backup produces a fresh receipt rather than treating an interrupted attempt as successful. A runtime archive missing its identity receipt is regenerated before reuse.

The root-only `backup-crash-acceptance.py controller <candidate-directory>` profile calls the actual backup function with synthetic snapshot/configuration/runtime adapters. It SIGKILLs the disposable worker at deterministic copying, restore creation, encryption and publication barriers, restarts its PID namespace with persistent fixture storage, and authenticates/rehearses each subsequent backup. Source and recovery keys are synthetic and the fixture receives no production profile. `backup-reboot-acceptance.py <candidate-directory>` separately boots an offline QEMU TCG guest on an ext4 disk and forces Linux emergency reboot during age encryption. Its second kernel boot must clean the stale workspace and authenticate the next backup; this narrow disk/crypto fixture complements the real PostgreSQL crash suite. Neither profile reboots the production VPS. See the dated [backup interruption record](../../docs/CPU-BACKUP-CRASH-20261018.md) for the measured scope and retained evidence.
