Telomere staging chain state checkpoints.
Installed and validated on Debian 12 on 2026-10-17; all 14 Linux tests passed.

chain-checkpoint.py preserves raw Anvil JSON; it never restores a snapshot and
never requests transaction execution. Only loopback eth_chainId and
eth_getBlockByNumber are allowed. The source is opened without following a
symlink and read twice with matching bytes/device/inode/size/mtime/ctime.
Strict Anvil structure checks and the matching live RPC head before/after reject
partial, changing, stale and unexpected-chain snapshots. Header arrays may be
unsorted; every serialized matching head header field is compared to RPC.

The root-provisioned destination must be owned by telomere and mode0700.
Directory flock prevents concurrent writers without a separate lock file.
last-good.json and previous.json are mode0600, each at most32MiB by default
(hard maximum64MiB). Each replacement uses an exclusive same-directory temporary
file, file fsync, atomic rename and directory fsync. Existing current state stays
in place until its previous copy is durable. An invalid existing current does
not replace the previous generation. Identical snapshots do not rotate.
Only two checkpoint files are retained after success. A killed writer can leave
one bounded .incoming.tmp; the next locked write removes it. No unbounded logs or
snapshot generations are written by the script.

Installation paths:
- root-owned /opt/telomere-pilot/checkpoint-operator/chain-checkpoint.py, mode0644
- root-owned parent /opt/telomere-pilot/checkpoints, mode0755
- /opt/telomere-pilot/checkpoints/staging-chain, owner telomere, mode0700
- new service/timer unit files from this directory; enable only the timer
- new telomere-staging-chain.service.d/20-require-existing-state.conf
  rejects startup with missing/empty/invalid source. It requires no live RPC,
  writes nothing, and does not alter the original chain unit. Install without
  restarting a healthy chain; validate unit syntax before daemon-reload.

The service has After=chain only; it cannot start that chain. Missing source or
checkpoint directory means systemd skips the run; unavailable/wrong/changing
chain or invalid source logs a skipped reason and preserves existing files.
--validate-only failures exit nonzero for the prestart guard.

Recovery remains manual. A valid chain checkpoint alone is not a consistent
PostgreSQL backup. The timer does not quiesce the controller or database, so a
checkpoint can be older than later recorded settlements/jobs. Before restoration
preserve current DB and chain files, compare controller_chain_binding, complete
transaction journal/receipts, contracts and canonical head; reconcile any later
DB rows explicitly. This protects staging chain persistence, not Base mainnet
financial activation, host outage root cause or full disaster recovery.

Tests: python -B test_chain_checkpoint.py
Linux tests exercise actual directory flock, file/directory fsync, rotation,
failure preservation, permissions and bounded file retention in temporary dirs.
On Windows the five POSIX filesystem tests skip; validation, changing reads and
read-only/RPC restrictions still run. A test-only Windows accommodation omits
ctime from stat/fstat comparison because these can report different ctime
semantics. Production Linux code retains the complete comparison; full tests
must run on Linux before installation. Temporary fixtures contain no real keys.
