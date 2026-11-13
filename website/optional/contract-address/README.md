# Hidden contract-address section

Prepared in the existing cream/black/orange Telomere style, with full address,
copy feedback and a fixed BaseScan link. Mobile layout stacks the headline and
address; the full address remains selectable and wraps instead of truncating.

**Default state:** `config.json` has `enabled: false` and `address: null`.
This directory is outside `website/dist`, and nothing in the public runtime
imports it. It adds no public DOM, layout space, bundle, request or wallet action.
The production site is not updated by this preparation.

The requested address has not been supplied. The escrow address, USDC token and
owner wallet are intentionally not substituted for the eventual project CA.
The local preview uses an inert placeholder and disables both actions.

For later activation, confirm the intended contract address, fill the config and
set `enabled` to true. Bundle this TypeScript module, include the accompanying
stylesheet, and mount it into the chosen homepage container:

```ts
import {mountContractAddress} from './contract-address.js';
mountContractAddress(container, config);
```

That integration is an explicit future publication step. Merely editing config
does not silently publish the component into the current audited frontend.
Disabled, missing, malformed or zero addresses mount nothing. A second mount in
the same container returns the existing section. No API call, account permission,
wallet signature or transfer is involved. Clipboard failures offer manual copy.
