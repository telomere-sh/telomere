# Selection death reputation publication

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`SelectionReputationPublisher` implements the optional publication side of Backend §9. It takes facts only from `SelectionReputation`, whose summaries are replayed from the confirmed Selection ledger. The ERC-8004 numeric signal is lifespan in seconds; exact lifetime income, income fees, net income, burn, cause and canonical death evidence remain in the hashed JSON feedback file. It does not invent a profitability score.

Publication is disabled unless the operator supplies a private, explicitly authorized configuration and a dedicated publisher key. Public feed routes remain read-only. No request body can supply metrics, a destination, signer, transaction or publication trigger. Initialization binds the database and never broadcasts. Maintenance runs after canonical Selection indexing.

## Configuration and composition

The composition root calls:

```ts
const publisher = await configuredSelectionReputationPublisher(db, selectionReputation, selectionIndexer, {
  ...(config.REPUTATION_PUBLISHER_CONFIG ? { configurationFile: config.REPUTATION_PUBLISHER_CONFIG } : {}),
  rpcUrl: config.RPC_URL,
  chainId: config.CHAIN_ID,
  mode: config.MODE,
  financialSigners: actualApplicationSignerAddresses,
});
// After a successful Selection sync:
await publisher?.maintain();
```

Omit the `configurationFile` property when disabled. `financialSigners` must come from actual application configuration. Main supplies its known controller, platform and demo signer addresses. Configured Vault income also rejects the publisher address as a facilitator signer. Any externally managed fee or facilitator signer remains an operator review requirement and must be included by an embedding application that knows it. The publisher key must match the reviewed publisher address and differ from the supplied application signers. The identity owner and its approved ERC-721 operators are also forbidden feedback publishers; these permissions are checked both at the historical source anchor and at a freshly pinned current target block before each send.

The private JSON file has this shape, with reviewed deployment values substituted by the operator:

```json
{
  "authorised": true,
  "profile": {
    "reviewed": true,
    "deploymentKind": "erc1967",
    "chainId": 84532,
    "identityAddress": "<reviewed identity registry>",
    "identityCodeHash": "<reviewed proxy runtime code hash>",
    "identityImplementationAddress": "<reviewed identity implementation>",
    "identityImplementationCodeHash": "<reviewed identity implementation runtime code hash>",
    "reputationAddress": "<reviewed reputation registry>",
    "reputationCodeHash": "<reviewed proxy runtime code hash>",
    "reputationImplementationAddress": "<reviewed reputation implementation>",
    "reputationImplementationCodeHash": "<reviewed reputation implementation runtime code hash>",
    "publisherAddress": "<dedicated independent publisher>"
  },
  "signerKeyFile": "<absolute private key file>",
  "confirmations": 3,
  "maxPublications": 1024
}
```

The example describes a schema, not deployable addresses. Files must be bounded regular files with one hard link; symbolic links and files changed during opening/reading are rejected. Unix group/other permissions must be absent. The key is never accepted through a public API or returned in status. Remote RPC requires HTTPS; a disposable local chain 31337 may use loopback HTTP. Testnet configuration is restricted to chain 84532 and requires at least one successor block for both source death evidence and publication receipt finality.

The immutable database namespace includes source profile, proxy and implementation pins, identity registry, publisher, application signer exclusions, receipt confirmations and capacity. Changing any requires an independently reviewed migration or a separate database. `deploymentKind: "direct"` is accepted only for an explicitly reviewed disposable chain 31337 fixture whose Identity and Reputation ERC-1967 implementation slots are both zero. A public-chain profile must use `erc1967` and specify both implementation addresses and runtime hashes. A proxy with a nonzero implementation slot cannot pass as `direct`. There is no automatic target discovery or public deployment assumption.

## Durable behavior

Each canonical summary hash fixes one exact `giveFeedback` intent. The complete canonical JSON, data URI, hash and calldata are persisted, then the existing `PlatformTransactions` journal atomically reserves the dedicated sender's nonce and stores original signed bytes before broadcast. The common nonce lane prevents signing around unresolved earlier transactions. Restarts and lost replies reconcile the original deterministic hash; automatic retries never sign replacement bytes.

A successful transaction alone is insufficient. Confirmation checks the exact current [ERC-8004 ABI](https://eips.ethereum.org/EIPS/eip-8004): `NewFeedback.feedbackIndex` is non-indexed, while `indexedTag1` carries the indexed tag hash. The event's publisher, agent ID, index, numeric signal, decimals, tags, endpoint, complete URI and content hash must match. The receipt must be canonical and sufficiently confirmed. Current `getLastIndex` and `readFeedback` must show the same live, unrevoked value and tags, and the active accepted entry must still be the last feedback index. Before creating a fresh signed intent, a publisher with prior feedback must account for every previous index through this database's canonically published and revoked journal entries. A first intent with earlier manual/database feedback fails with `selection_reputation_existing_feedback_requires_review`; existing original journal recovery remains possible. After this history review, current target permissions/code and the authorized last index are checked again before the final source snapshot. Code hashes, registry links and publisher independence are rechecked at pinned canonical blocks. Invalid events, altered storage, permission changes, RPC outages or unconfirmed receipts fail closed.

The publisher reads each proxy's EIP-1967 implementation slot and implementation bytecode by canonical block hash at the Selection source anchor, before a signed intent, at each original or revocation receipt's inclusion block, and during live feedback confirmation. An implementation upgrade visible in the receipt block's final state fails even if the slot is restored in a later block. Standard historical state reads cannot detect an upgrade and rollback within the same block; ruling that out needs reviewed upgrade governance or transaction traces. An RPC that cannot serve canonical historical storage or code is not eligible for publication.

The source's immutable birth owner is derived from canonical Selection replay, kept out of public death summaries, and persisted with each publication plan. A new feedback intent requires the Identity NFT owner at the source anchor and fresh target head to equal that birth owner. Acceptance also reads owner and publisher approval at the original feedback receipt's canonical block. A transfer or operator approval during inclusion cannot be hidden by reversing it before live observation, subject to the documented same-block state-read limit. If ownership or approval changes after publication, maintenance reconciles the original signed transaction and revokes only its own verified feedback, then surfaces `selection_reputation_identity_owner_changed` or `selection_reputation_publisher_permission_changed` for operator review. Revocation remains possible after transfer, approval change or source reorg. An unresolved original intent is retained, never replaced to bypass this gate.

If a source death is orphaned or its summary changes, a successfully read canonical feed must first cover both the persisted original death height and the complete current confirmed source head (`latest - source confirmations`). Its indexed block hash must match that exact canonical height. A successful but partial index synchronization, lagging index, unresynchronized reorg or unavailable RPC never proves absence. Complete confirmed-head coverage and the exact death or absence are checked again immediately before each publication/revocation submit. A new block can still arrive during transaction preparation or inclusion; this inherent chain race is handled by original-hash reconciliation and later canonical source review, rather than a claim of atomic cross-contract observation. The publisher observes the original feedback hash without rebroadcasting its signed bytes. A canonically present original feedback is revoked with a second journaled, exact `revokeFeedback` intent, and both `FeedbackRevoked` and live revoked storage must confirm it. This cleanup verifies the original index itself even if an unknown later feedback exists; it does not claim to control or revoke that external entry. An absent original receipt is marked retracted without signing a cancellation or replacement. A different summary for the same Selection agent cannot be admitted while an older signed original intent remains unresolved. After that original canonically appears and is revoked, the changed summary may be published. Each publication or revocation can advance the source head, so further work may wait for the next index-sync cycle.

If the source death remains canonical and only its publication transaction is reorganized, maintenance rebroadcasts the identical original signed bytes and verifies the resulting receipt. Index revisions may advance without changing publication identity or content.

## Operator recovery boundaries

Restoration after a revocation intent is deliberately fail closed. An old signed revocation can remine after a reorg restores the death and original feedback. Whenever that original summary is canonical again and its revocation journal exists, maintenance returns `selection_reputation_republication_requires_review`; it does not create a new generation automatically. The operator must review canonical source, original publication and revocation hashes, nonce state and active feedback before explicitly migrating this journal. There is no claim of automatic permanent recovery across this boundary.

An orphaned original signed intent with no canonical receipt can also block a changed source generation with `selection_reputation_original_intent_unresolved`. The service never cancels it, changes its nonce or broadcasts it merely to make progress. Review or canonical observation is required. Per-agent review errors are retained while other independently safe deaths are considered, then surfaced to the maintenance caller; global canonical-index, deployment, database and RPC failures stop the cycle. The shared signer nonce can still prevent independent sends when a prior transaction is unresolved. Any externally revoked feedback, reverted original transaction, consumed foreign nonce, incompatible deployment change or corrupt journal likewise remains unavailable instead of silently producing another feedback.

Capacity is bounded: at most 1,024 publication records by default, configurable up to 4,096, with at most 1,024 source agents per Selection profile. The shared transaction journal's existing 4,096-entry bound still applies to this sender, including revocations. Reaching a bound requires archival review. No history is automatically discarded. These are storage/replay bounds, not a bound on the total duration of a maintenance call: each individual RPC is bounded, but a large backlog entails sequential reconciliation. Operators must schedule/cap a large catch-up separately and account for the controller's shutdown deadline; this module does not promise to drain 1,024 records within that deadline.

These controls rely on independently reviewed non-adversarial registry semantics, upgrade governance that excludes same-block replacement attacks, and a truthful historical RPC. The ERC-1967 slot/address/runtime-hash pins reject an implementation change visible at checked block states but do not make an upgradeable proxy immutable. An authorized upgrade requires new review and an explicit immutable-profile migration. The local acceptance registry is a disposable exact-ABI semantics fixture, not an upstream reference implementation. This module does not perform a funded public launch.

## Acceptance

`tests/selection-reputation-publisher.test.ts` uses real Anvil transactions, deployed SelectionRegistry and AgentVault contracts, ERC-1967 proxy fixtures, and reopened on-disk PGlite. Scenarios cover exact publication and live state, lost send acknowledgment plus failed final observation, restart without duplication, publication reorg with exact-byte recovery, source reorg without rebroadcast, partial-index lag and replacement-branch revival, a block arriving during planning, canonical replay and revocation, changed-summary generation gating, prior manual and later unknown feedback, independent-agent progress through a per-agent review requirement, current operator permissions and target code changes, malformed events/live storage, immutable configuration and explicit recovery after an existing revocation intent. Proxy cases reject missing implementation pins, upgrades at historical/current anchors, altered implementation bytecode and receipt inclusion under a temporary upgrade. Identity cases cover transfers before or after publication, transfer-and-return across the original receipt, and operator approval after publication with exact cleanup.

For an enabled `startPilot` acceptance, reuse the fixture's compiled identity/reputation contracts, source deployment/profile, `catchUp` loop and private configuration shape. Supply independent real application signer addresses, write the dedicated generated test key to a private file, enable Selection with its reviewed source profile, then start the controller with its opt-in publisher config. Initialization must leave the publisher nonce unchanged; subsequent actual controller maintenance must publish once and retain the same transaction hash across controller restart. Root integration tests own this application-level wiring.
