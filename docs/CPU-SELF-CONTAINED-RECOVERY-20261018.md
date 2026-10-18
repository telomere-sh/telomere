# Self-contained CPU recovery kit, 18 October 2026

The sealed kit recovered the retained production data and immutable application in a fresh offline guest using **only its packaged files and a separately held age identity**. All seven gVisor distribution files came from the authenticated runtime archive. No loose sidecar supplement, original archive, source-host mount or network connection was available to the final guest. Actual gVisor CPU execution, local-token settlement/refund/withdrawal, API isolation, restart and HTTPS acceptance passed. A fully hashed private copy was then retained on the Windows PC, outside Git.

Production services, installed operator/application code, backup receipts, host packages, DNS and TLS were unchanged. No Git publication or mainnet transaction occurred. This is a recovery exercise; mainnet activation/fencing, public TLS and DNS cutover remain explicit operator steps.

## Exact artifact and scope

Trusted outer manifest SHA-256: **`c10288b254ae1ffeed5fee163c3a77a03ed38952f92f6cf5c778bca99310604d`**.

The kit contains **88 manifest-listed files**, totaling **1,382,107,528 bytes (1.287 GiB)**, plus its manifest. It includes:

- A standalone compressed QCOW2 dependency image built from a signature-verified clean Debian 12 OS. Docker 29.8.1, systemd/cgroup v2, age, nginx and the two exact digest-pinned container images are already present.
- The matching `6.1.0-45-amd64` kernel/initrd and boot/image identity settings. QEMU does not load the source host kernel/initrd for the final replay.
- A newly authenticated, mutually bound encrypted data/runtime pair: `backup-20261018T162623Z-812d6863` and `runtime-a75ee7bc44ff9aaa8964023975f0b7147c92fee4-553a1a38e36f2566`.
- Complete gVisor executables, Node, immutable release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4`, website, retained units and updated operator tools inside the runtime archive. All **758 original application pins** remain unchanged.
- An outer recovery tool tree whose **80 files** match their copies inside the authenticated runtime. The outer kit is sealed before replay and verified again afterward.

The application is the frozen deployed source release, with the updated recovery/backup operator tools packaged alongside it. This is not activation of every locally prepared application change. Standard Linux QEMU/e2fs virtualization-host tooling and an independently retained age identity remain prerequisites. The age identity, plaintext production configuration and decrypted database are not distributed as loose kit files. Their archived contents remain encrypted.

The dependency image was captured before the first recovery key was delivered. Independent filesystem inspection confirmed that it had no Telomere app alias, original `mainnet.env`, application data directory, Node binary or gVisor binary. It has no QCOW2 backing file. It supplies a clean OS/dependency baseline, not a clone of the production root filesystem. Image capture/key timestamps and the negative filesystem checks are retained in [the base proof](evidence/cpu-self-contained-20261018/dependency-base-proof.json).

## Construction and final replay

The build VM received the original encrypted pair, source public gVisor files and the frozen operator kit. It had no external NIC when receiving the recovery identity. It authenticated the original pair, retained every original data payload byte and all application pins, embedded the complete gVisor distribution and current operator tools, then encrypted a new runtime and rebound the data manifest to its exact checksum. Authenticated decryption/readback of the new pair passed before export.

This is a **repack of original snapshot `backup-20261018T160112Z-83e2cd3d`**, not a new live database snapshot. The dump, configuration, snapshot metadata and Cyst payload file hashes are byte-identical to that original snapshot. Repacked IDs and the original snapshot ID/hash are retained together. The new kit receipt explicitly says `recoveryKitOnly: true` and `cloudAcknowledged: false`; it does not impersonate a published production/cloud backup receipt.

After construction, the builder guest disk, INPUT disk, source archive copies and loose gVisor supplement tree were removed. A newly created overlay used only the kit's standalone dependency image. Its new INPUT disk contained only the kit's encrypted pair, receipt, verified operator files and boot settings. The two virtual disks, kit kernel/initrd and one acknowledged key channel are the only final VM inputs. No host filesystem sharing or network device was configured. The supervisor's before/after production guards are read-only and supply no files to the guest.

The final guest required `selfContainedKit: true`, rejected a loose supplement and compared its recovery tools against the authenticated runtime before installation. It installed all **7 gVisor files** directly from that runtime. The base contained neither Node nor gVisor, so execution could not succeed by borrowing an already installed runtime.

## Acceptance and timing

| Stage | Observed elapsed time |
| --- | --- |
| Signed clean OS construction | 40.657 seconds (0.68 minutes) |
| Clean guest dependency installation/image pulls, successful baseline reused | 365.118 seconds (6.09 minutes) |
| Offline pair-build boot, encryption, authenticated readback and shutdown | 442.570 seconds (7.38 minutes) |
| Final kit-only recovery boot, acceptance and shutdown | 584.029 seconds (9.73 minutes) |
| Inside final guest: restore and acceptance | 454.823 seconds (7.58 minutes) |
| Successful resumed offline build and final replay | 1038.391 seconds (17.31 minutes) |
| Private PC copy and complete manifest verification | 713.447 seconds (11.89 minutes) |

These are measured QEMU TCG exercise timings on the shared VPS, using two vCPUs, 4 GiB guest RAM and a 32 GiB writable overlay. They are not native VPS provisioning/cutover RTO guarantees.

- Both new archives authenticated; original data-file hashes and all 758 release pins matched.
- PostgreSQL restored **47 tables / 47 rows**. All table counts/hashes matched again after read-only original-owner/job/Workspace API checks. Original Cyst ciphertext files in this source snapshot: **0**.
- Unauthorized access and duplicate-controller startup were rejected. Original monetary units remained masked, original data reads had no IP networking and no application received the original mainnet signer.
- Retained Docker/network units and restored PostgreSQL systemd service started; gVisor stayed the default CPU runtime. No fallback to an ordinary CPU container runtime was used for the task.
- Private HTTPS served byte-matching retained HTML with CSP, enforced API authentication and rejected private/source paths, using a temporary test certificate.
- Two generated local wallet accounts passed Workspace/job isolation. The real gVisor job deposited **1000000**, charged **800** and withdrew **999200** atomic test-token units. The anchored receipt verified, a distinct generated treasury received the exact charge and escrow ended at **0**.
- Application restart preserved sessions, Workspace and the original settlement transaction hash. This financial acceptance used mock tokens on loopback chain **31337**, with zero mainnet transactions and no second human wallet.
- The writable final guest disk, INPUT media, key socket and decrypted staging were removed after successful readback. The sealed kit remained byte-identical and was independently verified again after copying to the PC. No decryption identity is included in that copy.

An initial builder attempt failed with `EXDEV` while using the backup sealer's atomic rename across the root disk and INPUT disk. Production backup code was unchanged: its same-filesystem atomic rename was correct. The corrected builder seals and authenticates both archives on the root filesystem, then copies only the complete verified receipt/ciphertexts to the output medium and fsyncs the exported files/directory. A regression exercises real cross-filesystem export between the host filesystem and `/dev/shm`; another rejects modified ciphertext before export. The failed builder disk was discarded. The successful retry reused only the pre-key clean dependency baseline, and repeated all decryption, repacking and final recovery. Dependency installation/OS construction were not counted as rerun; initial failed source/logs are retained separately.

**141 Linux tests passed:** 112 launch/recovery and 29 cloud/policy cases, including actual POSIX symlink and cross-filesystem checks. The 13 new kit tests cover outer-seal mismatch, missing/modified/extra files, receipt binding, loose supplements, unsafe paths, symlinks, external tool substitution and verified export. Bash bootstrap syntax and Node smoke syntax passed. Exact final frozen sources and raw Linux logs are retained; the final replay executes its driver from the sealed kit itself.

## Private location and replay

Private PC directory: `C:\Users\Administrator\Documents\Telomere-private-backups\mainnet-cpu\self-contained-kit-34a9445b0e564933`. Its binaries/encrypted snapshots are deliberately outside the public repository. The public evidence retains only the exact manifest, sanitized results, hashes, commands and source objects. No backup body or recovery identity is committed.

On a separate compatible Debian 12 virtualization host, install standard QEMU x86/e2fs tooling first. The supplied driver uses `/opt/telomere-mainnet-pilot/private/backup-crash-vm-tools/extracted` as its tool prefix, matching the existing isolated acceptance tooling. An ordinary signed-package installation can be exposed at that prefix by a root-owned link to `/` on that separate host. This is virtualization-host preparation, not a dependency on files from the original VPS. Keep the kit in a separate protected directory and create a fresh root-owned 0700 work directory named `fresh-vm-34a9445b0e564933` under `/opt/telomere-mainnet-pilot/private`; its namespace matches the packaged guest marker.

Verify the externally retained manifest hash before executing kit code. Using a trusted copy of the verifier:

```sh
python3 self-contained-recovery.py verify-kit /root/recovery-kit \
  --manifest-sha256 c10288b254ae1ffeed5fee163c3a77a03ed38952f92f6cf5c778bca99310604d
```

Then run the verified packaged driver:

```sh
python3 -B /root/recovery-kit/operator/cpu-launch/self-contained-recovery.py \
  restore-kit /root/recovery-kit \
  --manifest-sha256 c10288b254ae1ffeed5fee163c3a77a03ed38952f92f6cf5c778bca99310604d \
  --root /opt/telomere-mainnet-pilot/private/fresh-vm-34a9445b0e564933
```

When the offline guest requests its key, a separate protected process streams the independently held identity into the packaged `fresh-vm-acceptance.py deliver-key <same-work-directory>`. Do not place the key in the kit, argv, environment or logs. The standalone replay command retains its private working media for operator inspection; retire that disposable media after acceptance. The recorded integrated `run` profile performed its cleanup automatically.

This replay deliberately does not activate a mainnet controller. Real disaster cutover still requires fencing the old signer, chain reconciliation from the retained snapshot, independent key custody, trusted SSH updates, public TLS/DNS and owner-approved mainnet financial acceptance. The new cloud backup pair has not been published or activated under this task's constraints.

See the [sealed kit manifest](evidence/cpu-self-contained-20261018/kit-manifest.json), [new pair verification](evidence/cpu-self-contained-20261018/pair-build-result.json), [kit-only result](evidence/cpu-self-contained-20261018/result.json), [private copy proof](evidence/cpu-self-contained-20261018/local-copy-proof.json), [source record](evidence/cpu-self-contained-20261018/source-record.json) and [hashed evidence index](evidence/cpu-self-contained-20261018/manifest.json).
