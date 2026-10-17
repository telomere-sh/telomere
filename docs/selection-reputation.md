# Canonical Selection death summaries and unsigned reputation plans

Backend §9 requires a death summary containing lifespan, income, burn and cause in ERC-8004 Reputation, derived from evidence rather than self-reported numbers. `src/selection/reputation.ts` supplies the canonical summary feed; `src/selection/reputation-feedback.ts` prepares a reviewed, unsigned ERC-8004 transaction. Optional journaled publication and orphan-feedback revocation are described in [selection-reputation-publisher.md](selection-reputation-publisher.md).

## Feed integration

```ts
const reputation = new SelectionReputation(db, selectionIndexer, selectionReader);
app.route('/api/selection', createSelectionReputationRoutes(reputation));
```

The embedding service owns the existing indexer's bounded `sync()` schedule. Public callers cannot trigger synchronization, submit metrics or initiate a transaction.

| GET path below `/api/selection` | Result |
| --- | --- |
| `/reputation/deaths?limit=50&cursor=…` | Confirmed canonical death summaries; page size 1–100 |
| `/reputation/deaths/:agentId` | One death summary and its evidence/coverage envelope |
| `/reputation/files/:feedbackHash` | Exact canonical JSON bytes committed by the summary's KECCAK-256 hash |

The response carries the chain, reviewed Selection registry, indexed block/hash, confirmation policy, cursor revision and explicit `deploymentHistoryVerified: false`. This flag means the configured start block and retained ledger do not independently establish complete deployment history. It must not be interpreted as a complete network reputation dataset.

Every request replays the persisted bounded ledger in a repeatable-read, read-only transaction. Registry `Death` is checked against the reconstructed birth/lifecycle and cumulative accounting. Externally classified gross income, its fees and net income remain separate exact integer strings. Subsidies never become earned income. Burn comes from the registry's observation of settled escrow runs. No exchange-rate, payment-token decimal, positive quality score or economic ranking is inferred.

The public summary exposes agent/identity IDs, lifespan, gross/fee/net income, burn, death cause, birth/death times and canonical death transaction/log evidence. It excludes owner/payer addresses, Vault balance, Leash, run/workload/payment references, Cyst hash, endpoint declarations, keys and private runtime state. Existing public on-chain facts outside this response are not rendered private by this API.

Before and after replay, independent read-only RPC checks revalidate chain, Selection runtime code pin, anchor block/hash/timestamp and confirmation depth. A final database revision check rejects concurrent index advancement. The service refuses unavailable, insufficiently confirmed or orphaned evidence with 503. A changed snapshot invalidates pagination with 409; orphaned death summaries/files disappear with 404 after the indexer rolls back that branch. Responses use `Cache-Control: no-store`; an ETag identifies file bytes without claiming archival permanence.

Canonical file bytes contain death provenance, excluding the changing index revision or current anchor. They therefore retain the same hash after restart or ordinary index advancement, while a different canonical death creates a different hash. Files are reconstructed from canonical evidence rather than retained forever after a reorg.

## Unsigned ERC-8004 plan

```ts
const planner = new SelectionReputationPlanner(reputation, {
  reviewed: true, deploymentKind: 'erc1967', chainId,
  identityAddress, identityCodeHash, identityImplementationAddress, identityImplementationCodeHash,
  reputationAddress, reputationCodeHash, reputationImplementationAddress, reputationImplementationCodeHash,
  publisherAddress,
}, createSelectionReputationTargetReader(reviewedRpcUrl));
const plan = await planner.prepare(agentId);
```

The current [ERC-8004 primary specification](https://eips.ethereum.org/EIPS/eip-8004) defines `giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)`, with a KECCAK-256 commitment to the optional feedback file. It disallows feedback from the identity owner and its approved operators. The planner uses the literal lifespan in seconds as `value` with zero decimals and tags `lifespan` / `telomere.death.v1`; it does not invent a reputation score. The complete exact death summary sits inside the feedback JSON. An embedded `data:application/json;base64,…` URI supplies those exact bytes with their hash, so preparing a transaction requires no writable hosting destination.

The operator independently supplies all target addresses/code hashes and the intended publisher. At the feed's canonical anchor, read-only EIP-1898 block-hash calls require Selection's `identityRegistry()` and Reputation's `getIdentityRegistry()` to equal that reviewed identity address. Both target proxy runtime hashes, EIP-1967 implementation addresses and implementation runtime hashes must match. The identity must exist; its NFT owner must still equal the birth owner from canonical Selection replay, and the publisher must differ from that owner, token-approved address and globally approved operators. Chain, block/hash and confirmation depth are checked around the target reads; the feed is rechecked before returning. RPC uses only read methods, no retries, a deadline spanning headers/body, an 8 MiB response limit, HTTPS or loopback, and no userinfo or redirects. Unsupported historical storage reads fail closed. Provider errors are redacted.

The plan includes `from`, `to`, zero native value, calldata, exact feedback bytes/URI/hash, private original birth owner, source summary hash and canonical index/coverage. No nonce, signed transaction, gas estimate, broadcast or publication confirmation is produced. The optional publisher revalidates the exact plan before signing, tracks duplicate submissions and revokes its own orphan feedback. Proxy implementation pins still require independent deployment review and do not freeze governance.

For the specification's numeric `agentId`/`value` JSON fields the planner refuses values exceeding JavaScript's exact integer range instead of rounding; summary amounts always remain exact strings. A future wire-format adapter is required for larger identity IDs/lifespans. The plan is available as a backend module, without a public publication route or wallet requirement.

## Verification

Run `npx vitest run tests/selection-reputation.test.ts --reporter=verbose` and `npm run typecheck`.

The acceptance uses real repository SelectionRegistry/AgentVault/escrow/token contracts on a generated-key disposable Anvil chain, actual external income and excluded subsidies, signed paid-run settlement/burn, real dormancy/death and snapshot/revert reorgs. It checks filesystem PGlite reopen, stable content under index advancement, bounded pagination and stale cursors, exact public file hashes/privacy, rejection of corrupted event totals, target code/identity/owner/operator checks, and stalled/oversized RPC bodies. A minimal generated-key direct ABI fixture executes the prepared calldata locally; that fixture is deliberately not presented as the upstream ERC-8004 reference implementation or a canonical registry. No public chain or funded publication is exercised by this planner test.
