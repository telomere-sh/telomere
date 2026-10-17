# CPU pilot execution

`DockerCpuExecutor` uses the host's Docker CLI. The cell runs only the fixed Node
program in `src/runtime/task-program.ts`; task data goes through JSON stdin.
It accepts SHA-256 text, integer sorting, and prime enumeration. Large sort/prime
results become bounded summaries with first/last values and a SHA-256 digest of
the complete result. No user command, shell, package installation or network access
is available.

The default image is `node:22-alpine`. The VPS operator should resolve, review and
configure an immutable image digest before funded pilot runs. The optional
Dockerfile adds the non-root default; runtime isolation is applied by the executor:
network none, read-only root filesystem, all capabilities dropped,
no-new-privileges, UID/GID 10001, one CPU, 256 MiB memory with no additional swap,
64 PIDs, at most 120 seconds and 16 KiB combined process output. The Docker socket
is accessible to the trusted control plane only, never mounted in a cell.

Ticks describe software observations from Docker's container state, with a final
output hash and a hash chain. These are metering records, not TEE attestation or
proof that an untrusted host performed work. Confirmed billable seconds are the
floor of observed running milliseconds, capped by the authorized duration.
The executor awaits persistence of each tick; a failed write terminates work and
propagates after container cleanup.

Cancellation and timeout terminate the attached CLI, then kill and force-remove
the named container. Failed removal raises `CpuCleanupError`; new work should
stay paused until recovery confirms cleanup. At exclusive startup, reconcile the
durable run journal and call `cleanupOrphans()` before dispatching fresh jobs.
It selects only `telomere.managed=true` containers with validated Telomere names.

`DemoCpuExecutor` runs the same fixed program in a local Node child process for
offline Windows demos. It is explicitly **not a sandbox**, does not enforce Docker
CPU/memory isolation, and must not be used for funded or arbitrary workloads.
