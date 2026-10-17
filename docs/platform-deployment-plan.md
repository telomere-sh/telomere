# Unsigned Base paid-platform deployment plan

`npm run deploy:platform:prepare -- --network base-sepolia --public-profile=/private/path/platform-base-sepolia.json` builds an **unsigned** five-contract plan. Choose `base-mainnet` explicitly for chain 8453. The command loads no wallet or key, signs nothing, and sends no transaction. It refuses to overwrite the corresponding `.local/platform-deployment-plan-base-sepolia.json` or `.local/platform-deployment-plan-base-mainnet.json`; archive a superseded candidate deliberately before refreshing it.

The bounded public JSON profile contains independently reviewed Circle USDC proxy and implementation pins, plus public role addresses:

```json
{
  "chainId": 84532,
  "expectedTokenCodeHash": "0x<reviewed 64-hex proxy code hash>",
  "implementationPins": {
    "address": "0x<reviewed Circle implementation address>",
    "codeHash": "0x<reviewed 64-hex implementation code hash>"
  },
  "roles": {
    "deployer": "0x<reviewed EOA>",
    "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "governance": "0x<reviewed governance>",
    "initialReceiptSigner": "0x<reviewed receipt signer>",
    "quoteSigner": "0x<reviewed quote signer>",
    "guardian": "0x<reviewed guardian>",
    "penaltyTreasury": "0x<reviewed penalty recipient>",
    "workAllocator": "0x<reviewed work allocator>",
    "treasury": "0x<reviewed treasury>",
    "stakers": "0x<reviewed staker recipient>",
    "buyAndBurn": "0x<reviewed burn recipient>"
  }
}
```

For Base mainnet use chain ID 8453 and Circle native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Both assets and chain IDs come from [Circle's address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses) and [Base network information](https://docs.base.org/base-chain/network-information). The planner rejects Robinhood/USDG chain IDs and token addresses. Its schema version 2 records `reviewedAsset.kind = circle_proxy`, the proxy hash and the implementation address/hash. Circle uses the `org.zeppelinos.proxy.implementation` storage slot. Mainnet USDC has name `USD Coin`; Sepolia has name `USDC`; both use symbol `USDC`, decimals `6`, and EIP-712 version `2`.

The runner checks the selected chain, canonical token, proxy and implementation bytecode, pointer, metadata and domain at one canonical block. It requires an EOA deployer with no pending nonce gap, and every predicted address must be vacant at that block. `RPC_URL` may select a private HTTPS provider; it is not printed or written to the plan. The `.local` directory is private (`0700` on Linux), the plan uses mode `0600`, and no private key belongs in the public profile.

The plan reserves consecutive CREATE nonces in order: `SignerSet`, `ReceiptRoot`, `HostRegistry`, `FeeRouter`, `PlatformRunEscrow`. The registry and router constructors require the future escrow address, which the planner computes from the fifth nonce. Each step records compiler, artifact bytecode hash, full creation-data hash, nonce and predicted address. Disposable-Anvil tests submit those exact five payloads and verify their addresses and constructor bindings.

This is a point-in-time candidate. Before signing each step, recheck nonce, vacancy, asset proxy and implementation, roles, compiled artifacts, gas/funds, and the previous step's deployed code. A separate read-only [USDC archive preflight](network-preflight.md) and independent contract/role review are required before funds. The plan covers the paid core only; it does not deploy Selection, identity/staking dependencies, suppliers, a GPU Cell or the operator service. No Base public deployment has been accepted. Historical Robinhood testnet plan observations remain dated evidence in `docs/validation.md` and must not be used as Base pins.
