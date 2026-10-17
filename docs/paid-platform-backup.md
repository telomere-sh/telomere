# Paid platform stopped-state restore drill

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`npm run backup:platform --` captures a bounded PostgreSQL archive and a private copy of the single HostKit journal, then fingerprints the complete `public` schema and checks signed transaction, lease, tick, ACK, and Cyst evidence. `npm run restore:platform:verify --` restores the archive and HostKit files into disposable scratch locations, repeats those checks, and audits the signed transaction journal against an archived chain block. Both commands are Linux-only and fail closed. They do not sign or broadcast a transaction.

This is a **stopped-state verification drill**, not a disaster-recovery backup. The archive includes controller PostgreSQL state and the HostKit PGlite journal/key tree, including empty directories. It does **not** copy the paid profile, platform configuration, local large-Cyst shadow, or remote Cyst ciphertext into the backup. Restore verification requires the original private configuration and large-Cyst shadow to remain available and byte-identical, and both independent S3 regions to retain every referenced ciphertext. The manifest says `configurationRecovery: false`, `largeShadowRecovery: false`, `externalCiphertextRequired: true`, and `fullDisasterRecovery: false`. A loss of those sources is outside this drill's recovery claim.

Prerequisites:

- Review the exact paid controller and HostKit systemd unit names and stop **both**. Confirm paid runs, HostKit claims, and paid sessions are complete or reconciled. The commands independently reject active/unresolved journal state.
- Review the Docker socket and isolation mode actually used by HostKit. Pass those exact values as `--docker-socket` and `--host-isolation`; the script checks the `telomere.hostkit`, `telomere.session`, and `telomere.managed` inventories on that daemon and verifies the durable HostKit admission scope/hash against the production derivation. It rejects any container bearing one of those labels, including a malformed label value. These values are operator-supplied pins; the script does not cryptographically bind them to the systemd unit.
- Use one reviewed local HostKit binding. The source PostgreSQL container must publish its `5432/tcp` endpoint **only to `127.0.0.1`**, at the port in `DATABASE_URL`. The backup command runs `pg_dump` inside that container to use its matching PostgreSQL client. Supply a local, already-present immutable PostgreSQL image digest of a compatible major version for the scratch restore; the command does not pull an image.
- The paid profile must contain the matching local PostgreSQL URL, deployment pins, reviewed HostKit key/configuration, two independent small-Cyst S3 destinations, two independent large-Cyst S3 destinations and the local large-Cyst shadow path. Both S3 canaries and every recorded ready ciphertext/part must be readable. The S3 checks use GET only; they do not repair a replica.
- Supply the independently reviewed initial signer nonce for the deployment's paid transaction journal. The RPC must serve the saved historical block, receipts, and nonce queries for the restore audit. Keep the backup under `/opt/telomere-pilot/backups` with private directory permissions. Treat the HostKit key copy as secret material.

Example, with reviewed values substituted before execution:

```sh
npm run backup:platform -- \
  --env-file=/opt/telomere/profile.env \
  --output=/opt/telomere-pilot/backups/paid-2026-10-13 \
  --controller-service=telomere-platform.service \
  --host-service=telomere-host-kit.service \
  --host-directory=/opt/telomere-pilot/host-kit \
  --docker-socket=/var/run/docker.sock \
  --host-isolation=gvisor \
  --postgres-container=<reviewed-postgres-container> \
  --initial-signer-nonce=<reviewed-initial-nonce>

npm run restore:platform:verify -- \
  --directory=/opt/telomere-pilot/backups/paid-2026-10-13 \
  --env-file=/opt/telomere/profile.env \
  --controller-service=telomere-platform.service \
  --host-service=telomere-host-kit.service \
  --docker-socket=/var/run/docker.sock \
  --host-isolation=gvisor \
  --postgres-image=sha256:<reviewed-local-image-digest>
```

The backup command takes a PostgreSQL `REPEATABLE READ READ ONLY` snapshot and pins `pg_dump` to that exported snapshot. It rejects nonterminal paid runs, unresolved HostKit claims, active/unclean sessions, inconsistent signed HostKit evidence, mismatched small-Cyst owner quotas, missing Cyst replicas, a changed chain anchor, or a changed stopped state. The large-Cyst check reads every private local header, manifest, commit proof, and ciphertext part, validates their hashes and configured quotas, and rejects unfinished or unexpected shadow entries before checking both remote copies. The restore command checks file hashes and all database table fingerprints, reopens the scratch HostKit journal, verifies its controller linkage, scans the original local large-Cyst shadow and both remote S3 copies again, and compares the restored signed journal with canonical chain history. Both commands bound table rows, journal rows, file counts, file sizes, and time spent in subprocesses; an inventory beyond those limits fails rather than silently truncating.

Only a successful `paid_isolated_restore_verified` result establishes this narrow acceptance for the captured stopped state. It does not establish restartability of the paid services, recovery from loss of either S3 region, private configuration recovery, large-Cyst shadow recovery, or funded Base Chain behavior. The CLI has unit/integration fixtures; an actual stopped paid-service capture followed by scratch `pg_dump`/`pg_restore` on the deployment host is still required before claiming operational acceptance.
