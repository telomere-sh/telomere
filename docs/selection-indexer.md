# Selection indexer and canonical Fossil Record

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`src/selection` implements a read-only, durable event index for the actual `SelectionRegistry` and `AgentVault` contracts. It reconstructs owner agents, vault accounting, family/generation relationships, lifecycle state, population totals and a deliberately public Fossil Record. It never holds a signing key, signs a message, submits a transaction or exposes an indexing/financial mutation endpoint.

## Integration and reviewed deployment

Add `selectionSchema` to the database schema and execute `selectionMigrationSQL`. Construct the indexer with independently reviewed deployment settings:

```ts
const reader = createSelectionReader(reviewedRpcUrl);
const selection = new SelectionIndexer(db, {
  reviewed: true,
  chainId: reviewedChainId,
  registryAddress: reviewedSelectionRegistry,
  registryCodeHash: reviewedRuntimeCodeHash,
  startBlock: registryDeploymentBlock,
  confirmations: reviewedConfirmationCount,
}, reader);
await selection.sync();
```

The start block must include every birth in this registry. Missing a parent/ancestor fails closed rather than guessing a family or generating incomplete financial history. Chain ID is checked on each sync. An optional independently supplied runtime code hash is checked before indexing; the observed code hash is also pinned in the durable cursor and must remain unchanged across restarts. The contract/address/profile itself must be reviewed before enabling an index; a local `reviewed: true` flag cannot prove an ERC-8004 identity registry or deployment is canonical.

The profile key binds chain ID, registry address, start block and confirmation policy. Changing those settings creates a separate index. Operational bounds can change without mixing chain histories. Default bounds are 64 blocks per sync, 64 blocks of reorg recovery, 50,000 retained replay events, and 1024 discovered vaults. Maximum configurable bounds are 256 blocks, 256 reorg blocks and 100,000 events. Vault log filters are split into at most 64 addresses per RPC call; total logs in a page may not exceed 5000. A dense page or a full event/vault capacity fails closed; an operator must deliberately review a smaller block page or capacity/incremental-index upgrade rather than silently dropping events.

The JSON-RPC reader permits HTTPS or isolated loopback HTTP, refuses URL userinfo and redirects, makes no transparent retries, uses bounded request/body deadlines and caps each response at 8 MiB. It calls only `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_getCode` and read-only `eth_call` for a vault's spendable balance. Runtime/provider error details are redacted. Historical balance views require the provider to support `eth_call` at the indexed block; if unavailable, the financial view fails rather than fabricating a current balance.

## Cursor, reorg recovery and persistence

Each page persists canonical block headers, decoded logs, materialized agents, fossils and its next-block/hash/revision cursor in one SQL transaction. Logs must come from the reviewed registry or a discovered vault and match a fetched canonical block hash. Log order is block number then log index. Duplicate log IDs, changed block ancestry or a changed end-block hash reject the page. SQL row locks and cursor revision checks prevent concurrent indexers from committing two different pages over the same cursor. Steady-state sync returns without rewriting the cursor.

Before advancing, the previous cursor hash is checked against the current chain. A changed or shortened chain finds the last retained canonical ancestor, atomically removes orphaned logs/headers and rebuilds materialized views from the retained canonical ledger plus new logs. A shortened confirmation window also retracts records that no longer satisfy the profile. An RPC timeout is not treated as evidence of a reorg and cannot trigger rollback. A reorg beyond the configured recovery depth leaves previous evidence intact and requires operator-directed rebuilding from the reviewed start block.

Headers are persisted for ancestry verification; projection replay reads only event-linked headers and the bounded event ledger. The current implementation rebuilds materialized views transactionally from that ledger. It is intentionally capacity-limited and does not claim an unbounded production archival index. Database backup/restore must include these tables.

## Financial and family semantics

- Registry `Birth` determines identity, owner, vault, Leash and parent. Family is inherited from the indexed parent, and generations begin at zero. Total offspring and living children are tracked separately.
- `Income` is the contract's externally earned gross income; `Subsidy` is a separate total. Owner, own agent wallet, family wallets/vaults, controller, treasury and registry funding are excluded from income by `SelectionRegistry` itself. The index does not relabel generic ERC20 transfers as earnings. Direct token donations without classified registry events remain unclassified even though actual vault balance includes them.
- `Income` and `Subsidy` totals are counted once. The vault's `FundsReceived` event must match the registry classification in the same transaction and does not add a second income amount.
- `Burn` uses the amount and original `paidAt` emitted after actual settled-run observation; delayed synchronization does not invent a recent burn timestamp. Vault `RunFunded`/`RunFinalized` reconstruct open-run counts. Owner withdrawals and child funding are recorded separately and cannot become income.
- `Dormant`, grace extension, revival, freeze and death events reconstruct lifecycle state. Revival starts a new activation window without changing historical paid burn.

All token amounts and timestamps remain exact integer strings. Owner financial views use the vault's actual `spendableBalance()` **at the indexed canonical block**, independently recheck that block hash, and calculate trailing-24-hour burn over `(indexed time − 24 hours, indexed time]`. Runway includes both an integer-second display and its exact rational numerator/denominator. Net income is external gross income minus its protocol income fees; survival ratio is net income divided by lifetime burn, represented as a rational pair. Zero burn produces `null`, not an invented infinity or percentage. Subsidies do not enter this ratio. This ratio is an explicit metric, not an official reputation score.

## Public Fossil Record and API

A canonical confirmed `Death` produces a public fossil containing lifespan, final gross/net income, income fees, burn, subsidy, total offspring, family/generation, identity, cause bytes32, cyst hash, and death block/hash/transaction evidence. Lifetime totals and lifespan must agree with the indexed history. Later guardian activity does not rewrite the fossil snapshot. A fossil is immutable **within the indexed canonical history**; a chain reorg can retract an orphaned death/fossil, and the public response includes the indexing block/hash and confirmation policy so consumers can distinguish this from permanent archival finality.

Mount `createSelectionRoutes(selection, authenticatedOwner)` at `/api/selection` with the application's ordinary body/rate/security middleware:

| Method | Path below the mount | Access |
| --- | --- | --- |
| GET | `/agents?cursor=0x…` | Authenticated owner's bounded registry |
| GET | `/agents/:id` | Authenticated owner's agent and exact metrics |
| GET | `/fossils?cursor=0x…` | Deliberately public canonical fossils |
| GET | `/fossils/:id` | Deliberately public fossil snapshot |
| GET | `/population` | Deliberately public aggregate population/accounting |

Lists use strict ascending agent-ID cursors and pages of 50. Another owner receives an empty registry or 404 for an agent/financial view. Fossil fields are on-chain public facts. The embedding controller schedules `sync`; public callers cannot trigger indexing, enter Selection, withdraw, freeze, declare death or send wallet transactions through these routes. ERC-8004 reputation publication, hosted dataset export and external reputation delivery are separate integrations and are not claimed by this read-only module.

## Acceptance evidence

`tests/selection-indexer.test.ts` compiles and deploys the real new SelectionRegistry/AgentVault contracts onto a generated-key disposable Anvil chain. It verifies externally earned income, owner/family/controller/treasury subsidies, actual escrow payments and burn, child generations, exact vault balances, and no double counting of vault/registry events. It closes/reopens a filesystem-backed PGlite store and proves unchanged accounting/cursor. Actual lifecycle transactions cover dormancy, revival, death and immutable fossil snapshots.

A real Anvil snapshot/revert replaces an indexed death branch with a different income/revival branch; sync retracts the orphaned fossil/death event and replays the replacement. Other tests check confirmations, bounded pages, wrong chain/code, log-hash tampering, transient RPC failure without rollback, deep-reorg refusal and public/owner route boundaries. These are local-chain acceptance results, not funded Base Sepolia deployment or a public canonical ERC-8004 launch.

Run `npx vitest run tests/selection-indexer.test.ts`.

Primary protocol references: [Ethereum JSON-RPC API](https://ethereum.org/developers/docs/apis/json-rpc/) and [Ethereum execution API eth_getLogs schema](https://ethereum.github.io/execution-apis/api/methods/eth_getLogs/). Financial classification and lifecycle behavior come directly from the repository's `contracts/SelectionRegistry.sol` and `contracts/AgentVault.sol`.
