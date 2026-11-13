# Homepage contract-address section

Prepared in the existing cream/black/orange Telomere style, with full address,
copy feedback and a fixed BaseScan link. Mobile layout stacks the headline and
address; the full address remains selectable and wraps instead of truncating.

The owner approved publication on 13 November 2026. `config.json` now enables the
section with address `0xb200000000000000000000896858dec29c10fc01`.
`public/published-contract.ts` bundles it as `/contract-address.js`; the marketing
router shows it on the homepage and hides it on other routes. The host stays
outside the native Framer tree and is reused across SPA revisits.

This is the supplied public project address. It does not change the configured
escrow, USDC token, owner wallet, signer or any transaction destination. The
section does not assert token metadata or a verified-source badge. BaseScan is
linked for the exact displayed address. The separate private design preview can
still use an inert placeholder with both actions disabled.

The component stylesheet is included in the existing `site.css` so showing the
section adds no extra stylesheet request or unstyled flash. When changing its
styles, keep that published copy synchronized with `contract-address.css`.
For other future placements, bundle this TypeScript module, include its styles,
and mount it into the chosen container:

```ts
import {mountContractAddress} from './contract-address.js';
mountContractAddress(container, config);
```

Set `enabled` to false and rebuild/redeploy to remove the section from the site.
Disabled, missing, malformed or zero addresses mount nothing. A second mount in
the same container returns the existing section. No API call, account permission,
wallet signature or transfer is involved. Clipboard failures offer manual copy.
