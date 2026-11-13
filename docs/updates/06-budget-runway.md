# 06. Budget runway

Prepared locally behind `POSTLAUNCH_FEATURES=runway`. The private `/runway/` page uses the signed-in owner only. It combines available escrow balance at a canonical anchored block with confirmed charges over the trailing 24 hours. It excludes reservations, withdrawals and owner top-ups from spend. Exact arithmetic produces hours remaining and Full/Lean/Torpor/Cyst bands.

This is an escrow planning estimate, not a Selection Vault balance or an instruction to change hardware. No history means no estimate; a known zero-spend window is distinct from missing data. Incomplete scans, RPC errors, reorgs and changed sessions withhold the estimate. Polling stops on inactive routes and disabled configuration, with explicit retry available.

Validation: 23 focused tests including owner isolation, anchored balance, boundary arithmetic, empty history, reorg/RPC and visibility lifecycle.

Wallet session broadcasts immediately abort private reads and clear owner data; explicit review is required before new reads. Cleanup closes the channel.
