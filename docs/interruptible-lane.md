# Interruptible CPU lane (M8)

This module implements the preemption sequence in backend §3/4 with owner-controlled encrypted application state. It has a real local acceptance path: two separate live Node processes, checkpoint/restore, disk-backed PGlite restart, controller Worker receipts, and canonical settlements on a disposable Anvil chain. The process fixture provides **no sandbox or gVisor isolation**. This acceptance does not establish production multi-host capacity, GPU migration, CRIU/CUDA support, or public-chain deployment.

## What runs

1. The authenticated owner explicitly opts an existing active interruptible CPU reservation into the lane. Admission requires its original controller-signed Host Kit lease, exact host/image/owner/run scope, an existing lifecycle agent, a maximum spend, a deadline, and a conservative target runtime bound (`resumeSeconds`). This is not inferred from billed source seconds. The owner also explicitly authorizes permanent job-agent cancellation if a partially prepared wake must be superseded.
2. The owner separately approves one or more **already reserved** targets on different admitted hosts. This endpoint neither creates a reservation nor sends a payment. Each target's exact reserved ceiling must match its published CPU rate and `resumeSeconds`; there is at most one candidate per host and 16 candidates per admission.
3. The host-side `HostPreemptionService` signs and durably stores one immutable Ed25519 notice. Its signed domain is `telomere-interruptible/v1`. The original controller-signed lease hash, pinned host key, owner, agent and source run are all bound to the notice. The host-local lookup must prove active lease plus durable owner opt-in. A notice allows 30–120 seconds, and the controller requires at least 30 seconds still remaining at first acceptance. Exact retries return the original notice even after expiration or restart. Host-local `enforceDue()` stops the noticed run even if its client is absent, records actual cleanup, and retries uncertain cleanup after journal restart.
4. A durable lifecycle **sleep** intent checkpoints and then stops the source. `ClientAgentCoordinator` encrypts the checkpoint on the owner's client with XChaCha20-Poly1305 and keeps its recovery key in the owner's durable vault. The scheduler stores ciphertext identifiers and hashes; it receives no plaintext or recovery key.
5. The scheduler waits for the source's actual cleanup and confirmed controller settlement. Missing evidence is `source_settlement`, never an invented zero charge or refund. The supplied controller reader verifies the receipt's typed signature/domain/hash/token, completed CPU observations and exact conservation, then invokes a mandatory canonical chain-confirmation callback.
6. The scheduler ranks only separately approved reservations that are still present in the actual admitted capacity catalogue. Existing class/region/image/sealed/lane filters, price/reliability/stake ranking, deadline and exact integer budget checks apply. No target can be chosen before confirmed source stop and settlement.
7. An existing lifecycle **wake** intent attaches and resumes the selected target from the encrypted application checkpoint. Capacity, reservation scope, full target ceiling and deadline are checked again before both effects. If the provisionally selected target loses capacity **before any wake intent exists**, the scheduler returns to selection and may use another already approved, funded target under the same confirmed source charge, deadline and budget. After a wake intent exists, its target cannot change; a racing different selection cancels conservatively and accounts for the original wake target. The existing lifecycle service also rechecks its authoritative reservation at execution and acknowledgment. Each runner operation uses the durable lifecycle `intentId:phase` identity and must be idempotent after loss of its response.

The durable states are:

```text
admitted -> noticed -> checkpointing -> settling -> selecting -> waking -> resumed
                                       |             |           |
                                       +-------------+-----------+-> cancelling -> cancelled
                                                     ^           |
                                                     +-----------+ (only before wake intent)
```

## Cancellation and accounting

An infeasible deadline/budget, withdrawn reservation or absent approved capacity stops the job and reports confirmed refunds without buying a replacement. The provisional-target retry chooses only previously funded reservations; it neither extends the 120-second lease nor connects the separate legacy `/api/jobs/deadline` payment path. If no target wake has begun, the source agent remains in Cyst and can be reused through an owner-approved lifecycle operation.

If a wake is already partially prepared, cancellation uses the existing lifecycle terminal `kill` action. This invalidates stale resume phases and stops the pending target. Admission requires `allowTerminalAgentKill: true`; this behavior is explicit. Cancellation then waits for the stopped target's own confirmed receipt and actual cleanup. Lack of a resume acknowledgment alone never establishes zero target charge or a full target refund.

`spent` sums confirmed source and, where applicable, cancelled-target charges. `remainingBudget` is `maxSpend - spent`. `confirmedSourceRefund` and `confirmedTargetRefund` represent actual confirmed reservation conservation. Other approved but unused target reservations appear as `unconfirmedTargetReservations`: this module does **not** claim their funds have already returned or silently send an owner refund transaction. Their existing escrow timeout/refund path remains separate. `walletActionRequired: false` describes this orchestration; it does not claim every independently approved unused reservation was refunded.

Only integer completed seconds are charged: `charged = billableSeconds * pricePerSecond`, with `charged + refund = ceiling`. CPU-only reservations must have zero inference charge. Maximum spend covers the original source ceiling; before resume, the selected target's entire existing ceiling must fit the budget remaining after confirmed source charges.

## Root integration

All exports are in `src/scheduling/interruptible/index.ts`. No shared store/main/controller files are changed by this module.

- Add `interruptibleRuns` and `hostPreemptionNotices` to the central Drizzle schema as appropriate. Execute `interruptibleMigrationSQL` after the existing agent migration. Its SQL is fixed; do not interpolate request data.
- Construct `InterruptibleService(db, { lifecycle, controlKey, approvedRun, capacities, settlement, now? })`.
- `approvedRun(owner, agent, runId)` must read authoritative existing owner/agent reservation, active versus reserved state, original source lease, host key, exact price/image/class/lane and lease expiry. Its callback must never create a payment or reservation.
- `capacities()` must return actual admitted hosts. The implementation accepts CPU only. Do not turn discovery hints into capacity claims.
- Use `createControllerInterruptibleSettlementReader(db, reviewedReceiptPins, { confirmSettlement, cleanupConfirmed })`. `canonicalSettlementConfirmation(bridge)` wraps `ChainBridge.confirmedSettlement` as a read-only verifier. Cleanup must come from actual process/container removal; for production Host Kit this means the durable controller's verified `cleanupConfirmed` evidence.
- Mount `createInterruptibleRoutes(service, authenticatedOwnerCallback)` below `/api/interruptible` with the application's session, Origin and JSON middleware. Every route requires the callback. Bodies are independently bounded to 16 KiB and responses use `Cache-Control: no-store`.
- On the **host**, construct `HostPreemptionService(hostDb, hostEd25519Identity, { activeOptedInRun, stopNoticedRun, now? })`. Its private host identity stays on the host. Mount `createHostPreemptionRoutes` behind separate host-local operator authentication; it is not a public arbitrary signing endpoint. Deliver the resulting signed notice to the authenticated owner's controller endpoint. The host callback must consult the actual active lease and durable opt-in. Call `enforceDue()` at startup and at least once per second from the host watchdog. `stopNoticedRun(owner, runId, noticeId)` must be idempotent for `noticeId`, target only that owner/run, and confirm actual removal (or absence) without stopping a different current tenant. Failed or uncertain cleanup stays pending; do not admit replacement work while host cleanup is uncertain.
- On the owner's client, construct `InterruptibleClientCoordinator(schedulingControl, lifecycleControl, durableClientVault, idempotentRunner, applicationSchema)`. `HttpInterruptibleControl(ApiTransport)` and `HttpAgentLifecycleControl(ApiTransport)` provide the bounded authenticated HTTP controls. `finish()` executes a bounded number of phases and returns on pending receipt/notice; it never busy-waits or funds a target.

The production runner still needs an application-specific checkpoint channel and separately admitted second host. Its `checkpoint` operation must freeze/flush the application consistently before returning portable bytes; `stop` must confirm source cleanup; `attach` must prepare only the approved target; `resume` must restore the specified application schema idempotently. Arbitrary shell commands, runtime/image overrides and user hardware claims are not part of these routes.

Owner routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/interruptible` | List own admissions / explicitly opt in an active run |
| GET | `/api/interruptible/:id` | Read own durable progress and accounting |
| POST | `/api/interruptible/:id/targets` | Approve an existing reserved target `{runId}` |
| POST | `/api/interruptible/:id/notices` | Accept the original host-signed notice |
| POST | `/api/interruptible/:id/advance` | Advance trusted orchestration facts |
| POST | `/api/interruptible/:id/execution` | Recheck one client lifecycle phase |

There is no billing-ingestion, plaintext, recovery-key, wallet-signing, capacity-override or payment endpoint. Source admission and host notice issuance require `Idempotency-Key`.

## Verification

```powershell
npx vitest run tests/interruptible-lane.test.ts
npm run typecheck
```

The acceptance uses ephemeral generated Anvil accounts on loopback chain 31337 only. It prepays/reserves both targets before orchestration, then asserts that the customer transaction nonce stays unchanged. The actual source child advances a rolling SHA256 counter, freezes and checkpoints, and exits. After a real controller PGlite close/reopen, the second child resumes exactly the saved state and reaches the independently computed final counter/hash. Real Worker receipts are validated against canonical escrow receipts and reserve conservation. The operator's normal local settlement transactions are distinct from customer approvals; there is no public/paid provider call.

Negative coverage includes missing opt-in, wrong lane/source signature, short/stale/wrong-host/wrong-run/wrong-owner/wrong-lease notices, immutable notice retries, lost lifecycle-plan response, lost resume acknowledgment, missing source settlement, withdrawn target, deadline/budget/capacity infeasibility, late checkpoint stop, post-attach stale-resume rejection, pending target settlement, fractional/inconsistent/wrong-owner receipts, owner privacy and bounded HTTP owner-client orchestration.
