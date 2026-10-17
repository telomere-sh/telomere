# x402-funded CPU reservations, version 1

This opt-in backend path uses an explicit **Telomere CPU reservation extension** to x402 v2. A signed payment funds and opens a particular bounded CPU reservation in one EVM transaction. It is separate from x402 Vault Income and from the previously tested generic facilitator/resource module.

The implemented profile is an EOA payer, one-shot CPU task or reviewed command image, a maximum of 120 seconds, receipt-v1 and the original 9% ordinary-host fee. Vaults, spend permissions, economics-v2, receipt-v2, persistent sessions, Cyst file input, inference and sealed/GPU hosts are unsupported on this path. The runtime rejects unsupported combinations before issuing a payment challenge.

This is local implementation and acceptance evidence. It does not establish a public deployment, funded Base transaction, public wallet approval, GPU/TEE execution or launch readiness. The current evidence and source boundaries are in [the validation record](x402-cpu-reservations-validation-2026-10-15.json).

## Payment semantics and compatibility

Both schemes debit the **entire conservative reservation ceiling before execution**. The existing escrow settlement charges actual accepted CPU work and its fee. Unused funds become the original EOA's withdrawable escrow balance. Timeout refunds also return the full reservation to that EOA's escrow balance. They are not automatically transferred into the wallet.

| Scheme | Signed authorization | Atomic funding path | Compatibility boundary |
| --- | --- | --- | --- |
| `exact` | ERC-3009 `ReceiveWithAuthorization` | The new escrow receives the exact ceiling, then opens the run | Explicit Telomere extension; generic exact clients signing `TransferWithAuthorization` are rejected |
| `upto` | Official Permit2 `PermitWitnessTransferFrom` | The new escrow calls the official x402 Upto Proxy for the exact ceiling, then opens the run | Uses the standard signed witness structure, but upfront reservation and subsequent escrow refund differ from generic post-request actual settlement |

The mandatory `telomere-cpu-reservation` extension states the signature primary type, run/quote/request/Leash hashes, upfront ceiling, EOA refund beneficiary and external-wallet gas requirement. There is no unsupported-client fallback. An HTTP intent response is not a successful payment or a completed CPU result.

For `upto`, the signed token maximum is bounded by the owner's requested maximum and the 250 USDC run cap. Only the actual ceiling is pulled. Existing ERC-20 approval to Permit2 is required and remains a separate owner-wallet action. This implementation creates neither that approval nor a payment transaction automatically.

For example, a 25-second reservation at 100 token base units per second has a 2,500-unit CPU ceiling and a 225-unit fee ceiling, so 2,725 units are reserved. Final billing comes from the accepted host meter evidence, with the remaining reservation credited to the original EOA.

## Separate deployment and cryptographic scope

`PlatformX402EscrowV1` uses `TelomerePlatformEscrow` quote domain **4**. Original domains 1, 2 and 3, historical contracts, signed fields and prior balance/spend-permission input schemas remain unchanged. The new `x402CpuProfile` is mutually exclusive with economics and spend-permission profiles.

The reviewed profile pins the escrow, token/proxy implementation, receipt root, host registry, fee router, Permit2 and x402 Upto Proxy runtimes and relationships. Outside the disposable local chain, native Base USDC and canonical Permit2/proxy addresses are required. A canonical address is not itself a claim that its code provenance or a particular public deployment has been accepted; operators still need reviewed runtime pins.

The local fixture uses the retained upstream Uniswap Permit2 bytecode and unchanged upstream x402 Upto Proxy source. Their commits, source hashes, compiler and local artifact provenance are retained in `tests/fixtures/x402-reference/provenance.json`. Its local compiled artifact is not claimed to equal every canonical public runtime. The exact fixture is a distinct local receive-capable ERC-3009 token; it is not production USDC and does not modify the older transfer-only test token.

The authorization nonce binds the chain, new escrow, domain-4 signed quote, complete execution-time Leash terms hash, fixed HTTP resource/request hash, random challenge salt and selected scheme. The quote binds the original payer, Leash, host, resource/image/workload hashes, duration, prices and expiry. The exact ERC-3009 authorization also fixes sender, escrow recipient, amount and window.

The Permit2 witness has `spender = x402 Upto Proxy`, `witness.to = escrow` and `witness.facilitator = escrow`. A separate EOA cannot extract the authorization and settle it directly through the proxy. The exact path uses `receiveWithAuthorization`, whose payee check prevents extracting a transfer and consuming it outside the escrow wrapper. Cancelled or used nonces never substitute for a funded opening or generate free escrow credit.

Any outer relayer may submit the exact signed atomic reservation. If another account mines an identical authorized call first, the owner can admit that actual successful transaction hash. An owner duplicate may revert; this does not justify a fresh payment or nonce. Ordinary balance-funded opening retains its owner/agent caller checks.

Funding, full-ceiling credit, Leash/cap validation, run reservation and host admission are atomic. A later failure reverts token movement and authorization consumption together. Every money-moving entry is guarded against reentrancy. A funding callback cannot alter the same EOA-owned Leash through owner-only mutations.

## HTTP and Node SDK

The configured resource is `POST /api/platform/cells`, fixed from the trusted `PUBLIC_ORIGIN`. It requires the normal authenticated owner session and origin policy. Request bodies are limited to 32 KiB with a five-second streaming deadline. The financial body and payment header reject ambiguous JSON, invalid UTF-8, conflicting payment sources and unsupported extension values.

The body contains `request: { input, scheme, extension: "telomere-cpu-reservation-v1" }`. `input` retains the existing one-shot quote fields. The same `Idempotency-Key` and canonical original request must be retained throughout the flow.

1. The first request durably retains a challenge and its prepared run, then returns HTTP 402, `PAYMENT-REQUIRED` and the full reviewable challenge. The request hash covers `POST`, the fixed resource URL and the canonical original `request` object; the later authorization envelope is excluded.
2. `X402CpuReservationClient` verifies the quoted owner, workload, selected host/image/region, prices, ceiling, expiry, disclosure, domain-4 signature and independently supplied deployment pins. It supplies the exact typed-data primary type for the external wallet.
3. A signed retry carries the mandatory extension in `PAYMENT-SIGNATURE` or the body `payment`. Matching copies in both locations are allowed; conflicting values are rejected. The server verifies the original signature, Leash scope, current pins and a real read-only simulation before retaining the first intent hashes.
4. The response is an unsigned external-wallet transaction plan. The backend does not sign or broadcast it. The wallet, or an authorized external relayer, supplies gas and submits the exact call.
5. The client submits the successful transaction hash through the existing run-admission endpoint. Canonical original funding must be verified before the run enters the CPU queue. Normal run reads, stop/refund plans, execution receipts and settlement then apply.

`X402CpuReservationClient` exposes `challenge`, `typedData`, `payment`, `intent` and `admit`. The existing `PlatformRuntimeClient` and ordinary `/quotes` response remain compatible. The ordinary quote endpoint cannot submit or invent x402 funding metadata; x402 metadata is created by the server alongside the original input.

## Durable recovery and financial authority

The lifetime challenge inventory is bounded at 4,096 records globally and 64 per owner, including failed drafts. Records are retained. The journal binds owner, original idempotency key/input/request hashes, resource, scheme, random salt, run ID and immutable payment/intent hashes. It stores no payment signatures, private keys, raw signed wallet transactions or transaction calldata. The caller resupplies the same payment to reconstruct the exact original intent after response loss. The returned calldata itself contains a scoped signed authorization and must be handled privately.

Repeated requests retain the original quote, challenge and nonce after expiry, cancellation or uncertain external submission. A cached intent is reported as `retained_external_wallet_intent`; it is not a claim that the nonce remains usable or that payment succeeded. A different signature/payload/intent conflicts with the first retained hashes. There is no automatic nonce cancellation, fee replacement, new authorization, alternate run or payment relay.

Admission verifies the exact original selector/calldata hash, receipt and transaction identity, canonical block, public confirmation depth, historical escrow/token/Permit2/proxy pins, unique matching funding/opening/use evidence, immutable run fields and exact payer-to-escrow token conservation. Historical Leash binding comes from the original calldata and enforced funding event, allowing legitimate Leash updates after opening, including later in the same block.

The controller retains the originally selected funding method. Its shared opening guard is used before reads/admission/dispatch, during running-work monitoring, before persisting outcomes, and before financial reconciliation, receipt publication and settlement. The same guard protects the existing domain-3 spend-permission path. A reorg followed by a balance-funded replacement of an identical quote does not authorize the earlier funded outcome. Financial state is held for reconciliation and the task is not dispatched again.

For an external transaction with an unknown hash, used authorization state alone is insufficient. The owner must retain and supply the actual successful atomic-opening hash. Unknown unadmitted x402 refunds are not automatically classified as successful payments. Independent on-chain stop/timeout refund and owner withdrawal remain available; this version has no automatic external-transaction discovery or operator endpoint that fabricates missing funding evidence.

Pure payment schemas/constants live in dependency-leaf modules. Quote schemas do not import chain-proof readers; fresh native ESM import-order tests protect this boundary.

## Sources

The ERC-3009 [security considerations](https://eips.ethereum.org/EIPS/eip-3009#security-considerations) explain why contract wrappers use the receive authorization. The official [Permit2 signature-transfer reference](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer) describes witness-bound one-time transfers. Retained x402 upstream exact/upto specifications and proxy source are pinned through the local provenance manifest.
