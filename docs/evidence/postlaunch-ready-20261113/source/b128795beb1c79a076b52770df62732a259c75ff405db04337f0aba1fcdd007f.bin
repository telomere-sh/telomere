# 12. Service status and changelog

Prepared locally behind the single `POSTLAUNCH_FEATURES=status-changelog` flag. `/status/` shows fixed website-entry, configured chain, controller-worker, receipt-service, Selection dataset and price-source probes. Omitted components are not configured; errors/timeouts remain unavailable or unknown. Probe concurrency is bounded, timed-out work retains its slot, cached readiness expires at the earliest evidence deadline. These are server-local checks, not external/global uptime measurements or historical uptime claims. Private operations details, addresses and exceptions are not exposed.

`/changelog/` uses a curated, strictly validated catalog filtered by enabled flags. The source commit comes from actual build metadata; a dirty/unbuilt checkout is partial. Introduced dates mean implementation dates, not claimed production deployment times. No raw Git history, operator logs or private paths are published. Explicit refresh recovers from an earlier disabled deployment without automatic background retries.

When the CPU controller uses `SELECTION_PUBLIC_ORIGIN`, the Selection component probes that actual keyless public index through its fixed health route. It verifies the chain, confirmation policy and evidence age; missing, stale, future or malformed evidence cannot become Ready. The controller does not enable financial Selection or expose the index URL, registry address or private errors through status responses.

Validation covers status/changelog deadlines, stale evidence, privacy allowlists, actual build identity, manual retry and the external Selection health integration. Both pages belong to this one update and one commit.
