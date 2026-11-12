# Public domain and mobile verification

The public site and Workspace use `https://my-telomere.com`. Internal navigation,
browser API calls and wallet chooser assets resolve against that origin. The
homepage canonical URL was the remaining stale publication address and now uses
the new domain. This changes one URL only; all other homepage bytes are retained.
Historical audit records retain their original addresses and source hashes.
Legacy handoff paths also redirect to their existing canonical public sections,
including direct `/contact/` entry to Workspace and old article links to their
corresponding field notes. The redirects preserve query strings, reject unsafe
methods, and are stored inline in the existing nginx configuration captured by
backups. The SPA already maps these links during in-page navigation.

The previous frontend bytes are archived in
`evidence/domain-links-20261112/frontend-source.json`; the evidence verifier pins
both the preserved source and current approved source. The separate static review
checks the exact byte delta. Public HTTP verification is repeatable with:

```powershell
python -B ops/domain-migration/audit_pages.py
python -B ops/domain-migration/verify.py
```

The first command crawls the existing public route inventory and internal page
links, checks trusted HTTPS, domain-bearing markup, absence of legacy domains,
and the homepage canonical. The second checks release asset hashes, redirects,
new-origin sign-in challenge and rejection of foreign/old-origin writes. Neither
uses a wallet signature or sends a financial transaction.

Responsive checks use the browser's 320, 390 and 768 pixel viewport widths.
They cover public pages, menu navigation, public configuration forms, signed-out
Workspace navigation, and direct/SPA wallet chooser opening and closing. Physical
Android/iOS wallet-app behavior, real signature approval and account-specific
signed-in pages require those devices and wallets; browser viewport checks do
not claim to replace them. Existing mainnet settlements are not repeated.

For independent-check calibration, a temporary Git worktree outside the checkout
contains a deliberately wrong canonical URL. A separate checker must identify it
against the same checklist. This proves static domain-metadata detection; it does
not prove rendering, scrolling, wallet provider behavior or authentication. The
temporary worktree is removed after checking; the local report records its path.
