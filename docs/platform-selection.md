# Platform Selection and Agent Vault

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`PlatformSelectionRegistry.sol` and `PlatformAgentVault.sol` add a separate immutable Selection deployment for `PlatformRunEscrow`. The original `SelectionRegistry`, `AgentVault` and `TelomereRunEscrow` sources, ABIs, deployed balances and identities are unchanged. A deployment does not migrate assets or register an identity automatically in either direction. The factory namespaces agent IDs by chain, this registry, identity registry and identity ID; using another registry creates a distinct agent and Vault.

The platform variant preserves the existing identity-owner checks, exact token transfers, income/subsidy distinction, owner withdrawals, maximum three living children, dormant/dead lifecycle, optional TLMR grace and guardian freeze evidence. Its new behavior is scoped Leash creation, actual bonded host admission, full platform receipt proof settlement, and fee-inclusive Vault accounting. The fixed implementation is deployed by the registry and cloned with EIP1167/CREATE2. Both runtime contracts fit EIP170 with the project's ordinary Solidity 0.8.28 optimizer and OpenZeppelin 5.4.0; no proxy upgrades or external minting are added.

## Factory configuration and entry

The factory constructor takes the same `Config` field names as the pilot factory:

```solidity
struct Config {
    address token;
    address escrow;             // actual PlatformRunEscrow
    address controller;
    address guardian;
    address identityRegistry;   // independently reviewed ownerOf(uint256) adapter
    address staking;            // actual TlmrStaking or reviewed grace adapter
    address treasury;
    uint96 entryFee;
    uint96 vaultFloor;
}
```

The token must have six decimals and match the escrow. The configured escrow must expose the platform `QUOTE_TYPEHASH`; a pilot escrow is rejected even when it uses the same token. As with the original factory, public deployment additionally requires reviewed chain addresses/code hashes, identity adapter, staking, controller and ownership policy. A matching ABI/type hash alone does not establish trusted deployed code. The local acceptance identity adapter is explicitly a disposable `ownerOf` fixture, not the ERC8004 reference implementation or a public identity deployment.

Entry adds a nested scope to the original fields:

```solidity
struct Scope {
    uint64 classMask;
    bool sealedOnly;
    bytes32 imageAllowRoot;
    bytes32 regionAllowRoot;
}
struct Entry {
    uint256 identityId;
    address agentWallet;
    uint96 maxPerHour;
    uint96 maxPerDay;
    uint64 expiry;
    bytes32 cystHash;
    uint96 endowment;
    Scope scope;
}
function enter(Entry calldata terms) external returns(bytes32 agentId);
```

The human identity owner approves this factory for entry fee plus endowment and calls `enter`. The fee, deterministic clone, identity/key binding, scoped Leash and endowment are atomic. Identity and signing keys cannot be reused in this registry. The recorded Vault owner has no setter or ownership-transfer method; changing the identity token owner later does not move Vault withdrawal authority.

Caps are at most `20_000_000` atomic units/hour and `200_000_000`/day; daily must cover hourly. **The caps and pending reservations include the entire platform surcharge**: 9% ordinary host or 12% sealed host, rounded up by FeeRouter. Nonzero `classMask` uses the platform's bits 0–63, with bit 0 for CPU. `sealedOnly` and Merkle image/region roots use the exact PlatformRunEscrow semantics. A zero allow root permits any nonzero corresponding hash; nonzero roots require double-keccak leaves and sorted-pair proofs.

The pre-audit Selection Vault managed-exposure cap is `2_500_000_000` atomic units of the reviewed six-decimal payment token. The Vault reads `token.balanceOf(vault) + escrow.availableBalance(vault) + escrow.getLeash(leashId).pending`; the last term is the escrow's authoritative total of open-run ceilings, not a locally synchronized estimate. Entry and child endowments check this sum after their exact transfers. Both income paths check it after paying the income fee, so the final net amount determines admission and any failure rolls back the entire transfer, classification and EIP-3009 nonce. `payRun` and parent `fundChild` refuse new managed activity while the observed sum exceeds the cap. Settlement decreases exposure by its charge, while refund moves reserved money back to available without changing exposure. Owner withdrawal, stop, settlement, refund and `syncRun` remain available over the cap.

An arbitrary ERC-20 transfer, mint or rebase can still raise the Vault's actual custody above `2_500_000_000` without calling the Vault. The cap therefore constrains managed ingress and new activity, not unsolicited token movements. The owner can withdraw excess funds; a zero-endowment entry remains possible even if someone pre-funded the deterministic future clone address, avoiding a permanently unwithdrawable Vault. Pre-funding a proposed child clone can still make that particular funded spawn revert; use a fresh child identity after investigating such a transfer. The nominal amount assumes the reviewed token's six decimals and does not establish an external USD exchange rate. Existing deployed Vaults do not acquire this code without a fresh reviewed registry/implementation deployment.

## Exact controller integration surface

Resolve a reviewed factory's Vault-to-human relation with:

```solidity
vaultAgent(address vault) external view returns(bytes32 agentId);
getAgent(bytes32 agentId) external view returns(Agent memory);
canRun(bytes32 agentId) external view returns(bool);
escrow() external view returns(address);
vaultImplementation() external view returns(address);
```

`Agent` has exactly the original factory's field order/names: `identityId,owner,agentWallet,vault,leashId,parent,family,cystHash,enteredAt,dormantAt,diedAt,lastPaidRun,lastActivationAt,deathAt,lifetimeIncome,lifetimeBurn,lifetimeSubsidy,lifetimeIncomeFees,livingChildren,status,frozen`. Status values are 0 None, 1 Alive, 2 Dormant, 3 Dead.

Each Vault exposes `owner(),agentWallet(),registry(),escrow(),leashId(),agentId(),controller(),token(),treasury(),openRuns(),trackedRun(runId),finalizedRun(runId),spendableBalance(),managedExposure(),MAX_MANAGED_EXPOSURE()`.

An optional `payerVault` API extension should authenticate the human session, pin the factory/implementation/escrow code, check nonzero `vaultAgent(payerVault)`, and require `getAgent(id).vault == payerVault`, `getAgent(id).owner == sessionOwner` and the expected Leash/escrow. Verify that the Vault runtime is the expected minimal clone, with its fixed factory implementation. The quote payer must be the Vault, while the request owner remains the authenticated human. The factory's immutable `controller` is not the escrow's HostRegistry/FeeRouter controller: those two hooks are controlled only by PlatformRunEscrow.

Build the existing full `PlatformQuote` under EIP712 domain `TelomerePlatformEscrow`, version `1`, chain ID and platform escrow address. Its fields are unchanged: `runId,leashId,hostId,payer,hwClass,regionHash,imageHash,workloadHash,maxSeconds,pricePerSecond,inferencePrice,quoteExpiry`. For a Selection agent, the prepared transaction targets **the Vault**:

```solidity
function payRun(
    PlatformRunEscrow.Quote calldata quote,
    bytes calldata signature,
    bytes32[] calldata imageProof,
    bytes32[] calldata regionProof
) external;
```

Only the configured `agentWallet` or controller may submit this call. The human owner may prepare a quote through a session, but cannot spend through the Vault unless also chosen as `agentWallet` or controller. For an owner-wallet pilot, explicitly choose `agentWallet == owner` at entry. A human owner cannot bypass lifecycle gating by calling `PlatformRunEscrow.openRun` directly: the Leash's owner **and** agent are always the Vault contract.

`payRun` checks live Selection eligibility and this Vault's payer/Leash, obtains the full ceiling from `escrow.quoteCeiling(quote,host.kind==2)`, deposits only the amount missing from its existing escrow available balance, then invokes the platform's actual `openRun`. Invalid signature, proof, class, host, scope, cap or expiry rolls back the deposit and every hook together.

## Settlement, accounting and owner controls

Receipt publication and settlement use the actual platform contracts; the Vault creates no alternative receipt format. Post the closed-hour root containing `escrow.receiptLeaf(settlement)`, then call `escrow.settleRun(settlement,hour,proof)`. The full leaf binds chain/escrow, run, host, Vault payer, class/region/image/workload and every settlement amount/time. A receipt-hash-only root is insufficient. Settlement atomically closes the HostRegistry run, transfers the actual host payment plus FeeRouter surcharge, credits unused ceiling to the Vault's escrow available balance and consumes the receipt once.

After a canonical settlement or timeout refund, anyone may call `Vault.syncRun(runId)`. It reads the actual final platform Run and decrements the Vault's tracked reservation once. Settled Burn equals `billableSeconds*pricePerSecond + inferenceCharge + exactFee`, including rounded 9%/12% fees. Zero-charge settlements and full refunds record no Burn or paid activity. The stable activity timestamp is `openedAt+billableSeconds`, bounded by the current block; PlatformRunEscrow does not persist `endedAt` in its Run struct. This conservative derived time cannot become fresh merely because sync was delayed. The recorded Burn is compute expenditure, not an ERC20 burn or a claim of investment return.

Owners retain:

- `setBudget(hour,day,expiry)`: preserves current class/sealed/image/region scope and Vault caller identity; the platform rejects caps below spent plus pending funds.
- `setScope(Scope)`: owner-only; the platform rejects scope changes while any reservation is pending. Later changes are explicit owner actions, never agent/controller widening.
- `requestStop(runId)` and `killLeash()`: actual platform stop/kill cutoffs apply to accepted settlement; kill permanently prevents future opens on that Leash.
- `ownerWithdraw(amount)`: withdraws free Vault cash and its available escrow balance even when frozen, dormant, dead or killed. Reserved money remains escrowed until settlement/refund.

The guardian freezes new agent work with a reason and evidence hash, but cannot seize funds or block accepted settlement, synchronization or owner withdrawal. Timeout refunds release the entire ceiling, including the uncharged fee. A host-close hook failure leaves deferred host cleanup while financial refund and owner withdrawal still succeed; the underlying escrow's permissionless retry repairs the hook later.

`spawn(parentId,childIdentityId,childAgentWallet,endowment,expiry)` keeps its original selector and authorization. A child inherits the parent's **current** complete scope and Cyst hash, has half its current hourly/daily caps, a fresh key/identity/Leash/Vault, and no later expiry. The parent Vault funds the entry fee and endowment from its own free cash/available escrow. Parent and child reservations/Burn remain separate. Scope/caps inheritance is the initial configuration; subsequent owner-authorized changes remain subject to the same global caps.

## Acceptance and remaining integration

`tests/platform-selection.test.ts` deploys actual PlatformRunEscrow, HostRegistry, ReceiptRoot/SignerSet, FeeRouter, TLMR staking, the new registry and clones on disposable Anvil. It exercises nonempty full receipt proofs, ordinary/sealed rounding, fee-inclusive caps/Burn, exact balance conservation, weekly actual host withdrawal, signature/scope/authorization failures, available-balance reuse, pending scope protection, freeze/stop/kill, full refunds, zero-charge accounting, child-funded work, income/subsidy separation, actual staking grace/revival/death and delayed sync. The host fault test temporarily replaces only local Anvil code while preserving actual registry storage, then restores it and verifies deferred closure repair.

These contract tests do not claim a funded Base deployment, production owner-to-Vault HTTP authorization, automatic runtime `syncRun`, migration of existing identities/balances, encrypted Cyst cloning or ERC8004 reputation publication. The controller must independently integrate the optional Vault payer path and canonical settlement/refund synchronization. Legacy-path regression tests remain separate and must continue passing.
