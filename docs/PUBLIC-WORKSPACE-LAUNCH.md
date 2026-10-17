# Public Workspace launch

Entry point: https://telomere.sh/dashboard/. The supplied Workspace keeps its authored CSS, HTML, assets and motion modules. Its JavaScript now connects to the controller through same-origin APIs.

## Accounts and data

`WALLET_ACCESS=public` enables wallet message sign-in. The default remains `allowlist` for private installations. The server verifies a five-minute, single-use challenge bound to its domain, URI, address and chain. The eight-hour session cookie is HttpOnly, Secure on HTTPS and SameSite Strict. Signing in does not transfer tokens.

Workspace documents live in PostgreSQL under the authenticated wallet address. Clients cannot choose a different owner. Conditional revisions reject conflicting saves. An expected-owner request header and cross-tab session notifications prevent stale tabs from writing into a replacement wallet session. Account changes clear displayed private data and pending forms. Browser storage retains only an owner-scoped transaction journal; user-initiated funding, policy and reservation transactions require wallet approval. Runs settle within their approved ceilings.

The interface reads escrow balances, confirmed Leashes, run status, charges, refunds, signed receipts and encrypted snapshots from the backend. Funding, withdrawal, Leash creation/update/revocation and CPU reservation use explicit wallet transactions. An ambiguous submission stays journaled and blocks resending. “Check pending transactions” checks confirmation and retries admission using the original hash.

Run plans, Cyst policies, agent profiles, host profiles, preferences and imported receipt records are saved as private account metadata. These records remain distinct from confirmed execution and verified receipts. The live CPU action offers the deployed executor's admitted tasks and shows a fresh quote before reservation approval.

Application snapshots are encrypted in the browser with XChaCha20-Poly1305. Recovery keys are downloaded separately and never sent to the server. Restoring downloads the authenticated plaintext to the owner's device.

## Deployment and capacity

The controller uses Base mainnet, native USDC and the existing escrow `0x27c1e35F563Aa4f57a68B192d88a76c25e68e0db`. The operator signer remains `0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38`. Account funds belong to the wallet; the operator signer pays settlement gas.

Public admission is bounded to 64 outstanding quotes/active runs globally, eight per owner and 500 new run records per owner per day. Paid queue admission also enforces the active-run limits. Each admitted CPU run has a maximum of 120 seconds. Snapshots retain the existing per-owner quota and have a one-GiB aggregate reservation cap in this deployment. These bounds describe one VPS, not an unlimited concurrency guarantee.

The release installer backs up the application database, profile, activation, systemd unit and Nginx configuration. It verifies runtime file hashes, the original finalized deployment and immutable contract/asset/signer pins. An unsuccessful rollout restores the previous application and configuration without restoring an older database over newer writes. The enabled systemd controller restarts on failure and verifies activation before starting.

## First live paid acceptance

1. Open the Workspace in the OKX Wallet DApp browser. Connect the funded Base wallet and sign the login message.
2. Under **Overview → Base account**, deposit **1 USDC**. Approve the exact token amount and then the escrow deposit. The USDC goes to the owner's escrow balance, not the operator gas wallet.
3. Create a Leash with an hourly limit of **0.01 USDC**, daily limit **0.05 USDC**, CPU hardware and expiry within 30 days.
4. Save a CPU / Standard run plan attached to that confirmed Leash. Open the plan and select **Review CPU run**. Choose SHA-256 and a maximum of **20 seconds**.
5. Review the signed quote, then approve the reservation in the wallet. The current CPU price is 100 atomic USDC per second, so that reservation ceiling is **0.002 USDC**, plus ETH network fees.
6. Wait for settlement. Open the execution record and verify its signed receipt and anchored settlement. Check the charge and unused-funds refund in the escrow balance. A separate withdrawal returns available USDC to the wallet.

The wallet holder completed the first mainnet reservation on 17 October 2026. The SHA-256 task returned the expected result in 170 ms. The meter rounds down to whole running seconds, so this run charged zero USDC and returned its full 0.002 USDC reservation. The escrow balance returned to 1 USDC. The operator signature, meter tick hashes, canonical settlement transaction, on-chain receipt hash and refund event were verified. See `evidence/base-paid-cpu-20261017/verification.json` and its signed receipt. No minimum charge was introduced.

The second owner-approved mainnet run exercised a nonzero charge on the same day. One million hash-chain iterations completed in 4301 ms and matched an independently recomputed result. Four full seconds at 100 atomic USDC per second charged 400 atomic USDC (0.0004 USDC); 1600 atomic USDC (0.0016 USDC) returned from the 0.002 USDC reservation. The canonical settlement event and a single native USDC transfer from escrow to treasury confirmed the charge. Available escrow funds were 0.9996 USDC with no remaining reservations. Signature verification, on-chain receipt-hash binding, meter validation and the deterministic settlement journal all passed. See `evidence/base-paid-cpu-positive-20261017/verification.json` and its signed receipt. This verifies the real wallet reservation, CPU execution, nonzero token payment, partial return and receipt cycle; it is not a general security audit or a load-test result.

The owner then withdrew the full remaining 0.9996 USDC through OKX. The successful canonical transaction decoded to `withdraw(999600)` from the reviewed owner. Its escrow `Withdrawn` event and native USDC `Transfer` event both confirmed the exact amount and destination. The wallet increased from 1.422967 to 2.422567 USDC; the owner's available and reserved balances and the escrow contract's total USDC balance were all zero. See `evidence/base-withdrawal-20261017/verification.json`. The treasury in this deployment is the same reviewed owner wallet, which had already received the 0.0004 USDC compute charge before withdrawal.

The owner-approved reservation initially remained open while admission failed with RPC error -32011 (`request limit reached`). Recovery admitted that exact original run and transaction hash through the existing ownership, quote and asset checks. It did not create a new quote or reservation. The regular CPU worker executed and settled the run using its durable transaction journal.

## Base RPC transport

`scripts/base-rpc-router.ts` supplies a private loopback transport on `127.0.0.1:18545`. Reads use the configured public Base endpoint and fail over on transport or transient RPC errors; event-history reads start at the compatible secondary endpoint. Canonical block-hash selectors, calls, successful responses and contract-revert errors pass through unchanged. The router never signs transactions and never retries a signed broadcast through another upstream. The controller retains its deterministic settlement hash and existing reconciliation logic. Shared public upstreams still have no availability guarantee.

The VPS runs this transport in the restricted `telomere-mainnet-rpc.service`. Its root-owned executable is checked by SHA-256 before start. The controller unit depends on this service, and its profile, expected manifest and activation record bind the new loopback RPC URL. The unchanged activation guard reverified the finalized deployment, runtime hashes, contract roles and Circle USDC pins before the controller restarted. The frozen application release and frontend were not changed by this transport recovery. Seven focused transport tests and TypeScript checking passed.
