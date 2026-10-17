# Base/USDC deployment preparation

Telomere now targets **Base mainnet (8453)** or **Base Sepolia (84532)** for public payments. Local demo remains on disposable Anvil chain 31337 with a mock token. The only accepted public assets are Circle native USDC at [Base mainnet](https://developers.circle.com/stablecoins/usdc-contract-addresses) `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The metadata names differ: mainnet is `USD Coin`, Sepolia is `USDC`; both have symbol `USDC`, six decimals and EIP-712 version `2`.

The old Robinhood/USDG observations, plans and funding investigation are dated historical evidence. They are not valid Base deployment pins. No Base public deployment or funded transaction has been performed in this migration.

## Reviewed inputs

The legacy single-escrow planner requires an explicit network and a bounded public JSON profile. Set `chainId` to `8453` for `base-mainnet`, or `84532` for `base-sepolia`:

```json
{
  "chainId": 84532,
  "expectedTokenCodeHash": "0x<reviewed 64-hex Circle USDC proxy hash>",
  "implementationPins": {
    "address": "0x<reviewed Circle implementation address>",
    "codeHash": "0x<reviewed 64-hex implementation hash>"
  },
  "deployer": "0x<reviewed deployer EOA>",
  "operator": "0x<reviewed quote signer>",
  "receiptSigner": "0x<reviewed receipt signer>",
  "treasury": "0x<reviewed treasury>"
}
```

The hashes must be independently reviewed before inclusion in the profile. Circle's USDC proxy uses the `org.zeppelinos.proxy.implementation` storage slot, **not** EIP-1967. The planner checks the chosen chain ID, canonical token address, proxy bytecode hash, Circle implementation pointer and bytecode hash, exact metadata and EIP-712 domain at one canonical block. It also checks deployer code, pending nonce, predicted address and gas/funding. `RPC_URL` may select a private HTTPS provider and is never included in the output.

```sh
npm run deploy:prepare -- --network base-sepolia --public-profile /private/path/base-sepolia-roles.json
npm run deploy:prepare -- --network base-mainnet --public-profile /private/path/base-mainnet-roles.json
```

The command writes an unsigned, overwrite-protected `.local/deployment-plan-base-sepolia.json` or `.local/deployment-plan-base-mainnet.json`. It does not load a wallet, sign or broadcast. Its plan contains constructor-bound creation data, source and bytecode hashes, nonce, predicted escrow address, gas estimate and the reviewed asset pins. Use `deploy:platform:prepare` for the current five-contract paid core; see [its plan](platform-deployment-plan.md). The single-escrow path is retained only for legacy compatibility.

Before a paid Base deployment, a private archive RPC must also verify an independently reviewed six-hour-old canonical block, proxy code, implementation and EIP-712 domain at that anchor and at current head. The read-only `preflight:usdc-archive` command requires `BASE_ARCHIVE_RPC_URL`, `--network` and a public profile with `chainId`, `expectedTokenCodeHash`, `implementationPins` and `archiveAnchor: {number,hash,timestamp}` (decimal strings for number/timestamp). Its output repeats the checked anchor for review. The operator must separately pin that anchor in the private runtime profile; generated output is not automatically trusted.

```sh
npm run preflight:usdc-archive -- --network base-sepolia --public-profile /private/path/base-sepolia-archive.json
```

`deploy:submit` is a separate wallet stage. The unsigned plan and planner output include `reviewDigest`, a hash of the complete normalized plan excluding that digest field. After independently reviewing the exact plan, the operator must set `TELOMERE_DEPLOY_BROADCAST=<chainId>:<predictedEscrowAddress>:<reviewDigest>`. The submitter checks this value, the selected network, matching private deployer and signer keys, current canonical asset pins and available Base ETH. Its retained signed transaction journal binds the same digest and exact creation bytes. Any plan change, including a treasury change that preserves the predicted CREATE address, requires a new review and approval value. No wallet is configured in this migration, so that stage has not run.

## Contract scope

`TelomereRunEscrow` is non-upgradeable and records six-decimal USDC units. Its quoted CPU time and optional bounded inference charge remain separate. The contract reserves a run's entire ceiling against available balance and budget caps; an unresolved reservation is conservatively carried across hour/day buckets. The signed settlement is bound by the EIP-712 chain and escrow address. This is an operator-attested usage model, not a claim of trustless computation proof.
