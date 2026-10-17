# Canonical USDG acceptance on an isolated Robinhood testnet fork

Network update, 14 October 2026: the active implementation targets Base and native Circle USDC. Earlier Robinhood/USDG evidence below remains historical and does not prove Base deployment or funded acceptance. See [the current migration record](base-usdc-migration-2026-10-14.md).

The payment lifecycle passed using the actual issuer token's proxy and implementation bytecode on a private Anvil fork of Robinhood Chain Testnet. This is stronger evidence of token compatibility than the local mock-token tests. It is separate from a funded public testnet deployment and a user's wallet acceptance.

The source snapshot was testnet chain 46630, block 131164806, hash `0x6fd3847a8754f826d190dba1e0a2af7850fbd318fb940b8e06eeedcea9580beb`. The exercise completed on 8 October 2026 at 18:34:49 Moscow time and passed again at 18:38:04 after requiring the exact contract error names for stop and early-refund rejection. Its latest public result is `testnet-fork-acceptance.json`.

The canonical USDG proxy was `0x7E955252E15c84f5768B83c41a71F9eba181802F`, with six decimals and transfers unpaused. The fork's proxy bytecode matched the public pinned code hash `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6`; implementation `0xF0863D7A29a55d0c4263c11bFac754312ff078DF` matched code hash `0x72f197ff5ab8dcedf1244113dd91f245af65ae2c3354456d8bbfb6a3939ecd18`.

The script generated fresh disposable owner, signer, treasury and agent/relay accounts in memory. It funded gas only through the isolated fork's test RPC. USDG funding came from impersonating an existing funded holder only on that local fork and transferring 5,000,000 base units to the generated owner. It did not call issuer mint, claim a faucet, use existing operator keys, or submit any public transaction. The holder's public pinned balance was re-read unchanged afterwards.

The actual issuer token then completed approval, escrow deposit, partial withdrawal, delegated run opening, operator-signed settlement through an independent relayer, unused ceiling return, stop cutoff rejection, early-refund rejection, delayed permissionless refund, and final withdrawal. A run reserved 11,000 units, settled for 10,300, and returned 700. Final balances were owner 4,989,700, treasury 10,300 and escrow zero; all 5,000,000 funded units were conserved. The 10,000-unit inference component was simulated contract input: no provider request was made.

The fork bound to a fresh loopback port, kept chain ID 46630 for the EIP-712 signatures, and was never connected to the working staging controller or database. Mutation guards reject the public RPC, known staging ports, an exited/unowned process and any endpoint other than the exact loopback port of the newly created child. The separate upstream viem transport permits read-only RPC methods. The owned Anvil process was stopped and fork state discarded at completion.

## Reproduce

```sh
npm run testnet:fork
```

The command selects and records a fresh public source block. `--block-number <number>` selects an explicit snapshot when the public endpoint retains that state. `--report <path>` chooses the public JSON destination. It uses the installed platform-specific Anvil binary and recompiles the local escrow artifact. It never reads a private operator profile or changes production configuration guards.

To repeat the recorded snapshot and preserve the accepted report, run from the repository root:

```sh
npm run testnet:fork -- --block-number 131164806 --report .local/testnet-fork-recheck.json
```

The equivalent standalone command executes the TypeScript source directly through the installed loader:

```sh
node --import=./node_modules/tsx/dist/loader.mjs scripts/testnet-fork-acceptance.ts \
  --block-number 131164806 --report .local/testnet-fork-recheck.json
```

Keep this harness as native TypeScript: its imported compiler and local-chain helpers use their own entry-point checks. A single-file bundle changes those checks. Public RPC access, retained state at the pinned block and a funded source holder at that block are required; all writes still target only the fresh local fork.

## Practical limits

USDG remains upgradeable and issuer-controlled. At the tested block, `owner()` and `defaultAdmin()` returned `0x3a5B30D74e90E08F0E576CF9f6F2457E44AF38B3`, while `supplyControl()` returned `0x4549bb98c667aAb626627C118102c28065E8f54C`. The fully verified implementation exposes upgrade and supply-control entry points, and the transfer settings expose an issuer pause. An issuer upgrade, changed transfer policy or paused transfers can affect future escrow use. This test did not exercise issuer administration, freezing, every facet, or future implementation versions; refresh the pins and transfer state before public deployment.

Fork impersonation proves local behavior for the copied issuer state. It does not grant control of the holder, provide testnet assets to the user, test a browser wallet, prove public network finality, or validate remote compute. Public testnet funding/deployment, live provider acceptance and the owner's wallet flow remain separate checks.

The canonical address comes from [Paxos testnet USDG documentation](https://docs.paxos.com/guides/stablecoin/usdg/testnet). Token source and holder discovery use the [official Robinhood testnet explorer](https://explorer.testnet.chain.robinhood.com/address/0x7E955252E15c84f5768B83c41a71F9eba181802F?tab=contract); implementation ABI is available through its verified smart-contract API. Network parameters are published in [Robinhood's connection documentation](https://docs.robinhood.com/chain/connecting/).
