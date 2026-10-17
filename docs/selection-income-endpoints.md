# Selection income endpoint declarations

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`src/selection/income-endpoints` implements durable owner declarations and a read-only verification flow for x402 service endpoints belonging to actual PlatformSelection agents. It addresses Backend §9's requirement to declare income endpoints. It does not execute a payment, classify a transfer, charge a fee, increase income, or submit reputation.

The API reports three separate facts:

| Field | Meaning |
| --- | --- |
| `declared` | The registered Selection owner has an active declaration for this exact URL and revision. |
| `controlVerified` | A recent actual HTTP response supplied the exact issued challenge signed by the registered agent key; its Selection authority and recorded block remain canonical. |
| `termsMatchReviewedProfile` | That response's x402 v2 offer contains a supported `exact` or `upto` offer with this URL, configured network and asset, and this agent's Vault as `payTo`. |

Every view also says `incomeCredit: "none"` and `paymentCapabilityVerified: false`. Offer matching does not establish EIP3009 support, Permit2 deployment/allowance, asset solvency, service delivery, or earned revenue. A valid control proof with missing or different x402 terms remains `controlVerified: true` and `termsMatchReviewedProfile: false`.

## Private reviewed configuration

The optional `INCOME_ENDPOINTS_CONFIG` points to a private JSON profile. Omission disables the module. The loader accepts one bounded regular file, rejects duplicate JSON keys and malformed UTF-8, checks file identity around open/read, and requires a single link and private POSIX permissions. The maximum profile size is 8 KiB. Symlinks, directories, unsafe permission modes and a file changing during the read are rejected.

The profile has these fields:

| Field | Constraint |
| --- | --- |
| `pins.chainId` | Matches the configured runtime chain. |
| `pins.selectionRegistryAddress`, `pins.selectionRegistryCodeHash` | Independently reviewed PlatformSelection deployment and runtime hash. |
| `pins.vaultImplementationAddress`, `pins.vaultImplementationCodeHash` | Independently reviewed fixed PlatformAgentVault implementation and runtime hash. |
| `pins.confirmations` | 1–64 outside explicit local fixtures; either public Base mode requires at least 1. |
| `network` | Exactly `eip155:<pins.chainId>`. |
| `asset` | Matches runtime `TOKEN_ADDRESS` and the actual Selection registry's immutable token. |
| `allowedOrigins` | 1–32 distinct exact HTTPS origins, with no wildcard, credentials, path, query or fragment. Private operator policy, omitted from public API configuration. |
| `localFixture` | Defaults false. True requires demo mode, chain 31337 and a literal loopback RPC. HTTP endpoint origins are then allowed only for literal `127.0.0.1` or `[::1]`. |
| `challengeTtlSeconds` | 30–300, default 300. |
| `verificationTtlSeconds` | 60–3600, default 900. |

Startup checks RPC deployment bindings. It does not contact declared service endpoints, sign, or broadcast a transaction. The operator allowlist restricts possible probes; it does not itself establish endpoint ownership or eliminate DNS attacks.

## Independent Selection authority

`RpcIncomeEndpointReader({rpcUrl,pins,asset})` requires no CystRegistry, Cysts storage, API-origin signer or wallet. It reads actual PlatformSelection and PlatformAgentVault state through an independently configured RPC.

The authority anchor is `head - confirmations`. Code and contract state reads use EIP1898 `blockHash` plus `requireCanonical`; an RPC without that support fails closed. Registry and implementation code are checked at the observed head and confirmed anchor. The reader verifies Selection's token and implementation address, the implementation's token/escrow/controller/registry/treasury bindings, the exact EIP1167 clone code, registered wallet/Vault mappings, and clone owner/agent/id getters. Clone code is checked at the head as well as the confirmed anchor. Block number, hash, timestamp and retained confirmation depth are checked again.

Owners authorize declare, challenge, verify and revoke through the existing authenticated cookie model. The registered agent may read its declarations; its signature proves endpoint control but does not substitute for owner mutation authority. Outsiders cannot read or mutate another agent's collection. Alive, dormant and frozen agents may publish endpoint evidence. Death invalidates verified status and prevents new declarations/challenges/verification; the actual owner can still revoke.

## API

The main application mounts these routes under `/api/selection/income-endpoints`, retaining existing Origin, authentication and trusted socket-IP rate middleware. This prefix is separate from the public Selection dataset routes. Mutation bodies have their own streamed 8 KiB bound and five-second total deadline, so the application does not buffer them in the global body limiter first. Invalid UTF-8, duplicate JSON keys, extra fields and query parameters are rejected.

| Method/path relative to the prefix | Input/result |
| --- | --- |
| `GET /config` | Public module description for an authenticated principal; deployment pins, network/asset, time limits and explicit no-income/no-payment-capability flags. |
| `GET /agents/:agentId/endpoints` | Owner/agent's bounded declaration collection. |
| `GET /agents/:agentId/endpoints/:endpointId` | Fresh declaration and verification view. |
| `POST /agents/:agentId/endpoints` | `{url,expectedRevision}`; a new URL requires `"0"`, redeclaration requires its exact current revision. |
| `POST /agents/:agentId/endpoints/:endpointId/challenge` | `{expectedRevision}`; returns `{challenge,message}`. |
| `POST /agents/:agentId/endpoints/:endpointId/verify` | `{expectedRevision}`; performs the explicitly requested bounded HTTP probe and returns a fresh view. |
| `POST /agents/:agentId/endpoints/:endpointId/revoke` | `{expectedRevision}`; revokes the declaration and invalidates its proof. |

Every POST requires `Idempotency-Key` containing 1–128 ASCII letters, digits or `._:-`. The durable key is scoped to its authenticated principal and bound to operation, complete input and reviewed profile. Reusing it with other input returns 409. Replaying an accepted operation returns the current view; it cannot resurrect expired or revoked verified evidence or repeat a completed HTTP verification.

`endpointId` is the SHA256 digest of the canonical `{agentId,url}` binding. Declare/redeclare and revoke increment the same uint64 revision monotonically. Every mutation checks its expected revision under a database lock. Revoke, redeclare, challenge replacement and another successful verification win safely against an in-flight probe; its stale result cannot be stored.

## Agent proof and actual HTTP probe

The returned challenge contains exactly:

```text
protocol, chainId, selectionRegistryAddress, agentId,
owner, agentWallet, vault, url, revision, nonce, expiresAt
```

`expiresAt` is an integer Unix second. `nonce` is a fresh random bytes32. The agent signs the exact EIP191 message returned by the API, also constructible with `incomeEndpointProofMessage(challenge)`: the prefix `Telomere income endpoint control v1` plus a newline and recursively key-sorted canonical JSON of the validated challenge. This signature grants no token transfer or compute permission.

The declared exact URL responds to GET with HTTP 402, UTF-8 JSON, and:

```text
body: {proof: {challenge: <exact issued object>, signature: <agent EIP191 signature>}}
PAYMENT-REQUIRED: base64-encoded x402 v2 offer JSON
```

The verifier sends only `Accept: application/json` and `X-Telomere-Verification-Nonce`, plus the HTTP stack's Host/connection headers. It sends no challenge signature, cookies, authorization, payment header or body. Simply echoing the received nonce cannot satisfy the proof. The actual agent key must sign the full context and the endpoint must serve it.

Production probing uses an actual Node HTTPS connection. Every DNS answer must be public; private, loopback, link-local, metadata, carrier-NAT, unspecified, multicast, reserved/documentation, IPv4-mapped IPv6 and tunnel ranges are refused. One checked address is pinned through the connection's lookup callback, while the original hostname remains the Host/TLS server name. The connection disables agent reuse, verifies TLS certificates, follows no redirects and accepts no compressed response. Explicit local fixtures have only the narrow literal-loopback exception.

The probe has a five-second total deadline covering DNS, connection, TLS, headers and body; headers are limited to 8 KiB and combined header/body bytes to 32 KiB. JSON is bounded, strict UTF-8 and duplicate-key checked. Multiple payment headers, redirects, invalid encoding, oversized responses and unfinished bodies fail. No probe runs on startup, declaration, challenge creation, listing or reading.

## Freshness, persistence and limits

A stored verification preserves the signed proof, observed terms digest, reviewed profile hash, confirmed chain anchor and observation/expiry time. Its expiry is the earlier of observation plus `verificationTtlSeconds` and the signed challenge's expiry. Defaults therefore provide at most five minutes of verified evidence. A future observation time, backward controller clock, expired evidence, changed profile, changed agent authority, declared death, lost confirmation depth or orphaned anchor cannot retain verified status.

Each response checks current independently confirmed authority and rechecks its canonical anchor. HTTP verification checks authority again after the probe, before the locked compare-and-set. Read-only RPC outages fail closed; the service cannot convert an unavailable authority into a positive claim. Verification is a dated observation, not continuous monitoring or proof that a future response will retain the same terms.

The declaration collection is limited to 16 records per agent and 10,000 globally, including revoked records. The immutable operation journal is limited to 20,000 entries. Limits return 503 rather than silently deleting idempotency history. The service does not currently supply journal pruning, arbitrary marketplace verification, continuous endpoint monitoring, application egress enforcement or SDK/MCP methods.

## Financial integration boundary

Current x402 payments call the token's EIP3009 transfer or the upstream Permit2 proxy directly. Sending such a transfer to an existing Vault does not call `receiveFunds` and remains unclassified. Passing funds through an adapter and then calling `receiveFunds` would instead classify the adapter as the payer, losing existing owner/family/platform source exclusions. This module does neither.

A future classified ingress requires an atomic onchain transfer/classification path that preserves the cryptographically authorized original payer, exact transfer amounts, one-use reference, source exclusions and existing income fee. HTTP verification or a facilitator callback cannot create onchain income credit.

## Local acceptance

`tests/selection-income-endpoints.test.ts` uses actual PlatformSelection and PlatformAgentVault contracts on disposable Anvil, actual authenticated HTTP, actual endpoint GETs and filesystem-backed PGlite reopen. It exercises proof context/signature/replay/expiry, separate terms matching, durable idempotency/CAS/revoke/redeclare, canonical reorg invalidation, frozen/dormant/dead behavior, code/token/dependency rejection, request/response bounds, duplicate JSON, timeout, redirect and special-use address policy. Public-IP classification cases contact no public addresses; a localhost DNS case proves private resolution refusal before a connection.

Main-application and private-profile loader acceptance are recorded separately. This is local implementation evidence; no public Base deployment, funded transaction or paid provider request is claimed.
