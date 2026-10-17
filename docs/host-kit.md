# Host Kit CPU protocol

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`src/host-kit` implements a separate owner/operator-managed CPU host agent with a persistent Ed25519 host identity, signed control leases, signed host observations, independent control-plane verification, and control-plane countersignatures. It uses the existing Node/TypeScript runtime; the PDF's proposed Go/Rust split is not implemented.

The production CLI is `node dist/scripts/host-kit.js`. Its HTTP server binds only `127.0.0.1`. Use an operator tunnel or a reviewed TLS frontend for remote control. Every admission, status, stop, and acknowledgement is signed by the independently configured control-plane Ed25519 key. This key is separate from Ethereum wallets. No API accepts an Ethereum private key or broadcasts transactions.

## CPU cell policy

Only exact repository references ending in `@sha256:<64 lowercase hex>` from the configured allowlist are admitted. Tags are rejected. A lease binds its host key, owner, run ID, nonce, image, argv, stdin, issue time, expiry, and maximum seconds. Current leases are bounded to 120 seconds. Argv has at most 32 strings, 4,096 UTF-16 code units per string and 8,192 aggregate UTF-8 bytes; the host protocol bounds stdin to 128 KiB. The financial one-shot API imposes a stricter 8 KiB stdin bound and valid Unicode/NUL checks before persistence. The host invokes no shell and rejects common shell entrypoints. Application argv is permitted inside the reviewed image and sandbox.

Cells run with an explicit `runsc` or `kata-runtime`, no network, read-only root filesystem, all capabilities dropped, no new privileges, UID/GID 10001, one CPU, 256 MiB memory and swap ceiling, 64 PIDs, and a 16 MiB noexec/nosuid/nodev temporary filesystem. There are no tenant-provided Docker flags, bind mounts, host devices, ports, environment, or daemon sockets. Network allowlist proxies, GPU devices, NVML probes, and Kubernetes integration are not implemented here; current egress is denied entirely.

`gvisor` is the default. Startup inspects runtime inventory and fails closed when `runsc` is missing. `kata` similarly requires `kata-runtime`. There is no automatic fallback. `docker_development` requires both an explicit isolation setting and `HOST_KIT_ALLOW_DOCKER_DEVELOPMENT=true`; responses identify it as ordinary restricted Docker. `LocalProcessFixtureRuntime` is only an explicit test fixture with no sandbox security boundary and is never selectable by the production CLI. Production clients reject Docker-development and fixture responses unless explicitly permitted.

The host process is trusted infrastructure with Docker-daemon access. Its systemd hardening does not make Docker membership unprivileged. `HOST_KIT_DOCKER_SOCKET` selects every Docker CLI call and CPU-counter request; it can point to a dedicated daemon without changing an existing Enclave daemon.

## Shared one-shot and internal-session admission

`createDockerHostedHostKit` constructs the one-shot agent and internal `HostedSessionManager` around the same private HostJournal, full host/control keys, Docker socket, executable configuration and isolation. The production CLI uses this factory. gVisor and Kata supply a persistent-session backend; explicit Docker-development mode keeps sessions disabled. The bare `HostKitAgent` and `SessionRuntime` remain low-level components whose separate construction does not establish shared admission.

The journal contains one durable `cpu1` claim with a random ownership token, immutable original signed lease or complete session spec, input hash and exact backend-scope binding. Reservation and the corresponding original record are inserted atomically before dispatch. A session retains this claim through idle periods, ordinary nonzero command exits and background descendants. One-shot and session work exclude each other. Only confirmed physical cleanup followed by durable terminal publication can delete the matching token. Replaying an old terminal result cannot release a successor's claim. The session history is bounded to 256 retained IDs; reaching the limit requires operator archival.

Startup validates all original records, scope and both full-key Docker label namespaces before any removal. Unknown resources, contradictory labels/images, changed socket/binary/isolation/control key and nonempty unbound legacy journals refuse readiness. There is no implicit migration of an old journal: retain its original configuration for cleanup/reconciliation and review an explicit cutover before starting the new scope. Executable scope binds the configured path/string; it does not pin the executable's file contents or resolve a `PATH` alias to an immutable binary.

A dispatch marker is persisted before each actual backend invocation. A reservation-only gap can recover without dispatch. After a crash, a dispatched reservation with neither durable successful start/ready evidence nor an observed matching resource remains ambiguous and retains its claim. Docker CLI timeout, nonzero or malformed create acknowledgement followed by present absence likewise keeps a concrete-backend fence; a daemon request could still create later. A later observed exact original resource can be removed and reconciled. Time alone does not unlock an uncertain claim. Shutdown fences both admission modes synchronously and stops their owned resources before publishing terminal cleanup.

Sessions are an internal host API: `hosted.sessions.open(spec)` exposes repeated commands and durable events to a trusted embedding process. No public session route, remote session authorization, paid interactive lease, session financial meter or receipt is supplied. Sessions still last at most 120 seconds. Long-lived product orchestration, migration, process reattachment and Kata acceptance remain separate work. Dated focused acceptance is recorded separately from the original standalone HostKit and session-primitive evidence.

## Meter semantics

An operator-owned init process inside the cell spawns the workload with `shell:false`, frames ordinary stdout separately from init heartbeat records, and emits an in-cell heartbeat every second. The workload inherits a fixed minimal environment. Combined raw stdout/stderr is bounded to 16 KiB; result text contains stdout only. The runtime accumulates stdout bytes before strict UTF-8 decoding, preserving codepoints split between frames and normalizing an initial BOM before persistence/hashing. NUL or invalid/incomplete UTF-8 returns a durable failed result with a fixed safe diagnostic after cleanup. These software observations do not attest to an untampered init process.

Outside the cell, the host samples running state and Docker daemon CPU-usage nanoseconds every five seconds, converts CPU usage to cumulative milliseconds, and signs a tick containing lease scope, monotonic sequence, timestamp, elapsed time, CPU counter, state, preceding tick hash, and the latest init heartbeat. CPU-only GPU utilization/memory/power fields are explicitly zero. The fixture reports CPU usage as zero and makes no CPU-utilization claim.

`HostMeterVerifier` independently checks the reviewed host key, Ed25519 signature, lease hash, owner/run, exact sequence and hash chain, monotonic timestamps/counters, clock skew, and elapsed-time acceleration. A billed second must lie between two consecutive RUNNING observations, both with a fresh heartbeat and increasing heartbeat sequence. The first observation and terminal observation alone contribute no billing. Missing/stale heartbeats and excessive gaps contribute zero. Billing is bounded by the lease duration.

Three missed five-second tick intervals fault the control-plane verifier. The host also stops after three intervals without countersignatures or init heartbeats. Signed countersignatures bind the exact persisted tick hash and cumulative billable seconds. The host recomputes each billing interval before accepting an acknowledgement; duplicate acknowledgements are idempotent only when their complete signed hashes match. Replayed control nonces, stale commands, foreign-owner requests, substituted keys/runs, and altered counters are rejected.

The host persists signed leases, ticks, acknowledgements and confirmed billing in a private PGlite journal before exposing them. It admits one active tenant, retains run-ID tombstones up to an explicit 4,096-run archival gate, and uses a private exclusive process lock. On restart it removes only cells carrying its Host Kit label and exact host key, verifies cleanup, then faults interrupted leases while preserving their confirmed billing. Failed cleanup prevents subsequent admission. Signed status includes the persisted per-run `cleanupConfirmed` flag; it remains false while active or after ambiguous removal. Stop commands target the original run ID, so an old completed lease cannot interrupt a later tenant. The host's Ed25519 key is mode 0600 inside its mode 0700 directory and is not logged.

New leases are checked again when their serialized admission reaches the journal and after the reservation write. The original duration budget includes reservation and backend startup: it is the smaller of `maxSeconds` and the time remaining until `expiresAt`, with monotonic elapsed time preventing a backward wall-clock change from extending it. The existing five-second issue-time skew remains. An exact previously persisted signed lease returns its original record even after expiry; a changed lease for that run ID is rejected and never starts another resource.

Expiry initiates physical cleanup outside the journal queue, including while startup, sampling or persistence is blocked. A startup without a returned handle receives an owned-resource sweep and still retains its slot until the late handle is definitively stopped. If a runtime never returns, admission remains blocked; the agent cannot truthfully confirm cleanup or safely admit a successor. Shutdown closes admission before draining work. Old callbacks and heartbeats are scoped to their original run context. After a failed Docker removal, only a separately bounded Engine response confirming the exact owned container is absent permits duplicate cleanup to succeed; unavailable transport and other failures retain uncertainty.

Terminal observations preserve only the last durable CPU counter and add no billable interval. They do not sample an already removed container. A result delivered after the original deadline is recorded as timed out, even if its backend wait promise has already resolved successfully.

These safeguards cover existing one-shot HostKit leases. The internal persistent session primitive still has a separate journal and resource inventory; a common admission and paid interactive-session meter are not supplied by this change.

`HostKitCpuExecutor` is exported for controller integration. Its optional fourth argument is an observer with `onLease(signedLease)` and `onEvidence(tick, ack)` callbacks. It awaits lease persistence before admission and signed-evidence persistence before the standard worker tick callback and host acknowledgement. Production must supply durable observer storage; omitting it is only for local tests and does not mean signed evidence has been persisted in the controller. The adapter emits the existing strict SHA256-chained `MeterTick` format through `RunMeter`, including a final output hash and the correct completed/failed/cancelled/timed_out state. It attempts stop on cancellation or persistence/transport failure. A lost acknowledgement response is reconciled by its exact signed hash. `infra/host-kit/Dockerfile.cpu` builds the fixed SHA256/hash-chain/sort/primes runner from an explicitly supplied reviewed Node image digest. This adapter does not yet provide long-lived shell sessions or GPU state migration.

`ControllerHostKitCpu` supplies that durable observer through `controller_host_runs`. It requires a claimed running controller job, persists its original signed lease before dispatch, persists host ticks and control countersignatures before acknowledging them, and retains the original lease across database restarts. Startup cleanup verifies stored signature/hash/owner/run/host scope and sends a targeted stop with that original lease. The adapter rejects a terminal result without signed cleanup confirmation. A saved lease is never replaced by a new dispatch for the same run.

`HostKitCommandExecutor` shares the same durable lease/evidence/cleanup loop with the fixed-task adapter. It accepts bounded literal argv and optional stdin in a reviewed image. Before returning a terminal result it drains ticks newly exposed by ACK replies, including a short command whose final tick arrives during the first ACK. Full financial command opt-in, hashes and SDK/MCP interfaces are described in [platform-exec.md](platform-exec.md).

## Dedicated-daemon gVisor acceptance

Linux gVisor acceptance passed on the private VPS on 9 October 2026; the safe report is in `host-kit-acceptance.json`. The current official gVisor bundle was checked against its published SHA-512 and reported `release-20261005.0`. A real 14-second container returned the expected output with signed host observations, control acknowledgements and conservative billing. Separate state/socket/containerd namespaces, no bridge and no iptables mutation kept this acceptance isolated from the existing Docker daemon and Enclave containers. The commands below describe the corresponding operator setup; operators must review their own runtime and image digests.

```sh
install -d -m 0700 /opt/telomere-hostkit-acceptance /var/run/telomere-hostkit
printf '{}\n' > /opt/telomere-hostkit-acceptance/daemon.json
chmod 0600 /opt/telomere-hostkit-acceptance/daemon.json
ip netns add tlmr-hostkit-acceptance
ip -n tlmr-hostkit-acceptance link set lo up
nsenter --net=/run/netns/tlmr-hostkit-acceptance \
  dockerd --config-file=/opt/telomere-hostkit-acceptance/daemon.json \
  --host=unix:///var/run/telomere-hostkit/docker.sock \
  --data-root=/opt/telomere-hostkit-acceptance/docker-data \
  --exec-root=/var/run/telomere-hostkit/exec \
  --pidfile=/var/run/telomere-hostkit/docker.pid \
  --containerd-namespace=tlmr-hostkit-acceptance \
  --containerd-plugins-namespace=tlmr-hostkit-acceptance-plugins \
  --bridge=none --iptables=false --ip6tables=false --ip-masq=false \
  --add-runtime=runsc=/opt/telomere-hostkit-acceptance/runsc
```

Run that daemon under a dedicated transient service or a hidden/background helper with output redirected to a private log. Use `nsenter --net`, not `ip netns exec`: the latter also changes mount handling and can hide the cgroup devices mount on this host. Import reviewed images with `docker --host=unix:///var/run/telomere-hostkit/docker.sock image load`; the isolated namespace has no outbound network. Confirm the selected image contains `/usr/local/bin/node`. Generate a separate control identity and write its public key and image allowlist; do not print its private PEM.

The original bootstrap exposed a Docker 29 behavior: a second daemon with `--bridge=none` in the host network namespace deleted the existing `docker0` bridge. The original staging controller lost PostgreSQL connectivity and left an idle advisory-lock session. Recovery restored the inspected bridge address/MAC and exact PostgreSQL veth, then terminated only that original orphaned database session. The five completed jobs, owner balance 9,998,600 and signer nonce 6 were checked unchanged, and the original controller returned ready. The corrected daemon uses a separate Linux network namespace; both acceptance flows passed again after this change while the original staging controller remained ready. Independent data and socket directories alone are insufficient isolation from host network changes.

```sh
export HOST_KIT_DIR=/opt/telomere-hostkit-acceptance/host-state
export HOST_KIT_DOCKER_SOCKET=/var/run/telomere-hostkit/docker.sock
export HOST_KIT_ISOLATION=gvisor
export HOST_KIT_ALLOW_DOCKER_DEVELOPMENT=false
export HOST_KIT_PORT=13290
export HOST_KIT_CONTROL_KEY=REVIEWED_CONTROL_PLANE_PUBLIC_ED25519_KEY
export HOST_KIT_IMAGES_FILE=/opt/telomere-hostkit-acceptance/images.json
node dist/scripts/host-kit.js
```

The allowlist is a JSON array of exact immutable image references. The host emits only its public identity and recovery counts. In a separate process, the bundled acceptance runner executes a real 14-second CPU cell with the exact default argv below and verifies the signed host/control evidence:

```text
/usr/local/bin/node -e 'setTimeout(()=>process.stdout.write("hostkit-gvisor-acceptance"),14000)'
```

```sh
export HOST_KIT_CONTROL_PEM=/opt/telomere-hostkit-acceptance/control-ed25519.pem
export HOST_KIT_HOST_KEY=PUBLIC_KEY_FROM_HOST_IDENTITY
export HOST_KIT_URL=http://127.0.0.1:13290
export HOST_KIT_ACCEPTANCE_IMAGE=REVIEWED_REPOSITORY_AT_SHA256_DIGEST
export HOST_KIT_REPORT_FILE=/opt/telomere-hostkit-acceptance/acceptance.json
node infra/host-kit/acceptance.mjs
```

Acceptance requires `isolation:gvisor`, successful output, exact cumulative countersignature billing, at least three covered seconds, no public transaction, and no paid-provider call. Also inspect the dedicated daemon's selected runtime and confirm zero remaining cells after completion; restart the agent against the same journal and verify run history/key persistence. Treat failure or absence of `runsc` as unverified isolation, not a Docker-development pass.

## Local evidence and remaining work

`tests/host-kit.test.ts` runs real loopback HTTP, a real child process with actual one-second init heartbeats and five-second signed observations, countersignature conservation, tenant isolation, one-active-run/replay rejection, bounded input, persistent journal restart, and owned orphan cleanup. Separate adversarial tests cover wrong keys/run/owner/hash/sequence, clock skew, counters, heartbeat loss, three missed intervals and fixed Docker policy arguments. These tests prove the protocol and conservative accounting, not gVisor/Kata isolation.

Its adapter tests also pass the real child result through strict `validateCpuResult`, reopen the controller's PGlite database, and execute `Worker.recover` without redispatch or quarantine. `tests/controller-host-kit.test.ts` verifies the durable production adapter through real HTTP, database persistence before lease admission and acknowledgements, cleanup of a still-active child after controller interruption and database reopening, foreign/unsigned metadata rejection, and fail-closed reconciliation of unsigned or uncertain cleanup responses.

The configured controller path also passed on the same isolated host, using a fresh private EVM and database: deadline quote, real token reservation, actual fixed CPU task inside gVisor, signed host/control evidence, escrow settlement and change, database reopen without redispatch, then hourly root publication and independent RPC proof verification. `platform-host-acceptance.json` records 8 billed seconds, 800 charged units and 2,200 refunded units from a 3,000-unit reservation. These are private test-token units. The reproducible driver is `scripts/platform-host-acceptance.ts`; it requires explicitly configured isolated Host Kit and task-image pins. The fixed image's destination directory must remain traversable by UID 10001; `COPY --chmod=0555` avoids a real BuildKit 0444-parent-directory failure caught by this acceptance.

Remaining production gates include Kata acceptance, host registration on Base Chain, authenticated remote transport deployment, scheduled honesty probes, policy-driven egress, larger Linux sessions, GPU support, and an audit. That recorded pilot acceptance uses the pilot escrow and receipt-hash leaf; it does not establish compatibility with the separate full-financial-leaf PlatformRunEscrow. The full financial runtime has separate acceptance evidence in `platform-exec-acceptance.json`. Host-signed software observations do not provide TEE attestation or proof of computation.
