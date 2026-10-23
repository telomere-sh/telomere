# Release verification

`GET /api/version` is public and uncached. A built controller returns the exact source commit, source cleanliness, package-lock SHA-256 and SHA-256 of the five browser assets used in the independent review. It never returns environment variables, RPC credentials, filesystem paths, session data or signing keys. A source-only development run returns null revision fields instead of claiming a production release.

`npm run build` generates `dist/release-info.json` before the complete release inventory. The release manifest therefore protects the identity file as well as compiled backend and frontend bytes. `npm run release:verify -- --require-clean` checks the source commit, clean worktree, lockfiles and complete output inventory. The CI build artifact contains both identity files. Compare the hashes in `/api/version` with the bytes fetched from `/`, `/dashboard.js`, `/workspace-client.js`, `/site.js` and `/agent-panels.js`. The endpoint is a reconciliation aid; it does not replace an authenticated deployment manifest or an independent security audit.

## Corrections following the 23 October review

The disposable root-directory tests simulate root ownership only in their fixture metadata, including a separate non-root rejection. The production recovery function still requires UID 0 and private permissions. The Windows junction test uses the reparse-point attributes available in Python 3.11 instead of the later `os.path.isjunction` API. Contract fixtures start at a fixed UTC noon, and a separate 23:30 test checks the midnight reset without treating it as a daily-limit bypass.

Vitest and its coverage companion are pinned to 4.1.12; the lockfile resolves production `ip-address` to 10.7.4. The latter enters through `@modelcontextprotocol/sdk -> express-rate-limit -> ip-address`. The main CPU HTTP server uses Hono; the transitive package is still updated rather than relying on which MCP transports are enabled. Re-run both complete and production-only npm audits for the root and website lockfiles before release.

Workspace requests handle HTML, malformed JSON, authentication expiry and rate limiting without showing proxy HTML or parsing exceptions. An old-account reply cannot clear the new wallet session. HTTP failures never automatically repeat wallet signatures, transactions or API mutations. A confirmed CPU reservation retains its existing journal entry if admission fails and is reconciled through the existing recovery flow.

## Acceptance and publication

Run the full JS/TS suite from a clean dependency installation, Python SDK on the supported Windows interpreter, the non-root Linux ops fixtures, PostgreSQL concurrency and actual isolated gVisor acceptance. Keep skipped platform tests separate from passed tests. Retain the final build manifest and the server's activation/runtime-pin verification; do not infer deployment identity from GitHub main alone.

A local verification run is not a green GitHub Actions run. When publication is intentionally deferred, the operator can stage and deploy the exact locally committed, verified source bundle while retaining that distinction. Push the reviewed commits and require the configured release gate before claiming that GitHub CI passed. Deployment must retain an encrypted backup or checkpoint, compare financial journal and authority pins, and provide rollback without restoring an older financial database or resubmitting user transactions.
