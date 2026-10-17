# Cloud evidence appraisal — 8 October 2026

**Decision: keep inference disabled. The model evidence passed the bounded hardware appraisal, but the Gateway failed the configured strict TCB check and neither Cloud workload nor image provenance is approved.** No wallet, inference request, accepted policy change or new NEAR report was used.

The appraisal completed at **17:51:27 Moscow / 14:51:27 UTC**, using the packet captured at 14:39:01 UTC. It made one attempt for each of three Intel quotes against official Intel PCS collateral, then used the previously reviewed local NVIDIA implementation for the model's eight GPUs. The binary, library and loader soname hashes matched the pinned implementation. Native collateral HTTP request counts are not exposed by that runtime; the reported counts are three quote-verification attempts and one local NVIDIA appraisal. This is an appraisal of captured evidence, with no current admission or workload approval. [Machine-readable findings](near-cloud-review-findings.json).

| Check | Captured evidence result |
| --- | --- |
| Model and compose-manager Intel quotes | Native verification and strict `UpToDate`/empty-advisory checks passed. |
| Model nonce, signer and SPKI binding | Passed against verified quote data. |
| Model event log, configuration hash and manager history binding | Passed; model/manager VM and measurements agree. |
| NVIDIA evidence | Eight `GH100 A01 GSP BROM` devices passed the local raw-evidence appraisal. |
| Gateway Intel evidence | Native verification returned a report; strict overall/QE/platform TCB/advisory enforcement rejected it with `CPU_TCB_REJECTED`. |
| Gateway nonce/SPKI/configuration/event replay | Local consistency checks passed; Gateway acceptance remains unavailable because its strict TCB check failed. |
| Workload policy, publisher/build provenance, functional acceptance | Unapproved/uncompleted. |

The scratch appraisal did not retain the exact rejected Gateway TCB status/advisory arrays. The precise observed rejection is the configured requirement that overall, QE and platform status all be `UpToDate` with empty advisory lists. No status or advisory rule was relaxed. Full signed Intel collateral and native verdict files were not archived, so this summary does not provide independent full offline hardware replay. The [native library documentation](https://github.com/Phala-Network/dcap-qvl/tree/master/python-bindings) distinguishes parsing, synchronous verification using supplied collateral, and collateral retrieval; parsing alone was not treated as verification.

## Measured manager delta

The model's current manager history contains **175 actions**, canonical SHA-256 `64527de99907e1c079d454b0f4a611d38be6c4d5aa4e3ce8c69f380d1e678b78`. Its first 135 actions exactly match approved historical policy profile 0 (`00ac037c…`), and its first 174 exactly match the previously reviewed direct candidate. Relative to that policy prefix, there are now 40 further actions: 29 `compose_up` and 11 `compose_down`. Relative to the earlier direct candidate, one action was added:

- Index 174: `compose_up`, source commit `87b48f1fb122aeb2390b1966c5f07d45e14283ce`, file `prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V7-HiCacheOff-r3.yaml`.
- The fetched immutable file's exact SHA-256 is `b13fc8be413e86715c3427d986cc161226f88ea98c79ed7c6cf776a380c8c120`, matching its manager claim.
- The manifest declares an r3 experiment using the V7 engine with its HiCache host tier disabled. Its V7 image, FP8 KV/backend/scheduling and ghost-cache context remain material workload-review questions. Matching source bytes does not establish build provenance, model-weight bytes, actual resolved environment or quality parity. [Immutable manifest](https://github.com/nearai/cvm-compose-files/blob/87b48f1fb122aeb2390b1966c5f07d45e14283ce/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V7-HiCacheOff-r3.yaml).

The main quote's measurements match the earlier 174-action candidate; only RTMR3 differs from the older approved profile 0. The new manager history is independently bound through the manager quote's report data, so unchanged main measurements do not remove the history delta. The [previous review](near-policy-review.md) still leaves new serving/aggregator image publisher proofs and historical mutable DCGM identity unresolved. Complete filtered action/source hashes and Gateway/model boot-image claims are in the JSON findings. These are measured declarations, not a reconstruction of successful starts or current runtime images.

## Remaining evidence required

The next acceptance needs a Gateway satisfying the existing strict TCB requirement; independently reviewed Cloud Gateway/model measurements and a bounded policy; cryptographically verified provenance statements whose subjects match all required image digests; review and functional acceptance of the new serving changes; and fresh live admission before a bounded completion. A public source manifest or reachable build/provenance record does not supply publisher proof. [NEAR image-provenance requirements](https://docs.near.ai/cloud/verification/cloud-api/image-provenance).

The shared model-signing-key limitation also remains: valid model evidence and a later matching signer would not prove exact serving-instance equivalence. No accepted policy was generated, renewed or extended by this work.
