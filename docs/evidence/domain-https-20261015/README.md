# HTTPS domain preparation evidence, 15 October2026

This directory records the transition to `https://telomere.sh` and protected
`https://review.telomere.sh`. Mainnet financial activation remains absent and
the controller remains stopped. None of these records claims an owner wallet
signature, contract deployment, funded acceptance or exhaustive animation QA.

## Provenance and chronology

The public VPS archive
`/opt/telomere-mainnet-pilot/work/public-domain-evidence.tar.gz` was downloaded
over the existing SSH identity and verified before extraction:

`b99ef525959004a607ce91d8300b1fcdd5b75006c4b4a631d45c741b6e221699`.

It contains seven regular files totaling61,048 uncompressed bytes. Archive
inspection rejected absolute/traversing paths, links and special entries.
The archive itself remains in ignored local working storage; its original
seven extracted files are retained here byte-for-byte.

1. `domain-runtime-preparation.json` records the new HTTPS-origin helper on
   loopback3284 and the separate immutable public website copy. Its pending-TLS
   fields describe that early checkpoint, not the final domain state.
2. `domain-http-preparation.json` records the isolated ACME vhost/challenge
   checks, with no changes to existing Enclave vhost files.
3. `domain-certificate-validation.json` records the new Let's Encrypt lineage
   `review.telomere.sh`, SANs apex+review, valid until13January2027 19:01:46UTC.
   Existing Enclave/IP certificates were not expanded or replaced.
4. `domain-https-activation.json` records the live static apex, protected owner
   review, wrong-Origin rejection, and still-inactive financial controller.
   Profile SHA-256 is
   `f53cec74742e3ca7eb8eda806ffb00468d992e1b4d6dd421010782ea63fa5f0e`.
5. `domain-expected-public-summary.json` is a public subset of the reviewed
   manifest, not the private profile or signer. `domain-static-website.json`
   records the312 files/50,435,601 bytes; `domain-website-csp.txt` is the initial
   policy generated from the reviewed compiled website loader.

## Independent observations and corrections

- `dns-delegation-recheck.json` captures the then-current DNS observation;
  later externally resolved HTTPS behavior is in the external domain audit.
- `external-domain-audit.json` and its summary retain the complete initial
  external check without rewriting a failed result. All312 file bodies and
  sizes matched, but the auditor initially used an incorrect expected source
  file for `/dashboard`. `external-domain-audit-correction.json` corrects that
  comparison against the already captured response and original manifest.
- The remaining confirmed delivery issue in that initial external audit was
  the unchanged WAV served as `application/octet-stream` instead of audio MIME.
  `website-wav-mime-fix.json`, fetched separately from its public VPS record,
  records the owned-vhost correction at20:18:41UTC. Its resulting apex hash is
  `1d62089da137aa3e10e68833ec11c58054559e2c303b2d7073456595525abadc`;
  the owner-review vhost stayed unchanged. This does not by itself prove all
  browser animations work. Later bounded browser acceptance is recorded below.
- `wav-mime-recheck.json` subsequently confirms `audio/wav`, status200 and
  status206 with an exact64-byte range matching the unchanged source.
- `website-icon-csp-fix.json` and `website-required-icon-sources.json` record
  the finite six-icon module closures. `telomere-website-csp.current.conf`
  retains the verified marketing snippet, SHA-256
  `201329ed30f78ce89881a5213f095979756e6c6b7b4bd79634da87eb1192090c`.
  It extends the initial loader policy only for the required CMS connection
  path and twelve exact icon script URLs. Editor scripts, script wildcards and
  unsafe-eval remain excluded; the private review configuration is unchanged.
- `final-nginx-audit.json` independently confirms the initial three vhost
  hashes, trusted TLS/SNI routing, apex200/backend503/review401, byte-identical
  public inventory, exact compiled CSP and renewal coverage. Those TLS probes
  deliberately connect to local443 with hostname/SNI and system certificate
  verification; they are not an external-DNS test. The record predates the WAV
  vhost correction and temporary Enclave stop.
- `https-runtime-isolation.json` retains the independent review-helper
  namespace/Host/isolation audit. No credential contents or signer were read.
- `public-static-website-manifest.json` retains the independent public-copy
  manifest. Public file bytes remain unchanged by the routing/MIME correction.

## Approved social-link exception

After the original preservation audit, the user explicitly requested Telegram
and X buttons using the site's existing design. `social-links-approved-change.json`
records the source edit and original ZIP comparison. Only `website/dist/site.js`
changes; HTML/CSS and the other410 imported files remain unchanged. The two
targeted replacements are reversible to the exact original bytes, preserveLF,
reuse existing icons/classes/markup and leave GitHub's placeholder behavior.

The original import record is not rewritten. `docs/verify-evidence.py` compares
only its `dist/site.js` entry against original import commit
`9823db6fb9d2c2e70d636358c458eb96e4f2e625`, while still checking the other410
handoff paths against current files. It also requires the new approval record
and checks current `site.js` against independent SHA-256
`859669b4db1c9ba2061823769cbd80e1c38fc30be0bcbf71d4245318ab5e29ce`.
The exception cannot silently exempt other paths or accept an arbitrary hash.

`website-social-links-deployment.json` records root's separate deployment at
20:34:29UTC. The current public root is
`/var/www/telomere-public/20261015-social-859669b4`; the previous root is retained.
`website-current-manifest.json` records312 files,311 unchanged and the one
approved script. The current apex vhost hash is
`be4f6079c68d212fe2da5c207a134b79a8fb2294aae7993bd761fe8552917c43`.
This source/deployment proof is distinct from the browser acceptance below.

## Final bounded browser acceptance

`visual-verification-summary.json` is the public-safe compact comparison report
(SHA-256 `5325000bcac5f26bdec27eb6c1844f9d4bb9e88fbb04f37c4c483ffca6dc1159`).
Screenshots, heatmaps and detailed captures remain private; no image bytes or
private absolute paths were copied here. The report compares the current capture
set; it is not an exhaustive audit of every animation.

- Desktop1440x900 and mobile390x844 home records each contain48 headings. The
  recorded text/tags, boxes, typography and full recorded layout objects match
  exactly, with respective document heights27,404 and30,463 CSS pixels.
- The protocol's20-heading record also matches, height7,122 CSS pixels. Its
  compared viewport RGB grids are identical. Other screenshot comparisons retain
  unsynchronised procedural backgrounds, clock/time text and JPEG differences;
  nonzero pixel metrics cannot be presented as an accuracy percentage.
- Root's separate interactive check observed a changing hero WebGL background
  and ticking clock, restored location pin, desktop/mobile menu open/close,
  FAQ expansion, proof-chain button/ARIA state changes, working social URLs and
  home→protocol→home restoration. These observations are not actions performed
  by the pixel-comparison helper.
- A subsequent live matchMedia check reported reduced motion=true, shared by
  reference and production. The preference was not emulated and was not sampled
  at each earlier capture moment. The protocol's expected static reduced-motion
  end state and proof-chain fallback are not evidence of a normal-motion loop.
  Tiny temporal pixel differences do not prove a snake/full-animation cycle.
- Normal-motion full loops and exhaustive per-animation timing parity remain
  unverified. Existing recoverable React425/418/422 warnings and an intentionally
  blocked, unnecessary Framer editor import are not described as a clean console.

`social-deployment-recheck.json` independently confirms the served current
script SHA. `website-final-services.json` records Nginx/staging/HTTPS-review
active, all four Enclave units inactive, mainnet controller inactive and no
activation file. The owner-review vhost remains unchanged throughout.

## Temporary Enclave stop

`enclave-temporary-stop.json` was fetched separately from the public VPS work
record. It records the user's explicit temporary stop of `enclave-api`,
`enclave-worker`, `enclave-web`, `enclave-infra` and the three exact Enclave
Compose containers. Their Redis/PostgreSQL/Anvil volumes were retained, no
persistent enablement was changed, and no shared Nginx/Docker/containerd or
Telomere service was stopped. The certificate-renewal timer was preserved
because it now also renews Telomere's certificate.

## Retained sources and secret screening

`operator-sources/` and `routing-sources/` contain text copies of the local
operator/audit sources and original routing drafts used for review. They are
historical source evidence, not instructions to rerun a deployment. A later
runtime header correction may intentionally differ from the original draft.
Existing pinned files under `ops/legacy-mainnet` were not modified.

`evidence-manifest.json` records hashes for retained files and source archive
provenance. Before copying, UTF-8/JSON content and public field scope were
reviewed and scanned for private-key PEM, literal EVM keys, credential-bearing
DSNs, HTTP Basic values, provider/session secrets and GitHub token patterns.
No matching secret material was copied. No private environment, credentials,
certificate private key or ACME account file is included. The local access-file
path is documented only in the launch guide; its contents were not read.
