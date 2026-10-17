# Independent public Base mainnet asset observation, 15 October 2026

This packet records read-only observations for the proposed collateral-free
`TelomereRunEscrow` pilot. It is not a deployed contract, a signed transaction,
approval of role assignments, a private RPC subscription or funded acceptance.

`observe-public-base.mjs` uses only two unauthenticated public endpoints:
`https://mainnet.base.org` and `https://base-rpc.publicnode.com`. It restricts
RPC methods to reads and emits its complete report to stdout. The retained
`rpc-observation.json` contains 93 actual requests and JSON-RPC responses,
including complete proxy and implementation bytecode and canonical block data.
The run completed on 15 October at 17:52:30 UTC (20:52:30 Moscow).

## Observed asset and canonical states

Both providers reported chain 8453 and agreed on all six observations: each
provider checked a common finalized block, an older finalized ancestor and
its latest block. Metadata and the locally computed EIP-712 domain matched.

| Field | Observation |
| --- | --- |
| Native Circle USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Proxy bytes / Keccak-256 | 1,852 / `0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab` |
| Implementation | `0x2ce6311ddae708829bc0784c967b7d77d19fd779` |
| Implementation bytes / Keccak-256 | 23,464 / `0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873` |
| Metadata | `USD Coin`, `USDC`, six decimals, version `2` |
| EIP-712 domain separator | `0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f` |
| Finalized block | 52648113, `0xf65074a0cb535b65fe844c6105d18d34def9e596341c64373e250b76e410a3f5` |
| Historical finalized anchor | 52626513, `0xb0115e6a264a5f9fdbac013cfbb7d63de311e76e83e7cdfcda6f5d46e89570d8` |
| Anchor timestamp / age against finalized block | 1792042373 / 43,200 seconds |

Circle's implementation storage slot is
`0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`.
These hashes are observations of public chain state, not an independent
source-to-bytecode audit of Circle's current implementation.

The proposed owner/deployer/treasury address
`0xa67c6a174409b9b44e67d24cdd386a31d44edb1d` had empty code, zero pending and
canonical nonce, and zero ETH. Its vacant nonce-zero CREATE address was
`0x27c1e35F563Aa4f57a68B192d88a76c25e68e0db`.
This prediction changes if the account sends another transaction first.
Receiving ETH does not consume its nonce; funding a service signer from this
account does. No service signer address or private key is invented by this packet.

## Preparation and browser-wallet review

The legacy escrow constructor binds token, quote signer, receipt signer and
treasury immutably. Current `ChainBridge.check()` requires both signer roles
to match the dedicated service signer. The owner can sign deployment through
its external EOA wallet; no owner private key needs to leave that wallet.
Owner approvals, deposits, Leash creation and paid execution are separate
reviewable actions. This legacy flow does not register a collateralized host.

Before requesting a wallet signature, bind the source commit, compiler settings,
reviewed USDC pins, actual new public signer address, treasury, owner EOA,
pending nonce, vacant CREATE address and exact creation bytes. Include these
fields in the reviewed deployment digest. A browser request must omit `to` for
contract creation, use chain 8453, value zero and the exact reviewed data/nonce.
An automatic smart-account deployment or factory changes CREATE semantics.

After submission by the owner, independently compare the observed transaction
sender/nonce/value/input, successful canonical receipt, predicted contract
address, actual runtime and token/signer/treasury getters. Fresh compilation
has constructor immutables in its runtime template; do not label the template
hash as an observed deployed-runtime hash. A local fork or explicitly resolved
immutable references can supply the expected runtime for the exact constructor.

`scripts/usdc-archive-preflight.ts` calls its input a private archive RPC, but
its actual URL check accepts HTTPS publicnode and excludes only the two
default Base RPC hostnames, URL credentials and fragments. Successful execution
against publicnode establishes historical public RPC reads, not provider privacy.

## Full Base deployment fee estimate

The legacy planner's `gasLimit * gasPrice` and `sufficientForEstimate` cover
only its L2 execution estimate. Before owner approval, prepare the exact
unsigned transaction and observe the current full estimate:

1. Estimate execution gas and apply an explicit reviewed gas limit/buffer.
2. Prepare EIP-1559 fee fields, nonce, chain, value and exact creation bytes.
3. Serialize the unsigned transaction. At GasPriceOracle
   `0x420000000000000000000000000000000000000F`, call
   `getL1FeeUpperBound(unsignedSerializedByteLength)` and optionally
   `getL1Fee(unsignedSerializedTransaction)` for an additional estimate.
   The upper-bound method adds 68 signature bytes internally.
4. Call `getOperatorFee(gasLimit)` at the same oracle. This applies the active
   fork's formula. Do not hardcode the older pre-Jovian scalar division.
5. Compare available ETH with `value + gasLimit * maxFeePerGas + L1 estimate
   + operator estimate`, with an explicit allowance for changed fee observations.
   Refresh before confirmation and inspect the wallet's total fee.

The actual probes reported Fjord, Isthmus and Jovian active. Operator scalar
and constant at L1Block `0x4200000000000000000000000000000000000015` were zero;
`getOperatorFee(1000000)` returned zero. The 15,000-byte L1 upper-bound probe is
explicitly illustrative and is not the deployment transaction fee. L1 fees can
change independently of `maxFeePerGas`; this packet does not promise a future cap.

## Official references

- [Circle's native USDC address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- [Base network connection information](https://docs.base.org/get-started/connect-to-base).
- [Base network fee and GasPriceOracle documentation](https://docs.base.org/specifications/transactions/network-fees).
- [OP Stack execution, L1 data and operator fees](https://docs.optimism.io/op-stack/transactions/fees).
- [Circle implementation slot source at exact path commit](https://github.com/circlefin/stablecoin-evm/blob/574b947dfcfcb5fa05b46d8961ece29e06b14129/contracts/upgradeability/UpgradeabilityProxy.sol).
- [OP Stack GasPriceOracle source](https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol).
- [MetaMask external-wallet transaction requests](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/).
