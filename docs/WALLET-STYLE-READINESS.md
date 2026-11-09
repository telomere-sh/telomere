# Wallet chooser stylesheet readiness

The direct `/dashboard/` entry links `wallet-picker.css`. Landing and generic
route entries do not, so opening Workspace through in-page navigation could
previously display the chooser with browser default styles.

The existing shared chooser now loads its same-origin stylesheet before creating
or displaying the dialog. It reuses an applicable loaded stylesheet and shares
one pending load/open operation across repeated clicks. Load errors and a bounded
ten-second timeout release the pending state and reach the existing connection
error surface. A later click can retry. Discovery subscriptions start only after
stylesheet readiness; provider selection and focus/close cleanup remain unchanged.

No dialog markup, artwork, colors, spacing or payment flow was redesigned.
Verification covers the direct entry, landing-to-Workspace navigation, repeat
opens, delayed CSS and failed CSS followed by retry. Browser checks render the
desktop and 320px layouts; opening the chooser requires no wallet signature or
transaction.

Regression tests: `tests/wallet-stylesheet.test.ts`. The linked website, discovery,
Workspace client, readiness and release-identity suite passed 188 tests before
deployment. Historical frontend source bytes are retained by the evidence verifier.
