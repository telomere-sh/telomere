# Paid CPU session application checkpoint bridge

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`PaidSessionCheckpointRunner` is an owner-side `checkpoint(sourceRunId, operationId)` adapter for the existing paid CPU session command API. It runs an application-supplied executable in the **same admitted Cell** as the other commands in that run. The executable can quiesce and export its own application state, for example from an atomic state file or an application IPC endpoint. The adapter does not capture process memory, filesystem contents generally, a GPU context, or a CRIU image.

The owner constructs it with a `PlatformRuntimeClient` or an authorized `PlatformVaultRuntimeClient` and a fixed `argvPrefix` for an executable inside the reviewed session image. It appends `sourceRunId` and `operationId` to that argv. The executable must durably reuse the exact snapshot for the same operation ID if invoked again, then write one UTF-8 JSON object to stdout:

```json
{"protocol":"telomere-paid-app-checkpoint-v1","sourceRunId":"0x<64 lowercase hex digits>","operationId":"cyst-hook-<64 lowercase hex digits>","stateBase64":"<canonical base64 of application bytes>"}
```

The owner runner checks the paid command result, original command hash, exit status, output format, run and operation identity, canonical base64, and a 12,000-byte maximum state. The host has a 16 KiB combined per-command output limit. For a Vault run, only the approved agent wallet may issue the command. Neither the runner nor the Cyst coordinator signs a wallet transaction.

```ts
const runner = new PaidSessionCheckpointRunner({
  client: paidSessionClient,
  argvPrefix: ['/usr/local/bin/node', '/app/checkpoint.mjs'],
});
const coordinator = new CystCheckpointCoordinator({
  owner, agent, applicationSchema: 'my-agent.v1',
  cysts: ownerCystClient,
  vault: ownerPrivateFileVault,
  onCyst: ({ operationId }) => runner.checkpoint(paidRunId, operationId),
});
await coordinator.snapshot('owner_request');
```

The Cyst coordinator first saves a pending operation ID in the owner's durable private vault. The runner derives a stable paid command ID from that ID and the exact run ID. If the command response is lost after execution, `retryPending()` after an owner-daemon restart sends the identical command and Host Kit returns its persisted result without recapturing. A changed executable/argv for that ID conflicts. After Cell cleanup, the controller checks the retained host journal and receipt-bound event history before replaying the result. If that history is missing or uncertain, recovery fails closed. The coordinator then encrypts the application bytes on the owner and uploads only ciphertext to the Cyst endpoint; a lost upload response reuses its saved ciphertext and key.

**Privacy boundary:** the paid session command returns state as base64 in its ordinary stdout. The host and Telomere controller can read and retain that output in the existing command/event journal. Encoding it as base64 does not encrypt it. The Cyst upload is encrypted on the owner after the platform response is received. This bridge is appropriate only for application state whose exposure under the paid-session output contract is acceptable. Private checkpoints require a separately reviewed in-Cell encryption and owner-only key-release design.

**Lifetime boundary:** a paid CPU session lasts at most 120 seconds. A 15-minute periodic checkpoint of one continuously running Cell cannot be implemented with this protocol. Use the bridge for bounded application-state captures during a live paid session or for replay of an already executed capture. A longer Cell lease and fenced application restore protocol are separate work.

`tests/paid-session-checkpoint.test.ts` uses local Anvil contracts, authenticated platform/Cyst HTTP routes, signed Host Kit traffic, a shared Cell filesystem and a private owner file vault. It loses the actual paid-command HTTP response, changes live application state, stops and cleans the Cell, reopens the owner vault, and proves that `retryPending()` returns the original state with no second host capture. It also checks that the Cyst store contains ciphertext while the existing host output journal exposes the base64 state. The fixture uses the local process backend, not gVisor or a public Base deployment.
