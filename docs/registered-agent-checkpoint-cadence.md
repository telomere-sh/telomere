# Registered agent checkpoint cadence

`RegisteredAgentCheckpointCadence` is an owner-side Node runtime adapter for an already registered agent. Its `start()` method immediately checks the lifecycle registry and then polls it at most every 30 seconds. For an active run with no pending lifecycle transition, it calls the durable `CystCheckpointCoordinator` when the 15-minute checkpoint is due. Capture happens through the existing `ClientAgentRunner.checkpoint(runId, operationId)` hook; the runner must quiesce application state and persist the exact result by operation ID. The main server authenticates the owner and stores ciphertext only. It never receives the checkpoint recovery key or the vault master key.

```ts
const vault = new CystCheckpointFileVault({ directory: privateVaultDirectory, masterKey });
const cadence = new RegisteredAgentCheckpointCadence({
  owner, agent, applicationSchema: 'my-agent.v1',
  cysts: new CystClient(ownerTransport), vault,
  control: new HttpAgentLifecycleControl(ownerTransport), runner,
  onError: error => ownerLogger.error(error),
});
await cadence.start();
// On owner-daemon shutdown: await cadence.close(); vault.close();
```

Use an owner-controlled `CystCheckpointFileVault` with a separately provisioned 32-byte master key. Keep the master key outside the server and source repository, protect its backups, and close the cadence before closing the vault. `start()` requires an error callback so a background upload or storage failure is visible. `close()` stops future polls and waits for an in-flight operation. Manual `tick()` is also available to an existing owner daemon. The interval may be configured from 1 second to 24 hours for testing or an application-specific policy; the default is 15 minutes.

The adapter derives a distinct 240-bit-hash Cyst schema for each application schema and source run ID. This prevents a pending capture on an old run from being replayed against a different run after a migration or restart. For an unchanged registered run, a restarted adapter reads the same encrypted vault journal and retries its pending operation. Once an encrypted record is durable, a lost HTTP acknowledgment reuses the exact ciphertext, nonce, ID, recovery key and idempotency key. `restoreLatest(runId)` authenticates and returns that run's last completed application bytes to the owner, including after the server database and vault are reopened. It does not execute a restore into a Cell.

The active registration and lifecycle intent are checked before capture. An inactive, killed or transitioning agent is skipped. These checks are not an atomic fence against a concurrent external executor: the owner runner must serialize checkpoint with stop/migrate and enforce its own fencing. A pending capture from an old run remains in that run's private vault scope and requires explicit operator recovery; the adapter does not capture it on the new run. Existing Cyst and vault checkpoint limits still apply. At 96 captures per day, the 512-record limits need a reviewed retention and key-backup policy before long-lived production use.

`tests/registered-agent-checkpoint-cadence.test.ts` uses the actual owner-authenticated Hono agent/Cyst HTTP routes, persistent PGlite, private server ciphertext files and encrypted `CystCheckpointFileVault`. It executes an application counter in a separate Node process, verifies the 15-minute due boundary, loses an actual upload response, reopens both database and vault, retries without recapture, checks another owner's 404, and restores the state. A lifecycle migration changes the registered run; the same adapter starts a fresh cadence for that run while both runs' completed snapshots remain independently restorable. Owner kill blocks further capture. A second test starts a real one-second timer and verifies that `close()` stops it. Focused result: 2/2 passing on Windows.

This supplies an actual timer and durable encrypted **application-state** checkpoint for an owner executor that implements `checkpoint`. The current paid `HostCellRuntime` interface exposes start/sample/stop, not a persistent quiesce/snapshot/restore hook. Therefore this adapter is not automatically attached to a production paid Cell, does not capture its process/filesystem/GPU state, and does not establish cross-host migration or independent-region Cyst durability. Integrating a production Cell requires a host protocol for fenced, idempotent state capture and restore plus an owner-managed key path; this code does not manufacture either capability.
