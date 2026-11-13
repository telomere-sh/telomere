# 07. Accounting exports

Prepared locally behind `POSTLAUNCH_FEATURES=accounting`. `/accounting/` requires an owner session and shows monthly totals from verified settlement history. The matching CSV includes run ID, reservation and settlement timestamps, billable seconds, exact USDC charge, return category and transaction hash. Unknown execution dates, host identity and lane stay blank rather than inferred.

CSV streams every owner record using paged reads and backpressure, without a fixed 2000-run cutoff. A generation token and terminal coverage record prove completion. The browser offers a file only after both validate; RPC/reorg, interrupted streams and account changes discard the export. Files use UTF-8 BOM, CRLF and decimal strings suitable for spreadsheets. Browser-side final file assembly uses memory proportional to the export.

Validation: 25 tests including 2057 rows, owner filtering, month boundaries, exact arithmetic, CSV integrity, cancellation, session change and stale-history rejection.

Wallet session broadcasts immediately abort private reads and clear owner data; explicit review is required before new reads. Cleanup closes the channel.

English month names and a separate four-digit year keep the form and summary independent of operating-system locale, without limiting historical months.
