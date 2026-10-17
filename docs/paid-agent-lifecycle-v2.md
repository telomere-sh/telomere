# Owner-side paid CPU lifecycle v2

`PaidAgentLifecycleRunnerV2` implements full, lean and torpor migration/rollover, sleep, wake and owner kill over separately approved and admitted CPU sessions. It never creates a quote, funds a target or embeds a signing key. The original v1 runner and its encrypted records retain their existing protocol and behavior.

The constructor receives the immutable `intentId`, `kind`, `targetMode`, nullable source/target run IDs, reviewed image digest, application schema, read-only chain client, lifecycle control, paid-session client, durable private `PaidLifecycleClientVault` and an external wallet stop port. A `PaidAgentLifeline` runner factory can reconstruct this class for each original intent after restart; the owner-side loop handles checkpointing and encrypted state transfer through the existing coordinator.

Every phase rechecks the original owner, agent, Vault, Leash, paid-session mode and controller intent. The private journal binds deployment pins, original canonical `payRun` tuple and admission transaction, quote hash, guest command recipes and each controller-signed lease. Signed resource profiles are reconstructed into the financial workload hash. Changing full/lean/torpor requires a different matching reservation; `profile()` accepts only a no-op matching the already admitted quota. It cannot modify a guest quota or a signed price in place.

Before an external stop submission the runner checks the exact chain, Vault address, zero value and `requestStop(originalRunId)` calldata. A distinct private journal scope serializes reconciliation across participating processes. A durable attempt marker precedes the wallet call; a lost response is recovered through the wallet port's original operation lookup. An unresolved attempt is never submitted again. Canonical transaction, sender, block, stop event and historical source reservation are checked; the default confirmation requirement is 12, with an explicit one-confirmation setting used only by isolated local-chain tests.

Restore waits for retained terminal HostKit/controller evidence of cleanup and a final session event. The controller emits that evidence only after the exact host resource has been cleaned up. This is the existing reviewed controller evidence boundary; it is not an independent TEE proof. A migration may reuse the same physical host only after that cleanup check. Sleep records the checkpoint's original source stop proof in the private journal, and a later wake rechecks that proof before using its owner-held recovery key. Missing provenance, changed keys, changed target lease, expired reservation or changed state fails closed.

For a queued session that never reached a host, `cpuDispatch: {state: "never_dispatched", confirmed: true, admissionTx}` is required together with exact canonical full-refund accounting. The controller creates this observation only for audited terminal zero-work records with no original host lease. Zero billed seconds or a missing lease alone is insufficient. A confirmed canonical refund releases the already unexecuted reservation without a second wallet call; unconfirmed outcomes remain pending.

The guest checkpoint recipe receives the source run and operation ID and must durably replay the same application capture. The v2 restore recipe receives:

```text
sourceRunId-or-none targetRunId intentId checkpointId operationId stateSha256 resourceProfile
```

Its stdin contains the `paidLifecycleRestoreV2Schema` receipt plus `stateBase64`; stdout must contain exactly the matching receipt. The command ID and private restore record remain unchanged after a lost response, so the HostKit command journal returns the original result. Both guest operations must themselves persist idempotently. State remains limited to **4,096 bytes** of application data; this does not implement filesystem snapshots, larger Cysts or process-state recovery.

## Local acceptance

`tests/paid-agent-lifecycle-v2.test.ts` uses a real local EVM, actual Vault payments, HostKit session processes and an encrypted private file vault. A genuine settled warmup charge and actual owner withdrawals establish the Metabolism thresholds. The agent migrates from full to lean on the same cleaned-up host, sleeps, wakes in torpor and is killed. Tests lose a wallet stop response and a guest restore response, reopen the private vault, restore unchanged application data, reject fresh and old-key quote preparation after kill, and conserve every reservation's settlement plus refund.

A second local-EVM case stops a queued, never-dispatched session under concurrent runner calls. It checks that the external wallet submits once, no CPU execution occurs, no-dispatch is unavailable before canonical full refund, and removing that observation prevents completion even when the financial charge is zero. The role authentication seam in these tests is an explicit local fixture; production authentication has separate acceptance.

## Opt-in Linux gVisor acceptance

The ordinary test uses `LocalSessionFixtureBackend`, which provides no tenant isolation or physical CPU quota enforcement. To exercise actual quota isolation, both environment variables must be explicitly set:

```text
TELOMERE_ACCEPTANCE_GVISOR_SOCKET=/run/telomere-accept-20261014/docker.sock
TELOMERE_ACCEPTANCE_GVISOR_IMAGE=127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe
```

The test rejects the ordinary shared Docker socket and every other image. It uses `createDockerHostedHostKit`, `runsc` and `/usr/local/bin/node` inside the reviewed image. While each real Cell is live, Docker inspection must show `NanoCpus` of 1,000,000,000 for full, 500,000,000 for lean and 250,000,000 for torpor; 256 MiB memory and swap limits; 64 PIDs; a read-only root; and no network. Successful evidence is saved to `.local/paid-agent-lifecycle-v2-gvisor-evidence-20261014.json`.

The test clock advances only to close isolated local-EVM receipt hours. The optional factory clock preserves dynamic test time; production defaults remain unchanged. Passing the local-process test does not imply the Linux switch passed. Neither mode establishes public Base settlement, GPU Cells, an attested CPU Cell or independent-region disaster recovery.

## 14 October Linux acceptance history

The initial isolated Linux run passed the queued-kill case but failed the main warmup's positive-burn assertion. A retained diagnostic showed two RUNNING ticks followed by STOPPED: the first had no heartbeat, the second had one fresh heartbeat, and every signed ACK correctly charged zero. The fixed eleven-second test pause started when a lease was journaled, before actual gVisor admission; it stopped the guest before two fresh RUNNING observations existed. No incorrect debit or production meter failure was established.

The test now waits for an actual running session with its ready event. Warmup then waits at most thirty seconds for a positive billable interval in the retained signed ACKs before asking the owner wallet to stop. The positive settlement and burn assertions remain strict. No meter freshness threshold, charging formula or production runtime behavior changed for this correction.

The retry passed **2/2** cases on the isolated Docker daemon and real `runsc`. Actual inspection recorded 1,000,000,000, 500,000,000 and 250,000,000 NanoCpus for full, lean and torpor, with the stated memory, network, root and PID restrictions. It restored 34 bytes of application state, recovered lost responses and private-vault reopen, and conserved all tested financial ceilings. This run used parent snapshot `backend-candidate-20261014-f53290d7` plus test-file SHA-256 `a2460648872677089b6dbc916c4ddf2678b5ea1d442ce85b24ca552bcb0a3164`.

The downloaded raw retry evidence is retained unchanged. Its historical `sameHostRollover` flag describes the tested same-host migration; the actual intent was `migrate`. New evidence uses `sameHostMigration`. This case does not demonstrate automatic deadline rollover or continuous 24-hour operation. The final release snapshot requires its own exact-source verification after this metadata correction and other concurrent work.
