# Lifeline and Metabolism for application agents

`src/agents` implements a durable owner-scoped agent registry, confirmed-spend journal, Metabolism decisions, transition journal, authenticated REST routes, bounded HTTP client and an explicit owner-side Lifeline executor. It operates on encrypted **application state** using the existing Cysts service. It neither purchases compute nor signs or submits wallet transactions.

The main application already mounts this lifecycle API when Cysts are enabled and connects canonical settled billing through controller maintenance. `AGENT_RUNTIME=legacy` is the default and uses the original escrow path. The opt-in `AGENT_RUNTIME=platform` uses admitted EOA-paid CPU runs, a maximum 120-second lease and a 30-second rollover lead; see [paid-agent-lifecycle.md](paid-agent-lifecycle.md). It requires enabled Cysts and `PLATFORM_RUNTIME_CONFIG`. Both modes persist one immutable database financial binding rather than mixing histories from different protocols, chains, escrows or tokens.

## Durable data and integration

The shipped store includes `agents`, `agentIntents`, `agentBilling`, `agentRuntimeBinding` and `agentBillingProvenance` and executes the fixed `agentMigrationSQL` migration. A separate embedding must include those tables and migration. Construct `AgentLifecycleService(db, dependencies)` with:

- `cysts`: the initialized Cysts service.
- `balance(owner)`: confirmed available escrow units, excluding outstanding reservations, returned as an exact decimal integer string.
- `reservedRun(owner, agent, runId)`: an authoritative read that verifies owner, agent, a funded/approved reservation, run ID and future lease expiry. Return `{ id, owner, agent, reserved: true, leaseUntil: Date }`. The legacy policy allows at most 24 hours; the paid CPU policy allows 120 seconds. The lifecycle layer never creates a reservation.
- Optional `ensureReady()`, `refreshBilling(owner, agent)` and `leasePolicy: 'paid_cpu'`: the controller uses these for its persisted namespace, canonical paid billing and bounded paid lease policy.
- Optional `now()`: controlled clock for acceptance testing.

Mount `createAgentRoutes(service, authenticatedOwner)` below `/api/agents`, retaining the application's authenticated cookie, Origin/JSON/body limits and rate limits. Registration is bounded to 64 agents per owner. Read and mutation queries include the owner; another tenant receives a 404 for agent or transition identifiers. Extra request fields such as `recoveryKey`, `plaintext` or wallet signing material fail strict validation.

`appendSettledCharge(owner, agent, receiptId, amount, settledAt, provenance?)` is an **in-process settlement integration**, with no matching HTTP endpoint. Call it only for independently confirmed final settlement facts. A replay must match agent, amount and settlement time exactly. The platform adapter also atomically persists and rechecks canonical transaction/block provenance; a supplied provenance must match its original record on replay. The journal includes the open interval `(now − 24 hours, now]`; old charges remain auditable but do not affect the current burn. Future settlement times and invalid/overflowing integers fail closed. The shipped controller connects this ingestion for its selected runtime; a separate embedding must supply the same authoritative integration.

## Exact policy

The available balance and trailing 24-hour burn are integers in the same token units. Threshold comparisons cross-multiply before division; they remain exact above JavaScript's safe integer range.

| Mode | Runway | Runner obligation |
| --- | --- | --- |
| Full | More than 72 hours; positive balance with no recent burn | Any compute class allowed by the owner's Leash |
| Lean | 24 through 72 hours | One compute class down; GPU only for essential jobs |
| Torpor | 2 through fewer than 24 hours | CPU only; respect scheduled wake |
| Cyst | Fewer than 2 hours; zero balance | Checkpoint and stop execution; storage only |

The client runner implements actual resource/class restrictions in `profile` and `resume`; a mode value alone does not impose a CPU/GPU cgroup. The shipped counter acceptance uses CPU processes. GPU throttling, CRIU/CUDA process restoration and host resource enforcement are separate integrations and are not claimed by these tests. This adaptation uses trailing 24-hour burn for both thresholds and the owner-visible runway; the PDF also discusses current burn when describing compute transitions.

Legacy evaluation marks leases due to roll 30 minutes before expiry; paid CPU evaluation uses 30 seconds before its at-most-120-second expiry. If a separately approved target exists, Lifeline checkpoints and migrates. If it does not, it checkpoints and stops instead of silently extending the financial lease. A future scheduled wake keeps the agent asleep until its due time; an explicit owner wake can override that schedule if budget and a reservation permit it. A top-up makes an unscheduled Cyst eligible to wake, but it still needs the saved client key and an independently approved target reservation.

## Transition protocol

Active migration and lease rollover use persisted phases:

`checkpoint → stop → attach → resume → done`

Sleep uses `checkpoint → stop → done`; wake uses `attach → resume → done`; a resource change uses `profile → done`. SQL row locks, a unique open-intent index, owner-scoped idempotency keys and compare-and-swap versions protect registry transitions. The same idempotency key cannot change its request body. Every checkpoint acknowledgment checks the actual ready Cysts metadata, owner, agent, ID and ciphertext digest.

The owner client must durably save its envelope and recovery key **before upload**, quiesce the source while capturing a consistent checkpoint, and implement idempotent external operations keyed by `intentId:phase`. Losing an upload response reuses the same encrypted envelope and Cysts idempotency key. Losing an acknowledgment re-reads the durable phase and repeats the same runner operation. Keys and plaintext exist only in the owner's executor/client vault; the controller persists checkpoint IDs and digests. Temporary coordinator key/state copies are cleared after use. JavaScript memory clearing is best effort, and client-vault backups remain the owner's responsibility.

`validateExecution` checks the current phase/version and verifies the target reservation before external attach/resume; acknowledgment validates again. Owner kill permanently latches `killedAt`, supersedes a pending transition and queues stopping both a possible source and target. Later wake, migration and stale phase acknowledgments are rejected. The runner must serialize operations for an agent and enforce fencing/kill signals against any operation already in flight; an API preflight cannot atomically fence an unrelated external executor. The protocol does not claim exactly-once effects from an adapter that lacks its required idempotency and fencing behavior.

Owner kill remains available when paid canonical billing or RPC prevents evaluation. Its response has `evaluation: null`; other transitions retain a real evaluation. Kill cannot attach a new target reservation and does not replace the owner's runner stop/acknowledgment duties.

If a reserved target expires or is revoked, attachment/resume fail closed. A recovery key that is unavailable stops restoration. The current protocol exposes the pending intent for diagnosis and owner kill; retargeting a partially attached transition is not implemented. It never substitutes an unapproved target automatically.

## Owner-side execution

The owner supplies `ClientAgentRunner` and `ClientLifecycleVault`. The runner has `checkpoint`, `stop`, `attach`, `resume` and `profile`; the vault stores private checkpoint envelopes/keys locally and returns fresh key copies. `HttpAgentLifecycleControl` uses the existing `ApiTransport` HTTPS/cookie and response-byte restrictions and checks returned owner/agent scope.

```ts
const control = new HttpAgentLifecycleControl(authenticatedTransport);
const coordinator = new ClientAgentCoordinator(control, privateClientVault, fencedRunner, 'counter.hash.v1');
const lifeline = new ClientLifeline(control, coordinator, async (owner, agent) => {
  return alreadyApprovedReservations.lookup(owner, agent);
});
await lifeline.tick(ownerAddress, agentAddress);
```

`tick` resumes an unfinished transition before making a new decision. It returns `reservation_required` or `checkpoint_required` when it cannot wake safely. A steady-state tick performs reads without adding journal entries. The application chooses the polling/event schedule, including top-up notifications; there is no hidden daemon, wallet or paid provider call in this module.

## REST interface

| Method | Path below `/api/agents` | Purpose |
| --- | --- | --- |
| GET | `/` | Owner's bounded registry |
| POST | `/` | Register `{ agent, runId? }` |
| GET | `/:agent` | Registry and current unfinished intent |
| GET | `/:agent/evaluation` | Exact budget/burn/runway and wake/roll flags |
| POST | `/:agent/transitions` | `{ action, expectedVersion, targetRunId?, wakeAt? }` with `Idempotency-Key` |
| POST | `/intents/:id/execution` | Preflight `{ expectedVersion, phase }` |
| POST | `/intents/:id/ack` | CAS acknowledgment `{ expectedVersion, acknowledgment }` |

Actions are `evaluate`, `migrate`, `sleep`, `wake` and `kill`. Checkpoint acknowledgments contain only `phase`, `checkpointId` and `checkpointSha256`; other phase acknowledgments contain only `phase`.

## Acceptance evidence

`tests/agent-lifecycle.test.ts` runs a counter/hash-chain application in separate Node processes on two executor directories. It executes seven steps, encrypts and durably uploads its actual state, closes/reopens a filesystem-backed PGlite database, stops the first executor and restores on the second, then verifies the next nine steps equal an uninterrupted 16-step computation. A second test runs the migration through the real Hono REST routes and bounded HTTP/Cysts client. Additional cases cover response loss, operation replay, one immutable ciphertext upload, sleep/top-up/wake, scheduled wake, lease rollover, exact thresholds, confirmed billing, owner isolation, permanent kill, stale CAS, wrong keys, checkpoint scope and revoked reservations. All reservations and execution in these tests are private local fixtures; they do not prove public-chain funding or a production multi-host/GPU lifecycle.

Run `npx vitest run tests/agent-lifecycle.test.ts`.

The separate contract-backed paid runtime and mounted-main acceptance are described in [paid-agent-lifecycle.md](paid-agent-lifecycle.md); generic local runner tests alone do not establish their financial or public-deployment properties.
