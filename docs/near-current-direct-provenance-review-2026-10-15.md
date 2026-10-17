# Current direct NEAR workload provenance, 15 October 2026

**Decision: provenance remains incomplete; no candidate policy was generated. Admission remains UNAPPROVED.** A short validity window would not resolve the missing historical image identity or establish the current serving workload. The installed policy was unchanged before and after this review, SHA-256 `75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa`; it expired on 8 October at 14:29:11 UTC. [Machine-readable review](near-current-direct-provenance-review-2026-10-15.json).

This review read the already captured 15 October direct packet over SSH with the pinned host key. It verified the saved response hash `9c2e72ec9d5dac867a5a189a6db43f3b49fc8b2d9da599cafcfcd5befda199a4` and measured manager-history hash `f903bd0f836f7720580c6bb94534c2399e7800956d5bb8011a3b1432bbd54733`. Raw reports stayed private on the VPS. The review did not read credentials or change installed policy/service configuration. No new report GET, hardware appraisal, inference POST or wallet transaction occurred. Hardware acceptance of the saved model packet with eight GPUs is the separate [fresh native appraisal](near-live-2026-10-15.md), not a result rerun here.

The history has **186 actions**. Its first **135** exactly reproduce approved profile 0's action hash `00ac037cde28499ca5ee97b3fda1cd168d174bcd24f3a52adfa09f64047f6013`. The added **51** actions comprise 40 `compose_up` and 11 `compose_down`. All **17 distinct immutable source files** named by those actions were fetched successfully; all 16 files with measured SHA-256 claims matched. The remaining file is teardown action 137, which has no measured file-hash claim. Public source contents do not recover an absent measured claim. The sanitized [action inventory](evidence/near-current-direct-claims-20261015.json) was byte-identical before and after the review; [source evidence](evidence/near-current-direct-source-20261015.json) retains exact URLs, hashes, parsed image declarations and serving parameters.

The new [V7 fleet manifest at `1121ee5`](https://github.com/nearai/cvm-compose-files/blob/1121ee56851dcec7dc89e60099d7be28fc51a73e/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8.yaml) moves all four engines to V7 with FP8 KV, FlashMLA backends, 64 running requests, 380 Mamba slots, HiCache disabled and overlap scheduling disabled. The parsed [next manifest at `b9acc8f`](https://github.com/nearai/cvm-compose-files/blob/b9acc8f208409daa2c35d26f0b7bbd93ecc5eef5/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8.yaml) changes only engine-command paths: `--max-queued-requests` increases from 8 to 32 in each engine. Self-profiling variables are absent from this fleet configuration; shared ghost-cache and preprocessing controls remain.

The most recent per-service **start declarations** are:

| Role | Action | Exact declared image SHA-256 |
| --- | --- | --- |
| r1 / r2 / r3 | 181 / 182 / 183 | `fa730e6e62b2ae8058114ce540487ade33ab93bc42b1179ae78edc92bd563fc5` |
| r4 | 185 | `59700363c0b6885301ea1f344fe3d45c8335597fdef4ffd49def79dca347f91d` |
| Ghost aggregator | 179 | `fa730e6e62b2ae8058114ce540487ade33ab93bc42b1179ae78edc92bd563fc5` |

The r4 declaration matches the [immutable V8 canary YAML](https://github.com/nearai/cvm-compose-files/blob/46bfd83ec22c179693e06308e40950d540154b4d/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V8KdaCanary.yaml), SHA-256 `c7c1bf4d82e137b8d2e0788f41cd6637b38bd08fdc74f38e87b4571ce0c8562e`. Earlier [V6/V7/base publisher verification](near-image-provenance-review.md) and [V8 publisher verification](near-v8-image-provenance-2026-10-13.md) remain retained evidence for those exact subjects. This review did not repeat Sigstore verification or download image layers.

Candidate-policy blockers remain concrete:

- Action **138** starts the [GLM-5.2 manifest](https://github.com/nearai/cvm-compose-files/blob/ddec8d8c4f637d16884ca949e43c51582d8ed858/prod/GLM-5.2-W4AFP8-SGL-2xTP4.yaml), whose default `dcgm-glm52` service uses mutable `nvcr.io/nvidia/k8s/dcgm-exporter:4.5.2-4.8.1-distroless` with `SYS_ADMIN`. Its historical executed digest and outcome remain unknown. Resolving that tag today would not identify its earlier bytes.
- Manager records do not establish successful operations, effective environment overrides, project scope or authenticated current container/image IDs. YAML merge keys were resolved with PyYAML `safe_load`; environment interpolation was not performed. The table is not a reconstruction of live containers.
- Signed engine subjects cover a subset of the wider manager, proxy, telemetry and historical image/base inventory. Cached model-weight bytes, deployed numerical/functional acceptance of FP8/KDA/queue32 changes, and the earlier ghost-token-retention concern remain open.
- Shared provider signing keys and incomplete exact serving-replica/response binding remain. This evidence does not establish an arbitrary GPU Cell or a sealed Cell key recipient.

An authenticated historical execution/image record or a separately reviewed clean workload deployment is needed to resolve the mutable historical component. A complete deployment inventory, weight authentication and bounded functional acceptance must then support any separately approved policy and fresh admission. The direct path avoids the Cloud Gateway; the Gateway's strict `OutOfDate` TCB rejection remains unchanged.
