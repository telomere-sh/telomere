# Unsigned payment-platform deployment plans, version3

This separate planner prepares five unsigned CREATE transactions for either
`PlatformSpendPermissionEscrowV1` (quote domain3) or `PlatformX402EscrowV1`
(quote domain4). It preserves the historical schemaVersion2 planner and CLI.
There is no wallet, key, signing, transaction submission or configuration enablement.

`buildPlatformPaymentDeploymentPlan` reuses the historical builder's asset/role
validation, nonce/address calculations and exact first four transactions:
SignerSet, ReceiptRoot, HostRegistry and FeeRouter. Only the final escrow
constructor/bytecode and its explicit contract name/profile/domain change.
The new address map never labels either payment escrow `PlatformRunEscrow`.
Each step records its creation hash, compiler, bytecode hash and runtime-template
hash/size. The template includes unresolved constructor immutables; its hash is
**not** an observed deployed-runtime pin. EIP170 and initcode size bounds apply.

Run the read-only CLI with an explicitly reviewed JSON profile:

```sh
npm run deploy:platform:payments:prepare -- --network base-mainnet --public-profile /private/reviewed-payment-profile.json
```

Use `base-sepolia` and chain84532 for its native testnet USDC deployment. The CLI
accepts only public Base networks. Disposable chain31337 is available solely
through the pure builder and tests, with explicit local dependency addresses.

The profile has strict fields: `schemaVersion:3`, `chainId`,
`expectedTokenCodeHash`, `implementationPins:{address,codeHash}`, all historical
deployment `roles`, and one `paymentProfile`:

| Profile | Required explicit fields | Public constraints |
| --- | --- | --- |
| `base_spend_permission_v1` | `managerAddress`, `managerCodeHash` | Canonical Manager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` |
| `x402_cpu_v1` | `permit2Address`, `permit2CodeHash`, `proxyAddress`, `proxyCodeHash`, `tokenName`, `tokenVersion` | Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`; Upto proxy `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`; USDC name `USD Coin` on8453 or `USDC` on84532, version `2` |

No dependency hashes or implementation pins are supplied automatically. Code
observations alone do not approve provenance. The operator must independently
review the exact deployed upstream code, Circle implementation and intended
roles. The plan explicitly records that pins are operator-supplied.

Before saving, the CLI checks the RPC chain and one finalized block, native
Circle proxy/implementation code and metadata/domain, EOA deployer code, the
same pending/finalized nonce, and upstream hashes/type/domain relationships.
SPM checks its permission type and Manager EIP712 domain. The x402 profile checks
Permit2's domain, proxy PERMIT2/witness relationship, and USDC's Receive authorization
type/domain. Every code/storage/view observation uses the same canonical block
hash. Normal finalized advancement is accepted only after the original anchor
remains canonical and both the original and fresh finalized asset/dependency
states and nonce agree. A replaced original block, changed pins or nonce refuses output.

`verifyPaymentDeploymentPlanState` requires trusted compiled artifacts. It
rebuilds and compares the entire plan before rechecking provider state and all
five vacant addresses. A structurally valid JSON plan with substituted initcode
or detached artifact hashes is rejected. The JSON schema by itself validates
structure and internal consistency; it does not authenticate compiler inputs.

The profile is a bounded regular single-link file, parsed with duplicate-key
rejection. Output uses exclusive creation in the private `.local` directory:
`platform-payment-deployment-v3-<profile>-<network>.json`. Existing plans are
never overwritten. Errors expose a phase code, without profile/RPC exception
text. This is preparation evidence, not deployment or permission to submit.

Acceptance uses real retained official Manager/Permit2/Proxy bytecode on ordinary
disposable Anvil, deploying all five exact planned transactions for both profiles.
Synthetic public RPC fixtures separately test finalized/reference/nonce/address,
asset/dependency/domain and mutated-plan refusal. They establish no public funded
acceptance, production activation, Base AA support or generic x402-client compatibility.
