# Owner-scoped Streamable HTTP MCP

`src/mcp/http.ts` adds a real HTTP MCP endpoint using the installed official `@modelcontextprotocol/sdk@1.32.1` Web Standards transport. Existing `scripts/mcp.ts` and its stdio server are unchanged. No new dependency, wallet signer, funding action, transaction broadcaster or paid-provider request is introduced.

## Protocol scope

This endpoint implements the SDK's **2025 initialize/session protocol era**, with `2025-11-25` as its latest negotiated version. The official [2025 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) permits JSON request responses and a 405 response for an unoffered standalone GET SSE stream. This implementation selects that bounded JSON mode: POST initialize, POST `notifications/initialized`, POST requests/notifications and DELETE session termination. Each accepted notification returns 202 with an empty body. Session identifiers are cryptographically random UUIDs. Unsupported or mismatched subsequent protocol headers receive 400. The negotiated version is retained when a legacy client omits that header.

The [current 2026-07-28 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) changed to per-request metadata and removed protocol-level sessions and the GET stream. That newer era is **not implemented by this pinned SDK or endpoint**. A modern client must support legacy negotiation/fallback. Merely using the name Streamable HTTP does not establish support for the newer era. No SSE event store, `Last-Event-ID` replay, server push or legacy HTTP+SSE endpoint is advertised.

The main owner server now advertises the application-defined `telomere://mcp/compatibility` JSON resource through the standard [2025 `resources/list` and `resources/read` methods](https://modelcontextprotocol.io/specification/2025-11-25/server/resources). It reports the installed SDK's negotiable versions, latest version, initialize/session transport mode, active paid-CPU or read-only profile, cookie authentication and external wallet submission boundary. It is available only inside an authenticated owner MCP session and carries no token, signer, wallet plan or owner data. A 2026 `server/discover` probe still receives the legacy endpoint's initialize-required error; clients with automatic legacy fallback may then initialize. This resource is **not** a 2026 `server/discover` response or a claim of 2026 protocol support: [modern discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) is tied to per-request metadata and stateless serving.

The [2025 base protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic) requires clients to use a fresh request ID for each new operation. This endpoint additionally tolerates an exact retransmission of an original HTTP read: equal ID and canonical message share one in-flight operation and its retained response; changing the message under that ID returns 409. This is an application transport safeguard, not a protocol promise of persistent exactly-once execution. Clients use new IDs to obtain fresh observations. Cache identity never crosses sessions, cookies or owners.

Initialize and ready notifications are validated before allocating a session or changing its ready state. Following the [2025 cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation), malformed cancellation payloads within an accepted JSON-RPC notification are ignored with empty 202; they cannot initialize a session or change its ready state.

## Root application integration

```ts
import { createTelomereMcpHttp } from './mcp/http.js';
import { TelomereClient } from './sdk/index.js';

const mcpHttp = createTelomereMcpHttp({
  publicOrigin: config.PUBLIC_ORIGIN,
  auth, // Existing Auth instance; its owner(cookie) performs database/allowlist checks.
  createClient: sessionToken => new TelomereClient({
    baseUrl: config.PUBLIC_ORIGIN,
    sessionToken,
    pins: reviewedDeploymentPins,
  }),
});
app.all('/mcp', context => mcpHttp.handle(context.req.raw));
// On shutdown, close MCP before waiting for outstanding HTTP connections.
await mcpHttp.close();
```

Exports are `createTelomereMcpHttp(options) -> { handle(Request): Promise<Response>, close(): Promise<void> }`, `createTelomereOwnerMcpServer(client)`, the explicit `createTelomereReadOnlyMcpServer(client)`, `McpHttpOptions` and `McpHttpLimits`. The client factory is trusted root integration and must create a fresh client bound to the supplied cookie and the exact reviewed public origin. A shared mutable owner client is inappropriate. An explicitly scoped in-process API fetch adapter may be supplied through the existing SDK options instead of making HTTP requests back through the TLS frontend.

Mount one exact path, retain the application security/rate middleware, bind the underlying server to loopback behind the reviewed TLS frontend and preserve its canonical Host. This module validates the request URL authority and Host against the configured origin; forwarded headers do not override them. It does not listen, deploy a frontend or configure TLS. It also does not add OAuth discovery, a Bearer/key bypass, x402 authentication or a browser sign-in flow. HTTP MCP uses the already authorized Telomere cookie model explicitly requested for this transport.

## Authentication and isolation

Every request with owner data uses the existing `Auth.owner` database lookup, including initialize, exact cached retries, GET and DELETE. Missing, malformed, duplicate or expired `telomere_session` cookies fail. A Bearer header is not a substitute. MCP sessions bind both the normalized owner and SHA-256 of the specific Telomere cookie. Another owner, or even a second login by the same owner, receives the same 404 as an unknown session. Expired/revoked authentication receives 401 before a stored response is exposed.

Origin must match the reviewed public origin when present, on every method. POST and DELETE require that exact Origin, preserving the existing application cookie/CSRF model. Cross-site browser fetch metadata is rejected. Wrong URL authority/Host is rejected independently, including real raw-HTTP DNS-rebinding attempts. No permissive CORS or cross-origin credential sharing is added. Responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Cookie values, upstream error details and private factory exceptions are not returned or logged by this module.

The default `/mcp` endpoint has 16 tools. Thirteen read configuration, session identity, balance, operations, Leashes, runs/run status, existing receipts/proofs, CPU prices, deadline history and application-agent lifecycle/evaluation. Three tools connect the **main controller's** existing paid CPU path: `telomere_quote` creates or replays a signed quote and checked unsigned `openRun` wallet plan, `telomere_admit_confirmed_run` admits the original onchain payment and starts bounded work, and `telomere_stop_plan` prepares an exact unsigned owner stop transaction. The existing `telomere_run_status` reads its state and accounting. Quotes are limited to the four reviewed CPU task kinds, 1–120 seconds and no new `nearPrompt`; admission can still start an original externally prepared provider quote, so its annotation marks charged work and an external effect. No tool signs, approves or broadcasts a wallet transaction. A receipt check only verifies existing evidence. Tool data remains untrusted application data.

`telomere_quote` requires an 8–128-character ASCII letter/digit/underscore/hyphen `idempotencyKey`. Reuse that key with identical inputs if a response is lost; a different workload under the key is rejected by the controller. A fresh MCP session rechecks the same durable quote and exact wallet calldata but gives the local wallet plan a new `planId`; the `planId` is not a payment identity. `telomere_admit_confirmed_run` requires the original `runId` and externally confirmed `txHash`; the controller checks ownership, the canonical onchain reservation, quote terms and Leash agent binding before queuing work. Retry only those original values after uncertainty. The stop plan merely returns calldata for external owner review; accepted work remains payable. The owner SDK checks quote signature, deployment pins, task hash, tariff, ceiling, expiry, chain, target and calldata before the MCP tool returns a wallet plan. The MCP quote input is limited to 4,000 combined elements within the HTTP envelope's 4,096-element bound; larger sort jobs use the direct API. A caller may still choose the explicit read-only factory in trusted server wiring.

## Bounds, retries and shutdown

Defaults are 64 sessions globally, four per owner, 15-minute idle expiry, one-hour absolute lifetime, 256 distinct RPC request IDs per session and four concurrent distinct calls per session. Initialization reservations are counted before asynchronous connection work, including per-owner limits. Failed initialization releases its slot. Expiry cleanup occurs when the endpoint is next accessed; session count stays bounded while idle. Reaching history capacity requires a new session rather than evicting IDs and silently re-executing an old request.

POST bodies are limited to 64 KiB both by declared length and actual streamed bytes, with a five-second total body deadline. JSON is decoded as strict UTF-8; a single bounded JSON-RPC object is required, with structural depth/element bounds, safe integer or bounded string IDs, and strict tool argument schemas. Compression and JSON batches are rejected. POST Accept must permit both JSON and SSE even though this server selects JSON responses. Responses are bounded to 1 MiB and retained replay bytes to 2 MiB per session. Concurrent pending responses can temporarily add at most the configured pending-count times the response bound. Configuration has hard upper limits; arbitrary client-supplied limit overrides are not accepted.

Calls have a 35-second transport deadline, compatible with the existing SDK's 30-second API deadline. The separately configured paid-session command tool on `/mcp/platform` has a reviewed 140-second deadline to cover its 120-second execution bound and 130-second API deadline; all other tools retain 35 seconds. MCP clients and the TLS proxy must also permit a response of this duration. A timed-out or response-overflowing session is retired and subsequent requests receive 404. If a response causes aggregate replay capacity to overflow, that response can complete and the session is retired; it is not falsely advertised as replayable. DELETE and shutdown promptly close transport requests and clear cached responses/session references. An already dispatched read can finish inside the existing API timeout; it cannot become a charged job. Client cookie strings live in ordinary JavaScript memory while the session's SDK client is referenced; no strong memory-erasure guarantee is claimed.

An HTTP disconnection alone does not cancel an accepted 2025-era request. An exact retry in the same live authenticated session receives the original in-flight/cached answer. Sessions and caches are intentionally in memory: process restart invalidates them, after which the client reinitializes. There is no claim of cross-process session recovery or durable replay. Existing stdio behavior remains separate.

## Full financial CPU tools (11 October)

When reviewed `PLATFORM_RUNTIME_CONFIG` is enabled, the main application also mounts **`/mcp/platform`**. Each MCP session receives a new `PlatformRuntimeClient` bound to its exact authenticated cookie and reviewed platform pins. Optional reviewed Vault configuration supplies separately scoped `PlatformVaultRuntimeClient` instances. This endpoint retains the installed SDK's 2025 protocol, cookie/Origin/Host checks, streamed bounds, session isolation and replay limits. It shares the main application's trusted socket-IP rate bucket with `/api` and `/mcp`; forwarded IP headers cannot bypass it. Without platform configuration, the route is absent.

`createPlatformMcpServer` in `src/mcp/platform.ts` exposes ten tools. An optional `vault` address selects the reviewed delegated-payer API; omitting it selects EOA payment. Vault quote/admission/session commands require its agent wallet, stop requires its human owner, and reads/refund plans/session events permit either. Clients verify actual API binding and pins; another Vault/owner is never selected from a tool-supplied cookie or private key.

| Tool | Effect |
| --- | --- |
| `telomere_platform_config` | Read reviewed pins, CPU capacity and optional Vault binding |
| `telomere_platform_balance` | Read actual available EOA or spendable Vault funds |
| `telomere_platform_runs` | Read bounded payer-scoped history |
| `telomere_platform_run_status` | Read one scoped run and financial accounting |
| `telomere_platform_quote` | Create/retrieve a durable signed quote and exact unsigned `openRun`/`payRun` plan; no payment or execution |
| `telomere_platform_admit_confirmed_run` | Admit the original `runId` and externally confirmed `transactionHash`; starts bounded paid work against that reservation |
| `telomere_platform_session_command` | Execute an idempotent command in an already paid CPU session; Vault mode requires its agent wallet |
| `telomere_platform_session_events` | Read ordered, bounded session events; Vault owner or agent may read |
| `telomere_platform_stop_plan` | Return an exact unsigned escrow/Vault owner stop transaction |
| `telomere_platform_refund_plan` | Return an exact unsigned escrow timeout-refund transaction |

Quote, admission and action-plan tools require an explicit `idempotencyKey` using the platform's 1..128-character ASCII letter/digit/colon/underscore/hyphen grammar. A session command uses its 1..64-character `commandId` as the exact HTTP idempotency key. Quote, admission and session command advertise `readOnlyHint: false`; reads and unsigned action plans advertise read-only. Financial plans pass through the reviewed SDK's signature, task/scope/deadline/fee and exact-calldata checks. No tool signs, funds, approves or broadcasts a wallet transaction. Admission is an explicit execution action and should only follow external confirmation of the original payment.

At most sixteen distinct normalized Vault clients are retained per server without eviction. Wrong client origin/Vault identity fails before exposing data. The SDK tool-input bound is 4000 combined elements, within the HTTP envelope's 4096-element limit; large sort tasks can therefore require the direct API instead. The platform API additionally enforces its 32 KiB body bound. Errors use fixed generic codes; raw API details, credentials and factory exceptions are not returned.

For this financial endpoint, a disconnect, cancellation, transport timeout or DELETE **does not roll back an already accepted API quote/admission**. An in-flight API action may finish within its own timeout after the MCP session closes. After reinitialization, read the original run or retry with the same durable operation key/input/confirmed hash. Never pay again merely because the MCP response was lost. MCP request-ID replay remains bounded and in memory; durable reservation/transaction recovery belongs to the platform API. Use a fresh JSON-RPC ID for a fresh state observation. Shutdown closes both MCP handlers before releasing the database.

The HTTP transport's optional trusted `createServer(client, sessionToken)` factory is used by root integration for `/mcp/platform`. The default `/mcp` factory creates the 16 owner tools above. Clients cannot request a different factory or elevate capabilities.

### One-shot command tasks (12 October)

The same quote tool accepts `task: { kind: 'exec', imageDigest, argv, stdin? }` only for capacity advertising `execEnabled: true` and that exact digest. The signed quote binds all arguments and stdin. Checked clients fetch current capacity before returning an unsigned payment plan. Commands execute once for at most 120 seconds with bounded stdout text; persistent Cells and streamed output remain separate work. There is no new command-dispatch tool: the original externally confirmed reservation still enters through `telomere_platform_admit_confirmed_run`. See [platform-exec.md](platform-exec.md) for exact bounds and recovery.

For an explicitly enabled persistent CPU session, the quote task is `{ kind: 'session', imageDigest, maxCommands }`. The signed reservation and original admission still precede execution. `telomere_platform_session_command` then forwards bounded `argv` and optional `stdin` with a stable `commandId`; `telomere_platform_session_events` pages its ordered output. This local 120-second session path does not establish a long-lived fleet Cell. See [platform-paid-sessions.md](platform-paid-sessions.md).

### Financial stdio entry point

Run `npm run mcp:platform` for the same ten tools over stdio. Supply `TELOMERE_API_URL`, an existing `TELOMERE_SESSION_TOKEN` through the local MCP launcher's environment, and `TELOMERE_PLATFORM_PINS_FILE` pointing to a reviewed **public** JSON profile:

```ts
// Save actual reviewed values as JSON; pins use platformPinsSchema.
{ pins: reviewedPlatformPins, vaultPins: reviewedVaultPins }
// Omit vaultPins to disable delegated Vault tools.
```

The profile is a bounded 16 KiB regular file with strict UTF-8 and schema checks; symlinks/hardlinks and controller-private extra fields are rejected. It never loads a signer key. The entry point requires an existing valid-format session, performs no demo login/funding, reserves stdout for MCP and emits fixed diagnostics to stderr. API authentication is still checked on calls. The original `npm run mcp` remains the pilot entry point.

`tests/mcp-platform.test.ts` uses the official paired MCP transport, real checked SDKs, authenticated HTTP fixtures and actual viem signature/calldata vectors. It checks ten-tool discovery, exact nonempty-proof quotes/plans, explicit admission/retries, strict inputs, current roles, tampering/redaction and Vault cache/factory bounds. `tests/mcp-platform-stdio.test.ts` negotiates the actual child-process stdio entry point and checks scoped API reads, unsigned plans and public-profile refusal cases. `tests/platform-main.test.ts` separately exercises the real main server, generated agent signatures, deployed local Vault contracts, exact `payRun`, cross-cookie/endpoint isolation, Origin, shared socket rate limiting and shutdown. Paid-session tests exercise command/event execution and financial settlement. These checks do not establish public deployment, GPU capacity or new Linux/gVisor Vault execution; consolidated results are recorded in `validation.md`.

## Acceptance evidence

The original read-only transport acceptance passed **14/14** using actual loopback HTTP, the official StreamableHTTP client and PGlite authentication/session rows. It covered initialize/list/call/terminate, owner/cookie isolation, Host and Origin checks, retry bounds, request validation, timeout and shutdown. The current HTTP suite passed **20/20** and also checks paid tool discovery, invalid paid inputs, cross-cookie write refusal, the explicit read-only factory, standard compatibility-resource discovery/read, and refusal of a 2026 probe without leaking metadata or allocating a session. The controller-platform suite passed **7/7** and exercises the default HTTP MCP against the actual main controller and local deployed escrow: checked signed CPU quote, stable-key replay, changed-input refusal, owner-submitted `openRun`, admitted run status and exact unsigned stop plan. The changed actual-main `/mcp` discovery case passed separately. The MCP case submits one local fixture owner payment; no public transaction or paid provider request occurs.

```powershell
npx vitest run tests/mcp-http.test.ts --reporter=verbose
npm run typecheck
```

Root mounts the endpoint with cookie-bound SDK clients and the existing trusted socket-IP rate limiter. The 9 October main-application integration and CPU executor-mode recovery guard passed **6/6 on Linux**, including real Auth, a generated owner, an onchain balance read and session termination without a signer transaction. The complete Windows regression at that checkpoint passed **643 tests, three POSIX skips, 39 suites**. Linux separately covered all three permission cases and passed the complete HostKit/controller batch **37/37** after restoring a missing fixture asset in the copied snapshot. See `validation.md` for consolidated evidence. Public TLS frontend/client distribution and funded public release acceptance remain separate checks.
