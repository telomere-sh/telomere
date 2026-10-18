# Clean Debian VM recovery acceptance, 18 October 2026

A newly built Debian 12 VM recovered the actual retained encrypted data/runtime pair, compared every PostgreSQL table fingerprint, read the original records through the archived API and passed a separate gVisor CPU lifecycle with generated wallets on loopback chain 31337. The successful offline run used a separately verified complete gVisor executable supplement: the original runtime archive omitted mandatory STRICT sidecars. This prerequisite is explicit below. Production application/operator activation and Git publication were not performed.

## Isolation and retained media

The disposable QEMU TCG guest had **2 vCPUs, 4 GiB RAM and a 32 GiB overlay disk**. A minimal Debian filesystem was built from signature-verified official repository packages; the OS package inventory, image SHA-512 and kernel/initrd SHA-256 values are retained. The guest booted its own Debian `6.1.0-45-amd64` kernel/systemd; QEMU supplied kernel/initrd directly. It did not reuse the source root filesystem or host Docker socket. VM tooling was privately extracted; no source-host package installation or mainnet service replacement occurred.

The first boot reserved genuinely free UID 995/GID 993, installed dependencies through the guarded bootstrap and pulled the exact pinned PostgreSQL/CPU image digests, checking their image IDs. That boot had internet but no recovery key. The offline acceptance reset the overlay to this dependency checkpoint: original data/configuration and gVisor binaries were absent at the start of the restore.

The restore boot had **no external NIC**. A bounded, acknowledged virtio-serial frame carried the age identity from protected recovery tooling. It was never printed, passed in argv/environment or written to an identity file. Authenticated archives were decrypted only inside the root-only disposable guest. The original signer/configuration was retained privately for file recovery, never supplied to an application process. Original monetary units/timers remained masked. Original data API reads ran as UID 995 in a network namespace without IP networking; a separate empty database and generated keys served the CPU test.

The source VPS supplied frozen encrypted artifacts and public runtime-dependency media. This tests full application/data/service restoration in a clean VM, not independent cloud artifact transport or a second hosting provider. A real cutover must still obtain independent media, fence the original signer, reconcile chain state, provision public TLS, update trusted SSH pins and switch DNS. No production key failover or public certificate issuance was executed.

## Measured recovery

| Stage | Observed elapsed time |
| --- | --- |
| Signed minimal OS construction | 182.465 seconds (3.04 minutes) |
| Guest dependency installation and pinned image pulls | 387.664 seconds (6.46 minutes) |
| Successful offline restore boot, verification and shutdown/readback | 599.413 seconds (9.99 minutes) |
| Inside guest: complete restoration and acceptance | 464.925 seconds (7.75 minutes) |

Guest phase breakdown:

| Phase | Observed elapsed time |
| --- | --- |
| keyWaitSeconds | 33.328 seconds (0.56 minutes) |
| archiveAuthenticationSeconds | 105.460 seconds (1.76 minutes) |
| runtimeAndServicesInstallSeconds | 50.531 seconds (0.84 minutes) |
| databaseRestoreAndFingerprintsSeconds | 87.550 seconds (1.46 minutes) |
| restoredDataApiSeconds | 65.718 seconds (1.10 minutes) |
| httpsAndPaidCpuSmokeSeconds | 120.741 seconds (2.01 minutes) |

Key wait is included in the guest time. The successful dependency boot was retained, not rerun or falsely counted as a new clean install on the final retry. The complete exercise from the initial dependency-unit launch, including failed acceptance/diagnosis/operator delays, took 2463.903 seconds (41.07 minutes). OS creation precedes that interval. These are measured TCG exercise timings on a shared physical VPS, not an RTO guarantee for native VPS provisioning or real disaster cutover.

## Restored behavior

- Both encrypted archives authenticated; all **758 application pins** matched release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4` before and after execution.
- PostgreSQL recovered **47 tables and 46 rows**, with every original table count/SHA-256 matching before and after the read-only API exercise. Recovered Cyst files: **0**, with archived hashes checked.
- The archived API read the actual restored owner/job/workspace data; unauthorized requests and duplicate-controller startup were checked. The original mainnet worker stayed disabled.
- Retained dedicated Docker/network units and a separately managed restored PostgreSQL systemd service started successfully. The owned bridge guard preserved the legacy bridge. The acceptance CPU systemd service exited successfully.
- A private nginx HTTPS proxy served byte-matching retained HTML with CSP, rejected private source/configuration paths and enforced unauthenticated API denial. TLS used a temporary test certificate and numeric loopback origin.
- Two generated wallet accounts signed in; Workspace and job isolation passed. These were ephemeral local accounts, not a second human mainnet wallet.
- The archived application deposited **1000000 atomic test-token units**, completed **1 actual gVisor CPU execution**, charged **800**, released the reservation, paid a distinct generated treasury and verified an anchored receipt.
- Application restart preserved the session, Workspace and original settlement transaction hash. Withdrawal returned **999200** atomic test-token units; escrow ended at **0**. Exact token conservation passed.

All financial exercise transactions were on loopback chain **31337**, using a newly deployed mock token/escrow. No Base mainnet transaction was signed or broadcast.

## Findings and fixes

The first official Debian genericcloud image already allocated UID 995 to `polkitd`. The exercise rejected it without deleting or renumbering that account, delivering a key or decrypting data. The final signed minimal OS profile verifies both IDs are free and reserves them before optional package installation. An earlier dependency boot exposed missing `kmod` and failure to initialize Docker nft/NAT support; the final bootstrap explicitly installs kmod and AppArmor with noninteractive package configuration. Earlier setup versions/results are retained separately.

An initial offline boot exposed virtio-serial EOF before the protected sender connected. The reader now waits within a finite deadline, supports fragmented frames and acknowledges delivery. A clean dependency-snapshot reset passed the corrected transport. Unit tests cover delayed EOF, incomplete/disconnected senders and bounded frame sizes.

The next run recovered the database/API/HTTPS but the CPU job failed. A separate offline probe captured the exact cause: `runsc --version` succeeded, but its STRICT `gvisor_sentry` sidecar was absent. The source runtime archive contained only runsc, not the complete distribution. It was never treated as a successful full restore.

`mainnet-ops.py` now captures the entire regular-file gVisor distribution, preserving legacy `binaries/runsc` and hashing additional files under `binaries/gvisor/`. `gvisor-runtime.py` rejects incomplete/writable/symlink sources, verifies supplemental manifests and all members, binds the supplement to the exact retained runsc hash and installs the complete executable layout. The actual successful retry used **7 distribution files** frozen from the source host, including the mandatory sidecar. The original encrypted snapshot/runtime pair was left unchanged; its separately trusted public-executable supplement and provenance are recorded independently.

This backup fix is **local and pending deployment**. Existing encrypted archives have not magically acquired those missing files. After an approved operator update, create and independently verify a fresh complete runtime/data pair; retain the matching supplement for historical archives. The final recovery reran from the clean dependency checkpoint, rather than continuing the partially restored failed guest. No frozen application source or CPU isolation policy was weakened to obtain a pass.

The updated `runtime_bundle()` also ran against the actual immutable source release in a separate private fixture, with only its receipt/output directory redirected. It retained **22194 files** and produced **445,120,197 ciphertext bytes (424.50 MiB)**, below the **512 MiB** runtime archive limit, in 26.634 seconds (0.44 minutes). Production backup receipts and the installed operator tree were untouched. This is an actual packaging/capacity check; it does not claim a newly activated cloud-acknowledged data/runtime pair. Its sanitized harness and result are retained.

## Verification and production boundary

**128 Linux operator tests passed:** 99 launch/recovery and 29 cloud/policy tests. Bash bootstrap syntax and Node smoke-program syntax passed. The integration-frozen kit passed 127 tests; a final regression adds the direct-entry guard before the guest shutdown handler. On an unmarked host, the entry point now rejects execution before any poweroff command. An AST comparison verifies that this single guard call is the only executable change after the integration freeze: all bootstrap, restore, key-transport, CPU and diagnostic function bodies remain identical. The final guard and test run separately; this is not represented as another full VM integration run. Both exact guest versions and test logs are retained in the source record, together with earlier failed-attempt versions, package inventory, console reports and byte/hash evidence.

The source kernel boot ID, live controller PID/start time/restart count, immutable release and all 758 pins remained unchanged. Read-only Base audits retained the two original completed settlements, original journal SHA-256, signer nonce 2 and wallet/operator/escrow balances. No long-running production acceptance unit was stopped. No production operator/application update, DNS/TLS change or Git push occurred.

The successful guest's writable disk, INPUT disk, recovery staging and key socket were deleted after final readback. Recovery identities and decrypted backups are excluded from public evidence/Git. The original immutable OS base contains no original application secrets. Failed fixture cleanup is recorded separately when present.

See the [acceptance result](evidence/cpu-fresh-vm-20261018/acceptance.json), [prior CPU failure and diagnosis](evidence/cpu-fresh-vm-20261018/initial-cpu-failure.json), [exact source record](evidence/cpu-fresh-vm-20261018/source-record.json), [hashed evidence manifest](evidence/cpu-fresh-vm-20261018/manifest.json) and [operator recovery procedure](../ops/cpu-launch/CLEAN-SERVER-RECOVERY.md).
