# 08. Fossil Record

Prepared locally behind `POSTLAUNCH_FEATURES=fossils`. `/fossils/` reads `/api/public/selection/explorer` from the configured canonical Selection dataset and persisted block/event index. It supports UTC date windows, alive/dormant/dead filters and revision-bound pagination. Events link to fixed chain explorers; no owner-private configuration is included.

Only recorded Birth, Dormant, Revived, Death, Income, Burn and Subsidy events appear. Token base units are named explicitly; unclassified transfers are excluded and verified earned income is unknown. Registry classification is not independent proof of earnings. The existing Selection profile bounds apply and coverage is disclosed. Missing Selection returns not configured, never a synthetic population. Current CPU-only production has no configured Selection deployment; enabling the page alone does not supply one.

Validation: 17 tests covering real persisted index rows, reorg/cursor guards, filtering, provenance and inactive-page cleanup. No production indexing or deployment is performed.
