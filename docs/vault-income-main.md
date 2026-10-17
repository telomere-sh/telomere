# Optional inbound Vault payment receipt

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

The main server can expose one fixed-price, exact EIP-3009 payment into one independently reviewed PlatformAgentVault. It is disabled unless `VAULT_INCOME_CONFIG` names a private reviewed JSON file. No public deployment, payment request or USDC capability profile is supplied or enabled by this implementation.

This resource issues an inbound payment receipt. It executes no agent job. Its successful JSON is exactly:

```json
{"kind":"vault-payment-receipt","agentId":"0x…","vault":"0x…","asset":"0x…","grossAmount":"101"}
```

The standard `PAYMENT-RESPONSE` header contains the freshly checked settlement response and transaction hash. Canonical Selection `Income` or `Subsidy` events determine classification. The JSON does not assert income, subsidy, fee or net proceeds.

## Routes and authorization

| Route | Authority and behavior |
| --- | --- |
| `POST /x402/vault-income` | UTF-8 JSON empty object, with the exact request bytes bound into the challenge. Without `PAYMENT-SIGNATURE`, returns HTTP 402 and `PAYMENT-REQUIRED`. A valid external payer signature authorizes only the configured exact amount, token, Vault and request. Cookies and Authorization headers are removed before the paid-resource handler. |
| `GET /api/payments/vault-income/supported` | Existing Auth session, independently confirmed current owner or actual agent wallet. |
| `POST /api/payments/vault-income/verify` | Same owner/agent session; standard x402 request envelope, fixed reviewed terms, read-only verification. |
| `POST /api/payments/vault-income/settle` | Same owner/agent session; standard x402 envelope and original payer authorization. Existing global API Origin policy applies. |

The existing Auth allowlist still applies in either public Base mode. A dedicated facilitator key is never used as the agent's identity or endpoint-control signing key. Frozen, Dormant and Dead agents retain access to historical canonical receipt recovery; the actual native Vault rejects new income classification after Death.

The existing endpoint declaration verifier uses GET 402 plus an actual agent-signed control proof. This POST-only receipt resource is not automatically a verified endpoint declaration, an agent-controlled commercial service or integrated service execution. Those workflows remain separate.

## Paid-run boundary

The payment authorization moves an exact amount from its original signer into the agent Vault and atomically records `Income` or `Subsidy`. It contains no `runId`, workload hash, host, quote, Leash or refund condition. `PlatformAgentVault.payRun` is a separate call authorized by the agent wallet or controller; the external x402 payer cannot authorize or force it. The platform runtime accepts a run only after verifying the separate `payRun` transaction and its signed quote. Consequently, a successful inbound receipt is **not** a reservation, promise of compute or proof that this payer funded a particular run. A later run could fail capacity, budget, scope or deadline checks while the earlier income remains in the Vault.

The generic x402 resource helper persists an execution intent and calls its resource executor before settling the payer transfer. This mount gives that helper only a static receipt result. Pointing it at paid CPU execution would allow work to start before payment finality, so the helper must not be reused as a paid-run endpoint without a different admission protocol. A true pay-to-run flow needs an agent-authorized workload/quote, an onchain operation that binds the payer authorization to that exact Vault reservation and rolls both back together, durable recovery of its original transaction, and an explicit refund policy if dispatch fails after reservation. None of those obligations is supplied by this receipt route.

## Private configuration

The profile is strict JSON with these fields:

| Field | Bound |
| --- | --- |
| `pins` | Native `VaultIncomePins` from [the atomic ingress contract](vault-income.md): exact token/domain/code, Selection registry and Vault implementation code, chain, confirmation depth, agent, Vault, treasury and dedicated facilitator. Permit2/up-to fields are refused. |
| `facilitatorKeyFile` | Absolute private file containing exactly one 66-character `0x` private key. No newline or BOM. |
| `resourceUrl` | Exactly `PUBLIC_ORIGIN + /x402/vault-income`, canonical and without query or credentials. |
| `grossAmount` | Decimal token base units, strictly positive and less than `2**96`; fixed per profile. |
| `maximumChallenges` | Optional integer 1–10000, default 10000. Counts all retained challenges, including expired and consumed rows. At capacity, new challenges fail with 503; existing verification, settlement and recovery remain available. There is no automatic evidence garbage collection. |
| `localFixture` | Optional false by default. True requires demo mode, chain 31337, HTTP and literal `127.0.0.1` or `[::1]` resource/RPC hosts. Outside this explicit fixture, the profile requires the matching Base mainnet or Sepolia mode and HTTPS. |

The profile is at most 8192 bytes; the key file at most 80 bytes. Both must be regular, singly linked files with no symlink ancestors and stable pre-open, descriptor and post-read identities. POSIX requires the effective owner and exact mode 0600. Windows requires a non-null canonical DACL, trusted owner and Allow entries restricted to the current user, SYSTEM and Administrators. Missing or ambiguous ACL evidence fails closed. Errors disclose no file contents, private paths or ACL identities.

The facilitator must be a dedicated EOA distinct from the current Selection controller/treasury, bound owner/agent, bridge signer, optional platform signer and demo signer. A retained legacy token-transfer or different-Vault journal for that signer prevents startup. Startup performs read-only canonical chain/code/token-domain/native-selector checks and closes the store without opening a listener on failure.

## Bounds and recovery

Both mounts reject query parameters, ambiguous JSON, malformed UTF-8, more than 40 headers or 8192 total header bytes. POST bodies have an 8192-byte cap and retained five-second streamed deadline before chain authority checks. The public mount shares the API's trusted socket rate bucket; forwarded identity headers are not trusted. RPC transport has its own retained headers/body deadline and bounded JSON response.

The existing X402PaymentService owns the durable journal. Signed transaction bytes, hash and nonce are committed before broadcast. Retries and restarts preserve those bytes. Reorgs or insufficient confirmations withdraw prior HTTP success until the original transaction becomes canonical again; another transaction consuming the payer authorization requires reconciliation and is never silently adopted. See [native conservation and deployment boundaries](vault-income.md).

`/api/config` exposes only `vaultIncomeAvailable`. `/health/ready` rechecks the configured deployment. No private key/profile data appears in public configuration.
