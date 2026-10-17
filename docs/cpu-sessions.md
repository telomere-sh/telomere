# Bounded persistent CPU session primitive

`src/host-kit/sessions/index.ts` supplies an internal Node runtime for repeated commands in one persistent resource. It is not mounted in the main API or financial HostKit protocol. It does not issue a paid lease, meter a customer, produce a financial receipt, release checkpoint keys or resume a process after a controller crash.

The caller provides a reviewed immutable image digest, a bounded session policy, a backend and an exclusively owned durable journal. Sessions last 1–120 seconds including backend startup. The fixed Docker policy is one CPU, 256 MiB RAM/swap, 64 PIDs, a 16 MiB `/tmp`, no network, a read-only root, dropped capabilities and no new privileges. Tenant mounts, Docker flags and runtime overrides are not accepted.

The subsequent `createDockerHostedHostKit` factory supplies a common private HostJournal and one durable CPU claim for this internal session manager and signed one-shot work. The claim remains held between commands and is released only after physical cleanup and durable terminal publication. Its separate scope, original-input and ambiguous-create recovery rules are documented in [host-kit.md](host-kit.md). The primitive's original 27-case evidence below predates this integration. Bare separately constructed runtimes still require the caller's own shared admission and retain the original component boundary.

## Commands and output

`execute({ commandId, argv, stdin? })` serializes commands inside the same session. The temporary directory and deliberately retained background processes remain shared within that session. An ordinary nonzero command exit leaves the session available for a subsequent command. A completed command does not establish that every background process has stopped.

Command IDs bind immutable input hashes. The queued and starting states are saved before dispatch. Repeating the same ID/input returns the original outcome or awaits its original completion; changed input is refused. After reopening an unfinished journal, the runtime removes the old owned resource and marks unresolved commands uncertain. It never reruns them or claims process reattachment.

Each command permits at most 32 literal arguments with the existing lease argument bounds, and at most 8192 UTF-8 stdin bytes. Sessions accept 1–32 commands, at most 16384 output bytes per command, at most 65536 output bytes overall and at most 1024 output frames. Strict incremental UTF-8 preserves split characters, normalizes each stream's initial BOM and rejects NUL or invalid/incomplete text. Events are durably saved before `readEvents` or `events` publishes them; pages contain at most 128 events. A failed journal write wakes waiting streams with an error and refuses event reads instead of publishing an unsaved exit.

Incoming frames are validated and bounded before joining the persistence queue: at most 128 pending frames and bounded lifetime totals. Slow event consumers do not hold the command or journal queue. A host timer and heartbeat watchdog stop the resource independently of that queue. Physical cleanup starts before waiting for terminal journal persistence, including a handle returned late after startup expiry. Concurrent stop callers await the same durable terminal publication or the same failure.

`status()` is a live in-memory observation, not proof that a write is durable. `journalAvailable` becomes false after a persistence failure. The caller must reconcile that failure through the durable journal and resource cleanup before exposing a financial outcome. `sample()` reports cumulative CPU telemetry; it is not a billing receipt.

## Docker control separation

The persistent operator init runs as UID 10000. The trusted host invokes commands with `docker exec` as UID 10001 in that same existing container/cgroup and frames their raw stdout/stderr itself. Workload JSON remains ordinary output. The init's control descriptors and signals are separated by UID; no SETUID or KILL capability is added. Docker dispatch events do not assert an independently measured workload PID or hardware attestation.

Invalid live output, a transport fault or output overload ends the entire Docker session through verified container removal. Incomplete UTF-8 discovered only when an exited command's decoder is flushed fails that command; it can leave the session available. Killing only the local Docker CLI would not establish workload termination. Expiry and explicit stop also remove the entire namespace, including background descendants, and close owned attach/exec processes. Kata uses the same fixed construction but retains a separate untested hardware/runtime acceptance boundary.

`LocalSessionFixtureBackend` requires an explicit `test-fixture-only` acknowledgement. It exercises actual persistent processes and shared files, but provides no tenant isolation, filesystem sandbox, enforced resource limits or cross-UID control protection. Its per-command failure behavior can differ from Docker's whole-session termination.

## Journal ownership

`FileSessionJournal` stores bounded plaintext host-side inputs, outcomes and events in a private directory. It is separate from the owner-encrypted Cyst file vault. The caller controls its filesystem/backup/retention and must not pass owner recovery keys or other unrelated secrets into a workload.

The journal uses a random exclusive lock, stable regular single-link files, bounded repeated reads, fsynced atomic writes/readback and POSIX directory sync. Every operation rechecks its directory and lock identity/token. The persisted backend identity binds isolation and the exact host/socket/binary scope; changing that scope refuses reopening before cleanup. Crashed locks require administrative review; there is no age-based lock stealing. Windows ACL provisioning remains the caller's responsibility, and Windows directory-fsync or secure memory erasure is not claimed.

The record limit is 2 MiB with no automatic pruning. Maximum-sized inputs can exhaust this storage limit before all command slots are used; persistence then fails closed. Full older-snapshot rollback protection is not supplied.

## Product integration still required

The trusted host factory now supplies shared admission with one-shot HostKit leases. The main product still needs a signed interactive-session capability, command authorization and HTTP/SDK streams, durable metering and financial-root integration, controller recovery and checkpoint/migration orchestration. Extending the lifetime alone does not implement long-lived billing or rolling hourly/day budgets. This primitive must not be exposed as a free or already paid public Cell API before those connections exist.

Dated acceptance and exact source hashes are recorded in `cpu-sessions-validation.json` once the checks complete.
