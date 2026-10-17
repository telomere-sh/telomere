# Atomic exact payment ingress into a Selection Vault

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

This module atomically transfers an exact EIP-3009 payment into a registered `PlatformAgentVault`, classifies the original signed payer through `PlatformSelectionRegistry`, and pays the existing income fee. It preserves the standard `TransferWithAuthorization` typed-data signature.

The adapter is an explicitly constructed library. Its core acceptance below predates optional main mounting. The later [private-profile main integration](vault-income-main.md) remains disabled by default. No public deployment or public USDC capability is enabled. Acceptance uses disposable Anvil contracts and generated local accounts.

Subsequent reverted-transaction reconciliation checks the token nonce and Vault reference at the same freshly pinned canonical latest block, then rechecks that block and the original receipt before returning a definitive result. An own canonical revert followed by later direct-token or alternate-relay consumption refuses cached failed-payment evidence as `income_authorization_reconciliation_required`; it never adopts that other transaction. The complete Windows native suite passed 52/52 after this fix, including both actual low-gas-revert/later-consumption cases through the service's cached journal (`vault-income-reconciliation-validation.json`). The older 50-case native and `c4f71bf` main/Linux acceptances retain their historical source boundaries. A reverted outer transaction alone does not revoke an unconsumed, still-valid payer authorization.

## Contract behavior

The existing `receiveFunds(uint96,bytes32)` ABI and behavior are unchanged. The additive ABI is:

```solidity
function receiveFundsWithAuthorization(
    address from, uint256 value, uint256 validAfter, uint256 validBefore,
    bytes32 nonce, uint8 v, bytes32 r, bytes32 s
) external;
function incomeAuthorizationRef(address from, bytes32 nonce) external view returns (bytes32);
function usedIncomeAuthorization(bytes32 paymentRef) external view returns (bool);
```

The authorization destination is always this Vault and the asset is its immutable token. The caller cannot supply either destination, a classification source or a payment reference. `value` must be between 1 and `type(uint96).max`, and the Vault must be initialized for an actual agent.

The reference is `keccak256(abi.encode(domain, block.chainid, token, vault, from, nonce))`, where `domain` is `keccak256("TelomerePlatformVaultIncomeEip3009V1")`. Different chains, assets, Vaults, payers and nonces have distinct reference domains. The Vault marks the reference used before invoking the token; the token independently consumes its EIP-3009 authorization nonce.

Under the existing reentrancy guard, the Vault calls the token's `transferWithAuthorization`, verifies the exact incoming balance delta, invokes `recordIncome(agentId, from, gross, reference)`, and transfers any fee through the existing exact-delta `_pay` helper. A failure anywhere reverts the transfer, token nonce, reference marker, accounting and fee together.

The existing registry policy determines classification:

| Original payer | Classification | Fee |
| --- | --- | --- |
| External payer or unrelated registered agent | `Income` | Existing 1%, rounded up |
| Owner, own agent key, family Vault/key, controller, treasury or registry | `Subsidy` | Zero |

The relay transaction sender does not replace the original payer. Frozen, Dormant and killed-leash states still accept incoming classification; Dead rejects it and reverts the entire transaction. A direct ERC20 transfer or a direct token authorization transfer remains withdrawable, unclassified money.

For gross 1,000,001 token base units, eligible income produces fee 10,001 and net Vault funding 990,000. A subsidy retains the full 1,000,001 in the Vault. Success of a payment therefore does not by itself mean that Selection income increased.

## Adapter and reviewed deployment

`EvmVaultIncomeChain(publicClient, dedicatedWallet, pins, { rpcUrl })` implements the existing `PaymentChain` interface. It can be passed to the existing `X402PaymentService`; it maintains no separate payment ledger.

`VaultIncomePins` includes the existing exact payment fields:

- `chainId`, `asset`, `tokenCodeHash`, `payTo`, `facilitator`, `confirmations`.
- `reviewedTokenKind: "circle_proxy"` and `assetImplementation` address/code hash on public Base. Native Circle USDC uses the legacy Circle implementation slot and refuses `assetFacet` pins. See [payment asset pins](platform-asset-pins.md).
- A mandatory public `archiveAnchor: { number, hash, timestamp }` supplied in the independently reviewed private profile, with canonical state at least six hours old. No HTTP caller can supply or replace this anchor.
- Mandatory `exact: { reviewedEip3009: true, name, version }`.
- `agentId`, `treasury` and mandatory `selection` chain/registry/implementation/code-hash/confirmation pins.

`payTo` must be the actual registered agent Vault, and `facilitator` must be the dedicated wallet account. The Selection pins use the independent `RpcIncomeEndpointReader`; they require no CystRegistry. Chain and confirmation policies must agree. Unknown agents, wrong mappings, wrong clone bytecode, mismatched immutable token/controller/treasury/escrow bindings and wrong reviewed code fail closed.

`upto` configuration is rejected. The existing direct payment gateway and its exact/upto behavior remain separate. No ability of a public asset to support EIP-3009 is inferred from its name, decimals, endpoint declaration or an HTTP 402 offer.

### Preparation and durable replay

Verification checks exact terms, token/domain/code pins, the real payer signature and nonce, and independently simulates the whole native Vault call. It neither sends a transaction nor changes the journal or balances. Preparation repeats the full validation before signing the native ingress call.

The existing service journals the exact signed relay bytes, hash and nonce before the first broadcast. Recovery uses those same bytes; it does not create a replacement payment authorization or substitute another outer transaction hash. The adapter binds raw transaction chain, sender, destination, zero ETH value, nonce, full calldata and hash to the exact payment. Equivalent hexadecimal signature casing is supported.

The service's finality handling re-inspects finalized nonzero payment rows before returning success. A canonicality/depth loss returns a pending result without re-executing a resource or immediately broadcasting from the downgrade. A later explicit retry may recover only the original transaction bytes, subject to the shared nonce reservation checks. RPC uncertainty cannot return an old cached financial success. Zero-amount non-chain caching belongs to the separate legacy upto path; this exact ingress never accepts zero.

### Receipt authority

Inspection requires the original prepared transaction receipt and canonical confirmation depth. It verifies token and Selection/implementation/clone code at the receipt block as well as the current reviewed authority. It matches:

- The exact token transfer from signed payer to registered Vault, with exact gross incoming amount.
- Exactly one Vault `FundsReceived` event for the same payer, amount and deterministic reference.
- Exactly one matching Selection `Income` or `Subsidy` event for the bound agent.
- The exact rounded income fee or zero subsidy fee, and the exact Vault-to-reviewed-treasury fee transfer.
- Both the token nonce and Vault reference marker at the canonical receipt block.

Final canonical block, chain and confirmation depth are checked again after the state reads, including for reverted receipts. Current balances or current family mappings are not used to reconstruct historical per-transaction net amounts or classification; later transfers and registrations can change them. The reviewed contract code and matched receipt events provide that transaction's evidence.

### Other-relayer and direct-token races

Canonical `TransferWithAuthorization` allows any relayer to submit a valid authorization directly to the token. Such a transaction can consume the token nonce and deliver an unclassified donation before the Vault entrypoint runs. Another relayer can also submit the atomic Vault call under a different outer transaction hash.

If the authorization is consumed without the journal's own canonical receipt, the adapter throws the safe `income_authorization_reconciliation_required` error. The service preserves this reason for a prepared attempt and never reports financial success for it. A finalized attempt encountering this condition fails closed. The original prepared hash and raw bytes remain unchanged. No direct transfer, used nonce, HTTP callback or receipt from another transaction is silently adopted as this payment's evidence.

This is an explicit reconciliation boundary. The module does not automatically refund, classify a prior donation, issue a replacement authorization or claim that a local cancellation revoked a signed token authorization.

## Deployment boundary

`PlatformSelectionRegistry` embeds an immutable Vault implementation and creates fixed minimal clones. Adding the selector to the source does not update an existing deployed registry or agent Vault. Native ingress requires a fresh reviewed registry/implementation deployment and new pins. Existing Vaults retain their original funding, withdrawals and run lifecycle; this change performs no migration or public deployment.

The unchanged upto proxy requires its caller to equal the signed `witness.facilitator`. Calling it through a Vault changes that caller. Supporting upto atomically therefore requires a separately reviewed contract-facilitator versus EOA-relayer design, with an explicit actual-amount authority. This exact-only adapter does not claim that compatibility.

## Acceptance

The focused suite uses actual disposable Anvil, Selection, Vault, escrow, authenticated facilitator HTTP routes, and filesystem PGlite close/reopen. The unchanged local EIP-3009 authorization implementation is inherited by a local-only fault token with default-zero failure switches; short incoming/fee transfers test complete rollback without altering the reference fixture.

The suite covers original-payer exclusions and unrelated-agent income; fee rounding and conservation; replay, invalid signature/destination/time/size; incoming and fee delta failures; Frozen/Dormant/killed/Dead behavior; standard uppercase signature bytes; exact HTTP settlement; durable before-send and ambiguous-send restart; both other-relayer races; canonical reorg and depth loss during settled/reverted inspection; raw journal and actual receipt mutation rejection; and reviewed deployment mismatch refusal.

Safe metrics and source hashes are recorded in `vault-income-validation.json`. Broader legacy payment/finality regression and Linux acceptance are recorded separately by the root task. This evidence is local implementation acceptance, not a public asset capability or deployment claim.
