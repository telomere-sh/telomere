# Reviewed Solana USDC observations and Base treasury credits, version 1

This optional backend slice creates finite owner-scoped top-up invoices, verifies a finalized Solana USDC transfer through a reviewed RPC, and reconciles one externally authorized Base Vault credit from retained treasury inventory. It contains no signing key, consensus light client, token bridge, automated cross-chain swap or automatic Solana refund. The test source observations come from explicitly local JSON-RPC fixtures; the Base transfers and Selection classifications are executed by real contracts on disposable Anvil.

The original backend specification calls for Solana Pay reference transfers credited from Base treasury inventory after finalization (`backend.txt` lines 16–17 and 283–285). Network-token inventory, conversion/rebalancing, usable supplier leases, supplier heartbeat metering and external supplier settlement remain separate M6 work.

## Explicit operator scope

The controller mounts `/api/treasury/topups` only when both `TREASURY_TOPUP_CONFIG` and `TREASURY_TOPUP_CONFIG_SHA256` are configured. The path names a private, bounded, regular, single-link operator file; its exact UTF-8 bytes must match the reviewed SHA-256. A missing pair, changed hash, unsupported network pair, changed deployment, unavailable source treasury account or incompatible retained journal fails startup. Default configuration exposes no route.

The supported public pair is canonical Solana mainnet USDC and native Base mainnet USDC on chain 8453. Version 1 rejects Base Sepolia 84532; it does not send real mainnet source funds toward a testnet credit. An explicit local fixture profile supports loopback RPCs and chain 31337. Public configuration requires HTTPS RPCs without URL credentials or fragments; URLs come only from the hash-pinned operator file, and no invoice or API caller supplies one. RPC requests use fixed read methods, bounded bodies, deadlines and no redirects. Operator-approved private HTTPS RPCs are permitted.

The profile binds one original agent/Vault, Selection registry/implementation and USDC code/proxy/domain/archive pins. Current and historical Base checks reuse the existing native USDC and canonical Selection verification. The source mint and Base asset must match [Circle's published native USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). The actual Selection `treasury()` must be the EOA authorizing the credit. The EVM relayer is a distinct dedicated EOA; the controller rejects the treasury, registered owner, agent wallet, controller and other known service nonce senders in that role. Startup also inspects retained x402, Platform and legacy signed transaction inventories, even when those modules are disabled, before permitting a separate top-up journal. Each inventory is bounded at 4,096 rows or distinct senders; malformed, unprotected or oversized retained state requires operator reconciliation. Version 1 does not accept a Safe treasury authorization through its fixed 65-byte EOA signature port.

The policy lasts at most 24 hours, caps each invoice at 250 USDC, caps total issued credit at 2,500 USDC, and allows at most 128 retained invoices. Tighter policy caps apply. Version 1 declares zero fees explicitly and credits the same integer six-decimal USDC quantity. No floating-point exchange rate or USD parity assumption enters the calculation.

## Source verification

Startup and new invoice creation check the pinned Solana genesis and an existing initialized classic-SPL treasury ATA, including its program, mint, recipient and six decimals. ATA derivation checks the off-curve PDA, rather than trusting an arbitrary token-account address. [Solana Pay's transfer specification](https://docs.solanapay.com/spec) defines the recipient, SPL mint, ATA convention and read-only non-signer reference placement used by the invoice URL.

The verifier currently accepts legacy transactions whose final instruction is one exact classic-SPL `TransferChecked` to that ATA, for the original invoice amount and one original read-only non-signer reference. It checks the successful transaction, source payment window, token-account metadata, exact treasury token delta, final signature status and inclusion in a finalized block. Earlier direct token instructions, additional reference accounts, versioned/loaded-address transactions, CPI-only payments, plain `Transfer`, Token-2022 and malformed or oversized responses fail closed. This deliberately narrow format requires a compatible payer wallet and a pre-existing treasury ATA.

Read-only JSON-RPC uses [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction), [`getSignatureStatuses`](https://solana.com/docs/rpc/http/getsignaturestatuses) with history lookup, [`getBlock`](https://solana.com/docs/rpc/http/getblock), and the pinned cluster's [`getGenesisHash`](https://solana.com/docs/rpc/http/getgenesishash). These are observations from the reviewed RPC, not an independently verified proof of Solana consensus. Dense blocks exceeding the bounded response limit require operator reconciliation.

## Finite inventory and durable replay

The separate private journal fixes the original policy hash and an initial inventory ceiling equal to the smaller of the policy cap and confirmed/current Base treasury stock. Total original invoice amounts never exceed this ceiling. Later deposits, refunds, policy expiry, process restart or a reorg do not renew that budget. New invoices also require current uncommitted stock, the waiting-invoice limit and a fresh check of previously credited receipts. The Vault's canonical `managedExposure` includes cash, available escrow balance and outstanding reservations; aggregate unresolved top-up invoices must also fit its remaining `MAX_MANAGED_EXPOSURE` capacity before a payment URL is returned.

Each invoice reserves Base inventory before its payment URL is returned. Original owner, agent, Vault, amount, reference, source proof, authorization and signed transaction remain retained. A source transfer is globally identified by Solana genesis, transaction signature and instruction index. Its deterministic EIP-3009 nonce excludes the invoice, reference and target Vault, preventing another invoice from obtaining a second credit for the same source under the fixed treasury payer.

Exclusive file locks, bounded private reads, atomic replacement and fsync protect ordinary concurrent/crash operation. A crash-held lock requires confirmed operator recovery. The initialization marker makes a missing journal fail closed instead of silently restoring a fresh issuance budget. These files are not rollback-proof hardware storage. Preserve the policy, journal, `.initialized` marker and original pending bytes together; deleting, rolling back, rotating or replacing that state is not an automatic supported recovery procedure. The separate journal is not supplied by the controller PostgreSQL backup alone.

Expired waiting invoices retain their reservation. An in-time payment may be observed after invoice expiry while the original overall policy remains valid. Late, ambiguous or unsupported source payments require manual reconciliation and, if appropriate, an independently authorized return of source funds. The API never claims those funds were automatically returned. A depleted existing journal remains readable; an initially empty treasury does not create a new zero-budget journal.

## External authorization and canonical credit

Every endpoint requires the authenticated human owner matching the canonical Vault binding. The agent wallet alone cannot create a treasury invoice. The service returns an exact unsigned treasury EIP-3009 authorization after source verification. An external treasury wallet signs it. The service verifies that original signature and exposes only the exact Vault calldata and bounded relayer plan. An external dedicated relayer wallet signs the EIP-1559 transaction. Before retaining or relaying it, the service checks its sender, chain, destination, value, calldata, nonce, fee/gas caps and an execution simulation using the exact signed gas amount.

The source, authorization, raw transaction/hash/nonce and inventory reservation are committed before optional broadcast. Unknown delivery outcomes retain the same bytes and hold. Read-only reconciliation checks the original transaction. Explicit rebroadcast rechecks the original source and still-unused authorization and sends exactly the retained bytes; it never changes a fee, nonce or authorization. An externally submitted replacement transaction is not silently treated as the original credit.

A credit requires canonical confirmed Base evidence: the pinned USDC transfer, consumed token authorization and Vault authorization reference, exact `FundsReceived` conservation, historical clone/registry/treasury code relationships, and one exact Selection `Subsidy`. Treasury funding does not increase earned `Income` or charge the income fee. Cached credited states are rechecked before being returned or releasing current inventory capacity. A reorg or reverted original transaction clears its credit anchors and retains the unresolved hold. Owner withdrawal after an accepted credit does not make the original source reusable.

The historical Vault uses `TransferWithAuthorization`. [ERC-3009's security considerations](https://eips.ethereum.org/EIPS/eip-3009#security-considerations) explain the wrapper front-running issue: an observer can call the token directly with that authorization, moving its funds into the intended Vault without the wrapper's classification events. The service detects consumed-but-unclassified authorization, refuses a false credit or replacement authorization, and retains the hold for manual reconciliation. Preventing this workflow issue requires a separately reviewed `ReceiveWithAuthorization` Vault version. This slice does not change historical Vault bytecode or claim atomic cross-chain settlement.

## Owner HTTP workflow

All POST bodies are strict JSON, at most 8 KiB, with a five-second complete-body deadline. Existing controller Origin, owner-session and rate controls apply.

| Method and suffix under `/api/treasury/topups` | Input or purpose |
| --- | --- |
| `POST /invoices` | `{clientId,amountMicros}`; reserves finite inventory and returns the immutable invoice |
| `GET /invoices/{id}` | Owner invoice and fresh canonical credit status |
| `POST /invoices/{id}/observe` | `{signature}` for the original finalized Solana transfer |
| `POST /invoices/{id}/authorization` | `{signature}` from the external pinned treasury EOA |
| `POST /invoices/{id}/submit` | `{rawTransaction}` from the external dedicated relayer |
| `POST /invoices/{id}/reconcile` | `{}`; inspect the original Base transaction without broadcasting |
| `POST /invoices/{id}/rebroadcast` | `{}`; explicitly retry only the retained original bytes when eligible |

Local acceptance covers real Vault credit and owner withdrawal, Subsidy-only accounting, source reuse refusal, immutable authorization/transaction replay, response loss before/after relay, private-journal reopen, real EVM reorgs, finite inventory/concurrency, expired holds, wrong operator signatures, exact-gas failure, missing-journal refusal, direct token consumption and actual controller HTTP/auth/body controls. Live Solana payment, funded Base execution, treasury custody/recovery review and production operation remain external acceptance work.
