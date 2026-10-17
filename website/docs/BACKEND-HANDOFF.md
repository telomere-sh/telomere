# Backend integration handoff

## Current implementation

This is a complete frontend without connected backend execution. `dist/site.js` renders public routes and caches their DOM for same-document navigation. The native landing runtime remains mounted between pages. `dist/dashboard.js` owns workspace forms and currently persists a version 1 object under localStorage key `telomere-workspace-v1`. Host profiles use `telomere-hosts`. Compute-page configuration handoff uses sessionStorage key `telomere-pending-plan`.

The state object contains `version`, `budget`, `plans`, `leashes`, `cysts`, `receipts`, `agents`, `records` and `preferences`. Run plans are prepared configurations. An imported receipt is a record supplied by a user, not a verified proof. There are no wallets, signing keys, real balances or secrets in the frontend source.

## Entry points to replace or extend

| UI path / function | Current behavior | Backend connection |
| --- | --- | --- |
| `newPlan`, `requestFor`, `planDetails` | Save a prepared run and export a request | Quote, authorize and open `/v1/cells`; retain returned run and host IDs |
| `budget` | Device planning ceiling | Fetch owner/vault balances and enforce authoritative limits server-side |
| `newLeash`, `data-leash-kill` | Save or revoke local policy; mark linked plans blocked | Create/kill Leash and reflect on-chain confirmation/state |
| `newCyst`, `data-export-cyst` | Save checkpoint configuration | Trigger snapshot/resume, poll status, store verified hash and storage reference |
| `newAgent`, `selectionPage` | Prepare agent profile | Selection registration, spawn workflow and public Fossil Record |
| `host-profile` public form, `hostsPage` | Save operator profile | Host registration, performance probes, collateral state and posted prices |
| `receipt-file`, `receiptPage` | Validate basic schema and import JSON | Retrieve proof, verify host tick signatures, receipt root and settlement events |
| `chart`, `metric`, `record` | Plan projections and device activity | Source authoritative live usage, settlement and audit records |
| `save` and startup state load | Device storage | Introduce a shared API client/repository and reconcile authenticated owner data |

Keep saved plans distinct from live runs. Preserve loading, empty, error, authorization, pending settlement and retry states when adding the API. The current CSV/JSON exports can be retained as user export actions.

## API contract from Backend specification, section 8

All routes below are under `/v1`. Treat the supplied PDF as the authoritative reference.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/cells` | Hardware class, lane, image, max_usd, max_seconds, leash_id, optional deterministic/sealed_only/cyst_from; returns a 402 challenge or run/host/exec endpoint/rate |
| POST | `/cells/{id}/exec` | Stream execution |
| POST | `/cells/{id}/stop` | Stop and settle a run |
| GET | `/cells/{id}` | Live seconds, spend and runway |
| POST | `/jobs/deadline` | Bounded deadline job |
| POST | `/cysts/{agent}/snapshot` | Create encrypted state snapshot |
| POST | `/cysts/{agent}/resume` | Resume verified snapshot |
| POST | `/leashes` | Create owner rules |
| POST | `/leashes/{id}/kill` | Revoke authority |
| GET | `/receipts/{run_id}` | Receipt and proof |
| GET | `/prices` | Eligible posted prices |
| GET | `/hosts/{id}` | Host record |
| POST | `/selection/enter` | Register an agent |
| POST | `/selection/{id}/spawn` | Spawn a child under specified rules |
| GET | `/selection/fossils` | Public Fossil Record |

The exported run-request shape currently uses `class`, `lane`, `image`, `max_usd`, `max_seconds`, `leash_id`, `sealed_only` and `region`. The added region is an owner filter; confirm the final server schema before mapping it. The endpoint returns the actual supplier quote; the form's planning rate is not a supplier price.

## Receipt and settlement boundary

Backend specification sections 3, 5 and 6 define the proof chain. Five-second host-signed ticks and workload heartbeat establish liveness. The receipts service creates leaves and posts an hourly Merkle root to ReceiptRoot on Base. Verify tick signatures against HostRegistry.hostKey, the leaf against its root and the amount against RunEscrow events. Importing JSON alone must not produce a verified badge.

The leaf includes run_id, host_id, hw_class, lane, image_digest, started_at, stopped_at, billable_seconds, price_per_sec, amount_usdc, probe_result, perf_score, tick_root and stop_reason. tee_quote_digest applies to sealed hosts; output_digest applies when declared. Use the PDF for the exact contract types, fixed-point precision and transaction semantics.

x402 facilitator routes are `/supported`, `/verify` and `/settle`. `upto` uses a bounded authorization and `exact` supports small fixed jobs. Keep payment signing and user authorization in their intended wallet/owner flow, with final state confirmed by the backend/contracts. No signing credentials belong in static source or workload configuration.

## Metabolism content

The replacement landing section follows Backend section 4.1: Full above 72h of runway, Lean at 24–72h, Torpor at 2–24h and Cyst below 2h. Runway is vault balance divided by the trailing 24-hour burn rate, in hours. Full permits hardware allowed by the Leash; Lean steps one class down and reserves GPU for essential jobs; Torpor is scheduled/payment-triggered CPU; Cyst is frozen compute with encrypted storage and wake on top-up. Implement the boundary conditions consistently with the final protocol definition.

## Services and data ownership

The supplied architecture uses Base contracts, Bun/Hono/tRPC control services, Postgres/Timescale, Redis/BullMQ, Go Host Kit, Rust metering and S3-compatible Cyst storage. The scheduler owns run transitions, settlement owns transaction columns and meter-ingest owns ticks. Preserve these ownership boundaries when wiring the UI.

Introduce API/auth configuration at one shared frontend boundary. A public API base URL is configuration; privileged service credentials remain server-side. Authentication, chain/provider configuration, CORS and operational environment variables are not implemented by this static frontend and should be supplied by the backend repository.

## Routing and validation

Deploy public page directories and assets as provided. Keep backend `/v1` requests out of the static fallback. Validate desktop, 390px mobile, keyboard dialog close/focus, More-menu scrolling, direct route loads, back/forward, persisted configurations, proof failures, budget/Leash validation and absent hardware availability. Reduced motion should continue to work. Existing static checks are `npm run check` and `npm run build`.

The handoff includes the original PDFs under `docs/reference/`, source for the adapted native animation engine under `src/runtime/`, authored app modules under `dist/`, asset provenance and both finished MP4s. Add your own backend and deployment configuration in the target repository.

## Revision 4 presentation modules

`dist/agent-panels.js` owns the per-capability icon and copy maps and extends each expanded grid to show the full set of seven capabilities. `dist/proof-chain.js` replaces the native guarantees layout with an interactive Snake-inspired proof chain; it is presentation state, not backend run state. Avoid mapping its collected-checkpoint counter to financial or verification state.

`dist/preload.js` prefetches the image manifest and prepares each page before reveal. `build-assets.mjs` regenerates that manifest and the page boot tags during `npm run build`. Preserve these modules when integrating server-side routing so the page readiness contract stays intact. The manifest contains local public image paths and no private data.

Research reference for the design mechanic: https://theoriginalsnake.com/how-to-play. The canvas artwork and Telomere layout are authored in the supplied source.
