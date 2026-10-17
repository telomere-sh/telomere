# Paid CPU Lifeline and Metabolism

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`AGENT_RUNTIME=platform` connects the existing authenticated `/api/agents` lifecycle API to EOA-paid `PlatformRunEscrow` CPU work. `AGENT_RUNTIME=platform_vault` connects it to each agent's own reviewed `PlatformAgentVault`. The original legacy lifecycle integration remains the default. All modes use the same owner-scoped transition protocol, Cysts client and explicit owner-side runner described in [agent-lifecycle.md](agent-lifecycle.md).

## Configuration and persistent financial scope

| Setting | Effect |
| --- | --- |
| `AGENT_RUNTIME=legacy` | Default; lifecycle reservations and settled spend use the original controller escrow |
| `AGENT_RUNTIME=platform` | Lifecycle reservations and Metabolism use the independently reviewed paid platform runtime |
| `AGENT_RUNTIME=platform_vault` | Human-owner lifecycle with per-agent `PlatformAgentVault` spendable balance and canonical Selection burn; private runtime JSON must include reviewed `vaults` pins |
| `CYSTS_ENABLED=true` | Required for platform lifecycle and for mounting either lifecycle's application-checkpoint API |
| `CYSTS_DIR` or `CYSTS_REPLICATION_CONFIG` | One authoritative private Cysts storage configuration; required when Cysts are enabled |
| `PLATFORM_RUNTIME_CONFIG` | Required for platform lifecycle; private reviewed JSON with platform contracts, dedicated signer and HostKit configuration |

The private platform configuration is documented in [platform-runtime.md](platform-runtime.md). Merely enabling that configuration does not switch the lifecycle away from its default legacy binding. No wallet key is supplied to `/api/agents`; the owner independently approves/funds paid runs through the existing platform payment flow.

The lifecycle database persists one financial namespace in `agent_runtime_binding`: protocol, chain ID, escrow address, token address and, for Vault mode, a hash of the reviewed public registry/implementation addresses and code hashes. Startup checks it before host cleanup or financial recovery. Changing any field fails closed and requires a separate, reviewed lifecycle database; it does not reinterpret existing billing, reservations or agents. Existing unmarked lifecycle records are treated as legacy and cannot be silently adopted by either platform mode. Backups/restores must retain this binding, `agent_vault_bindings` and the billing/provenance tables with the ordinary agent/intent/Cyst records.

The public controller configuration exposes `platform.agentRuntimeScope`; private signer/control files remain outside that response. EOA mode identifies `ownerPayersOnly: true`; Vault mode identifies `ownerPayersOnly: false`, `agentVaultsOnly: true` and its reviewed registry/profile hash. Both paid modes have maximum lease 120 seconds and rollover lead 30 seconds.

## Human ownership and per-agent Vault finances

In Vault mode the lifecycle `owner` is the actual human Vault owner and `agent` is its `agentWallet`, while the financial runtime's payer remains the Vault contract. Registration resolves `PlatformSelectionRegistry.agentWalletAgent`, verifies the registry entry, exact factory clone, immutable owner/agent/Leash bindings and reviewed code relationships. It commits the agent row and its pinned Vault binding in one SQL transaction after those RPC reads. An agent wallet's authenticated runtime session cannot impersonate the human lifecycle owner. Registration accepts no caller-supplied Vault address. Subsequent financial reads must match the persisted original Vault; a changed registry mapping or local binding fails closed.

Metabolism reads that agent Vault's `spendableBalance`, including free token cash and unreserved escrow funds. Two agents owned by the same person retain separate balances and burn journals. EOA escrow balance is excluded from this mode. Frozen/dormant/dead identities retain owner reads and kill access; new target reservations still require current Vault `canRun` and Leash permission.

Vault charge import requires the actual canonical agent-signed `payRun` transaction, matching `RunFunded`/`RunOpened`, historical registry ownership at admission, original signed quote, Merkle financial proof and fee-inclusive escrow settlement. It additionally verifies the runtime's automatic `syncRun`, actual `RunFinalized`, tracked/finalized state and matching Selection `Burn` event. Positive burn uses the event's exact `paidAt` (accepted opening time plus billable seconds, clamped as the contract specifies), so delayed settlement/sync cannot refresh an old burn into the latest 24-hour window. Zero-charge finalizations have no Selection `Burn` and remain valid zero entries.

Vault provenance anchors the later canonical sync block, which must follow the escrow settlement block. Losing only sync finality therefore blocks evaluation even when the original escrow settlement survives. Shared staged-import and durable-prefix checks below apply equally to this distinct financial namespace. The lifecycle importer verifies sync evidence; it does not broadcast new payments or replace the runtime's existing automatic sync recovery.

## Admitted reservations and the owner runner

The EOA adapter accepts admitted EOA-paid CPU runs belonging to the authenticated owner and the registered agent. It checks the original signed quote/input/workload, canonical `RunOpened` transaction, reviewed escrow relationships, current active run/Leash and owner/agent scope. Vault-paid runs are excluded from EOA mode. Vault mode accepts only separately admitted CPU runs from the owner's pinned agent Vault; EOA-paid work is excluded.

The lease ends at the earliest of the run's opened time plus its accepted duration, accepted expiry, current Leash expiry and original deadline. Maximum duration is 120 seconds; `rollDue` becomes true 30 seconds before expiry. The API does not extend the paid reservation. A rollover needs a distinct, independently admitted reservation; missing/revoked/expired targets fail closed.

Actual checkpoint, stop, attach, restore and resource-mode effects still belong to the owner's `ClientAgentRunner` and `ClientLifecycleVault`. The server supplies durable intent phases and checks; it does not turn a completed exec task into a persistent agent, purchase a target run or silently create an execution daemon. The [paid-session checkpoint adapter](paid-session-checkpoint.md) can capture application-state bytes from an already paid CPU session. Arbitrary application restore still requires an application-aware runner. A 15-minute checkpoint cadence cannot occur inside a single 120-second reservation; longer owner-side operation requires separately approved paid reservations and lifecycle orchestration.

## Canonical fee-inclusive burn

Metabolism refreshes billing before evaluating or planning activity. Imported entries come from actual completed EOA-paid platform runs, never HTTP-supplied spend. Validation binds the original quote to its payer, workload, Leash and run ID; the parsed settlement must reference that same run. It rechecks the runtime's financial receipt proof, canonical admission and settlement, exact charge/refund conservation and successful escrow events. Burn includes host charge plus the platform fee, in exact payment-token units. Available balance excludes outstanding reservations.

Agent attribution reads the parent block's Leash and replays the original block's canonical `LeashCreated`/`LeashUpdated` events before the `RunOpened` log. Updates later in that same block or a later block do not move historical burn to the replacement agent. EOA admission also rejects an agent changed before opening, even if it changes back before block end. This requires historical RPC reads and bounded block-hash log queries. Settlement time comes from the canonical settlement block timestamp; a leading chain clock is refused until wall time catches up. Current paid evidence checks canonical inclusion through the reviewed RPC; this adapter does not add a separate finalized-block or configurable confirmation-depth policy.

Each imported charge and its settlement transaction/block number/block hash are committed in one SQL transaction. A facts hash binds those fields to owner, agent, run, amount and settlement time. Replays must preserve both accounting and provenance. New provenance starts unvalidated. A separate durable `agent_billing_anchors` prefix advances atomically with validation markers only after checking its previous canonical block, the imported blocks and an unchanged pinned chain head. Partial imports cannot advance this anchor. It is rechecked even after charges leave the trailing 24-hour window; a reorg during import cannot be masked by a newer replacement-chain charge. Missing provenance, unfinished validation, changed facts or lost canonical history block evaluation and require original-history recovery or deliberate operator reconciliation.

Refresh imports and validates at most 100 pending entries per call. If more remain, the imported page persists and evaluation returns `agent_billing_unconfirmed`; subsequent maintenance/evaluation advances the next page. Maintenance visits a rotating bounded page of 100 registered owner/agent pairs, including interrupted unvalidated imports, and continues other pairs when one requires recovery. At most 2,048 recent evidence entries per agent are evaluated in the rolling 24-hour window; overflow fails closed rather than truncating burn. This is a bounded service and requires deliberate capacity/reconciliation work when those limits are exceeded.

## Permanent owner kill during uncertainty

Unavailable RPC, orphaned financial evidence or an unfinished billing backlog returns 503 `agent_billing_unconfirmed` for evaluation and activity planning. Owner-scoped registry reads remain available. `action: "kill"` bypasses financial evaluation and returns `evaluation: null`; it permanently latches `killedAt` and supersedes a pending intent. It cannot attach a target reservation. The HTTP client accepts a null evaluation only for a kill intent.

The owner runner must execute and acknowledge the durable stop phase, including a possible source and partially attached target. The latch blocks subsequent wake/migration and stale acknowledgments; a local API response alone cannot fence an unrelated external executor. This transition neither withdraws funds nor supplies an owner signature for an on-chain Leash transaction.

## Local acceptance

Run `npx vitest run tests/paid-agent-lifecycle.test.ts tests/paid-vault-agent-lifecycle.test.ts tests/paid-vault-agent-main.test.ts tests/platform-main.test.ts --reporter=verbose` with the repository's ordinary type/build checks.

The paid lifecycle acceptance uses real local platform contracts, generated accounts, actual admitted CPU execution and fee-inclusive settlement, disk PGlite reopen, later Leash agent changes, billing corruption and snapshot/revert loss of settlement finality. Vault acceptance verifies Selection burn, separate balances for two agents of one owner, historical paid-at time, sync-block provenance, lost sync while escrow settlement survives and owner kill during policy-reader failure. Main-app acceptance exercises actual signed authentication, mounted HTTP clients/routes, missing Vault-pin rejection, owner versus agent-wallet authorization, public scope and rejection of a persisted financial-scope switch. These are local engineering checks. They establish no public Base deployment, personal-wallet transaction, production lifecycle runner, GPU/TEE migration or general multi-host restoration.
