# Public contract-address section

The owner authorized publishing this exact address on 13 November 2026:
`0xb200000000000000000000896858dec29c10fc01`.

The prepared section appears at the bottom of the homepage, with a full selectable
address, copy feedback, and the exact BaseScan address link. The direct target is
`/#contract-address`. It hides on other routes and reuses its host on SPA revisits,
outside the native Framer tree. Scoped styles are included in the existing site
stylesheet to avoid an extra stylesheet request or unstyled flash.

The section publishes the supplied project identity, not token metadata or a
verified-source claim. The existing Base/USDC escrow, token, operator keys and
payment bindings are not changed. Display/copy/explorer actions send no wallet
request or transaction.

Configuration lives in `website/optional/contract-address/config.json`. Set
`enabled` to false and rebuild/redeploy to hide it again. The source component is
shared with the private preview. Previous styles and runtime source remain
archived in `evidence/contract-publish-20261113/frontend-source.json` with both
previous and current source hashes checked by the evidence verifier.
