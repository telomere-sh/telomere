# Weekly Selection datasets

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

When the reviewed `SELECTION_ENABLED` indexer is configured, the main server exposes three public, read-only endpoints:

- `GET /api/selection/dataset?week=2030-01-07&limit=50`
- `GET /api/selection/dataset.csv?week=2030-01-07&limit=50`
- `GET /api/selection/analytics?week=2030-01-07`

`week` is a UTC Monday in `YYYY-MM-DD` format. Pages contain at most 100 agents and may return an opaque `nextCursor`; pass it unchanged with the same week. A changed index revision, canonical hash or profile returns 409 and requires restarting at the first page. Invalid dates, duplicate/unknown query parameters and malformed cursors return 422. The server does not broadcast transactions or require a wallet for public datasets. Owner-scoped `/agents` remains authenticated.

The dataset replays the persisted canonical event ledger as of the earlier of week end and indexed time. Historical pages exclude later births and later changes of status. Income, fee, net income, burn and subsidy are exact decimal strings in **registry token base units**. Subsidies remain separate from income. Weekly amounts use canonical event block timestamps; they do not substitute settlement execution time. No asset symbol or decimal scale is assumed without an independently reviewed token binding.

Every response includes the index revision, canonical block hash, confirmation policy and coverage. A history starting inside the week or an index stopping before its end is marked partial. `deploymentHistoryVerified` remains false: a configured starting height alone does not establish complete deployment history. CSV uses quoted RFC 4180 records with CRLF and always includes a metadata record, including for an empty week. Page metadata records `firstPage`, `afterAgentId`, returned/total row counts, `hasMore` and the next cursor, so a saved final page does not claim to be a complete export. CSV also carries `X-Selection-*` headers. Responses are `no-store`.

Analytics includes seven UTC birth/death buckets, population at the cutoff, exact rational median completed lifespan, exact income/burn distributions, income-to-burn comparisons and a deterministic top-ten income list. The median retains numerator/denominator rather than rounding large integers through floating point. Percentiles use nearest rank. Public rows omit owners, Vault/Leash addresses, payers, payment references, private freeze reasons and controller job histories.

The DB read uses a repeatable-read snapshot bounded by the reviewed indexer's event and Vault limits. Independent RPC checks before and after the read verify chain, code pin, canonical anchor timestamp/hash and confirmation depth; a final DB revision check rejects a concurrent index update. Orphaned, insufficiently confirmed, unavailable or over-capacity evidence returns 503 until the index is synchronized. Unsupported or stalled RPC responses fail within the retained per-request deadline. This provides bounded canonical snapshots, not a live reputation oracle or a complete token accounting audit.

Acceptance is recorded in `selection-datasets-validation.json`. Tests use disposable local EVM deployments, real event indexing and PGlite, HTTP responses, actual reorgs and server/database restart. They do not assert public Base deployment, independent regional availability or a production dataset distribution service.
