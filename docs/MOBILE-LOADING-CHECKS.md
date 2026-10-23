# Mobile loading checks, 2026-10-23

Application baseline: `ff1df39790a5746c08270aaccf3348fcea78749b`.
Checks used the public website and a local copy of its compiled website assets.
The local fixture added a visible timing report, disabled the HTTP cache,
compressed public text assets and preserved concatenated Framer CMS query ranges.
Its rate limiter shared bandwidth across all response bodies on each test origin.
It accepted no POST requests or wallet transactions.

| Network profile | Response delay | Overlay released | Route prepared |
| --- | --- | --- | --- |
| 1.28 Mbit/s | 300 ms | 4.018 s | 7.506 s |
| 400 kbit/s | 800 ms | 4.050 s | 13.500 s |
| 400 kbit/s repeat | 800 ms | 4.087 s | 13.507 s |
| Images return HTTP 503 | 150 ms | 2.945 s | 2.946 s |
| `site.js` delayed by 12 s | 150 ms | 4.031 s | 14.121 s |
| `preload.js` returns HTTP 503 | 150 ms | No overlay mounted | Page remained accessible |

Times start at the fixture's early observation script. They are observations,
not a production SLA. The repeated 400 kbit/s run showed visible text at 4.087 s.
Full initialization can continue after the overlay disappears. External font
hosts used their ordinary connection; a permanently pending font promise is
covered separately by the readiness regression fixture.

Browser viewport checks: 320x568, 360x800, 390x844, 430x932 and 844x390.
These are desktop-browser viewport and transport emulation, not physical iOS or
Android/WebView tests or low-end phone CPU benchmarks.

Observed working: landing entry, mobile navigation, return from Workspace,
Compute hardware selection and budget recalculation, FAQ expansion, section
reveals, Telomere Lab hand/card movement, the Protocol canvas and Proof Chain.
Separate screenshots of each canvas changed between frames; Proof Chain grew
from zero to three safeguards and its manual selection changed the pressed state
and explanatory copy. No payment or wallet signature was requested.

The 320px wallet chooser split "MetaMask" mid-word because the availability
status consumed the label's space. Below 361px, availability now occupies a second
line under the name. All six wallet names fit one line in the verified 320px
layout; existing icons, borders and touch target heights remain in use. The dialog
keeps vertical scrolling for short screens.

Automated checks: 61 tests across website readiness, website serving/security and
release identity. Additional readiness cases cover five mobile viewport heights,
late image completion after reveal, a subsequent route with an image that never
decodes, and a synchronous decoder failure. Original historical frontend bytes
remain preserved by the evidence verifier.
