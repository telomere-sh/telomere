# 04. Opt-in receipt links

Prepared locally behind `POSTLAUNCH_FEATURES=receipt-links`. No deployment or publication is performed by this change.

A signed-in owner can publish a verified accounting summary from an execution record after explicit consent, then revoke it. Every public read rechecks the receipt, canonical settlement and current consent. Only whitelisted run/accounting identifiers and amounts are returned; task input, output, full receipts and wallet identity are excluded. Concurrent revocation supersedes a pending publication. This verifies the execution/payment record, not the mathematical result of the task.

`/r/:runId` supplies owner-approved HTML metadata and a locally rendered 1200 x 630 PNG preview. Preview caches maintained by other services may survive revocation. Actual Telegram/X crawler rendering requires a later public deployment; local tests validate image bytes, dimensions and metadata.

Owner endpoints: POST `/api/receipt-links` with `{runId,publish:true}`, POST `/api/receipt-links/:runId/revoke` with `{}`. Public read: `/api/public/receipt-links/:runId`; preview: `/:runId/card.png`. These endpoints never broadcast a wallet transaction.

For a deployment whose front proxy serves SPA routes statically, apply the prepared `ops/public-wallet-launch/receipt-share-location.conf` inside its existing server block so `/r/` reaches the backend metadata renderer. Validate proxy syntax and the configured `PUBLIC_ORIGIN` before enabling. The snippet is not applied by this commit.

Validation: 17 sharing tests, plus workspace authentication/client integration (135 tests total). Disposable loopback-chain browser acceptance covers consent, publication and revocation; no mainnet transaction or public receipt publication is needed.
