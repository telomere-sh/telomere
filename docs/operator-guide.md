# Operator diagnostics and private staging recovery

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

The current VPS installation uses a disposable EVM on chain 31337, a mock token, an isolated PostgreSQL container, and Docker CPU cells. The controller is `telomere-staging.service`; its chain is `telomere-staging-chain.service`. The API, chain and database bind to loopback ports 13280, 18547 and 15434. These procedures select only Telomere resources.

## Read-only status

Run from `/opt/telomere-pilot/app` using the installed Node runtime:

```sh
/opt/node-v22.23.3-linux-x64/bin/node --import=./node_modules/tsx/dist/loader.mjs scripts/operator-status.ts \
  --env-file /opt/telomere-pilot/config/staging.env
```

The command validates the same mode/network restrictions as the controller, derives the configured operator's public address in memory, and checks the actual RPC chain, escrow token, quote signer, receipt signer and six token decimals. It reports the configured owner allowlist, CPU image digest, provider verification mode, local provider readiness, operator gas balance and latest/pending nonce. Local readiness performs no provider request or subprocess, and cannot replace live attestation admission. An optional `--api-url http://127.0.0.1:13280` chooses the health endpoint; it accepts an origin without embedded credentials.

For PostgreSQL, diagnostics open one fresh connection and a repeatable-read, read-only transaction. They observe the controller advisory lock, aggregate status counts and oldest queued timestamp, then inspect at most 25 actionable transaction journal entries and 25 reconciliation entries. They never call `openStore`, acquire its lock, run migrations, write jobs, broadcast stored bytes or sign anything. The PGlite path is deliberately left closed; use its running API instead of opening a second controller against its directory.

JSON output omits database/RPC credentials, private keys, session cookies, prompts, outputs, provider credentials and raw signed transactions. Error output exposes a stable phase code, without dumping the underlying exception. Exit code 1 means a check failed, the controller or lock is unavailable, or a selected run needs review. Counts and RPC observations are a snapshot, not a finality guarantee. A healthy worker may be `idle` or `running`; health alone does not prove that every financial or provider outcome is settled.

`receipt_pending` means the CPU/provider outcome is durably known but its signed receipt could not yet be prepared or stored. The worker retries only receipt construction after a ten-second cooldown, then uses the existing settlement journal. It never repeats CPU work or a paid provider dispatch. Diagnostics include up to 25 pending run IDs and their intended outcomes, and return exit code 1 while receipts remain pending. `RECEIPT_RECOVERY_REQUIRED` denotes invalid stored evidence requiring review; `PROVIDER_OUTCOME_UNKNOWN` remains reserved for an ambiguous dispatch whose successful result was not durably stored.

Retries rotate through eligible receipts and settlements rather than repeatedly favoring the oldest failure. External refund checks visit up to 20 reconciliation rows per iteration with independent read-only RPC results, and run before new queued work. Database timestamp cursors preserve microseconds and wrap at the end. A service stop leaves unclaimed work queued; a stop racing with an already committed claim passes an aborted CPU signal, preserves a zero-charge cancellation receipt and lets a restarted controller settle it.

| Diagnostic | Meaning and required review |
|---|---|
| `settlement_rejected` | The exact journal transaction has a canonical mined revert. Review its settlement and current contract state. A consumed nonce does not make an invalid charge correct. |
| `unresolved_transaction_nonce` | The signed transaction's nonce has not been observed consumed on the canonical chain. Preserve its bytes and journal; investigate RPC/history. |
| `external_refund_unresolved_nonce` | The run was refunded, while an earlier signed transaction nonce remains unresolved. New transactions from that signer remain blocked. |
| `nonce_consumed_receipt_unknown` | Chain nonce advanced but the exact transaction receipt is unavailable. Find the canonical transaction using that nonce before concluding a settlement succeeded. |
| `noncanonical_receipt` | The receipt's block hash no longer matches the canonical block. Review history before reconciliation. |
| `settlement_state_mismatch` | A reported successful receipt does not agree with a settled run. Review its events and escrow state. |
| `legacy_nonce_unknown` | The nonce could not be recovered from the persisted transaction. Preserve evidence and review before changing signer state. |
| `PROVIDER_OUTCOME_UNKNOWN` in reconciliation | A provider POST may have occurred without a durably accepted outcome. Never repeat it automatically or invent a zero provider charge. |

The status command performs none of the payment or reconciliation actions above. It does not reprice a settlement, change signer nonce, cancel a pending transaction, or generate a replacement owner wallet.

## Consistent private staging backup

Anvil state and PostgreSQL must describe the same stopped staging instance. Copying only the database, regenerating a profile, or taking the chain file while Anvil is running can break that relationship. The capture command therefore requires both dedicated staging services to be loaded and inactive, and no containers with `telomere.managed=true`, including stopped leftovers. It does not stop or start services itself.

Run the following during an operator-controlled staging maintenance window:

```sh
systemctl stop telomere-staging.service
systemctl stop telomere-staging-chain.service
cd /opt/telomere-pilot/app
/opt/node-v22.23.3-linux-x64/bin/node --import=./node_modules/tsx/dist/loader.mjs scripts/backup-staging.ts
```

The command verifies the exact private profile selects the loopback staging chain and dedicated database. It uses `pg_dump --format=custom --no-owner --no-acl` inside `telomere-staging-postgres`, captures `/opt/telomere-pilot/data/chain.json` and the matching `/opt/telomere-pilot/config/staging.env`, and rechecks the stopped services and absence of cells before producing a complete manifest. PostgreSQL stays running so `pg_dump` can take its consistent snapshot. No existing database, service configuration, signer, or payment is modified by capture.

Each new capture resides in `/opt/telomere-pilot/backups/<UTC timestamp>` with directory mode 0700 and files mode 0600. A custom `--output` must remain under that private backup root or an ignored `.local` directory. The command refuses a pre-existing capture directory and any directory symlink. `profile.env` contains test-only private keys and database credentials: keep the entire capture private and out of Git, screenshots, reports and public artifacts. A missing manifest means capture did not complete; keep the partial directory for inspection and create a new directory for a retry.

Validate the reported directory before starting services:

```sh
/opt/node-v22.23.3-linux-x64/bin/node --import=./node_modules/tsx/dist/loader.mjs scripts/verify-backup.ts \
  --directory /opt/telomere-pilot/backups/<UTC timestamp>
systemctl start telomere-staging-chain.service
systemctl start telomere-staging.service
```

Verification checks every file's SHA-256 and size, private permissions on Linux, safe filenames, PostgreSQL archive header, parseable chain JSON, and profile/manifest agreement for the network and public contract/account identities. It is read-only and does not restore data. Header/checksum validation is not a complete PostgreSQL restore exercise. To inspect the archive table of contents without changing its database, on the VPS run:

```sh
docker exec -i telomere-staging-postgres pg_restore --list < /opt/telomere-pilot/backups/<UTC timestamp>/database.dump > /dev/null
```

After restart, run diagnostics and the existing acceptance comparison:

```sh
/opt/node-v22.23.3-linux-x64/bin/node --import=./node_modules/tsx/dist/loader.mjs scripts/operator-status.ts \
  --env-file /opt/telomere-pilot/config/staging.env
/opt/node-v22.23.3-linux-x64/bin/node --import=./node_modules/tsx/dist/loader.mjs scripts/staging-smoke.ts --recover
```

The recovery comparison checks the previously accepted run, identical receipt/settlement, valid signature and on-chain anchor. It is useful evidence that a restart preserved state; it does not by itself exercise a database restore.

## Restore and rollback review

A restore must preserve a complete matching set: PostgreSQL archive, Anvil chain state and profile, plus the v2 ciphertext snapshot when Cysts are enabled. `docs/cyst-backup.md` describes the 128 MiB / 4096 blob capture limit and read-only completeness checks; client recovery keys are never backed up by the server. Keep the current set as a separately verified backup before replacing anything. Restore first into a separate isolated scratch PostgreSQL database/container and a separate Anvil directory, with loopback-only ports and no active Telomere controller. Use `pg_restore --exit-on-error --no-owner --no-acl` into the empty scratch database, restore its matching chain file, and compare contract addresses, signer roles, run states and accepted receipt anchors. Do not run inference or send new transactions during this check.

The historical three-file restore exercise passed before Cysts were enabled; see `restore-acceptance.md` and its public JSON report. The current four-file v2 backup also passed an isolated PostgreSQL/EVM/ciphertext restore, including checkpoint metadata, quotas, download hashes and the existing receipt/settlement. See `cysts-restore-acceptance.json`; TypeScript and Python separately decrypted the existing checkpoint locally after the live service restart. `scripts/restore-acceptance.ts --directory <verified private backup>` automates scratch creation, restore, signature/anchor/event/journal/checkpoint checks and labelled scratch cleanup without starting a controller or modifying live staging.

Only after that comparison should an operator switch a stopped staging instance to the verified matching set. Do not overwrite only one component or leave the old controller connected to the restored database. Restart the chain first, then exactly one controller, and repeat the read-only checks. If checks fail, stop both services and select the previous complete verified set; preserve the failed set for analysis.

These Anvil restore instructions apply only to the private staging chain. A Base Sepolia database backup cannot roll back the public chain, consume a nonce, reverse a transaction or cancel a provider charge. For the testnet rollout, restore database evidence and operator configuration separately, then reconcile it against current public chain history before enabling dispatch. The existing unsigned deployment plan remains separate from this tooling; wallet acceptance comes later.
