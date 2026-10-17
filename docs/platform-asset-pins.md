# Paid Platform payment asset pins

The active public rails are Base mainnet 8453 and Base Sepolia 84532 with their canonical native Circle USDC. `PlatformPins` requires `reviewedTokenKind: "circle_proxy"`, the token proxy runtime code hash, and `assetImplementation: { address, codeHash }`. Authorization-facet pins are forbidden for these deployments. Local 31337 fixtures may retain immutable or explicitly reviewed EIP-1967 tokens.

Circle uses `org.zeppelinos.proxy.implementation` at slot `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`, not the EIP-1967 slot. Current checks bind proxy bytecode, implementation pointer/code, six decimals, symbol `USDC` and the chain-specific EIP-712 domain at one canonical block. Mainnet name is `USD Coin`; Sepolia name is `USDC`; both use version `2`. Node and Python clients compare independently supplied nested pins before presenting wallet actions.

Quote signing, admission and settlement check the current reviewed deployment. Canonical receipt readers repeat the payment checks at the receipt block and require the parent implementation to match with no `Upgraded` event in that block. This also rejects an upgrade followed by rollback within the receipt block. Missing historical state fails closed. A token governance change mined after an offchain check can still change behavior; code pins cannot prevent it.

The legacy escrow now also requires `TOKEN_CODE_HASH`, `TOKEN_IMPLEMENTATION_ADDRESS` and `TOKEN_IMPLEMENTATION_CODE_HASH` for either public Base mode, and checks retained transaction chain/destination/calldata before rebroadcast. Network/deployment changes require a fresh dedicated controller database, preserving old journals for reconciliation.

Before public funds, independently review token and project contract provenance/governance, supply a private archive-capable RPC, approve the current code pins, deploy the final contracts and accept a funded owner-wallet reservation, settlement and timeout refund on the chosen Base network. [The isolated Circle USDC fork](base-sepolia-fork-acceptance-2026-10-14.md) proves token/legacy-escrow compatibility locally; it does not prove public deployment.

Local tests cover token-code and implementation replacement, Circle slot selection, metadata/domain mismatch, receipt-block upgrade/rollback, cross-chain retained journals and nested SDK pin substitution. Earlier USDG-specific fixtures and dated evidence remain historical; see [migration record](base-usdc-migration-2026-10-14.md).
