# Mobile-compatible owner review

This overlay preserves the frozen Base deployment plan and read-only helper on
127.0.0.1:3284. It replaces the browser HTTP Basic prompt with an ordinary HTTPS
form using the **same existing account and password hash**. Credentials never
enter source, URL parameters or logs. The service reads the existing SHA-512
verifier through systemd LoadCredential, issues a 30-minute Secure/HttpOnly/
SameSite=Strict session and rate-limits login attempts. Unauthenticated plan,
JavaScript and review requests remain blocked.

The separate DynamicUser service binds only 127.0.0.1:3285. It cannot access the
mainnet installation, controller data, staging, Docker or the original password
file. Its only proxy destination is the original loopback review helper; it
strips cookies and credentials and retains exact Origin and CSRF checks. No
signing, financial endpoint or controller activation is added.

The Switch to Base control requests wallet_switchEthereumChain for 0x2105 only after an explicit owner click, verifies the selected network, clears stale review approval and never deploys automatically. Read-only checks identify a connected wallet on the wrong network.

The browser entry now rediscovers late-injected OKX/EIP-6963 providers when the
owner clicks Connect. Initialization errors are visible. Unavailable local
storage permits read-only checks but keeps deployment disabled. A retained
ambiguous attempt still blocks another deployment; it is never cleared here.

The gate relocates status messages next to wallet controls on the unchanged
frozen helper page. Same-origin Referrer-Policy is required for the native login
form's Origin check; no external referrer is sent. Main marketing files are
unchanged.

## Installed 17 October 2026

- Public login: https://review.telomere.sh/login
- Runtime: `/opt/telomere-review-mobile-20261017`, root-owned read-only files.
- Unit: `telomere-owner-review-mobile.service`, manual operator service.
- Bundle SHA-256: `6f86e846156478e70ff6afc9f040279345f4d45f4a1b72b531f407420d2a232f`.
- Runtime identity: `MANIFEST.json` beside the deployed overlay.
- Original vhost backup: `/opt/telomere-mainnet-pilot/work/review-mobile-20261017/nginx-before-mobile.conf`.
- No owner financial transaction or mainnet controller start was performed.

The session remains private; the login page itself is intentionally public.
The mainnet deployment and financial profile pins are unchanged. Restarting the
gate expires all its sessions. Do not run the Linux crypt-based gate on a
Python release that has removed crypt without preparing a reviewed verifier.

## Verification

`node node_modules/vitest/vitest.mjs run tests/owner-wallet-deployment.test.ts tests/owner-wallet-browser-ui.test.ts`
passed **46/46**; `tsc --noEmit` passed. On Debian 12,
`python3 -B ops/owner-review-mobile/test_gateway.py` passed **9/9**.

The actual public HTTPS form login passed in a browser with the existing
credentials, its Connect control showed a visible missing-wallet diagnostic in
the browser without an extension, and Run read-only checks returned
`Read-only checks passed`. No wallet provider or signature was simulated in the
production browser. Real mobile OKX connection still requires the owner's
device. UI fixtures cover late provider injection and inaccessible storage;
they never invoke a financial method.
