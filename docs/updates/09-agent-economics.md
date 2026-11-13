# 09. Agent economics

Prepared locally behind `POSTLAUNCH_FEATURES=agent-economics`. `/agents/:id/` displays canonical Selection registry events and spendable Vault balance at the indexed block. Daily gross income, fees, net income, burn and owner subsidies remain separate exact base-unit amounts. Registry-classified income is labeled as such; independent earned-income provenance remains unknown, and unclassified transfers are excluded.

Date filters, coverage boundaries, limited lifecycle rows and stale data are explicit. Unindexed days show no coverage rather than zero. Canonical block and dataset checks bracket the balance read; reorgs and unavailable sources withhold economics.

The keyless public Selection service reuses the current reviewed registry profile and a consistent copy of its persisted index. It verifies the canonical creation receipt/code hash and serves GET-only economics, Fossil Record and a fixed health endpoint. The CPU controller connects through optional `SELECTION_PUBLIC_ORIGIN` while its financial Selection mode remains unchanged. Reports are bounded, schema-validated and bound to the requested agent, chain and dates; private fields are rejected. `ops/selection-public/README.md` describes isolated preparation, protected publication and guarded rollback. Building or testing does not deploy this service.

Validation covers persisted event projection, exact monetary precision, gateway/feature boundaries, stale/reorg failures, bounded HTTP reads and isolated operator rollback fixtures. This change performs no on-chain action.
