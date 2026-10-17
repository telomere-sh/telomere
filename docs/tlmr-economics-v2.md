# Optional TLMR economics v2

This is a new, explicit financial deployment profile. Existing `FeeRouter`, `TlmrStaking`, `TlmrToken`, `PlatformRunEscrow`, their signatures, journals and balances are unchanged. The new profile has not been publicly deployed or funded. Local mechanism acceptance does not establish approved token allocation, live liquidity, independent measurement operators or production readiness.

## Admission and owner discounts

`PlatformRunEscrowEconomicsV2` keeps the original quote, settlement, `getRun` and financial-leaf ABI. Its EIP-712 quote domain is `TelomerePlatformEscrow`, version `2`; the original escrow uses version `1`. The new `FeeRouterEconomicsV2` reports `economicsVersion() == 2`.

`quoteCeiling` still reserves the full undiscounted host price plus 900 basis points for ordinary hosts or 1,200 for sealed hosts. At `openRun`, the escrow snapshots the owner's current holding-plus-active-stake tier. The tier is an absolute reduction of the platform rate: a 100-basis-point tier changes 900 to 800, preserving the host's complete posted price. Allowed locked tiers are 0, 100, 200 and 300. Later transfers, staking or unstaking cannot change that original run's fee. Integer fees round up in six-decimal payment-token units; unused ceiling returns to the payer.

The original explicit tier thresholds are reused: 1,000 / 10,000 / 100,000 held-plus-active TLMR produce 100 / 200 / 300 basis points. They are implementation parameters, not evidence of approved public economics. Queued stake does not count.

EOA payers use their own holding tier. Canonical `PlatformAgentVault` payers may use their human owner's tier after one deployment-time factory binding. `configureDiscountVaultRegistry(registry, codeHash)` requires the guardian, paused opens, no prior paid admission and no prior binding. It checks the registry's exact code hash, payment token, escrow and Vault implementation relationships. There is no replacement or removal method. Admission resolves `vaultAgent(payer)` through that reviewed registry and checks the returned agent's exact Vault and nonzero owner. Arbitrary `payer.owner()` methods are never trusted. TLMR stays with the owner rather than being sent to a Vault without a utility-token withdrawal path.

Independently reviewed `PlatformPins.financialProfile` is required:

```typescript
{
  kind: 'tlmr_economics_v2',
  stakingAddress, stakingCodeHash,
  utilityTokenAddress, utilityTokenCodeHash,
  // Optional; required for owner-tier resolution and v2 Vault evidence.
  discountVaultRegistry: {
    address, codeHash, implementationAddress, implementationCodeHash
  }
}
```

When the factory pin is absent, readers require the escrow's factory address and hash to remain zero. Historical readers validate the reviewed economics code and relationships at the original block. Public financial verification reads the admission-locked tier rather than present holdings. Combined v2 evidence compares the opening tier against the settled tier.

CPU v2 evidence supports exact nested `Vault.payRun` openings only with the four reviewed factory/implementation pins, the canonical EIP-1167 clone, original factory binding, exact calldata, genuine escrow and HostRegistry events, original domain-2 signature and canonical historical state. A generic contract call is not accepted as a Vault opening. Older v1-profile Vaults lack this evidence authority and must use their separately reviewed supported path.

## Weekly work allocation

The fee split is unchanged: work 80%, treasury 10%, stakers 5%, buy-and-burn 5%. Rounding remainder stays in work. Each settled host payment is distinct from these fee buckets.

`CanonicalCpuWorkVerifier` retrieves both configured public v2 copies, validates signed host admission and tick/ACK billing, original archive authority and canonical settlement, then derives recipient, billable seconds and settlement week from the verified run. It refuses a corrupted/missing copy, failed/non-compute outcome or self-reported units. This establishes accepted paid CPU billing; unsealed execution correctness and physical-stream completeness remain outside that proof.

`CanonicalCommittedWorkVerifier` supports publisher-accepted probe, verification and storage observations. Each leaf binds the kind, source receipt, recipient, units, observation week/time, evidence digest, approved policy digest, chain and reviewed ReceiptRoot. The verifier checks the exact canonical `postRoot` transaction, historical root and SignerSet code pins, publisher authority, closed hour and Merkle inclusion. Those units remain the reviewed publisher's measurement testimony. The module does not manufacture live observations or claim that a chain commitment independently measures storage/probes.

`CompositeWorkActivityVerifier` connects explicitly approved producers. `buildWeeklyWorkAllocation` rejects duplicate source receipts and wrong chain/week/kind; applies explicit approved per-kind weights; aggregates one claim per recipient; and uses deterministic largest remainders so every allocated base unit is conserved. No production weights or actor allocation are inferred from the PDFs, test fixtures or token price.

`prepareWeeklyWorkAllocation` reads the actual closed-week work budget and immutable allocator from a confirmed canonical router snapshot. It returns the complete plan, Merkle claims and exact unsigned `postWorkRoot` transaction. If the same root is already posted, it returns `already_committed` with no new transaction. A different posted root is never overwritten or relabeled. Signing/broadcasting remains a separately reviewed wallet operation. The configured allocator remains trusted to select the complete fair observation inventory and approved policy.

## Time-weighted staker payouts

`TlmrRewardStaking` is a separate optional staking deployment with the original utility/stake/14-day queue ABI. It checkpoints owner and total active stake integrals on each stake and unstake request. Closed-week rewards use actual token-seconds over the entire UTC epoch week, excluding queued time immediately; a same-block round trip contributes zero. A large stake just before payout cannot acquire a snapshot-sized claim.

`fundWeek(week)` atomically pulls the actual staker fee bucket from its immutable, code-pinned v2 router. Each owner claims `floor(weekBudget * ownerStakeSeconds / totalStakeSeconds)` once. USDC reward custody and TLMR stake custody are separate. Claims cannot exceed the actual funded budget; rounding dust remains backed and accounted. A week with no eligible active stake remains unallocated in the router; there is no invented fallback recipient, yield guarantee, mint or administrative withdrawal.

Only the configured staker/burn recipient can pull v2 buckets 2/3. This prevents a third party from sending a bucket outside its recipient's atomic funding/accounting method. Anyone may invoke those recipient funding methods. The treasury bucket remains permissionless with its fixed recipient.

## Bounded market purchase and burn

`TlmrBurnableToken` is a new fixed-supply token variant with holder burn and no mint/admin role. The original non-burnable TLMR deployment is unchanged. Its production supply/distribution is not chosen by this implementation.

`TlmrBuyAndBurn` accepts only its actual closed-week fee bucket. Its immutable configuration fixes the payment/utility pair, reviewed swap route and code hash, pool fee, quote signer, per-swap maximum, per-week maximum and maximum quote lifetime. Every operation requires an EIP-712 `BurnQuote` with a unique operation ID, exact week/input, positive minimum output and bounded validity window. The contract grants only an exact temporary token allowance, checks exact input/output balance deltas, clears allowance, burns the received utility tokens and checks the actual supply decrease. Budget reservation, operation replay protection, swap and burn are atomic. A rejected/partial/false-output swap restores the original funds and operation state.

The outer route ABI includes `deadline`. `TlmrSwapRouter02Adapter` supplies the different Base V3 SwapRouter02 ABI through a separate immutable adapter: fixed burner, pair, fee, underlying router/code hash; restored deadline; exact temporary downstream allowance; exact balance checks. It does not accept arbitrary calldata, token paths, recipient changes or native value. A publicly reviewed route and actual TLMR liquidity are still deployment dependencies. No token purchase was submitted to a public chain.

`prepareBuyAndBurn` validates current reviewed pins, immutable route configuration, signed quote and funded limits, then returns exact unsigned calldata. `reconcileBuyAndBurn` checks the original transaction, canonical confirmations, historical pins, matching operation event, exact payment transfer and actual utility burn transfer. An already executed operation is reconciled instead of prepared again. A caller supplying a wallet must journal the original signed raw transaction before broadcasting; these helpers do not contain a signer or invent a second quote after an ambiguous broadcast.

Minimum output and price approval remain the configured quote signer's responsibility. Budget limits and a nonzero minimum are not an independent market-price oracle.

## Local validation and deployment limits

Tests use disposable Anvil accounts, a faucet payment-token fixture, a local identity fixture and a local swap fixture. They exercise real Solidity transfers, supply burns and contract replay/budget rules, not a live market price or live external measurement operator. `TestReviewedV3Router` and `TestEconomicsIdentity` refuse non-local chain IDs.

The economics fixture checks domain isolation, admission tier locking, EOA/Vault owner resolution, historical public financial verification, stake-second payouts, flash/queued stake behavior, actual buy/burn, route adaptation, swap rollback, unsigned preparation/reconciliation and exact Merkle work payout. The paid CPU v2 issuance fixture separately checks the actual published signed CPU work producer, canonical work derivation, Node SDK v2 acceptance and downgrade refusal.

The final focused cohort passed **39 tests across seven files**, including **19 actual local-EVM economics cases**; no tests failed or skipped. TypeScript typecheck and diff checks passed. [Machine-readable validation](tlmr-economics-v2-validation-2026-10-14.json) records the combined frozen production fingerprint and [unaltered raw report](evidence/tlmr-economics-final-20261014.json). This cohort is not a new full-suite result. Separate [mounted economics HTTP acceptance](platform-economics-runtime-validation-2026-10-14.json) verifies actual within/outside-price-band TLMR placement and positive EOA/Vault settlement with the original locked owner tier.

Before public activation: review fresh contract/code pins and governance roles; approve token supply/allocation and work policy; bind the canonical Vault factory before any admission; supply reviewed DEX code/route and real liquidity; configure actual measurement publishers and signer authority; complete independent contract review and funded Base/USDC acceptance. GPU Cells are not required for these mechanisms.

Implementation references: [OpenZeppelin SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20), [OpenZeppelin math](https://docs.openzeppelin.com/contracts/5.x/api/utils), [Uniswap V3 exact-input swaps](https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping), [SwapRouter02 V3 interface](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol), [Base V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments).
