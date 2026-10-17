# Host collateral, receipt roots and weekly fee accounting

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

These non-upgradeable Solidity 0.8.28 contracts implement the separate M1 registry,
receipt commitment and fee accounting building blocks for a six-decimal token on
Base Chain. OpenZeppelin 5.4.0 supplies exact-safe ERC-20 calls, reentrancy
protection and sorted-pair Merkle verification. They have no proxy, delegatecall,
arbitrary administrative withdrawal or emergency override of user withdrawals.

The existing pilot `TelomereRunEscrow` remains a separate contract. This change does
not claim to have connected its live settlements to the new registry/router. A
production escrow integration must call registry admission/closure atomically with
open/settle/refund, and fund the router with the receipted host price plus the fee.
Deploying these contracts by itself does not establish metering truth, authenticate
physical hardware, perform a public testnet deployment, or complete an audit.

## HostRegistry

Constructor: `(token, controller, guardian, penaltyTreasury, receiptRoot)`.
The token must report six decimals; all roles and the evidence root are immutable.
For public deployment the reviewed production escrow is the controller. Generated
local test accounts act as the controller only in disposable acceptance tests.

`register(hostKey, kind, teeMeasurement, collateral, gpu)` pulls exactly the declared
collateral, assigns the caller as operator, and emits its deterministic host ID.
CPU hosts require 300 token units (`300_000_000`), GPU hosts 1,500
(`1_500_000_000`). Kind is 0 Host Kit, 1 network adapter, or 2 sealed host.
Only sealed hosts accept a nonzero measurement. Measurement registration is a
commitment, not an attestation verifier. One operator can hold one bonded host;
host signing keys are never reused, even after unbonding.

The immutable controller calls `openRun(hostId, runId)` and `closeRun(runId)`.
IDs cannot be reopened. Underbonded, unbonding or unknown hosts cannot open runs.
Existing runs can close after a penalty. Operators can add collateral to restore
eligibility. `requestUnbond()` requires zero open runs and immediately stops
admission for that host. `withdrawCollateral()` requires the complete 21-day delay
and returns only the remaining collateral. The operator can register a fresh host
key after withdrawal. Neither operation needs guardian approval.

The guardian can pause or resume registrations, without a power to seize funds,
slash a host, change roles, stop closures or block collateral withdrawals. Pausing
new paid runs in the production escrow is a separate integration requirement.

`penalize(hostId, incidentId, amount, hour, proof)` is controller-only. Its evidence
must be committed in the configured `ReceiptRoot` and bind the exact chain,
registry, host, incident and amount. The exact leaf is available through
`penaltyLeaf(...)`:

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
    block.chainid, address(registry), hostId, incidentId, uint96(amount)
))))
```

An incident can be used once per host, even if a second amount is committed later.
The transfer goes only to the fixed penalty treasury. Strikes increment and a host
below its minimum becomes inactive. Penalties remain possible during the unbond
delay. Evidence inclusion establishes what the trusted publisher committed;
independent correctness of the penalty requires verified metering and arbitration.

## SignerSet and ReceiptRoot

`SignerSet(governance, initialSigner)` fixes the current epoch week's publisher.
`scheduleSigner(week, signer)` allows only immutable governance to fill a future
week once. Weeks are `floor(unixTimestamp / 604800)`; they are epoch-aligned,
starting Thursday UTC, rather than ISO calendar weeks. A production deployment
must use its reviewed governance timelock address. The contract itself does not
implement a Safe or timelock. Future weeks must be scheduled before rollover;
an unscheduled week deliberately disables publication.

`ReceiptRoot(signerSet)` accepts
`postRoot(uint64 hour, bytes32 root, uint32 count)` only from the **current week's**
publisher. `hour = floor(unixTimestamp / 3600)` must already be closed; roots and
counts must be nonzero. Each hour is immutable after the first post. The current
publisher can publish a previous week's final closed hour, so the old publisher
does not retain authority after rotation. `getRoot(hour)` returns root, count,
publisher and publication timestamp. The count is publisher-supplied metadata;
a Merkle path proves inclusion and does not prove the number of leaves.

`verify(leaf, proof, hour)` uses OpenZeppelin's sorted-pair Merkle proof. Leaves
are supplied as bytes32; this contract does not impose a receipt serialization.
The hourly receipt service uses the double-keccak leaf
`keccak256(bytes.concat(keccak256(abi.encode(bytes32(receiptHash)))))`. Host
penalties have the separate domain-bound leaf above. A missing hour, changed leaf
or invalid path returns false. Publication does not independently verify the
underlying computation or a host's signed meter ticks.

## FeeRouter

Constructor: `(token, controller, workAllocator, treasury, stakers, buyAndBurn)`.
All rates and roles/recipients are immutable; six decimals are required.
`recordSettlement(receiptId, host, hostAmount, sealedHost)` is controller-only and
pulls **hostAmount + fee** from the controller. Each nonzero receipt ID is used
once. The host receives its posted amount in full:

```text
cell fee   = ceil(hostAmount × 900 / 10000)
sealed fee = ceil(hostAmount × 1200 / 10000)
```

The quote can be read with `quoteFee`. Fee rounding is upward by at most one token
base unit. Settlement prices/ceilings must account for that explicit fee before
owner approval. This is add-on pricing from the Overview, rather than taking 9%
out of the host's posted price.

Host credits are tracked by settlement epoch week. `claimHost(week)` lets only the
credited host pull its closed-week amount once. Fee shares accrue into four
separate buckets: treasury 10%, stakers 5%, buy-and-burn 5%, and work pool 80%.
Each fixed-recipient share rounds down in base units and the remainder stays in
the work pool, conserving every unit. `claimBucket(week, 1|2|3)` is permissionless
but always pays the fixed treasury/stakers/buy-and-burn recipient, once; it cannot
redirect the payment. A transfer to buy-and-burn does not itself execute a market
purchase or burn; staking distributions and buy/burn execution remain separate
components.

The optional [economics-v2 profile](tlmr-economics-v2.md) now supplies separate
weekly work-allocation, time-weighted staking and bounded buy-and-burn components.
Its new router and escrow use explicit reviewed financial pins and a distinct
quote domain. This original router deployment is not silently migrated.

After the week closes, the immutable work allocator can post one sorted-pair
`postWorkRoot(week, root, allocated)` bounded by that week's actual work bucket.
The allocator is trusted to calculate fair shares from receipted uptime, probes,
verification and storage; this contract enforces the money limit rather than
performing those measurements. `claimWork(week, amount, proof)` binds the claim to
the caller, chain, router, week and amount; one recipient claims once per week.
The helper `workLeaf` returns:

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
    block.chainid, address(router), uint64(week), recipient, uint256(amount)
))))
```

Even an overallocated tree cannot spend above its declared allocation or funded
bucket. Unallocated funds remain in that week's work pool; there is no admin
sweep. Duplicate recipient entries cannot yield multiple claims. `accountedBalance`
equals all unpaid host credits and bucket balances. Unsolicited token transfers
do not create credits and cannot be swept by a controller or caller.

## Reproducible acceptance

```powershell
npx vitest run tests/platform-contracts.test.ts --reporter=verbose
npm run typecheck
```

The suite compiles these exact source files with the installed pinned Solc/OZ
dependencies, deploys to a new loopback Anvil chain (31337), funds generated local
accounts, snapshots/reverts between tests and stops the chain afterward. It uses
no existing private keys, public RPC, funded wallet or paid provider. The compiler
import resolver admits only the installed OpenZeppelin package.

The 23 tests cover collateral conservation, CPU/GPU minimums, host identity,
controller/guardian authority, run replay, the precise unbond boundary, penalties
and incident replay, complete slashing, immutable closed hours, sorted proofs,
weekly signer rotation and missing-signer failure, integer fee conservation,
host/fixed-recipient/work withdrawals, proof scope and overpayment rejection,
transfer-tax rollback during both deposit and withdrawal, and callback reentrancy
including an authorized-controller callback. See test output for the result;
the tests do not constitute a security audit or public-chain acceptance.
