# Base and native USDC migration, 14 October 2026

The active backend target is Base mainnet **8453** with native Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Base Sepolia **84532** uses `0x036CbD53842c5426634e7929541eC2318f3dCF7e` for public testing. Local demo remains on disposable chain **31337**. The network migration does not claim a deployed or funded Base service.

Sources: [Circle native USDC address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses), [Base chain ID documentation](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId), and [Circle proxy source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol).

## Changed interfaces and financial boundaries

- Main configuration, public API metadata, auth allowlist, SDKs, receipt v2 chain schemas, operator monitoring, deployment/fork tools and supplier accounting now accept mode-matched Base mainnet/Sepolia and USDC units. Former Robinhood chains and USDG are rejected by active payment profiles.
- `MODE=mainnet` requires 8453; `MODE=testnet` requires 84532. Both require the exact canonical asset, digest-pinned CPU executor, PostgreSQL, explicit owner/agent allowlist, HTTPS for remote API/RPC and reviewed token pins. Demo owner signing remains disabled in public modes.
- Circle uses the legacy zeppelinos implementation slot, not EIP-1967 or USDG authorization facets. Public payment pins require proxy runtime hash and implementation address/hash. Current and historical checks bind those pins, metadata and EIP-712 domain to canonical blocks. Mainnet name is `USD Coin`; Sepolia name is `USDC`; both use version `2` and six decimals. Receipt blocks with `Upgraded` events or differing parent implementation fail closed.
- Legacy public `TelomereClient` now also requires independently supplied `tokenCodeHash` and `assetImplementation` pins before trusting `/api/config`. Configuration echoes public hashes only; private RPC credentials and operator keys are not exposed. Python mirrors these fields and checks.
- Public Vault income requires a reviewed profile `archiveAnchor: { number, hash, timestamp }`, at least six hours old and canonical, with matching asset state. The HTTP caller cannot provide a new anchor. Historical state unavailability blocks activation.
- A durable controller chain/deployment binding is installed before recovery. Changing mode, chain, escrow, token, signer or asset code pins refuses the existing database. First public binding refuses existing operational rows across all modules, including disabled ones; migration-created lock rows are exempt. A new Base deployment uses a fresh dedicated database, while original journals and balances remain preserved for reconciliation.
- The unused exported `createChainGateway` convenience helper is restricted to disposable loopback chain 31337. Public signing and settlement use the checked, journaled bridges and SDKs; this helper cannot bypass their USDC pins.
- Retained legacy settlement bytes are checked for original chain, destination, calldata, run, signer, nonce and hash before any broadcast. Network changes never rewrite signed bytes. Old supplier ledger records and signed budget fields using USDG are not silently relabeled as USDC.

## GPU scope and confidentiality

Arbitrary GPU Cells remain optional. The required model path is managed bounded inference: the controller validates authority, budget and request scope, journals the dispatch intent, verifies provider attestation/response binding and accounts for an accepted result. No arbitrary Docker/CUDA program, GPU filesystem/session or GPU snapshot is supplied by that model endpoint.

The ordinary CPU VM can see the agent's plaintext and model requests. Running NRAS or another verifier there validates remote hardware evidence; it does not make the VM confidential. A provider inference attestation does not attest the complete Telomere agent, its tools, process memory or checkpoint restore. Sealed CPU Cells and recipient-bound key release still need separate real CPU-TEE acceptance where advertised. [Required scope](backend-scope-inference-only-2026-10-13.md) retains managed inference and makes arbitrary GPU Cells optional.

## Observed verification

Both actual Circle USDC local forks passed with zero public sends: [legacy escrow lifecycle](base-sepolia-fork-acceptance-2026-10-14.md) and [native Vault EIP-3009 ingress](base-sepolia-usdc-vault-fork-acceptance-2026-10-14.md). The second checks external income with rounded fee, owner subsidy, exact conservation, journal replay, wrong-domain rollback and nonce front-run reconciliation. Public RPC use was read-only; generated accounts, impersonation and deployments existed only inside disposable Anvil. Observed code hashes and archive anchors are candidates, not independent production approvals.

The initial full Node run collected **2,073 tests**: **2,013 passed, six failed, 54 skipped**, across 150 files in 2,835.33 seconds. It exposed invalid legacy worker fixtures, an expected admission-error wording change, a guard-test timeout and the omitted Node Vault SDK public schema. The fixes were verified with **180/180 final focused checks** covering every failed file, the Vault SDK and the local-only gateway. The initial failed report is preserved; no clean full-suite rerun is claimed. The final Solidity/TypeScript/application build, TypeScript and whitespace checks passed. See [structured validation](base-usdc-migration-validation-2026-10-14.json).

The guard timeout also exposed a test boundary problem: its RPC URL was public and a broadcast spy did not replace the method. The prior full run cannot prove zero external requests or submission attempts. The final test uses literal loopback and rejects unexpected broadcast/receipt-wait calls locally. A read-only lookup found no receipt for the deterministic fixture hash at that time. This does not establish public owner-wallet acceptance.

Python post-anchor/post-transport validation passed: **200 tests with seven platform skips** under the full opt-in crypto/Anvil run, and **185 tests with 22 expected skips** under the standard run (207 collected in either case). Both treated ResourceWarning as an error; bytecode compilation and whitespace checks passed. Earlier dated JSON and Robinhood/USDG acceptance remain unchanged as historical evidence.

The latest SSH probe timed out before authentication, so this source was not uploaded and the existing VPS deployment was not changed.

## Remaining public launch gates

1. Independently review current Circle and project contract source/code/governance; approve public pins and a private archive-capable RPC on the chosen Base network.
2. Prepare and deploy new Base contracts/profiles with a dedicated fresh database, production HostKit configuration, alerts, backup and restore acceptance. The old Robinhood plan and private local-31337 VPS deployment are not Base deployments.
3. Approve a current model-provider measured-workload policy and pass fresh hardware/transport/signature checks, then accept one bounded Telomere completion. The last accepted evidence still leaves policy/Gateway admission blocked; provider access alone is not a passing Telomere run.
4. Test the real owner wallet last: exact network/USDC funding, Leash/Vault reservation, dispatch, canonical settlement, returned balance, stop/kill, timeout refund and recovery. No funded Base owner transaction has been accepted by this migration.
5. Preserve the remaining milestone-specific external gates from the earlier backend audit: physical host-loss recovery, independent storage regions, supplier capacity/settlement, sealed CPU/key-release acceptance and complete hosted receipt evidence where those capabilities are advertised. A network switch does not add functional milestone credit.
