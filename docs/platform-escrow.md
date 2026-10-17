# Separate platform escrow with atomic host and fee accounting

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`PlatformRunEscrow.sol` adds an independent non-upgradeable Solidity escrow.
It does not replace or modify `TelomereRunEscrow`, migrate its balances, change
the running pilot, or use its quote/settlement selectors. Both versions can exist
on one chain. All monetary quantities here use the reviewed six-decimal token.

## Immutable deployment pins

Constructor configuration is
`{token, quoteSigner, receiptRoot, hostRegistry, feeRouter, guardian}`. Contract
addresses must contain code, the token must report six decimals, and both registry
and router must pin that token and **this escrow** as their controller. The registry
must pin the same receipt root for penalty evidence. Rates remain immutable in
FeeRouter (9% ordinary hosts, 12% sealed hosts). The guardian can pause new opens;
it cannot change those pins, spend balances, seize collateral, stop withdrawals,
block accepted settlement, or prevent timeout refunds.

Controller immutability creates a deployment dependency: predict the escrow's
CREATE address, deploy HostRegistry and FeeRouter against that address, then deploy
the escrow with their addresses. The acceptance suite calculates the address from
the generated deployer's actual nonce, deploys the two preceding contracts, and
checks that the final address matches. Production must use a reviewed deterministic
deployment plan or exact nonce plan and verify code/roles before funding. The
constructor rejects mismatched controllers, tokens or evidence roots.

## Pre-audit financial caps

The adapted Base Sepolia pilot uses a six-decimal USDC token. The escrow
enforces three fixed limits in token base units: a **250 USDC** fee-inclusive
ceiling for each signed run quote, a **1,000 USDC** daily maximum for every
created or updated Leash, and **500,000 USDC** of aggregate available plus
reserved escrow liability in this contract. A deposit that would exceed the
aggregate cap reverts before token transfer. Moving funds from available to
reserved does not create new room; withdrawing funds does. The boundary values
are accepted and one base unit above each limit is rejected by local EVM tests.
The constructor's exact six-decimal token check is required for these fixed
base-unit limits. These are per-contract controls; deployment review must also
prevent bypassing an aggregate pilot limit through multiple escrow instances.

## Scoped quotes and Leash

The EIP-712 domain is `TelomerePlatformEscrow`, version `1`, current chain ID and
this escrow address. The complete signed message type is:

```text
PlatformQuote(bytes32 runId,bytes32 leashId,bytes32 hostId,address payer,uint16 hwClass,bytes32 regionHash,bytes32 imageHash,bytes32 workloadHash,uint64 maxSeconds,uint96 pricePerSecond,uint96 inferencePrice,uint64 quoteExpiry)
```

Quotes bind host, payer, hardware class, region, image, workload and every price/
duration input. Maximum duration is seven days; inference is an optional fixed
charge. The maximum host charge plus the router's rounded-up fee must fit uint96.
Quote signature, unique run ID, expiry and actual owner/agent caller are checked
before reserving funds. Arbitrary caller-selected host payees are not accepted:
the host operator is read from HostRegistry and stored at admission.

`createLeash(id, terms)` and owner-only `updateLeash(id, terms)` use:

```solidity
struct LeashTerms {
    address agent;
    uint96 maxPerHour;
    uint96 maxPerDay;
    uint64 classMask;
    bool sealedOnly;
    bytes32 imageAllowRoot;
    bytes32 regionAllowRoot;
    uint64 expiry;
}
```

Class bits cover indices 0–63; class 0 is CPU, and every other class requires the
registry's GPU eligibility flag. The signed quote and host probe system are still
trusted to identify the particular GPU class: the registry's boolean flag is not
an independent hardware benchmark or TEE verifier. `sealedOnly` requires registry
kind 2. Measurement registration likewise does not independently verify hardware.

Nonzero image/region roots require OpenZeppelin sorted-pair Merkle proofs of
`keccak256(bytes.concat(keccak256(abi.encode(bytes32(value)))))`. Zero roots permit
any nonzero value in that dimension. `allowLeaf` exposes the exact leaf helper.
Proofs are bounded to 64 siblings. Empty class masks, zero hourly caps, daily caps
below hourly caps, and past expiry are rejected.

Hourly/daily limits reserve the entire host price **plus fee**. All unfinished
ceilings carry across every bucket boundary; rolling a UTC hour/day never clears
pending debt. Reductions below spent-plus-pending are rejected. While any ceiling
is pending, class/TEE/image/region rules cannot be changed retroactively. Owner
`killLeash` and `requestStop` stop new or future work without cancelling valid
receipted seconds before their timestamp. Killed leashes cannot be revived.
Accepted expiry is snapshotted at open; later budget changes do not rewrite it.
Spent buckets accrue actual settled total at settlement time, rather than
reconstructing historical sub-hour bill allocations.

## Atomic admission and settlement

`openRun(quote, signature, imageProof, regionProof)` verifies the pinned active,
bonded host and all quote/Leash checks, reserves available payer funds, and calls
`HostRegistry.openRun` in the same transaction. Registry failure rolls back the
entire admission. The host cannot request unbond while these runs remain open.

Settlement uses a complete billable commitment:

```solidity
struct Settlement {
    bytes32 runId;
    uint64 billableSeconds;
    uint64 endedAt;
    uint96 inferenceCharge;
    bytes32 receiptHash;
}
```

Anyone can call `settleRun(settlement, hour, proof)` after the publisher has
committed the closed hour. `hour` must equal `floor(endedAt / 3600)`;
`endedAt` cannot precede opening or exceed the effective stop/kill/accepted-expiry/
current-time boundary. Billed seconds must fit the run maximum and that ended
interval, with the existing one-second timestamp tolerance. Inference can be
zero or its complete accepted amount, never a substituted partial charge.
Settlement is unavailable at or after the timeout refund boundary.

The receipt leaf is double-keccak over these exact ABI-encoded fields:

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
    block.chainid, address(escrow), settlement.runId,
    run.hostId, run.payer, run.hwClass, run.regionHash,
    run.imageHash, run.workloadHash, settlement.billableSeconds,
    settlement.endedAt, settlement.inferenceCharge, settlement.receiptHash
))))
```

`receiptLeaf(settlement)` exposes the exact helper. Field widths are the contract
types above and stored `Run` types. This is a **separate platform leaf format**;
the pilot hourly receipt service's double-keccak of `receiptHash` alone is not
sufficient proof for this contract. An expanded publication adapter must construct
and persist these full leaves. The acceptance suite publishes actual full leaves
to the actual ReceiptRoot contract. It does not claim the pilot HTTP controller
already publishes platform leaves or uses this escrow.

After proof verification, settlement atomically closes the real registry run and
calls `FeeRouter.recordSettlement`. The host receives its full receipted posted
charge in the router's weekly pull ledger; the 9%/12% fee is added, not deducted
from host pay. The unused ceiling returns to the payer's available balance in the
same transaction. The final charge updates Leash spent/pending and aggregate
available/reserved counters. An already-used receipt hash cannot pay another run.
A proven zero-charge settlement closes the host and refunds the complete ceiling
without creating a fake host credit or fee. Failure of either hook reverts all
settlement state, including the host closure, receipt-use marker and owner ledgers.

`settleBatch` performs the same logic atomically for 1–32 items. A bad proof,
duplicate receipt or failed hook in any item reverts the whole batch. The root
publisher's commitment remains trusted evidence; inclusion does not establish
that the underlying compute or metering was correct independently of the signer.

## Refunds survive host accounting failures

After `openedAt + maxSeconds + 6 hours`, anyone can call `refundRun(runId)`.
It credits the entire accepted ceiling to the payer, clears the reservation and
finalizes the financial run even when new opens are paused or the leash is killed.
The payer can then withdraw that credit normally. This is a permissionless on-chain
operation; automation must submit it because EVM timestamps do not execute code.

The registry close hook on this path has a 100,000-gas limit. A memory-safe call
copies **no untrusted return/revert data**. Registry reverts, return-data bombs and
gas exhaustion cannot hold the payer's refund. Failure emits `HostClosureDeferred`
and leaves `hostReleased=false`; the host's accounting still needs repair.
Permissionless `retryHostClosure` can later finish that hook without touching
refunded money. A retry failure also cannot undo a prior refund. This separates
financial availability from an accounting dependency while retaining a visible
unresolved host state for operators.

`penalizeHost(hostId, incidentId, amount, hour, proof)` forwards committed evidence
to the real HostRegistry. A valid registry/chain/host/incident/amount-bound proof
is the authority, so any caller may submit it. Wrong amounts, uncommitted evidence
and incident replay are rejected by the registry; the recipient is its immutable
penalty treasury. The guardian cannot invent a penalty. Underbonding blocks new
admission but does not prevent valid accepted settlement or refund.

Token deposit/withdraw uses exact balance deltas and reentrancy protection. The
immutable router receives approval only so its controller-restricted settlement
can pull the exact total. At all ordinary operation boundaries, escrow token
backing equals `totalAvailable + totalReserved`; unsolicited token donations
create no caller credit. No admin sweep or emergency withdrawal exists.

## Acceptance and remaining integration

```powershell
npx vitest run tests/platform-escrow.test.ts --reporter=verbose
npm run typecheck
```

The 23 real local-Anvil cases compile the exact sources with pinned Solc/OZ under
the ordinary optimizer and EIP-170 size limit. They deploy actual HostRegistry,
SignerSet, ReceiptRoot and FeeRouter, register real collateral, create Leashes,
sign EIP-712 quotes, publish full receipt leaves, settle and move real test tokens.
They cover scopes/eligibility, signature substitution, pending budgets, receipt
binding and timing, ordinary/sealed fee conservation, owner/guardian controls,
timeout boundaries, atomic batches, evidence-backed penalties, pin rejection and
real-registry rollback after router transfer failure. A clearly local-only faulty
registry exercises admission/closure failures, a 1 MiB revert-data bomb and gas
exhaustion, proving that owner refunds and withdrawals remain available before
independent accounting repair.

Public deployment/funded-chain acceptance, runtime quote/publication/settlement
adapters, a Platform-compatible AgentVault, host signed ticks and probe admission,
full TEE verification, x402 rails, independent audits, Safe/timelock deployment,
and actual weekly work-share allocation remain separate work. This contract has
immutable configuration rather than embedding a governance timelock or proxy.
