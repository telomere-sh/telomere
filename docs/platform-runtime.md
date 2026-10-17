# Full financial platform CPU runtime

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

This opt-in path connects the main Hono application to `PlatformRunEscrow`, registered HostKit capacity, full financial hourly receipts and `FeeRouter`. It uses its own database tables and dedicated signer. Existing pilot jobs keep their original escrow and receipt format.

## Actual flow

1. An authenticated EOA owner requests a bounded CPU task through `/api/platform/quotes`. An optional one-shot `exec` task additionally requires explicit host opt-in and its exact reviewed image digest. The controller checks the reviewed contract code and relationships, current Leash, live host registration/key/collateral/strikes, image/region allowlists, deadline and available funds. Capacity selection includes the rounded 9% fee and excludes zero-price candidates or candidates above the 250 USDC cap before the fee RPC and host ranking. This avoids calling a `uint96` fee function with an overflowing time-multiplied price. A sole invalid host returns the normal budget error.
2. The response contains the complete signed `PlatformQuote`, proofs and exact unsigned `openRun` calldata. The owner submits the transaction. Admission verifies its canonical escrow event and actual reservation before queueing work.
3. The controller persists the original signed host lease before admission and paired host ticks/control acknowledgments before ACK. Only reviewed immutable images are admitted; command leases additionally bind the exact argv and stdin. Production configuration accepts gVisor/Kata host responses; local subprocess fixtures require an explicit test-only client option.
4. A confirmed host cleanup and validated output become a durable financial outcome before root publication. Its leaf binds chain, escrow, run, host, payer, hardware class, region, image, workload, seconds, end time, inference charge and receipt hash.
5. After the Unix hour closes, the controller publishes its immutable tree, verifies the actual root/signing epoch/canonical transaction and submits the proof to `settleRun`. The contract closes host accounting, allocates the host price and fee, and returns the remaining reservation atomically.

This path runs four allowlisted CPU algorithms, explicitly enabled one-shot commands, or an explicitly enabled paid interactive CPU session for 10–120 seconds. The one-shot command bounds are documented in [platform-exec.md](platform-exec.md); the paid session protocol and private isolated-host acceptance are in [platform-paid-sessions.md](platform-paid-sessions.md). It has no inference charge. Hourly publication delays payment until the hour closes; the six-hour timeout refund remains independent of the controller.

## Recovery and bounds

The full host lease, paired evidence, original outcome and signed transaction bytes survive database restart. A running intent is recovered by stopping/reading its original lease, verifying already persisted evidence and confirming cleanup. It is never dispatched to a replacement host automatically. Uncertain execution blocks new work until original-lease recovery succeeds.

Quote preparation, paid admission and CPU dispatch check the dedicated signer's approved publication week, including a run whose hour closes in the next Unix week. A missing/different scheduled signer blocks new work before dispatch. This check does not block original-lease startup cleanup or owner refund access. The current configuration uses the same dedicated account for quote signatures, root transactions and settlements; a different weekly publication account needs a separate adapter.

Root and settlement transactions share one dedicated durable nonce lane. Signed bytes/hash/nonce are saved before broadcasting and independently revalidated on every retry. An uncertain response reuses the exact transaction. An unresolved or externally consumed nonce fails closed and requires operator reconciliation; deleting the journal is not a recovery procedure.

Sealing checks every admitted nonfinal run, including outcomes beyond the current 32-row processing page. A same-hour outcome must already have its exact durable receipt entry. Processing rotates pages so the 33rd outcome can progress. The runtime admits at most 256 unresolved runs, and each owner may have at most 64 active/prepared runs; expired unsubmitted quotes retain their original idempotency history without occupying active quote slots.

A legitimate permissionless third-party settlement is reconciled from a canonical escrow `RunSettled` event and the complete leaf/amounts, without a duplicate payment. Lookup starts at the canonical root publication and is bounded to 65,536 blocks in 2,048-block chunks. Older unresolved history requires operator review.

Completed/refunded responses are revalidated against chain evidence when read. Restart also revalidates the 256 most recently updated final rows. A lost finality marker becomes `reconciliation` with no claimed charge/refund. For a recoverable root/settlement reorg, the maintenance loop replays original signed intents for the same financial hour; it does not rerun CPU or rewrite the outcome. A stopped/expired reservation whose financial hour is already published is refused at admission and retains its timeout-refund plan.

An EOA owner can submit `openRun` and lose the subsequent HTTP admission request. The reservation remains `prepared` and is never dispatched merely because it exists on-chain. Recovery rotates through prepared EOA and Vault records, observes an onchain timeout refund and records the full return without launching work; restart preserves this result. Final records are revalidated on subsequent reads. The owner/refunder must still submit the permissionless refund transaction after the contract deadline. A prepared count alone does not prove an opened reservation.

## Operator configuration

Set `PLATFORM_RUNTIME_CONFIG` to an explicit private JSON file. Omitting it disables these routes. The file contains:

- `pins`: chain ID, escrow/token/quote signer/root/host registry/fee router addresses and the reviewed runtime code hashes of the latter four contracts.
- `signerKeyFile`: a separate bounded private file holding the platform signer key. It must differ from the pilot signer.
- `hosts`: one to sixteen reviewed CPU capacity records, each with `hostId`, `hostKey`, immutable `image`, matching `imageDigest`, region, price, reliability, availability, lane, allowlist proofs, `url` and `controlPemFile`. Optional `execEnabled: true` enables one-shot commands; `sessionEnabled: true` separately enables paid sessions for that reviewed image.

Configuration/key/control files must be bounded regular files without hardlinks or symlinks and private on POSIX. Endpoints require HTTPS or loopback without embedded credentials. Chain 31337 additionally requires a loopback RPC; Public Base requires mode-matched chain 8453 or 84532, canonical native Circle USDC and its reviewed proxy/implementation pins. Startup verifies all pinned deployed code and contract relationships. The default platform routes authenticate an EOA payer. An optional reviewed `vaults` configuration enables the delegated Vault adapter described below.

The existing application session, trusted Origin/CSRF, socket rate limiting and security headers apply to `/api/platform`. Public configuration omits host transport URLs and control files. Mutation bodies have an actual-stream 32 KiB bound and five-second deadline. The main application's earlier body buffer is bypassed for this namespace so an unfinished stream reaches the route deadline. Quotes/admission require an `Idempotency-Key`; owner stop/refund endpoints return unsigned exact calldata.

`PlatformRuntimeClient` in `src/platform-runtime/client.ts` is a Node SDK. It verifies deployment pins, current owner, task/deadline/region/image/price bindings, EIP-712 signature, fee ceiling and byte-exact calldata including both proofs. It never signs or broadcasts owner transactions. Separate Python platform clients support EOA and Vault payers as described below. The optional `/mcp/platform` and `npm run mcp:platform` expose the checked financial and paid-session API through ten MCP tools; see `mcp-http.md`. Browser work is outside the current backend delivery scope.

## Evidence

- `tests/platform-runtime.test.ts`: actual HostKit HTTP, real local subprocess execution, disposable Anvil contracts and disk PGlite; fee-inclusive conservation, stopped-work zero dispatch, owner/admission checks, original-lease recovery, journal integrity, third-party settlement and a real snapshot/revert financial recovery.
- `tests/platform-client.test.ts`: actual authenticated HTTP and contract-backed quotes; tamper/privacy/bounds checks and 33 real reservations processed across pages into a verified root and canonical settlements.
- `tests/platform-receipts.test.ts`: independent full-leaf equality, canonical root/proof/settlement, replay/late/privacy failures, signing epochs, journal reopen and same-byte reorg replay.
- `docs/platform-runtime-acceptance.md`: separate real Linux/gVisor main-application acceptance procedure and its recorded result. Subprocess test success alone does not establish isolation.

No public deployment, personal-wallet transaction, paid provider request, GPU cell or independent-region migration is established by this local runtime integration.

## Delegated Vault backend (11 October)

The project scope is backend only. An optional `vaults` object in the private `PLATFORM_RUNTIME_CONFIG` contains four reviewed pins: `registryAddress`, `registryCodeHash`, `implementationAddress`, `implementationCodeHash`. Startup checks both code hashes, the factory's implementation, and immutable token/escrow/controller/treasury relationships. Admission accepts only the exact EIP-1167 clone of that implementation whose owner, agent wallet, agent ID and Leash match the reviewed registry. Public configuration exposes these pins and binding, never a signing key.

The authenticated principal is the agent's EOA or its human owner; the payer is the Vault contract. Sign in through the existing challenge/verify API. Testnet still requires each principal in `PILOT_ALLOWED_OWNERS`. The backend never signs the agent's payment or owner withdrawal/stop transaction. The optional Node `PlatformVaultRuntimeClient` verifies the platform and Vault pins, caller role, signed quote, full fee ceiling, scope and byte-exact outer calldata before returning an unsigned transaction.

Endpoints under `/api/platform/vaults/:vault`:

| Endpoint | Authorized principal | Behavior |
| --- | --- | --- |
| `GET /config`, `/balance`, `/runs`, `/runs/:id` | Owner or agent | Reviewed binding, actual cash plus escrow available funds, and payer-scoped runtime records |
| `POST /quotes` | Agent | Active Selection/Leash checks and an unsigned Vault `payRun` transaction |
| `POST /runs` | Agent | Canonical successful outer `payRun` from the agent, exact quote/signature/proofs, matching Vault `RunFunded` and escrow `RunOpened` events |
| `POST /runs/:id/commands` | Agent | Execute an idempotent bounded command in an already admitted paid session while Vault and on-chain policy remain active |
| `GET /runs/:id/events` | Owner or agent | Read bounded, ordered paid-session events |
| `POST /runs/:id/stop` | Owner | Unsigned Vault `requestStop`, preserving its contract owner check |
| `POST /runs/:id/refund` | Owner or agent | Unsigned permissionless escrow `refundRun`; the contract still enforces timeout |

Every mutation retains the streamed body bound/deadline and idempotency requirement. Unknown Vaults and unrelated principals receive the same 404 response. New quotes require an active agent; a previously paid reservation can still be admitted after freeze/kill so the runtime can settle zero work and return its ceiling. The CPU dispatch and running monitor also check the actual Vault lifecycle. A temporary pre-dispatch policy/RPC failure leaves the original paid intent queued.

The original binding is persisted in a nullable migration alongside the financial runtime record. After canonical settlement or refund, the dedicated signer automatically calls permissionless `syncRun` through its existing durable transaction lane. The Vault records actual fee-inclusive burn, closes its original tracked run, and preserves returned funds. A separate canonical `vault_sync_tx` is retained. Financial status `completed`/`refunded` describes escrow finality; a `platform_vault_sync_*` error indicates that Selection accounting is still awaiting recovery. A sync failure never reruns CPU or fabricates a second charge.

Startup and maintenance retry unsynchronized final work and revalidate a rotating 32-record page of known finalizations. A third party's canonical finalization is accepted without a duplicate signer transaction. Lost sync finality is replayed using the original persisted signed bytes; lost financial settlement follows the existing root/settlement recovery first. The most recent 256 bindings/final rows are checked at startup; older records are checked on access and by the rotating maintenance page. Third-party sync evidence lookup is bounded to the latest 65,536 blocks in 2,048-block chunks; older unresolved history requires operator reconciliation.

If the agent paid `payRun` but disconnected before HTTP admission, the backend never starts that work automatically. It can observe a later actual timeout refund of the prepared reservation and close Vault tracking, including after database reopen. Removing reviewed configuration while Vault recovery remains unresolved fails startup closed. Main-app acceptance checks actual signed agent sessions, mounted routes, Origin rejection, stream timeout, code-pin startup failure and database release.

The new tests use disposable Anvil contracts, generated accounts, authenticated HTTP and real local CPU child execution. They do not establish a new public deployment or Linux/gVisor Vault acceptance. Existing isolated gVisor evidence remains applicable to the unchanged host execution protocol. Generic long-lived sessions, Cysts orchestration and supplier/GPU/TEE domains remain separate backend work; the browser remains the earlier pilot.

## Python platform clients (11 October)

`python/src/telomere_sdk/platform.py` exports separate `PlatformRuntimeClient` and `PlatformVaultRuntimeClient` implementations for the full financial API. They reuse the existing bounded `ApiTransport` and authenticated session. Configure reviewed platform pins, and Vault pins/binding for delegated work; see `python/README.md` for the shared sign-in example. Financial actions require an explicitly supplied `CryptoVerifier`; metadata, balance and validated run reads can use the dependency-free core. Neither client signs or broadcasts a wallet transaction.

Before returning an unsigned intent, the clients independently check the current principal, configuration, task digest, EIP-712 quote signature/domain, scope, deadline, rounded 9% fee ceiling and exact ABI encoding, including both dynamic proof arrays. Cached quotes retain their original input and recheck the session and expiry. Bounds include 32 KiB requests, 1 MiB responses, 64 proof siblings, 128 returned runs and 128 distinct attempted quote keys per client. Keys retain the existing Python transport's 8..128 ASCII letter/digit/underscore/hyphen subset.

`python/tests/fixtures/platform-typescript.json` is generated from real viem signatures/calldata and deterministic public test identities. Python compares the typed digest, signature recovery and exact calldata with those vectors, plus an independent `eth_abi` oracle at 0, 1 and 64 proof siblings. Unicode tasks, wrong signing domains/keys/chains, strict integer bounds, fee/calldata tampering, cached authorization and actual cookie/Origin transport are covered. The 11 October Python suite passed 77/77 with crypto; its dependency-free run passed 44 with 33 explicit optional skips. The 12 October one-shot command extension passed 87/87 with crypto, or 48 passed with 39 explicit optional skips without crypto. These are local SDK checks, not a new live/public financial acceptance.

The 13 October paid-session extension adds strict session capacity opt-in, EOA/Vault command and event methods, response bounds, role checks, exact command-ID retries and a command-specific 130-second request allowance. The full crypto-enabled Python suite passed 124/124 locally. This is client/transport evidence; actual paid session execution and settlement are evaluated separately.
