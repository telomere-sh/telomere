# Selection, AgentVault and TLMR utility staking

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`SelectionRegistry.sol`, `AgentVault.sol`, `TlmrToken.sol` and `TlmrStaking.sol`
implement on-chain Selection accounting and lifecycle with the existing pilot
`TelomereRunEscrow` ABI. The contracts are Solidity 0.8.28 with OpenZeppelin 5.4.0,
non-upgradeable, and tested on generated accounts in a disposable local EVM.
This adds actual contract behavior; it does not deploy Selection publicly or claim
that a public ERC-8004 registry already exists on Base Chain.

## Configuration and identity ownership

`SelectionRegistry` takes one immutable configuration struct:

```solidity
struct Config {
    address token;             // exact-transfer, six-decimal payment token
    address escrow;            // existing TelomereRunEscrow, same token
    address controller;        // permitted bounded compute initiator
    address guardian;          // policy freeze/unfreeze only
    address identityRegistry;  // reviewed ownerOf(uint256) identity adapter
    address staking;           // reviewed graceExtension(bytes32) staking
    address treasury;          // entry and explicit income fee recipient
    uint96 entryFee;           // nonzero configured payment-token base units
    uint96 vaultFloor;         // nonzero dormancy threshold, base units
}
```

All contract addresses must contain code where appropriate. The payment token
must report six decimals and must match the pinned escrow's immutable token.
The registry records the owner returned by the pinned identity adapter at birth.
Identity ownership transfers later do not transfer the vault owner's withdrawal
authority. Each identity ID and agent signing key can enter only once; death does
not recycle either. Public deployment needs independently reviewed chain ID,
token, identity adapter, staking and controller pins.

The identity interface is the ERC721-compatible `ownerOf(uint256)` surface used
by ERC-8004 identity registries. It proves ownership at entry rather than an
agent's capabilities, income, reputation, network policy, or a declared endpoint.
The tests' `LocalSelectionIdentity` is an explicitly local-only `ownerOf` fixture;
it is not represented as the ERC-8004 reference implementation. Reputation summary
submission to ERC-8004, public indexing and endpoint declarations remain separate
integrations.

## Entry and budgets

The identity owner calls:

```solidity
enter(Entry({
    identityId: id,
    agentWallet: signingKey,
    maxPerHour: hourlyUnits,
    maxPerDay: dailyUnits,
    expiry: expiryTimestamp,
    cystHash: encryptedStateHash,
    endowment: initialPaymentTokenUnits
}))
```

The owner approves the registry for the entry fee plus initial endowment. Entry
deploys a deterministic EIP-1167 minimal clone of a fixed, locked `AgentVault`
implementation. Creation, fee, endowment, identity binding and escrow leash are
one atomic transaction. Fee-on-transfer failures revert all of them.

Selection caps are enforced in the clone and actual escrow: at most 20 units/hour
(`20_000_000`) and 200 units/day (`200_000_000`), hourly nonzero, daily at least
hourly, and expiry in the future. The vault is the escrow leash's owner **and**
named agent. Its human/agent signing key cannot call escrow `openRun` directly to
bypass frozen, dormant or dead status. `setBudget(hour, day, expiry)` is vault-owner
only and keeps that contract identity and maximums. Owner `killLeash()` is permanent
under the existing escrow semantics; changing Selection lifecycle cannot revive it.

## Actual compute and withdrawal

The agent signing key or pinned controller may call
`AgentVault.payRun(Quote, signature)`. The exact existing escrow quote includes its
run ID, this vault as payer, this vault's leash, workload hash, maximum seconds,
price/second, inference charge and expiry. The vault checks Selection eligibility
and quote scope, deposits only the missing part of the signed ceiling, and calls
the existing escrow's `openRun`. Invalid signatures, expired/killed budgets or
excess limits revert the deposit together with admission. It exposes no arbitrary
execute, caller-selected payment destination or unbounded agent transfer.

Receipt settlement and timeout refunds remain callable directly on the existing
escrow, including after a Selection freeze. Permissionless `syncRun(runId)` then
reads that exact final escrow state, decrements its tracked open-run count once,
and records only the actual receipt-backed charge as `Burn`. Zero-charge results
and full refunds record no burn or paid activity. The paid-run timestamp derives
from the escrow's opened timestamp plus billable seconds, bounded by the current
block to respect the escrow's one-second tolerance. Delaying sync cannot invent
recent activity. Dormancy is blocked until every tracked final run is synchronized.

`ownerWithdraw(amount)` always permits the owner to withdraw free vault cash and
the vault's **available** escrow balance, including frozen, dormant, dead or killed
agents. It cannot release an unfinished reservation. Owner `requestStop(runId)`
uses the actual escrow stop boundary. The guardian has no withdrawal, confiscation,
arbitrary payment or settlement power. Exact incoming and outgoing token deltas
are checked by the vault; unsupported token behavior rolls back its operations.

The existing pilot escrow currently sends its settled charges to its fixed
treasury. HostRegistry/FeeRouter coupling, receipt-root inclusion for that payment,
full hardware/image/region rules and x402 remain distinct production escrow work.

## Income, subsidies and circular funding

`AgentVault.receiveFunds(amount, paymentRef)` pulls the exact amount from
`msg.sender`; a caller cannot supply a different payer identity. The registry
classifies that authenticated source, emits a public event and updates counters.
Owner, own signing key, controller, platform treasury and registry payments are
`Subsidy`, not verified income. Payments from vaults or signing keys in the same
parent/child lineage are also excluded, including siblings and descendants.
Unrelated Selection agents are not automatically excluded.

Eligible explicit on-platform income is counted gross and charged the Overview's
1% income fee, rounded upward to a payment-token base unit. The fee is transferred
to the immutable treasury; net funds remain in the vault. Public counters preserve
gross income, income fees, subsidies and compute burn separately. The minimum
one-base-unit payment is entirely its rounded income fee.

Direct ERC20 transfers bypass classification, so they remain withdrawable and
increase available funds but do not become claimed verified income or trigger
an income fee. Endowments and owner top-ups are separately logged subsidies.
These rules exclude direct known circular sources; they do not claim to detect
an owner funding an undisclosed intermediary, a mixer, a separate wallet or an
off-platform refund. Proven third-party service income needs endpoint/facilitator
and source attribution evidence beyond ERC20 transfer provenance.

No classified incoming payment is accepted after declared death. Existing money,
including direct donations after death, remains owner-withdrawable. A dormant or
frozen vault can receive classified funds; receiving money does not silently change
its lifecycle or guardian policy decision.

## Offspring

An alive, unfrozen parent with a committed nonzero Cyst hash can spawn at most
three living children:

```solidity
spawn(parentId, childIdentityId, childAgentWallet, endowment, expiry)
```

The caller must be its owner, signing key or pinned controller. The new identity
must already belong to the parent's owner and have a fresh signing key. The child
receives a new vault and leash with exactly half the parent's current hourly and
daily caps. The owner may later explicitly configure the child's independent
budget within Selection limits. Its initial expiry cannot outlive the parent's
current leash. Killed/expired parents cannot spawn. The entry fee and nonzero
endowment come from the **parent vault**, using free cash or its available escrow
balance; pending reservations remain unavailable. A failure rolls back creation,
population, counters, fees and endowment.

The child inherits the parent's current encrypted Cyst hash, rather than its leash
or signing key. This contract copies the on-chain hash commitment; actual encrypted
object copying, agent-key wrapping and portable process/GPU restoration remain
Cysts integrations. `setCystHash` lets its owner or agent commit a new nonzero
checkpoint hash. The hash by itself does not prove storage availability.

Dormant and frozen children still count as living. Declared death frees exactly
one parent's child slot, and does not delete the historical identity, vault, leash
or counters. A child whose parent died can retain its own funds and lifecycle.

## Dormancy, death, revival and policy freeze

Anyone can declare dormancy only when all three conditions hold: spendable vault
cash plus available escrow funds are below the configured floor; there are no
unresolved tracked runs; and 24 full hours have elapsed since the latest paid run
or birth/revival activation. Activation and actual paid-run timestamps are stored
separately, so a top-up/revival is never reported as paid work.

Dormancy schedules a death eligibility time 30 days later, extended by active
agent-name TLMR stake to at most 60 days from that dormancy. `extendGrace` can
capture additional stake during dormancy. Published grace only increases during
one dormant period; a later unstake cannot retract an already published deadline.
That explicit mechanic means a captured extension survives withdrawal of the
stake after its own 14-day queue. A new dormant period must qualify again.

After that eligibility time, anyone can declare death only if the agent remains
below its floor with no unresolved runs. Death is a terminal on-chain declaration:
it records final income/burn/lifespan, decrements population, frees a parent slot,
and forbids revival and new compute. It does not seize or destroy the owner's
remaining money. A balance at or above the floor prevents death; an owner can
explicitly revive a funded dormant agent before death has actually been declared,
including after the eligibility time. This follows the specified permissionless
death condition rather than treating a timestamp as an automatic state transition.

Only the owner can revive an unfrozen dormant agent with funds at or above the
floor. Alive and dead agents cannot be revived. A guardian freeze or unfreeze
requires a nonempty reason (maximum 256 UTF-8 bytes) and nonzero evidence hash,
both published in an event. Freeze blocks new compute, spawning and revival,
while retaining withdrawals, valid settlements, refunds and checkpoint commitments.
Egress allowlists, outbound scans and enforcement against policy violations are
off-chain runtime responsibilities, not implied by this freeze contract.

Events include `Birth`, `Income`, `Subsidy`, `Burn`, `Dormant`, `GraceExtended`,
`Death`, `Revived`, `Spawn`, `Frozen` and `CystCommitted`. They provide immutable
source data for the Fossil Record. A reorg-aware indexer, public dataset, weekly
CSV and ERC-8004 reputation feed are separate deliverables.

## Fixed supply and utility staking

`TlmrToken(recipient, supply)` mints the complete positive supply exactly once in
its constructor. It has the standard 18 decimals, no external mint, faucet,
owner role, proxy or transfer tax. The constructor's supply is also exposed as
`fixedSupply`; public token economics and allocation amounts are not inferred by
the acceptance fixture.

`TlmrStaking(token)` accepts an 18-decimal token, with no mutable role or arbitrary
admin withdrawal. `stake(agentId, amount)` pulls exact tokens from the caller and
tracks owner/agent active amounts separately from total custody.
`requestUnstake(agentId, amount)` removes that amount from active grace/priority
immediately and queues it for 14 full days. A second request on the same position
resets the entire queued position's timer. `withdrawStake` returns only the caller's
queued tokens after the exact deadline, once. There are no rewards, return promises
or minted balances; staking never deposits a payment token into an agent vault.

The immutable mechanism parameters chosen for this implementation are:

| View | Behavior |
| --- | --- |
| `graceExtension(agentId)` | Linear from 0 to 30 extra days at 1,000 active TLMR; capped thereafter |
| `feeDiscountBps(owner)` | 0/100/200/300 basis-point discount input at 0/1,000/10,000/100,000 held-plus-active TLMR |
| `schedulingWeight(host, strikes)` | Active owner stake divided by `strikes + 1`, for ordering within a price band |

These thresholds were not numerically specified in the PDFs; they are explicit
implementation parameters, not a claim of approved economics. Queued stake counts
in custody but not these active views. FeeRouter does not yet consume the discount
view, and the scheduler does not yet consume the weight view. Neither view executes
a fee payout or changes a host's quoted price.

The separate opt-in [economics-v2 profile](tlmr-economics-v2.md) now consumes these
tier/priority mechanisms, including canonical Vault owner-tier resolution,
admission-locked discounted settlement and weekly stake-second fee payouts.
It uses fresh versioned contracts and reviewed code pins; the original contracts
and the acceptance checkpoint above remain unchanged.

## Acceptance

```powershell
npx vitest run tests/selection-contracts.test.ts --reporter=verbose
npm run typecheck
```

The 40 acceptance cases compile these exact contracts with the installed pinned
Solc/OpenZeppelin dependencies and deploy them under the normal EIP-170 bytecode
limit to a fresh loopback Anvil chain (31337). They use the **actual existing
escrow**, EIP-712 quote/receipt signatures and real ERC20 transfers. They verify
identity ownership, clone locks, caps, caller/source scope, fees/subsidies, circular
funding, distinct offspring and capacity limits, invalid-signature rollback,
settlement/refund/child funding conservation, frozen/reserved owner withdrawals,
stop/kill, exact 24h/30d/60d/14d boundaries, final death, revival and grace, token
supply, utility tiers, mismatched pins, fee-token rollback and token callback
reentrancy. The tests stop their generated chain afterward and do not use a public
wallet, public RPC, paid provider or canonical identity address.
