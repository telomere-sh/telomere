# Update 03: settled price board

Prepared locally, not deployed or pushed. Enable `prices` in the comma-separated
`POSTLAUNCH_FEATURES` setting after deploying this commit. It is independent of
the refunds flag; both use one bounded confirmed-history source when enabled.

`/prices/` uses `GET /api/public/insights/prices?period=1h|24h|7d`. Every qualifying
sample is a unique confirmed settlement with positive CPU billable time and an
actual recorded CPU price. Zero-second runs, timeout refunds, missing prices and
unknown hardware are excluded with counts. Fixed inference charges are not
blended into CPU per-second prices. Current offers/configuration are not samples.

P10/P90 use exact nearest ranks; an even median is the exact mean of the middle
values, with a rational half-atomic-unit representation when necessary. Counts
and sums use BigInt. More than 2000 samples are supported. An explicit limit of
10000 distinct price levels fails with unavailable rather than silently truncating
observations. API responses include algorithm, period boundaries, source, UTC
as-of time and coverage. Mid-read reorg/generation changes withhold statistics.

The legacy CPU receipt profile does not record standard/interruptible lanes, so
lane stays unknown. GPU classes without a verified price source show no data,
not zero prices. The current captured real Base history has no positive-billable
samples in the latest seven days; the board correctly reports no data for these
windows rather than substituting a configured rate. Exact quantiles are covered
by isolated arithmetic/window tests.

The table contains aggregates only. Native period/refresh controls, wrapped source
hashes and an accessible horizontal table preserve mobile layout. Polling stops
on hidden cached SPA pages and disabled/unconfigured endpoints; explicit refresh
can retry after configuration changes. The shared dispatcher disposes readers
when navigating away and remounts them when the cached page is shown again.
