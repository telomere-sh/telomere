# Paid CPU application-state handoff

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`PaidSessionStateHandoff` is an opt-in owner-side adapter for carrying up to 4,096 bytes of application state from one paid CPU Cell to another. The owner separately obtains, funds and admits both reservations. The adapter neither opens a wallet transaction nor extends a Cell lease. The source and target have different run IDs, and each keeps its own signed meter, settlement and refund.

The owner configures two fixed commands in the reviewed session image: a checkpoint executable and a restore executable. The checkpoint command follows [the paid-session checkpoint contract](paid-session-checkpoint.md). `snapshot(sourceRunId)` uses the existing `CystCheckpointCoordinator` and `PaidSessionCheckpointRunner` with a source-run-specific vault scope. A failed capture or lost upload acknowledgement is resumed with `retryCapture(sourceRunId)`, which reuses the pending operation and its exact durable ciphertext. An uploaded result supplies `operationId` and `checkpoint.id` for the handoff.

```ts
const handoff = new PaidSessionStateHandoff({
  owner, agent, applicationSchema: 'counter.v1',
  client: paidSessionClient, cysts: ownerCystClient,
  vault: ownerPrivateFileVault,
  checkpointArgvPrefix: ['/usr/local/bin/node', '/app/checkpoint.mjs'],
  restoreArgvPrefix: ['/usr/local/bin/node', '/app/restore.mjs'],
});

const captured = await handoff.snapshot(sourceRunId);
if (captured.status !== 'uploaded') throw new Error('Capture was not uploaded');
// The owner then stops/settles the source and separately funds/admits the target.
const restored = await handoff.restore({
  sourceRunId, targetRunId,
  checkpointOperationId: captured.operationId,
  checkpointId: captured.checkpoint.id,
  restoreOperationId: 'restore-counter-001',
});
```

`restore` reads the exact source Cyst record and recovery key from the owner's vault, downloads the uploaded ciphertext, compares the whole envelope, decrypts locally and checks the 4,096-byte bound. Before sending a target command, it durably saves an immutable encrypted binding of owner, agent, application schema, source and target run IDs, capture and restore operation IDs, checkpoint ID, SHA-256 of the state, and SHA-256 of the fixed restore argv prefix. A repeated restore operation with changed values fails before dispatch. The command ID depends on the owner scope and restore operation ID; retries send exactly the same argv and stdin. The paid command API and HostKit's durable journal reject changed input for that ID and replay the original result after a lost response or target Cell cleanup, subject to the platform's retained-history checks. The adapter verifies the returned command hash, clean exit and exact JSON receipt.

The restore executable receives final argv values `sourceRunId`, `targetRunId`, `checkpointOperationId`, `checkpointId`, `restoreOperationId`, `stateSha256`. Its stdin is one JSON object with `protocol: "telomere-paid-app-restore-v1"`, those same values and canonical `stateBase64`. It must validate the values and digest, apply or recover the same operation durably, and print only the same object without `stateBase64` to stdout. An application-specific restore can rebuild a file or process state but must not treat a successful command receipt as proof that a long-running process survived. The fixed argv-prefix hash binds the command specification, **not executable or image bytes**; operators must separately review and pin the target image in the paid reservation.

The 4,096-byte state bound leaves room for base64 and JSON under the paid command's 8 KiB stdin limit. The source checkpoint stdout and target restore stdin contain base64-encoded **plaintext** in the existing host/controller command and event journals. The Cyst server stores encrypted state, but this adapter does not make host-visible application state confidential. Do not use it for secrets until an in-Cell encryption and key-release design is reviewed.

`tests/paid-session-handoff.test.ts` exercises two separately funded local Anvil runs through authenticated platform and Cyst HTTP routes, signed HostKit traffic and a local-process Cell fixture. It tests capture, encrypted upload, the 4 KiB limit, owner-vault reopen, a lost restore response, exact retry without redispatch, changed-binding rejection, application state in the target, two financial receipts and host release. This is a local fixture acceptance; it does not claim a gVisor/Kata run or public Base transaction.
