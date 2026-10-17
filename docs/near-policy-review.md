# NEAR workload review — 8 October 2026

**Decision: review incomplete; retain `WORKLOAD_NOT_APPROVED` and keep live NEAR inference disabled.** The observed change is a material serving-workload delta. It cannot be treated as a routine restart or resolved by extending the policy expiry.

This independent, static review used the saved candidate captured at `2026-10-08T01:04:35Z`, its compact summary, the exact installed policy and the previously accepted Enclave v6 archive. No new provider attestation request, paid completion, policy approval, installation or renewal was performed. Existing hardware-verification results were inspected; this review does not claim a new Intel/NVIDIA cryptographic appraisal.

## Evidence that agrees

The installed policy is canonically identical to the policy in the accepted v6 archive. The candidate matches its profile 0 in model identifier, boot app-compose hash, compose-manager image, GPU count/model and 13 of 14 TDX measurement fields. Only `rt_mr3` and the full manager-action hash differ.

| Identifier | SHA-256 |
|---|---|
| Policy exact file bytes (deployment pin) | `75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa` |
| Policy canonical JSON (review comparison) | `7f1a6d63131dd9b077de262a478b67afb3bd4e29e33237ada5ac5b5bb68e3f94` |
| Candidate whole profile | `7c9db494c1c62ec6d956b05a137d4197cea497aa243c6fd7ab4cd30a13c94bed` |
| Candidate 174 actions | `79fa9649b7a3f17bad8e4af49bac46a9e9b790a0464eb15d8b364799361cc6f0` |
| Approved profile 0 / exact first 135 actions | `00ac037cde28499ca5ee97b3fda1cd168d174bcd24f3a52adfa09f64047f6013` |

Independent SHA-384 replay of the saved event log matches candidate RTMR3. The event-log prefix through index 30 matches the approved RTMR3; three additional measured `nearai-replica-report-key-v1` events follow. A measured change is authenticated evidence of a change, not approval of that change.

The saved successful acceptance used profile 3 with a 94-action history; it is not a successful acceptance of this new 174-action gpu03 profile. Prior acceptance and policy provenance cannot be reused as a new functional acceptance.

## Verified source delta

The exact approved 135-action history is followed by **39 actions: 28 `compose_up` and 11 `compose_down`**, from 2 October through 8 October. All 12 distinct additional `(commit, file, file_sha256)` claims were fetched from immutable `nearai/cvm-compose-files` source URLs and matched their declared SHA-256. A thirteenth teardown-only manifest was read; that action has no file hash claim.

The history declares TP2x4 rollout, a temporary GLM-5.2 deployment, prefill/decode experiments with new router/relay services, rollback to TP2x4, memory/scheduling changes, ghost-cache aggregation and a V7 canary. The latest declared model starts are mixed:

- r1/r2: previously used `47aff791…` image, with changed memory/concurrency/scheduling arguments.
- r3: new `9c6ddd43…` image and shared ghost-cache volume/telemetry.
- r4: new `fa730e6e…` V7 image, FP8 KV, FlashMLA backends, 64 running requests, 380 Mamba slots and disabled overlap scheduling.

These are declarations of starts, not a reconstruction of the exact running container set. The measured manager records do not expose resolved environment overrides, project scope, successful completion or actual runtime image IDs.

The [ghost-cache manifest](https://github.com/nearai/cvm-compose-files/blob/9bbcef0e013464ec42862e3ed9069afbd2942b4b/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8.yaml) explicitly adds a shared keyed prefix-digest aggregator. The [V7 manifest](https://github.com/nearai/cvm-compose-files/blob/652bf62441fcf8067170a683959a49d6193fd74f/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V7Canary.yaml) explicitly declares the r4 image, KV precision, backend and serving-envelope changes. Matching public YAML bytes does not establish image publisher provenance, source/build reproducibility, model-weight bytes or quality parity.

## Concrete remaining blockers

1. New engine/aggregator image identities and their publisher/build evidence are outside the previously approved source review. Ghost telemetry and the V7 numeric/scheduling changes need explicit review and functional acceptance.
2. Action index 138 declares a default GLM-5.2 start whose [immutable manifest](https://github.com/nearai/cvm-compose-files/blob/ddec8d8c4f637d16884ca949e43c51582d8ed858/prod/GLM-5.2-W4AFP8-SGL-2xTP4.yaml) selects `dcgm-glm52` using mutable `nvcr.io/nvidia/k8s/dcgm-exporter:4.5.2-4.8.1-distroless` and `SYS_ADMIN`. The saved action does not establish which image digest executed or whether that operation succeeded. Its historical identity cannot be recovered from the YAML hash alone.
3. The existing trust boundary remains a managed provider with a privileged control plane and measured manager declarations. The review found no evidence of compromise, but it does not justify declaring the added history benign.
4. Policy `near-direct-glm-e1-2026-10-03.6-nvat` ends **8 October at 17:29:11 Moscow / 14:29:11 UTC**. Any later use needs a separately reviewed, bounded policy and fresh exact-profile admission; extending the date alone would not resolve the rejected workload.

CPU runtime, chain/ledger/controller validation and SDK/MCP completion are separate from this external NEAR admission. No paid NEAR request was sent by this review.

## Later Cloud packet and publisher review

The subsequently captured Cloud packet has 175 actions, adding a HiCache-off-r3 variant at index 174. Exact immutable YAML bytes declare both r3 and r4 on v7, with HiCache disabled for r3. The separate [image publisher/source review](near-image-provenance-review.md) verified exact Sigstore subjects for v6, v7 and their immediate shared base. This advances the publisher part of blocker 1; wider image history, runtime scope/weights, numerical/functional acceptance and the [rejected Gateway TCB](near-gateway-tcb-resolution.md) remain unresolved. The earlier 174-action observations above are retained as historical evidence, not the latest running configuration.
