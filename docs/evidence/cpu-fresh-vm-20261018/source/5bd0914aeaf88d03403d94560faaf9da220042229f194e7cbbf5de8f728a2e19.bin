# Prepare a replacement CPU server

The recovery kit targets Debian 12 / x86_64 with systemd/cgroup v2, Docker 29.8.1, the retained Node 22.23.3 binary, retained gVisor and the exact deployed application. It prepares dependencies and authenticates data/runtime files. It does not switch DNS or start a mainnet controller.

## Preserve recovery material

Download the selected data snapshot and its exact referenced runtime bundle from the private operations repository. Keep the sanitized backup receipt containing both ciphertext SHA-256 values. The runtime bundle must match the snapshot's `runtimeBundle.id` and checksum; choosing the newest unrelated runtime is not sufficient. Obtain an age identity using the existing independent owner-recovery workflow and a fresh trusted recovery-device public recipient. Never place the plaintext identity, decrypted configuration, database or Cyst files in Git.

Also retain this directory's `clean-server-recovery.py`, `restore-rehearsal.py`, `gvisor-runtime.py`, `bootstrap-clean-host.sh` and this runbook, together with `../cpu-cloud/archive_policy.py` and its sibling `cyst-capacity.json` in their original relative layout. After the pending operator update is installed, new runtime backups include the complete gVisor distribution and these tools. The backup does not contain the Debian operating system or Docker images. The install plan lists pinned CPU/PostgreSQL image references: either pull those exact digests or supply separately verified offline image exports, then check the loaded identities. Do not substitute mutable image tags.

## Prepare dependencies on the new host

Review and run `bootstrap-clean-host.sh` only on the replacement host. It exits before package operations if `/opt/telomere-mainnet-pilot` already exists, the architecture is not amd64 or the OS is not Debian 12. It configures Docker's signed official apt repository and pins the Engine/CLI version used on the current VPS. Debian dependencies and containerd are selected from their signed repositories; verify the resulting host inventory before proceeding. The script follows the [official Docker Debian installation procedure](https://docs.docker.com/engine/install/debian/).

Reserve the available UID 995 / GID 993 for `telomere-mainnet` before installing optional packages. The bootstrap now rejects conflicting account IDs before package operations and explicitly installs `kmod` and AppArmor, with noninteractive package configuration. Some Debian cloud images already assign UID 995 to `polkitd`; select a compatible minimal image rather than replacing that account. The clean VM profile checks that both IDs are genuinely free, then creates the service account before installing dependencies.

After checking that both numeric IDs and the account/group name are free, reserve them, then install dependencies:

```sh
groupadd --gid 993 telomere-mainnet
useradd --uid 995 --gid 993 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin telomere-mainnet
bash -n bootstrap-clean-host.sh
bash bootstrap-clean-host.sh
python3 clean-server-recovery.py check-host --require-fresh
```

This prepares dependencies only. The install plan also requires at least 8 GiB free working disk, appropriate CPU/RAM capacity and separate private recovery storage. Verify image availability, network isolation, firewall settings and gVisor compatibility on the replacement host.

## Authenticate and stage the chosen snapshot

Create a root-owned, non-writable-by-others staging parent. Stream the recovery identity from protected recovery tooling into stdin; do not pass it as an argument or print it. The command requires a new absolute target and writes only inside that target:

```sh
python3 clean-server-recovery.py stage \
  --receipt /root/recovery/backup-receipt.json \
  --data /root/recovery/selected-data.tar.age \
  --runtime /root/recovery/exact-runtime.tar.age \
  --target /root/recovery/verified-stage
```

Both ciphertext hashes, authenticated age decryption, bounded regular-file archive members, every manifest file, the snapshot/runtime binding and all reviewed application pins are checked. The output contains `verified-stage.json` and `install-plan.json`. Files remain private; no restored executable is run and no original filesystem destination is overwritten. Failed staging is retained privately for diagnosis and is never an activation candidate. Use a new directory for another attempt.

## Execute the generated plan in order

The plan binds release paths, binaries, website, operator files, private configuration, Cyst files, systemd units and image digests. Place files with their required modes and ownership. Create the exact immutable release/app alias and writable data layout. Restore the retained dedicated Docker/network configuration and inspect its units' dependency graph. Keep the controller and timers disabled while recovering.

Install the complete authenticated gVisor distribution, including `gvisor-bin/gvisor_sentry`; `runsc --version` alone does not prove CPU execution works. The retained release uses STRICT sidecars. New backup code records `binaries/runsc` and every additional distribution file under `binaries/gvisor/`, with file hashes. After authenticated staging, the helper installs that layout:

```sh
python3 -c "import runpy; from pathlib import Path; runpy.run_path('gvisor-runtime.py')['install'](Path('/root/recovery/verified-stage/runtime'))"
```

Older runtime bundles contain only `runsc`. Keep their original snapshot/runtime binding intact. Before activation, obtain a separately trusted complete distribution matching the retained runsc SHA-256; verify every supplemental file and preserve its provenance. The clean VM test uses such a supplemental public-executable medium frozen from the current source host. It is a separate recovery prerequisite, not a claim that missing files were present in the original encrypted archive. Generate and independently verify a new complete runtime/data backup pair after deploying the pending backup fix.

First restore `data/database.dump` into a scratch, network-disabled PostgreSQL container with no application worker. Use the existing restore verifier to compare every `snapshot.json` table fingerprint and Cyst ciphertext. Restoring onto the replacement host must also preserve the original raw transaction journal and signed archive checkpoints. The staging command verifies backup contents; it does not itself perform this PostgreSQL restore.

Fence the old mainnet controller and signer before enabling a replacement. Perform the read-only asset/role/chain checks and the chain-cursor recovery audit from the main runbook. Reconcile every post-snapshot reservation and settlement, canonical receipts, nonce floor, native USDC and balances. An old backup must never cause an invented execution result or a new settlement for an already mined original transaction.

Update the restricted cloud-export SSH public key, independently verify the replacement's SSH host key and update the hosted known-host pin/server address. Obtain public TLS certificates on the new host, validate nginx and authenticated HTTPS, and verify independent encrypted backups, restore and Telegram delivery. Enable exactly one reconciled controller, complete owner-approved financial acceptance, then enable operational timers and switch DNS.

The existing same-host rehearsal checks restored data/API/runtime/proxy. A separate full guest profile now builds a minimal Debian 12 root filesystem from signed repository packages, boots its own kernel/systemd under QEMU TCG, installs dependencies and pinned images, then boots without any external NIC before receiving the age identity once over virtio serial. It authenticates the actual data/runtime pair, restores every table and reads the original owner records without a mainnet worker. The archived application separately executes a generated-wallet paid CPU lifecycle on loopback chain 31337, through a systemd acceptance service and private TLS proxy. Original release files remain pinned; production units involving money stay masked.

`fresh-vm-image.py <private/fresh-vm-16hex>` runs in a private mount namespace and writes only the selected fixture directory; QEMU/debootstrap tooling is downloaded and extracted privately, without host package installation. `fresh-vm-acceptance.py run <same-directory>` starts the two guest boots. A separate protected process streams the recovery identity to `fresh-vm-acceptance.py deliver-key <same-directory>` after the offline guest requests it. The acceptance launcher freezes media from the existing source VPS; actual disaster recovery still uses the independent off-host media and ordered procedure above. Writable guest disks and decrypted staging are removed after acceptance. No original mainnet service, host network, TLS certificate or DNS record is changed. See the dated [clean VM recovery record](../../docs/CPU-FRESH-VM-RECOVERY-20261018.md) for measured timings, setup corrections and retained evidence.

This profile uses a freshly built OS and dedicated guest kernel, with kernel/initrd supplied by QEMU. It measures the application/data/service recovery workflow on the existing physical VPS. Provisioning another hosting account/VPS, installing a bootloader, obtaining a public certificate, independent cloud transport and switching DNS remain distinct cutover steps. Its emulated timing is not a native VPS performance guarantee.
