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

Every successful backup first restores its database dump into an isolated, temporary PostgreSQL container using the production image digest, `--network none`, and no application process. All restored table fingerprints and row counts must match. Failure prevents publication of a new successful backup status. The plaintext staging directory is removed on completion.

Data and private configuration are encrypted with age X25519 before retention. The separate encrypted runtime bundle contains the exact app release, public website, operator code, systemd units, Node and runsc binaries. All 749 production runtime pins are checked before archiving. Data manifests bind the bundle ID and checksum. Do not remove an older runtime bundle while retained data snapshots reference it.

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

## Disposable acceptance

```sh
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py load
python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/launch-acceptance.py recovery
```

The launcher checks the frozen production pins and passes only the CPU image and dedicated Docker socket. Tests use generated keys, new contracts on loopback Anvil chain 31337 and separate scratch databases. The load harness uses the production PostgreSQL image and real gVisor CPU tasks. It never receives the mainnet signer or production database URL. Resource limits bound the transient unit; container labels restrict cleanup to the acceptance namespace. Never replace the acceptance Docker wrapper with a global cleanup command.

The recovery suite injects SIGKILL during computation and between journal persistence and settlement broadcast, verifies byte-identical recovery and no duplicate charge, and exercises the timeout refund. Its PGlite parent/child harness needs a 3 GiB memory limit; the initial 1 GiB test limit caused an isolated test OOM and was corrected. The live controller keeps its existing 768 MiB limit.

See the dated launch record in `docs/CPU-LAUNCH-READINESS-20261017.md` and its retained evidence for measured results and remaining external acceptance.
