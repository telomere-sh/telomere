# Independent CPU backups and incident delivery

The primary backup/notification path does not use the owner's Windows PC. Production computation, contract roles and the original website are unchanged.

## Installed topology

- The VPS creates an age-encrypted consistent PostgreSQL/configuration/Cyst snapshot hourly. It checks all restored table fingerprints in a disposable, network-isolated database before publishing success.
- The existing monitor checks the controller, RPC, database, financial invariants, stalled jobs, gas, TLS, disk and backup freshness every two minutes. `telomere-mainnet-pager.timer` sends incident and recovery messages to the explicitly bound private Telegram recipient through `@telomere_alert_bot`.
- The private repository `telomere-sh/telomere-ops-backups` runs a GitHub-hosted workflow at minutes 17 and 47. It checks the public HTTPS deployment, accesses the restricted export protocol, copies encrypted snapshots into private release assets, authenticates their age decryption and verifies every file checksum. New uploads are downloaded back from GitHub before acknowledgment.
- A separate 03:07 UTC schedule restores the stored dump into PostgreSQL on the hosted runner, using the production image digest, no network and no application worker. The restored table hashes/counts must match. A manual dispatch can perform the same rehearsal.
- The cloud runner also sends Telegram incidents and recovery messages. It can report a lost VPS/SSH connection independently of that VPS and this PC.

GitHub scheduling can be delayed; this is a periodic external checker, not a two-minute external availability SLA. The two-minute VPS pager covers failures for which the VPS can still send HTTPS. If GitHub stops running while the VPS remains alive, the VPS monitor detects the stale cloud receipt after three hours.

## Storage and key custody

Backup bytes are **private encrypted release assets**, never Git commits, public releases or workflow log attachments. Snapshot retention keeps 24 latest copies and seven older daily copies; runtime bundles stay retained so historical data references remain recoverable. Exported archives are bounded to 512 MiB; crossing this limit raises an error and requires a reviewed capacity increase.

There are two age recipients: the existing owner identity and a separate cloud recovery identity. Only public recipient keys are on the VPS. The cloud identity is a GitHub Actions secret; it also has a DPAPI-protected local recovery copy. Loss or shutdown of the original PC therefore does not prevent the hosted verifier from decrypting and validating future snapshots.

The GitHub-hosted worker handles decrypted bytes only in its private temporary directory, deletes those files after verification, and never starts a restored Telomere controller. Mainnet keys/configuration are not printed or uploaded unencrypted. The private repository's administrators are trusted with recovery capability: access to modify its workflows can grant access to its Actions secrets.

GitHub uses its short-lived repository-scoped `GITHUB_TOKEN`. The account's Desktop credential is used only for initial provisioning and is not installed on the VPS or in the workflow. Standard private-runner usage consumes the account's Actions allowance; no paid spending setting was enabled by this setup. See GitHub's [billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and [release storage limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Restricted server access

The cloud has a separate SSH identity. Its authorized-key entry uses `restrict` plus a fixed `/usr/bin/python3 -I .../export.py` command. It cannot open an interactive shell, use forwarding or request an arbitrary file. The protocol permits only:

1. Reading sanitized backup/monitor metadata.
2. Downloading a strictly named, regular, single-link encrypted archive from the root-owned backup directory.
3. Acknowledging the current snapshot/runtime hashes, with the configured repository identity and cloud run ID.

The known server host key is pinned. Changing the VPS requires independently verifying its new SSH host key and updating `TELOMERE_KNOWN_HOSTS`; do not disable host verification. `cloud.py` also needs its reviewed server address updated if the IP changes.

`cpu-cloud-required.json` makes the monitor use the **cloud** receipt. A fresh Windows copy cannot conceal a failed cloud copy. The previous Windows watcher/startup entry is retired after cloud acceptance; retained PC copies remain an additional manual recovery source.

## Notification behavior

The Telegram recipient is resolved from a fresh private `/start` by the expected username and stored as a numeric chat ID. No unrelated bot webhook is removed. Bot credentials and chat IDs stay in protected server configuration and Actions secrets.

Changed incidents send immediately on the next check, unchanged incidents repeat hourly, and recovery sends once. Failed delivery does not advance deduplication state. The VPS and hosted worker maintain separate delivery state. If GitHub storage/state itself is unavailable, the external worker attempts a bounded fallback notification without claiming delivery success.

## Operations and recovery

On the VPS, inspect `cpu-monitor-status.json`, `cpu-cloud-offhost-status.json` and `cpu-vps-pager-state.json` under `/opt/telomere-mainnet-pilot/private`. Check the backup, monitor and pager timers with `systemctl list-timers 'telomere-mainnet-*'`. Do not print private configuration or bot tokens.

The private repository's Actions page offers:

- **Independent CPU backup and monitoring:** manual verified copy, optional isolated restore, explicit delivery test, and a synthetic SSH outage directed only at a closed loopback port on the hosted runner. The synthetic test does not stop the real VPS or execute wallet transactions. A subsequent normal run must send recovery.
- **Recover owner access to encrypted backups:** create a fresh age identity on a trusted recovery device; supply only its public `age1...` recipient. The hosted job wraps the cloud recovery identity to that recipient and stores only the resulting ciphertext in a private recovery release. Download and decrypt that file on the recovery device, then use the recovered identity to decrypt retained backup assets. This path needs neither the VPS nor the original Windows DPAPI identity.

Perform database recovery offline first, verify `snapshot.json`, Cyst ciphertext and the runtime manifest, and reconcile all on-chain changes since the selected snapshot before starting exactly one production controller. Follow [the main CPU recovery procedure](../cpu-launch/README.md). The hourly snapshot / half-hour transfer schedule is a target, not a guarantee that a selected snapshot is fresh: inspect its actual timestamp and the last successful cloud run.

Source files under this directory are mirrored into the private operations repository as appropriate. Only `export.py`, `pager.py` and pager unit files execute on the VPS. Changes to hosted scripts require updating the private repository; changes to server scripts require deploying those files and making a new verified runtime backup.
