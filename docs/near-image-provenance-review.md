# NEAR image publisher and workload-source review

**Two new SGLang image publisher links and their immediate shared base are now cryptographically verified. NEAR admission remains unapproved.** The v6 engine/ghost aggregator, v7 engine and immediate base have signed GitHub build attestations whose subjects equal their exact pinned OCI index digests. This closes specific missing publisher links; it does not resolve the [Gateway's rejected platform TCB](near-gateway-tcb-resolution.md), expired policy, historical deployment scope, model-weight identity or numerical acceptance.

The static review ran on 8 October 2026. It used public immutable source and bounded registry/GitHub metadata reads, plus the already saved Cloud candidate captured at 14:39:01 UTC. No new NEAR attestation GET, inference POST, wallet operation, deployment, policy approval or renewal occurred. No image layers, large SBOMs or new executable tools were downloaded. [Machine-readable evidence](near-image-provenance-review.json) records exact hashes, verification conditions and remaining gaps.

## Exact image-to-publisher links

| Role | OCI index SHA-256 | Signed source revision | Build run |
| --- | --- | --- | --- |
| v6 engine and ghost aggregator | `9c6ddd4319c4ab00e351d8650459e68b8830e36ffcc029d67fa5e19d0ac3ed17` | `678a6b5ee3e4e7b83340f810c76530958eecc499` | [37505271073](https://github.com/nearai/cvm-compose-files/actions/runs/37505271073) |
| v7 engine | `fa730e6e62b2ae8058114ce540487ade33ab93bc42b1179ae78edc92bd563fc5` | `29a7db96822caedff38c571dfef8942110702a23` | [37693106399](https://github.com/nearai/cvm-compose-files/actions/runs/37693106399) |

Both raw OCI index byte hashes match their pinned digests. Their referenced Linux manifests, small config blobs and embedded BuildKit statements also match their content digests. The embedded BuildKit statement names a Linux child-manifest subject, has an empty builder ID and declares incomplete materials and `reproducible: false`. Those unsigned statements alone are insufficient publisher evidence.

The separate GitHub Sigstore bundles name `docker.io/nearaidev/sglang` and the exact **index** digest. Full verification passed at **16:35:18 UTC / 19:35:18 Moscow** using the existing `sigstore@3.1.0` and `@sigstore/verify@2.1.1` libraries installed with Node/npm. Verification used the library's TUF root bootstrap/update, certificate-chain checks, certificate-transparency threshold 1 and transparency-log threshold 1. Required certificate identity and OIDC issuer were exactly:

```text
https://github.com/nearai/cvm-compose-files/.github/workflows/publish-glm53-admission-reserve.yaml@refs/heads/main
https://token.actions.githubusercontent.com
```

The authenticated SLSA v1 statements bind that workflow to the source revisions and build runs above. Both declare a `self-hosted` runner. This confirms the named publisher's statements under the stated identity; accepting that runner/build process is a separate policy decision. Current GitHub API observations report both runs completed successfully with the matching head commits.

The small embedded Dockerfile bytes match the corresponding immutable [v6 recipe](https://github.com/nearai/cvm-compose-files/blob/678a6b5ee3e4e7b83340f810c76530958eecc499/docker/sglang-glm53-hicache-w4afp8/Dockerfile) and [v7 recipe](https://github.com/nearai/cvm-compose-files/blob/29a7db96822caedff38c571dfef8942110702a23/docker/sglang-glm53-hicache-w4afp8/Dockerfile). At each source revision, the publishing workflow pins the exact recipe, `PROVENANCE` and `SHA256SUMS` file hashes. Both recipes derive from `nearaidev/sglang@sha256:3eccc30709f5719c81084d1264f03ca5354b3059ec4cff62f0c5ff88c309680c` and declare SGLang source `fc91d2403cc210a86bd5fc715c6609f58c932e5a`.

One bounded follow-up verified that immediate shared base at **16:43:45 UTC / 19:43:45 Moscow**, using the same strict identity and previously TUF-verified current cache. Its signed subject equals `3eccc307…`; source revision is `0244bab81cc0ec42f0aa24d5de57b804650c9cfa`, [build run 35253564994](https://github.com/nearai/cvm-compose-files/actions/runs/35253564994). Its embedded Dockerfile matches the immutable [HiCache admission-reserve recipe](https://github.com/nearai/cvm-compose-files/blob/0244bab81cc0ec42f0aa24d5de57b804650c9cfa/docker/sglang-glm53-hicache-admission-reserve/Dockerfile). Changed statement and signature checks also reject this bundle. The recipe's next base is `01f44c790d43b3eae136f5f3bc930599947bd37fcea081d2dbd3271ff4fc3f8a`; no deeper recursion or wider Gateway/control-plane/history inventory verification was attempted.

Changed statement bytes, changed signature bytes and an unapproved workflow identity were rejected for both new-image bundles: **six negative checks passed**, plus the shared base's two tamper checks. The artifact records bundle/API hashes and TUF metadata/target hashes. Public bundles can be retrieved again through the [GitHub CLI's documented source implementation of digest lookup](https://github.com/cli/cli/blob/trunk/pkg/cmd/attestation/api/client.go); production verification must use a maintained [Sigstore verifier](https://github.com/sigstore/sigstore-js/tree/main/packages/client) with explicit identity and subject checks. Reaching an API record is not verification. This follows NEAR's [image-provenance verification flow](https://raw.githubusercontent.com/nearai/docs/main/cloud/verification/cloud-api/image-provenance.mdx).

## What the latest claimed YAML declares

Action 174 names [commit `87b48f1…`, V7-HiCacheOff-r3 YAML](https://github.com/nearai/cvm-compose-files/blob/87b48f1fb122aeb2390b1966c5f07d45e14283ce/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V7-HiCacheOff-r3.yaml). Exact file bytes match its claimed SHA-256 `b13fc8be413e86715c3427d986cc161226f88ea98c79ed7c6cf776a380c8c120`. PyYAML `safe_load` resolved YAML merge keys; environment overrides were not resolved.

| Declared service | Image | KV/backend | Running / Mamba slots | HiCache | Overlap scheduling |
| --- | --- | --- | --- | --- | --- |
| r1 / r2 | v6 | BF16 / TileLang | 48 / 330 | Enabled | Default |
| r3 | v7 | FP8 e4m3 / FlashMLA | 64 / 380 | Disabled | Disabled |
| r4 | v7 | FP8 e4m3 / FlashMLA | 64 / 380 | Enabled | Disabled |

The ghost aggregator uses the same verified v6 image. All four engines enable shared ghost telemetry and KV-tier metrics. Both v7 services additionally declare four preprocessing workers, a 60-second preprocessing timeout, tool-schema depth 32/node count 25,000 limits, and a 50-step self-profile after 900 seconds. The [v7 provenance notes](https://github.com/nearai/cvm-compose-files/blob/29a7db96822caedff38c571dfef8942110702a23/docker/sglang-glm53-hicache-w4afp8/PROVENANCE) explicitly limit claimed GPU/TEE profiler coverage. These changes need functional and numerical acceptance; repository lab claims were not independently rerun.

This is the file's declared configuration. A measured manager action does not identify its actual service selection, successful completion, live container IDs or effective environment. The two v7 replicas matter here: inherited header comments describing only r4 are not a reliable representation of the generated r3 variant.

## Ghost telemetry boundary

The [ghost patch](https://github.com/nearai/cvm-compose-files/blob/678a6b5ee3e4e7b83340f810c76530958eecc499/docker/sglang-glm53-hicache-w4afp8/ghost-prefix-cache.diff) is byte-identical at the two build revisions, SHA-256 `1423d2dbec36830d7b8cee22d838fc49425e0f787a0ffc911584d8276c7ee209`. Inspection found chained keyed BLAKE2b hashes of 64-token pages, a 32-byte random/shared key, 16-byte digests and 1/16 sampling. Sampled digests travel through a local Unix datagram socket; the aggregator exposes aggregate Prometheus counters. The declared key file uses mode `0600`, on a shared `tmpfs` volume with mode `0700`; no host port is published for the aggregator in this YAML.

The engine **copies prompt and output token IDs into a background-work queue**, default 256 requests. Raw token IDs are not placed in the inspected aggregator messages. The worker's last processed `prompt`/`output` lists also remain referenced by local variables while it waits for the next request; the code has no explicit post-processing clearing. “No token IDs retained” must therefore be qualified: the durable tracked set contains keyed digests, while queued copies and the last processed request can remain in engine memory until subsequent processing or process termination. The shared key allows prefix-equality/reuse correlation between replicas inside the CVM. This static inspection is not a deployed network-egress or memory-behavior test.

## Remaining evidence

Admission still requires acceptable Gateway TCB, a separately reviewed bounded policy and fresh live admission. The review also leaves the wider image inventory/deeper base chain, historical mutable DCGM identity at action 138, resolved runtime scope and cached model-weight bytes open. Resolving today's mutable tag cannot recover its historical image digest. FP8 KV, HiCache-off behavior, scheduling/concurrency changes, token-copy retention and enabled diagnostics need independent functional/quality/TEE acceptance. Shared model keys and incomplete Gateway/model/response binding still limit exact-serving-instance claims.
