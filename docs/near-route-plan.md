# NEAR admission route — 8 October 2026

The verified provider implementation is ready for policy-controlled acceptance. Live inference remains disabled pending reviewed deployment evidence and fresh admission. The owner's Robinhood wallet is unrelated to these checks.

## Current direct route

The installed Enclave v6 policy approves a historical direct GLM profile and expires at `2026-10-08T14:29:11Z` / **17:29:11 Moscow**. The saved new gpu03 workload fails that policy; the source delta and open provenance questions are recorded in [the workload review](near-policy-review.md). Extending this expiry or learning a new profile from a live report would not resolve that mismatch.

Official NEAR documentation now classifies direct endpoints as experimental and recommends the Cloud Gateway for new integrations. A report covers one answering replica; later connections can reach another replica and fail the attested TLS pin. Signatures kept by one replica can be unavailable when the signature lookup reaches another. These are provider protocol limits, so Telomere retains its single paid POST and bounded signature-GET retry rule. [Direct Completions](https://docs.near.ai/cloud/experimental/direct-completions).

## Preferred acceptance path

1. Prepare a separate Cloud policy for the selected canonical NEAR model and approved Gateway deployment. Reuse the protected API key if appropriate, while reviewing exact Gateway and model configuration, images, build provenance, hardware requirements and bounded expiry. The direct policy has no approved Gateway profiles and cannot be reused by only changing the URL.
2. Inspect fresh Cloud Gateway evidence and every returned NEAR model candidate before any completion; require the selected model, explicit ECDSA, fresh nonce, replayed event log, approved measurements, GPU verdict and Gateway TLS binding. Retain the preflight result for the later signer check. [Cloud Gateway verification](https://docs.near.ai/cloud/verification/cloud-api), [verification policy](https://docs.near.ai/cloud/verification/reference/verification-policy).
3. Once those required checks pass, perform one bounded acceptance completion using the canonical model ID and `x-no-aliasing: true`. Verify exact request/response bytes and require a `provider_tee` signature matching exactly one retained model identity. Missing or mismatched evidence remains unverified; never retry that paid dispatch. [Response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures).
4. Record the limited guarantee accurately. Model replicas can share one signing key across different measurements, so a signer match does not prove exact-instance equivalence. The Gateway, model evidence and final response are separate checks under the current protocol. [Model attestations](https://docs.near.ai/cloud/verification/cloud-api/model-attestations).

Static local `readiness()` checks can expose policy expiry and deployment defects without a network request. They are not a live NEAR acceptance test. No API-key request, paid completion, policy approval or renewal was performed while preparing this route assessment; the sources were read from the official `nearai/docs` repository.
