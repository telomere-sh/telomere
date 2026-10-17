# Base mainnet pilot: HTTPS review prepared, activation pending

The new legacy `TelomereRunEscrow` CPU pilot is prepared on `2.27.12.39` with
native Circle USDC on Base mainnet, chain `8453`. This deployment path requires
no HostRegistry collateral. The public website and protected owner-review page
are available over HTTPS. At this preparation checkpoint, the mainnet controller
has not been started and no owner wallet request, signature or public transaction
has been made. Website availability does not mean paid compute is activated.

## Prepared installation

| Item | Prepared value |
| --- | --- |
| Application source | `ee6169d1007b11f037fbc409dc1f7575f15117c9` |
| Owner-review source | `8f5f41e9e0fd94c95c37992ff910f098bf7908b4` |
| Server installation | `/opt/telomere-mainnet-pilot` |
| Public website | `https://telomere.sh` |
| Current public static root | `/var/www/telomere-public/20261015-social-859669b4` |
| Protected owner-review page | `https://review.telomere.sh` |
| Owner-review loopback upstream | `127.0.0.1:3284`, fixed HTTPS review origin |
| Controller origin after activation | `https://telomere.sh`, upstream `127.0.0.1:3282` |
| PostgreSQL | `127.0.0.1:15435`, separate `telomere_mainnet` database and role |
| Restricted CPU runtime | Separate Docker socket/data, gVisor `runsc`, pinned Node image |
| Controller activation | Absent; service inactive, no listener on `3282` |
| Current financial profile SHA-256 | `f53cec74742e3ca7eb8eda806ffb00468d992e1b4d6dd421010782ea63fa5f0e` |
| HTTPS certificate | New `review.telomere.sh` lineage, SANs apex and review, valid through 2027-01-13 19:01:46 UTC |

The source release was installed with locked Linux dependencies and built on
the VPS. The database has 43 tables, no financial records, no controller chain
binding and only the five initialization lock rows. The application role has
no superuser, role-creation, database-creation or replication privileges.

The owner-review service uses its own systemd DynamicUser. Its actual mount
namespace denies access to private configuration, controller data, staging and
Docker. It recompiles the reviewed contract and browser code in memory and
exposes only static public data and a bounded read-only review endpoint. The
service has no owner key or financial transaction endpoint. It is manual-only
and listens on loopback. A separate owned Nginx vhost supplies HTTPS and BasicAuth,
preserves the actual Origin, and fixes the upstream Host to `review.telomere.sh`.
Wrong-Origin and financial-endpoint probes returned 403 and 404 respectively.
The prior `3283` review service and local tunnel were deliberately stopped after
HTTPS became available, leaving one financial review origin.

Access credentials are retained only in the local private file
`C:/Users/Administrator/Documents/GitHub/tt/Telomere/.local/telomere-review-access.txt`.
Only its path is recorded here; its contents are not copied into documentation.
The unchanged `ops/legacy-mainnet/open-owner-review.ps1` is a historical loopback
transport artifact, not the current HTTPS access procedure.

The original apex copy contained 312 exact built website files, totaling
50,435,601 bytes. The current root retains 311 unchanged files and one explicitly
approved `site.js` social-link update; its original public root is retained.
Backend namespaces return
503 until the controller is activated; missing assets return 404. The private
owner-review page returns 401 without valid BasicAuth. The certificate was
issued with the existing Certbot webroot runtime, without stopping Nginx or
replacing an Enclave certificate. The existing renewal timer covers all lineages
and already uses a generic Nginx reload hook.

The mainnet controller unit requires an activation record and an independent
pre-start check of the actual finalized creation transaction, resolved runtime,
immutable roles, native USDC and 906 pinned runtime files. The controller's
worker is started only with that service, after deployment verification.

## Frozen proposal for the owner

| Role | Address |
| --- | --- |
| Owner and deployer | `0xA67c6a174409B9b44e67D24cdd386a31D44Edb1d` |
| Proposed treasury | Same owner address, explicitly shown for review |
| Dedicated quote and receipt signer | `0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38` |
| Predicted escrow at owner nonce zero | `0x27c1e35F563Aa4f57a68B192d88a76c25e68e0db` |
| Native Circle USDC on Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Frozen plan SHA-256:
`2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8`.
Normalized review digest:
`0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f`.
Resolved escrow runtime: 12,573 bytes, keccak256
`0xd2ce03e0de4dc334d671294ae5f900eee12ff05cebc6f6484455103f0b204ed5`.

The dedicated signer was generated on the VPS and remains there in root-only
private files. It is distinct from the owner and existing staging signer. No
private file, seed or key was exported to this repository.

The current CPU profile proposes `100` atomic USDC per second, which is
`0.0001 USDC/second`. Paid work still needs the owner's separate deposit and
Leash limits. The deployment transaction itself transfers zero ETH value and
zero USDC; it consumes ETH gas.

## What the owner does next

1. Confirm fresh **ETH on Base** balance and owner nonce before deployment.
   At reference block `52652598`, the helper observed
   `3,668,724,411,292,060 wei` (`0.00366872441129206 ETH`) without a balance
   override. This replaces the earlier zero-balance observation; the deployment
   remains tied to owner nonce zero and its reviewed predicted address.
2. Review the plan on the closed page. A desktop injected OKX Web3/EIP-6963
   wallet is supported. A phone wallet browser can use the protected
   `https://review.telomere.sh` origin rather than the PC's loopback address.
   No owner seed or key should be given to the service.
3. Run fresh read-only checks. The prepared review bounds are gas `4,000,000`,
   fee per gas `20,000,000 wei` and total estimated gas budget `0.0001 ETH`.
   These are visible proposals for owner review, not authorization to spend.
4. Only the separate **Deploy new escrow through my wallet** action can open
   the transaction. The owner inspects and confirms it in the wallet. There is
   no automatic retry after an ambiguous wallet outcome.

At block `52649795`, the observed total buffered cost was
`23,935,807,079,162 wei` (`0.000023935807079162 ETH`), including the Base L1
data-fee upper bound and operator fee. This is a dated observation, not a
current quote. The helper refreshes fees and balance and the wallet independently
checks them. The review budget does not hard-cap a future Base L1 fee onchain.

The later HTTPS preparation at block `52652598` observed a buffered total of
`23,907,851,674,283 wei`, including the recorded L1 data-fee upper bound. This is
also a dated read-only observation, not an authorization or a current gas quote.

**Deploy before making an outgoing owner transfer to fund the service signer.**
Incoming ETH does not consume the owner's nonce. An outgoing owner transfer
does consume it and invalidates this nonce-zero deployment plan. A changed
nonce requires a newly prepared and reviewed plan, address and activation pins.

## After the separately authorized deployment

The operator verifies the exact creation bytes, successful canonical receipt,
finality, predicted address, runtime and immutable token/signers/treasury. Only
then may the reviewed activation record be completed and the controller started.
`ops/legacy-mainnet/activation.json.template` deliberately does not authorize
activation. Its deployment fields must come from the real finalized receipt.

The remaining live acceptance sequence is separately reviewed signer gas
funding, owner login, a bounded USDC allowance/deposit, Leash creation, one small
CPU run and charge/refund/stop/checkpoint checks. These need owner wallet
actions and are not recorded as completed by this preparation. No contract has
been deployed by the preparation tooling.

The original 411-file handoff import remains verifiable against its historical
Git revision. The current checkout preserves 410 original files and one
explicitly user-approved exception: `website/dist/site.js` now links Telegram to
`https://t.me/telomereonchain` and X to `https://x.com/telomere_base?s=11` using
the existing social-button markup/icons/styles. GitHub remains a placeholder.
The deployed 312-file copy has exactly that one approved change; HTML and CSS
remain unchanged. The current `site.js` SHA-256 is
`859669b4db1c9ba2061823769cbd80e1c38fc30be0bcbf71d4245318ab5e29ce`.
A WAV MIME delivery correction was applied to the owned apex vhost at
20:18:41 UTC on 15 October 2026, without changing website bytes. A subsequent
check confirmed `audio/wav` and an exact 206 byte range.

The final marketing-only CSP retains the required CMS connection path and was
extended at 20:29:30 UTC with twelve exact URLs covering six native icon-module closures.
No editor script, broad script-origin wildcard or unsafe-eval was enabled.
The resulting snippet SHA-256 is
`201329ed30f78ce89881a5213f095979756e6c6b7b4bd79634da87eb1192090c`.
The private owner-review policy/configuration was not broadened. The subsequent
social deployment changed only the owned apex root pointer and approved script;
the controller remains inactive.

The final bounded browser check compared the original reference with production
at desktop 1440x900 and mobile 390x844: all 48 recorded home heading entries,
their boxes/typography and document heights matched exactly (27,404 and 30,463
CSS pixels). The protocol's recorded 20-heading layout also matched. The
location icon, desktop/mobile menus, FAQ, proof-chain button/ARIA selection,
social destinations and home/protocol/home navigation responded; the initialized
hero WebGL background changed and the clock ticked after returning home.

The browser subsequently reported `prefers-reduced-motion: reduce`; the
preference was retained, not emulated, and was not separately sampled at each
earlier screenshot capture. The protocol's static reduced-motion end state and
proof-chain reduced fallback must not be reported as normal-motion loop
acceptance. Normal-motion full cycles and exhaustive per-animation timeline
parity remain unverified. Screenshot pixel metrics include dynamic backgrounds,
time text and JPEG differences and are not a visual-accuracy percentage.
Recoverable React hydration warnings 425/418/422 were also present in the
reference; an unnecessary Framer editor import remains intentionally blocked.
The owner-review page is a separate operator tool. The chosen launch scope is
the legacy trusted-operator CPU pilot; the separately implemented Platform/Vault
deployment path is not activated by this plan.

## Verification and operational record

- VPS build passed; focused Linux backend tests passed **72/72**.
- Owner-review helper tests passed **39/39** and TypeScript checking passed.
- Infrastructure guards passed **59 Node fixtures and 8 Python tests**.
- The actual `DockerCpuExecutor` ran as the new controller UID `995` through
  the isolated socket, produced a hash/meter record and confirmed its container
  cleanup, with no chain calls or payment.
- Configuration verification passed; activation verification refused at the
  absent activation boundary. Independent final inspection confirmed loopback
  listeners and the inactive controller.

During preparation, starting the second Docker daemon with `bridge=none`
deleted the global `docker0` bridge and interrupted staging. The bridge was
restored, only its original PostgreSQL endpoint reattached, and one precisely
identified disconnected PostgreSQL backend holding the stale controller lock
terminated. Staging recovered with its configuration and data retained. This
incident is recorded rather than described as uninterrupted operation.

The corrected daemon uses an owned `tlmr-mainnet0` bridge, guarded persistence,
and before/after snapshots of every other interface. A reviewed restart
preserved staging PID `3888942` and restart count `104`, chain `1952401` and
watchdog `1952410`. Actual Docker info confirmed distinct container and plugin
namespaces. The two daemons still share the system containerd process and
kernel. The installed Docker version needs its plugin namespace supplied by
the explicit CLI flag; both misleading JSON spellings are rejected by our guard.

Enclave web, PostgreSQL and Redis responded during the earlier independent
audit. Its separate API restart loop already existed before preparation.
Later, at the user's explicit request, the four verified Enclave-owned units
and three exact Compose containers were temporarily stopped. Their PostgreSQL,
Redis and Anvil volumes were retained, and persistent enablement was not changed.
Shared Nginx, Docker, containerd, Telomere services and the shared certificate
renewal timer were preserved. Enclave application unavailability during this
temporary stop is deliberate; its public Nginx vhost files were not replaced.

Public raw records and the frozen owner-review package are retained in
`docs/evidence/legacy-mainnet-preparation-20261015`. The earlier configuration
record predates the final infrastructure guard update; the authoritative final
state is `vps/final-isolation-validation.json` plus `final-runtime-audit.json`.
The source/archive and constructor verification are also retained in
`docs/evidence/base-mainnet-asset-observation-20261015`.

The HTTPS/DNS transition, exact public-copy manifest, independent external and
SNI/TLS audits, temporary Enclave stop, and WAV MIME correction are retained in
`docs/evidence/domain-https-20261015`. Its README distinguishes historical
checkpoints, the auditor's corrected `/dashboard` expectation, the approved
social-link exception, and the precise limits of browser/motion verification.
The original downloaded public archive SHA-256 is
`b99ef525959004a607ce91d8300b1fcdd5b75006c4b4a631d45c741b6e221699`.

Historical instance-specific templates, guards and operator instructions under
`ops/legacy-mainnet` remain unchanged because their preparation manifest pins
their bytes. The later HTTPS profile hash and public records above supersede
the earlier loopback-origin observation without rewriting that history.
Keep completed private profiles and keys on the VPS;
do not substitute staging data or start a second controller against its database.
