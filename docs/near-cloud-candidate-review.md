# Cloud candidate packet — 8 October 2026

**UNAPPROVED. No hardware verification, accepted policy, inference completion, or activation is implied by this capture.**

Subsequent offline [hardware appraisal](near-cloud-review-findings.md) passed model/manager Intel and NVIDIA checks but rejected Gateway TCB; [network-isolated replay](near-gateway-tcb-resolution.md) reproduced that rejection. Later [image/source review](near-image-provenance-review.md) verified publisher links for two new serving images and their immediate shared base. Those separate results do not approve this captured candidate or authorize inference.

At **17:39:01 Moscow / 14:39:01 UTC**, one official Cloud report GET returned HTTP 200 for the protected canonical model `z-ai/glm-5.3-flash`. The response contained one Gateway report, one model candidate and two app-compose manifests. Its exact raw bytes total 315,786 bytes; SHA-256 is `878b26db70406b14582ff6fd2b7cf6c9e74996ef145974d7635e806bfeaebd3c`. See [the public summary](near-cloud-candidate-summary.json).

The private packet is stored on the VPS in `/opt/telomere-pilot/work/cloud-candidate-2026-10-08T14-38-44Z`. The directory is mode `0700`; every packet file is `0600`. It contains the exact raw response (`report-response.bin`), safe request metadata and the peer certificate/SPKI from that same response socket (`connection-request.json`), a parsed offline-verifier input (`candidate-input.json`), a discovery inventory (`claimed-image-inventory.json`) and the safe summary. No API key or Authorization header is serialized. Raw reports are not published or checked into the repository.

## Reusable collection

The CLI is `scripts/near-cloud-evidence.ts`. With a protected environment already loaded, invoke it using `node --import=./node_modules/tsx/dist/loader.mjs scripts/near-cloud-evidence.ts --output <new-private-directory>`. The model defaults to `NEAR_MODEL`, must be in `NEAR_ALLOWED_MODELS`, and the key comes only from `NEAR_API_KEY`. The endpoint is fixed to official `cloud-api.near.ai`; the existing direct endpoint configuration is ignored.

It sends exactly one GET to `/v1/attestation/report` with a fresh 32-byte nonce, canonical model, `provider=near`, explicit ECDSA, `include_tls_fingerprint=true` and `x-no-aliasing: true`. The deadline is 55 seconds; raw response size is capped at 16 MiB. Normal CA and hostname checks remain required. Redirects, compressed bodies and oversized responses are rejected. HTTP 401/403 stops the capture immediately, with no credential or request retry. There is no completion/signature route or POST implementation. The stdout summary contains only fixed status/reason values, trusted model, hashes, sizes, counts and pending review tasks. The files preserve malformed successful-response bytes privately for diagnosis.

Gateway and model reports are requested together as specified by [Gateway attestation](https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation) and [model attestations](https://docs.near.ai/cloud/verification/cloud-api/model-attestations). The certificate is captured on the report response's own connection; this records the material required for the later [TLS binding check](https://docs.near.ai/cloud/verification/cloud-api/tls), rather than declaring that check verified.

## Review still required

- Cryptographically verify Intel quotes/collateral, accepted TCB/advisories, debug rejection, nonce/signing-key bindings and RTMR3 event-log replay.
- Match each raw measured app-compose string to MRCONFIGID; verify NVIDIA evidence for the model candidate and Gateway SPKI binding.
- Inspect the entire measured manager history as well as boot manifests. The discovery inventory contains only digest references found in app-compose strings; its one unique image claim is not a complete inventory of running/historical serving images.
- Verify source/build provenance and exact image-subject digests under an explicit review policy. A reachable provenance page or matching YAML is insufficient. [Image provenance](https://docs.near.ai/cloud/verification/cloud-api/image-provenance).
- Review the workload independently, then prepare and approve a separate bounded Cloud policy. The expired direct policy cannot authorize these Gateway/model reports.
- Obtain fresh operational admission before one bounded functional acceptance completion. This stored candidate packet cannot authorize a later run.

Model replicas can share one signing key across different measurements. A later signer match would not establish that this report and completion came from the same serving instance; separate model, Gateway and response checks do not form a complete end-to-end instance-binding chain. [Response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures).

`tests/cloud-candidate.test.ts` covers fixed route/parameters, fresh nonce, one request, auth/rate/redirect/server rejection without retry, byte bounds, configuration/cancellation gates, safe transport errors, malformed reports, discovery checks and private non-overwriting packet files. All 17 tests are offline; the live candidate capture is a separate GET-only observation.
