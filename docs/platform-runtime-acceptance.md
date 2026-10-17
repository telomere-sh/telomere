# Full platform runtime acceptance driver

`scripts/platform-runtime-acceptance.ts` exercises the configured `startPilot` path, actual HTTP through `PlatformRuntimeClient`, and the reviewed existing Host Kit. This differs from the earlier `platform-host-acceptance.ts`, which settles the legacy pilot escrow. The new driver requires the full financial Merkle leaf accepted by `PlatformRunEscrow` before an actual payment is considered settled.

The driver is Linux only. The operator executed it successfully on the reviewed VPS during integration; its safe evidence is stored in [platform-runtime-acceptance.json](platform-runtime-acceptance.json). To reproduce it after reviewing the script, run it from the project checkout with the already installed dependencies:

```sh
node --import tsx scripts/platform-runtime-acceptance.ts
```

The existing Host Kit must already be running at `http://127.0.0.1:13290`, with public host key `0xe11487bd43e613c421f7eaffcb79d97cd8b507f9b16f33d36bcadeebbbc3874c`, private control identity `/opt/telomere-host-runtime/control.pem`, and the exact allowed image:

```text
127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe
```

These are fixed pins. Conflicting corresponding Host Kit environment variables are rejected. The PEM must be a bounded regular file with one link and no group/other permissions. It stays on the VPS and is never included in output. The parent directory `/opt/telomere-host-runtime` must already exist. The script creates a fresh private `platform-runtime-*` directory there; it does not change or restart existing services or daemons.

Each run starts a new Anvil at an automatically allocated loopback port on chain 31337, with generated owner, host operator, legacy signer and platform signer accounts. All token balances come from the local `MockToken` fixture. It deploys its own legacy escrow to satisfy the idle legacy startup path, then a separate platform SignerSet, ReceiptRoot, HostRegistry, FeeRouter and PlatformRunEscrow. The registry/router controller addresses are the predicted platform escrow address. The platform signer differs from the legacy signer. Both possible publication weeks are explicitly scheduled.

The private directory holds its own database, generated signer key file, reviewed runtime configuration and pilot configuration. Configuration is constructed explicitly, without inheriting a database URL, NEAR credentials, Selection configuration or other live settings. `CPU_MODE=demo` applies only to the unused legacy executor; `PLATFORM_RUNTIME_CONFIG` configures the actual Host Kit executor for the platform route. A run requires zero legacy host rows and zero legacy signer transactions.

The acceptance performs the following checks:

1. Register the reviewed host key with 300 local token units of collateral, deposit one local token unit and create a CPU Leash. Request the signed fee-inclusive quote over HTTP, review its exact transaction with the SDK, submit it using the generated owner, verify the atomic host open counter and admit the original transaction through HTTP.
2. Execute the fixed `hash_chain` task with 2,000,000 SHA-256 iterations. Require a successful original result, positive billed time, matching signed gVisor status, terminal cleanup, durable paired host ticks/control acknowledgments and an independent output calculation. Replay the persisted signed meter evidence. The host software observations establish accounting and the reported isolation; they do not establish TEE attestation or a general proof of computation.
3. Only after the original outcome and cleanup exist, advance the disposable chain to a closed receipt hour. The real maintenance loop must publish the root and settle the run. Independently read and verify the published full financial leaf, canonical publication, RPC Merkle inclusion and canonical escrow settlement. A single real run produces a one-leaf tree, so an empty sibling path is valid; the financial leaf and root are still verified onchain.
4. Check the exact host amount, rounded 9% platform fee, refund of the unused reservation, 80/10/5/5 fee buckets, host weekly accrual, pending Leash balance, closed host counter and conservation of actual token balances. Host accrual is checked before its weekly withdrawal; this driver does not advance an extra week or claim the buckets.
5. Stop and restart `startPilot` using byte-identical private configurations and the same database. Let its real maintenance loop run, then require the completed SDK view, balance, original lease, signed host history and two original transaction journal hashes to remain unchanged. There must still be only one run and one lease, with no redispatch.

The script prints one safe JSON report and writes the same report to the new private directory's `acceptance.json`. A failed acceptance returns a bounded stage/code and exit status 1; raw dependency errors are deliberately excluded because they may contain signed transaction data. Generated keys, PEM, session cookie, raw transactions and complete database rows are never reported. The Anvil and disposable controller are stopped on both success and failure; the private directory is preserved for operator diagnosis. The existing Host Kit remains running. No public transaction or paid provider request is made.

A passing report establishes this specific single-host, local-chain, EOA-owner platform path. It does not establish public Robinhood deployment, canonical USDG compatibility, GPU execution, remote host transport, AgentVault payer authorization or production availability. The separate platform selection tests cover the contract-level vault flow.

## Recorded Linux acceptance

All reported financial amounts below are six-decimal token base units; 1,000,000 base units equal one fixture token.

The final integration run recorded at `2026-10-10T09:17:11.044Z` passed the actual configured runtime and SDK HTTP flow on the existing reviewed gVisor host. The SHA-256 task completed with 4 signed host ticks and 4 matching control acknowledgments, producing 9 billable seconds. From the 3,270-unit reservation, the escrow settled 900 units of host work and an 81-unit fee, returned 2,289 units and left the owner's available balance at 999,019 units. The fee buckets were 65 work, 8 treasury, 4 stakers and 4 buy-and-burn units, including integer-rounding remainder in the work bucket.

The earlier successful 8-second run is retained in [platform-runtime-acceptance-first.json](platform-runtime-acceptance-first.json). The later acceptance was repeated after the final quote-limit, signer-readiness and queue-recovery changes. All 19 runtime/contract/integration source files in [platform-runtime-source-sha256.txt](platform-runtime-source-sha256.txt) matched the local workspace byte for byte. Timing-dependent covered seconds differ between runs; each charge is derived from that run's independently replayed signed evidence.

The actual financial root and settlement were verified on the disposable local chain. Atomic host open/close hooks, token conservation, unchanged completed state after restarting the same configuration/database, and no redispatch all passed. The report confirms zero public transactions, zero paid provider requests and shutdown of the disposable controller and Anvil. The existing Host Kit stayed running. This recorded run is integration evidence for the sources used at that time; subsequent runtime changes require another execution of the driver.
