# Backup interruption and kernel reboot acceptance, 18 October 2026

The isolated candidate passed five deterministic backup interruption scenarios and a separate **real Linux emergency kernel reboot during encryption**. Every subsequent backup completed, authenticated its archive and recovered the tested payload. The last successful receipt/archive survived each interruption. Changes are prepared locally for review; production application/operator activation and Git publication were not performed.

## Recovery implementation

`mainnet-ops.py` now holds the exclusive backup lock while recovering abandoned work, taking the next snapshot and cleaning up. Plaintext data, runtime packaging and partial age output live under a root-only `private/cpu-backup-work/attempt-<32 hex>` directory. Recovery validates canonical paths, directory ownership and restrictive permissions before deletion. A concurrent backup fails the lock without touching an active attempt.

Scratch PostgreSQL containers and volumes carry the attempt ID and the hash of its canonical private root. Cleanup selects and rechecks both labels, includes stopped containers, removes containers before volumes and preserves the workspace for retry if Docker is unavailable or labels differ. Descriptor-safe recursive deletion unlinks inner symlinks without traversing their targets; unknown names or symlinks at the workspace boundary stop recovery. Legacy directories from older backup versions are intentionally outside this automatic cleanup namespace.

The encrypted file is fsynced before atomic rename and its destination directory is fsynced afterward. JSON receipt publication also fsyncs the file and directory; no-follow, nonblocking descriptors reject symlinks, FIFOs and hardlinks before truncating existing scratch files. Recovery removes only explicitly selected unfinished receipt files. A fully published data archive interrupted before receipt publication stays unacknowledged and intact; a later run creates a fresh backup. A runtime archive without its identity receipt is regenerated before reuse. The service explicitly sets `KillMode=control-group`, `TimeoutStopSec=30` and SIGKILL escalation to cover age/exporter children.

## Full backup process interruptions

Candidate `backup-crash-candidate-a042e7e04e7d4268` ran the actual `backup()` function inside a disposable, network-disabled worker container. Adapters supplied a separately exported PostgreSQL snapshot/dump target, synthetic private configuration and synthetic runtime payload. Production profiles, database credentials and signers were never supplied. Deterministic barriers interrupt real copying, PostgreSQL restore creation, age encryption or publication rather than relying on timing guesses.

The source PostgreSQL database held one table with **100 rows**. The filesystem held **64 synthetic ciphertext files totaling 16 MiB**. This is a backup/recovery fixture, not a claim of 64 SDK-encrypted application checkpoint decryptions. The normal Cyst copier checked original file sizes and SHA-256 values. The original exported PostgreSQL snapshot remained valid through the real dump. Scratch PostgreSQL used a labelled disk volume, 512 MiB cap and no network.

| Barrier | Actual interruption | Required next-run result |
| --- | --- | --- |
| First Cyst copied while exported snapshot remains open | Worker container SIGKILL | Remove abandoned plaintext; complete a fresh backup |
| Scratch restore container/volume created | Worker container SIGKILL | Remove labelled orphan container/volume before the next backup |
| Runtime age process holds incomplete ciphertext | Worker container SIGKILL | Remove partial runtime ciphertext and temporary packaging |
| Complete data archive renamed, receipt not yet written | Worker container SIGKILL | Preserve prior receipt/archive and the unacknowledged complete archive; publish a fresh successful backup |
| Data age process holds incomplete ciphertext | Immediate restart of the disposable worker PID namespace | Reclaim stale attempt and partial file on persistent fixture storage |

Both interrupted age processes were alive with **983,464 bytes** of partial output at their barriers. SIGKILL cases exited with code 137 and restarted in new worker instances. The last successful receipt stayed byte-identical before restart; its archive checksum stayed unchanged after recovery. All five subsequent backups authenticated age decryption, validated manifest/member hashes and recovered every Cyst file. Each backup's own rehearsal restored all 100 PostgreSQL rows, and a second restore from the authenticated recovered dump independently matched the table fingerprint. No abandoned exported-snapshot transaction remained. The complete five-case fixture, including its baseline backup, took **48.405 seconds**.

## Actual emergency kernel reboot

A separate QEMU TCG guest booted Debian kernel `6.1.0-45-amd64` with **one vCPU, 512 MiB RAM and one disposable 384 MiB ext4 disk**. It had no network, Docker daemon, production hardware passthrough, application profile or mainnet signer. Debian QEMU packages were downloaded and extracted into private fixture tooling; host packages/services were not installed or activated.

The first boot created a successful baseline backup with the production workspace/sealer/publication functions. A second attempt created plaintext and ran actual age encryption through a bounded stdin prefix. After persisting the interruption record and partial file, the guest invoked Linux **emergency SysRq `b`**. This resets the kernel without orderly process shutdown or Python cleanup. The console then recorded ext4 **journal recovery** on the second boot.

The two guest boot IDs differed (`e66f73ef-5d0c-4455-97b6-d5ea0dfa5bcb` and `d95e4743-c5f0-4dcb-be85-394e0483f9db`). The second boot found the abandoned plaintext and `.partial`, verified the previous successful receipt/archive, removed the stale workspace on the next backup and created/authenticated a new **5,254,600-byte** archive. Both recovered payload files matched their source hashes. The guest powered down successfully; the complete VM preparation/boot/reboot/readback took **72.246 seconds**.

This guest is a focused filesystem/crypto recovery exercise: its `database.dump` is a 4 MiB synthetic binary payload, its checkpoint is a 1 MiB synthetic blob and Docker inventory is an explicitly empty adapter. Real PostgreSQL dump/restore and orphan-container cleanup are covered by the full backup process suite above. The guest's 8 GiB production free-space prerequisite is outside this narrow fixture. Emergency kernel reboot is also distinct from a physical host/storage power cut; no physical storage power-loss claim is made.

The host kernel boot ID stayed unchanged and the production VPS was never rebooted. The guest disk, unpacked root filesystem, generated recovery identity, plaintext trees and fixture containers/volumes were removed. Synthetic encrypted archives and sanitized reports remain in private candidate storage; encrypted archive bodies and disposable keys are excluded from Git.

An additional fixture assertion initially demanded that the interrupted, unpublished plaintext retain its original checksum after emergency reboot. That assertion failed: dirty scratch data can be torn even when the successful published backup is durable. The final fixture instead requires that the leftover plaintext and partial ciphertext exist, records whether the plaintext hash survived, discards the entire interrupted attempt and verifies a fresh backup against the original source. The failed assertion's exact source/console and the initial successful smoke are retained separately. Production recovery code did not change in response; it already discards abandoned workspace contents rather than resuming from them.

The final run actually observed a changed interrupted plaintext hash and still passed cleanup and fresh authenticated readback. No bytes from the interrupted attempt were reused.

## Verification and local publication boundary

- **103 Linux operator tests passed**: 74 launch/recovery and 29 cloud/policy tests. The 17 new cases cover lock contention, stale recovery, symlink/hardlink/FIFO boundaries, Docker failure, stopped-resource cleanup, label mismatches, exception cleanup and failed fsync publication.
- All **758 production runtime pins** still matched immutable release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4`.
- The production controller remained active with PID 521970, zero restarts and its original start time on 17 October. Test units finished successfully and no fixture container/volume remained.
- The read-only Base audit retained the original two completed settlements, journal SHA-256 `d26dcd891a949f492e0457fb8bc94f06ded34993caf1724dc27389098143593e`, signer nonce **2**, operator balance **98,462,564,567,330 wei**, owner balance **2.422567 USDC** and empty escrow. No transaction was broadcast.
- No Git push, private cloud source publication, production operator replacement or application activation occurred. Deployment must carry the matched `archive_policy.py` and sibling `cyst-capacity.json` already prepared by the earlier capacity/count work; updating this local checkout alone does not activate server recovery behavior.

See the [hashed evidence manifest](evidence/cpu-backup-crash-20261018/manifest.json), [five-case process acceptance](evidence/cpu-backup-crash-20261018/acceptance.json), [kernel reboot proof](evidence/cpu-backup-crash-20261018/kernel-reboot.json), [exact source record](evidence/cpu-backup-crash-20261018/source-record.json) and [operator procedure](../ops/cpu-launch/README.md).
