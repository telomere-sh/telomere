# Durable application checkpoint coordination

`CystCheckpointCoordinator` connects an application's `onCyst` capture hook to the existing owner-authenticated encrypted Cysts API. It schedules a checkpoint every 15 minutes by default and accepts explicit `owner_request`, `preemption`, `budget_exhaustion` and `metabolism_step_down` events. It saves the original encrypted envelope and recovery key in the caller's private durable vault before uploading ciphertext. A wallet is not involved.

The embedding application calls `tick()` from its own scheduler and calls `snapshot(trigger)` at lifecycle boundaries. There is no hidden timer or background daemon. A first tick durably sets the first due time to now plus the interval. A successful upload schedules the next capture from completion; a long gap causes one capture rather than a catch-up loop. Intervals are bounded to one second through 24 hours, and clock values must be finite safe integer timestamps. The clock and scheduler are responsibilities of the embedding runtime.

```typescript
import { CystCheckpointCoordinator } from '../src/sdk/index.js';

// ownerClient is already authenticated; privateVault implements the durable
// CystCheckpointVault contract for this application's owner/agent/schema scope.
const checkpoints = new CystCheckpointCoordinator({
  owner,
  agent,
  applicationSchema: 'counter.v1',
  cysts: ownerClient.cysts,
  vault: privateVault,
  onCyst: async ({ operationId, trigger }) => captureApplicationState(operationId, trigger),
});

await checkpoints.tick();
// The application's scheduler invokes tick again as time advances.
await checkpoints.snapshot('preemption');
const restoredBytes = await checkpoints.restoreLatest();
```

The hook must quiesce application state when needed and return an owning `Uint8Array` copy of 1 byte through 2 MiB. The coordinator clears that copy after encryption, including error paths. An incomplete durable begin may call the hook again with the same operation ID; the application must make capture idempotent for that ID. Do not recursively await the same coordinator from its hook. Restored bytes are returned to the caller for application-specific validation and use.

## Durable sequence and retries

1. Save one pending operation ID, trigger and start timestamp.
2. Capture application bytes, encrypt locally, and durably save an immutable envelope/recovery-key record for that operation.
3. Read the saved record back, compare exact envelope/key copies, and authenticate the saved key against the ciphertext.
4. Upload that original envelope with the operation ID as its idempotency key.
5. Check ready metadata against the original envelope, then durably save the completed pointer and next due time.

Capture failure, record-write failure, uncertain upload outcome or completion-write failure leaves recoverable pending work. `retryPending()` reuses the original durable operation and, when already prepared, the original envelope, nonce, checkpoint ID and key. It does not recapture or reencrypt after a lost upload acknowledgement. A lost acknowledgement after durable completion is recognized from the completed state without uploading again.

Concurrent work within one coordinator shares a single flight. An explicit request arriving during an idle tick still captures state. Separate coordinators serialize through their common vault boundary. `pause()` persists its state and waits for the current exclusive operation; it blocks future ticks and new explicit snapshots. It cannot undo an upload already in flight. `retryPending()` is explicitly permitted while paused and never creates a new operation. `resume()` preserves the saved cadence.

`restoreLatest()` reads the last completed pointer, obtains its separately saved key, downloads the owner-scoped blob, and compares the entire original encrypted envelope before local AEAD decryption. It does not capture, upload or retry a newer pending checkpoint. Older immutable recovery records remain available until the owner applies a separate retention policy.

## Required client vault

`CystCheckpointVault.exclusive(scope, callback)` is a lock-only boundary. Every participating coordinator and process for that scope must use the same exclusive lock. The callback's journal `save` and `saveCheckpoint` operations must each become atomic and durable before returning, even if a later operation throws; wrapping the whole network operation in a rollback transaction violates this contract.

The optional Node-only `CystCheckpointFileVault` implements this boundary with encrypted private local files, atomic individually synced writes and a cross-process lock. It requires the caller's master key and explicit directory. See [the file-vault guide](cyst-checkpoints-file-vault.md) for recovery, retention and filesystem boundaries; importing it is separate from the browser SDK entry point.

Journal reads return independent objects and fresh owning key arrays. `saveCheckpoint` copies its inputs and retains an immutable, idempotent record by operation ID. The coordinator clears only its temporary key copies; the vault must retain the originals. Keep the vault and its backups private, with suitable OS access controls or local encryption. Never send its recovery keys to the Telomere API. The SDK deliberately requires the application's chosen vault instead of silently storing keys in browser storage or the server database.

The acceptance fixture uses synced private files and atomic rename, reopens the vault from disk, and shares a process-local scoped mutex across fixture instances. This establishes disk durability and same-process serialization in those tests. It does not establish an OS lock between independent processes or supply a production client-vault implementation. JavaScript does not guarantee complete secure memory erasure.

## Validation and boundaries

The focused suite passed **26/26** on Windows with real HTTP, owner-scoped Cysts routes, PGlite, ciphertext files and reopened client-vault files. It covers cadence/events, exact retries after lost upload/vault acknowledgements, persistence failures, concurrent operations, paused recovery, retained historical keys, metadata substitution, corrupt/missing keys, bounds and authenticated owner isolation. Strict TypeScript and browser bundling passed. See `cyst-checkpoints-validation.json`.

This component preserves application bytes. It does not stop or resume a Cell, connect runtime lifecycle events automatically, register a checkpoint onchain, migrate to another host, enforce a 24-hour lease, replicate to independent regions or release keys to an attested enclave. Use the separate checked CystRegistry client for unsigned publication plans. Those product integrations and larger filesystem/process/GPU snapshots remain separate backend work.
