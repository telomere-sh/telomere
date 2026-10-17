# Owner wallet deployment review

This helper prepares one new `TelomereRunEscrow` deployment on Base mainnet
(`8453`). It is the closed CPU pilot with a trusted operator, native Circle USDC,
owner Leash limits and checkpoint support. It does not deploy the five-contract
Platform/Vault marketplace, a HostRegistry or GPU Cells. No host collateral is
required by this legacy contract.

The helper never loads the owner's seed or private key. Starting the server,
opening the page and running checks make no financial request. Connect requests
the selected public account only. The separate **Deploy new escrow through my
wallet** button is the only path that can call `eth_sendTransaction`, after an
explicit owner click and review checkbox. Preparing this page is not consent to
deploy, fund the service signer, approve USDC or start paid work.

## Frozen inputs

The operator must independently review the complete unsigned legacy plan and
supply its raw-file SHA-256 and normalized `reviewDigest`. The server recompiles
the exact legacy Solidity source and OpenZeppelin imports in memory, compares
the compiler, artifact hash, entire constructor data and CREATE address, and
retains source/import/package-lock hashes. It rechecks these public inputs before
each review. It never replaces `contracts/artifacts` or updates the plan.

The prepared 15 October 2026 proposal has these public roles:

| Role | Proposed public address |
| --- | --- |
| Owner and deployer | `0xa67c6a174409b9b44e67d24cdd386a31d44edb1d` |
| Dedicated quote and receipt signer | `0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38` |
| Treasury, for owner review | `0xa67c6a174409b9b44e67d24cdd386a31d44edb1d` |
| Predicted escrow at owner nonce zero | `0x27c1e35F563Aa4f57a68B192d88a76c25e68e0db` |
| Native Circle USDC on Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

The separate service signer key stays on the VPS. Treasury equal to the owner
is a visible proposal, not an independently confirmed payment instruction.

## Start a local review

Use Node 22 with the locked `npm ci` dependencies. No new npm script, website
change or public service is required. For the frozen proposal above, the
following PowerShell command supplies explicit proposed review limits:

```powershell
node --import tsx scripts/owner-wallet-deployment.ts `
  --plan .local/deployment-plan-base-mainnet.json `
  --plan-sha256 2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8 `
  --review-digest 0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f `
  --owner 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d `
  --signer 0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38 `
  --treasury 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d `
  --max-gas 4000000 `
  --max-fee-per-gas-wei 20000000 `
  --max-total-gas-budget-wei 100000000000000 `
  --port 3283
```

The example total review limit is `0.0001 ETH`. These are proposal bounds to
review with the owner. They are not a current quote or authorization to spend.
An estimate exceeding any bound refuses deployment preparation; the helper
never raises a bound itself. If a plan or role changes, prepare and review a new
frozen plan and use its actual new digests.

`RPC_URL` optionally selects an HTTPS Base RPC (loopback HTTP is also accepted).
The URL is not returned to the page or logged. No owner signing key environment
variable is consumed. The server listens on `127.0.0.1` only. The default origin
is `http://127.0.0.1:3283`; a separate operator-managed HTTPS reverse proxy can
use `--public-origin https://review.example.org`, preserving that exact Host.
The public plan and instance CSRF token are not authentication for a public
administration service. Keep the review closed, or add operator access control
at the proxy. No arbitrary JSON-RPC proxy or server transaction endpoint exists.

For an SSH-forwarded review the same loopback port can be used locally and on
the VPS. A mobile wallet browser cannot reach the computer's loopback address;
it needs an explicitly configured HTTPS review origin reachable by that phone.
The helper supports injected OKX Web3, `window.ethereum` and EIP-6963 discovery.
It does not contain WalletConnect, seed import or a smart-account relayer.
Actual wallet compatibility still needs the owner's explicit acceptance test.

## Read-only checks and fee review

The plan is inert on load. Select the exact owner account, connect explicitly,
select Base mainnet in the wallet, then run read-only checks. Both the server
and the selected wallet RPC independently verify the network, original
canonical block, native USDC proxy/implementation/metadata/domain pins, empty
EOA code, unchanged owner latest/pending nonce and vacant predicted address.
The server also retains the exact source and plan binding.

Each review lasts at most 30 seconds. A fresh deployment estimate gets a 20%
gas buffer plus one gas unit and must fit the explicit gas and fee bounds. The
fee budget serializes the exact unsigned EIP-1559 creation transaction, without
a `to` field. At the same canonical snapshot it calls Base's GasPriceOracle
`0x420000000000000000000000000000000000000F`:

1. `getL1FeeUpperBound(unsignedTransactionBytes)`, which includes the oracle's
   signature allowance;
2. `getOperatorFee(bufferedGasLimit)`.

The displayed total is `gasLimit * maxFeePerGas + L1 upper bound + operator
fee`. The owner must have real Base ETH covering that total. Zero balance can
produce an explicitly marked read-only balance-override estimate, but can never
be ready for a wallet request. Missing or invalid oracle data refuses review.
Before the explicit wallet request, the wallet RPC recomputes both fee
components and refuses any increase over the displayed review, inadequate
total funding, expired review or changed nonce/state.

The total limit is a local review guard. An ordinary Base EIP-1559 transaction
does not provide a future hard cap on its separate L1 data fee. The owner must
still inspect the wallet's final fee before confirming. The helper exposes
`includesL1DataFee: true` and `futureL1FeeHardCap: false` rather than presenting
an L2-only amount as the total cost.

**Deploy first, then separately review service-signer funding.** An incoming
ETH transfer to the owner does not consume the owner's nonce. An outgoing
transfer from the owner to fund the signer does consume it and invalidates
this nonce-zero deployment plan. This helper does not send such a transfer.

## Explicit request, ambiguity and post-deployment work

Deploy repeats the server review and independent wallet checks before calling
the selected provider once. A Web Lock prevents simultaneous same-origin tabs
from creating competing attempts. Before the call, local storage durably
records the original digest, owner, nonce and predicted address. A returned
hash is retained. Wallet rejection, timeout, lost response or page restart
leaves the attempt blocked for manual reconciliation; no automatic retry or
clear-attempt button is available. Check the original account nonce and
transaction/receipt with read-only RPC before preparing another attempt.

The wallet request specifies owner `from`, chain `0x2105`, type `0x2`, zero ETH
value, original nonce, exact creation data and bounded EIP-1559 gas fields. It
omits `to` entirely. It does not approve or transfer USDC.

After a separately authorized signature, the operator must verify the exact
submitted transaction, canonical successful receipt, expected contract
address, resolved runtime and immutable roles/native USDC before enabling the
new service profile. Then separately review signer gas funding, personal login,
owner Leash and minimal USDC allowance/deposit, real CPU reservation/charge/
refund/stop/checkpoint acceptance. The deployment helper starts no worker and
does not claim those later acceptance steps have happened.

## Verification

```powershell
npm run typecheck
node node_modules/vitest/vitest.mjs run tests/owner-wallet-deployment.test.ts
```

The focused tests use actual legacy compilation, mutated frozen files, strict
role/constructor/digest rejection, canonical asset and nonce drift, zero and
L2-only funding, oracle failure/fee drift, a synthetic read-only EIP-1193 wire
endpoint, and the real local HTTP boundary. They send no public transaction
and load no owner key.
