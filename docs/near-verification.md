# Verified NEAR inference

`createVerifiedNearProvider` implements the same `NearProvider.complete` interface as the TLS-only adapter. Its additional `verifyAttestation(signal)` method performs a fresh official attestation GET and hardware verification, then closes the transport. It never sends an inference POST. A preflight does not authorize a later request: every inference obtains fresh evidence and a fresh nonce.

`readiness()` is a separate bounded local probe. It reports `ready`, `unavailable`, or `disabled`, a fixed `reasonCode`, check time and, after parsing an exact pinned policy, its expiry time. `getNearProviderReadiness(provider)` also handles disabled and legacy adapters. Every snapshot explicitly includes `scope: "local_configuration"` and `liveAttestationChecked: false`. This method checks policy hash, full measured-policy shape, model, dates, NVIDIA mode, required Cloud gateway profiles, readable runtime/verifier/helper files and local native artifact/loader metadata. It performs no subprocess, attestation GET, inference POST or hardware appraisal. Native file hashes are still checked by live verification. A locally ready configuration cannot override an earlier `WORKLOAD_NOT_APPROVED` result or authorize a request; a new live admission is required.

The adapter is extracted from Enclave commit `0816078462dfd1307686ab2c190a1f93f50b9d18`. The local replacements for Enclave's error/hash helpers have no database, logging, receipt, NEAR payment, or client admission dependencies.

| Telomere file | Enclave source under `_backend` |
| --- | --- |
| `src/providers/verified/inference.ts` | `packages/core/src/near-inference.ts` |
| `src/providers/verified/attestation.ts` | `apps/api/src/near-provider.ts` |
| `src/providers/verified/attestation-error.ts` | `packages/core/src/near-attestation-error.ts` |
| `infra/near/verify.py`, `verifier.py` | `infra/near/verify.py`, `verifier.py` |
| `infra/near/requirements*.{txt,lock}` | `infra/near/requirements.txt`, `requirements-linux.lock` |

Local changes add caller cancellation, Telomere's input/output/token bounds, a mandatory policy hash, policy checks before admission and immediately before POST, safe outcome classification, and a result that drops the full HTTP transcript and hardware report. No source Enclave file is modified.

## Operator configuration

The existing endpoint/model/API key/model allowlist remain required. Set these additional protected configuration fields:

```text
NEAR_VERIFICATION_MODE=enclave_verified
NEAR_VERIFIER_PYTHON=/absolute/path/to/dedicated-venv/bin/python
NEAR_ATTESTATION_POLICY=/absolute/path/to/reviewed-provider-policy.json
NEAR_ATTESTATION_POLICY_SHA256=0x<64 lowercase hex characters>
NEAR_NVIDIA_VERIFIER_MODE=nras
```

`NEAR_VERIFIER_PATH` optionally selects an absolute path to the vendored `verify.py`. Its default resolves both a TypeScript checkout and `dist/src/providers/verified` with `infra/near` at the project root. Deploy `infra/near` alongside `dist`; these Python assets are not bundled into JavaScript.

For a policy that explicitly approves the local NVIDIA implementation, set `NEAR_NVIDIA_VERIFIER_MODE=local`, `NEAR_NVAT_BINARY` and `NEAR_NVAT_LIBRARY` to separate absolute files. The verifier accepts only NVIDIA SDK `1.2.2`, binary SHA-256 `ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6` and library SHA-256 `088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24`. The same identities must be approved by the policy. Telomere does not inherit ambient NVIDIA mode or executable paths and does not bundle these native artifacts.

The library directory must also contain loader soname `libnvat.so.1`, as a symlink to or exact copy of the pinned library. The verifier hashes both the configured library and this actual loader target before and after running NVAT. A missing or different soname produces `NVIDIA_IMPLEMENTATION_CHANGED` even when the two configured files have correct hashes. Preserve this requirement when copying the implementation into an isolated deployment; do not weaken the check.

The API key stays in protected process environment. It is used by the Node HTTPS client and is excluded from the Python child environment. Neither errors nor evidence metadata contain credentials or prompts.

Install the verifier in a dedicated environment on Linux x86-64, glibc 2.28+, CPython 3.11 or 3.12:

```sh
python3 -m venv /absolute/path/to/dedicated-venv
/absolute/path/to/dedicated-venv/bin/python -m pip install --require-hashes --only-binary=:all: -r infra/near/requirements-linux.lock
```

The lock pins DCAP QVL, cryptography, PyJWT, requests and all transitives. `requirements.txt` describes the direct dependencies; use the hash lock for this deployment. Intel collateral, NVIDIA NRAS/JWKS, or native NVIDIA verifier collateral may require HTTPS during verification. The adapter performs no paid inference during installation or preflight.

## Policy review and expiry

The policy hash is an operator's approval of independently reviewed **exact bytes**. File existence or a successful hardware quote does not approve an unfamiliar workload. Policies must contain the selected model, approved measurements and compose-manager identities, GPU model/count, a bounded session lifetime, and a valid time interval. Python enforces the complete measured workload policy. Node additionally rejects development/candidate version labels, wrong model, invalid time, and NVIDIA mode mismatch before any provider operation. Changing whitespace changes the pinned hash.

No usable live policy is checked into this adapter. Enclave's public `policy.glm-2026-09-29.json` is a development example that expired on `2026-09-29T21:13:29Z`.

The operator identified a reviewed accepted v6 policy at `/var/lib/enclave/releases/e1-20261001/acceptance-v6-20261004/accepted/provider-policy.json`, hash `0x75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa`, expiring `2026-10-08T14:29:11Z` (17:29 Moscow). It selects local NVIDIA verification, model `z-ai/glm-5.3-flash`, direct endpoint `https://glm-5-3-flash.completions.near.ai/v1`. These are deployment observations, not a renewal or a permanent default. Copy approved public policy bytes into an isolated Telomere directory and verify the same hash before activation. After expiry, obtain and independently review new measured workload evidence, write a new versioned policy, and configure its new hash. Never extend a date or auto-approve new measurements to bypass expiry.

A [13 October VPS check](near-live-2026-10-13.md) confirmed the active Enclave `near-verified` configuration and captured fresh Cloud Gateway/model evidence. The saved model's Intel/NVIDIA appraisal passed for eight GPUs, while Telomere's local probe returned `POLICY_EXPIRED`, the Gateway still failed strict Intel TCB appraisal, and the model's manager history changed. This does not reactivate the route or approve the new workload.

For direct-route discovery, set the **approved direct** `NEAR_ENDPOINT`, `NEAR_MODEL` and `NEAR_ALLOWED_MODELS`, then run `npm run near:direct:evidence -- --output /absolute/new/private-directory`. This performs one attestation GET, sends no inference key and no POST, and saves the raw report, nonce, same-socket TLS certificate, SPKI and a safe `UNAPPROVED` summary with private file permissions. On Linux with the pinned local NVIDIA runtime, `python scripts/near-direct-appraisal.py --packet /absolute/private-directory --nvat-binary /absolute/nvattest --nvat-library /absolute/libnvat.so.1.2.2` verifies the saved packet and hardware without another NEAR request. Its `DIRECT_HARDWARE_VERIFIED` result is a historical evidence appraisal, not live admission or policy approval. The [13 October direct packet](near-live-2026-10-13.md) passed this check for eight GPUs, but its policy expired and two measurements changed. [NEAR documents direct completions as experimental](https://docs.near.ai/cloud/experimental/direct-completions).

For a reproducible comparison to the **exact historical v6 policy only**, `python scripts/near-direct-policy-diff.py --packet /absolute/private-directory --policy /absolute/provider-policy.json --policy-sha256 75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa --nvat-binary /absolute/nvattest --nvat-library /absolute/libnvat.so.1.2.2` re-appraises the saved hardware evidence and emits bounded measurement deltas. It refuses a different policy hash, missing or ambiguous baseline profile, and never writes a policy, contacts NEAR or admits a session. Its exit status is intentionally nonzero even for an exact match; the 13 October server run reported `POLICY_EXPIRED` and the two changed fields above.

## Verification and money boundaries

1. Before inference, the adapter validates input caps and the pinned policy, requests a fresh attestation nonce, verifies Intel TDX and NVIDIA evidence, rejects debug/outdated TCB, checks workload measurements, and binds the signer and TLS SPKI to that evidence.
2. It retains public CA and hostname verification. Every connection, including reconnects, must use the attested SPKI. Compression and redirects are rejected, so the signed hashes cover the raw HTTP body bytes.
3. It sends exactly one bounded non-streaming inference POST. The raw request/response hashes and selected model must match a canonical ECDSA signature recovered to an attested signer. Cloud requires `provider_tee`. Only signature GETs can retry, at most three attempts.
4. Failure before the POST marker throws `VerifiedProviderRequestRejectedError`, a `ProviderRequestRejectedError`. Any transport, timeout, malformed response, signer failure, cancellation, or changed/expired policy after POST throws `AmbiguousProviderError`. A paid inference must never be retried from either a provider fallback or worker recovery.

Pre-dispatch rejection exposes a safe `reasonCode` and optional `attestationFailure` containing only fixed stage/reason/verifier-code enums. These diagnostics require trusted verifier-error provenance; arbitrary error details are discarded. They allow an operator to distinguish a missing implementation artifact from an unapproved workload without logging a report or automatically authorizing new measurements.

Returned completion evidence contains request/response/output hashes, the attestation reference, pinned policy hash, session times, a hash of the full public provider signature evidence, and the public signing address/ECDSA signature/binding text. Optional token usage is accepted only from the signed response and must fit the requested token cap. The adapter does not persist or return complete HTTP transcripts or raw hardware reports. The normal completion output remains the product result.

`enclave_verified` describes the external provider checks above. It does not certify the Telomere VPS, CPU task, escrow contract, or local process as a hardware TEE. The report/signature protocol and reviewed workload remain part of the trust boundary; CPU/GPU physical co-location is not established. Because the full hardware proof and raw signed HTTP bodies are not archived, the stored metadata supports live verification references and signature checks, **not** independent later replay of complete hardware verification.

The current official protocol also has an instance-binding limit: replicas of one model can share a signing key while running different measured configurations. A verified `provider_tee` signer therefore does not establish that the report and the completion came from the same serving instance. Separate Gateway/model preflight checks and a response signature do not form a complete cryptographic model-to-Gateway-to-final-response chain. The adapter must not advertise that stronger guarantee. See [NEAR model attestations](https://docs.near.ai/cloud/verification/cloud-api/model-attestations) and [Gateway response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures), checked against the official documentation repository on 8 October 2026.

## Offline checks

`tests/verified-near.test.ts` uses disposable local signing keys, synthetic reports and a subprocess fixture. It checks ECDSA binding, one POST, bounded signature-only GET retries, preflight without POST, stale/unreviewed/changed policy, malformed signer/usage, cancellation, timeouts, input caps, credential-free verifier environment, and hostname/SPKI mismatch. These tests make no paid API call and are not a live provider acceptance test.

`tests/provider-readiness.test.ts` verifies local readiness, complete policy shape, exact-byte changes, expired/candidate/development policies, model/Gateway/NVIDIA mismatches, missing and oversized files, loader soname metadata, safe error redaction and repeated expiry checks. It also asserts stale/unreviewed/changed admission sends no report GET or paid POST. Synthetic native files in these tests are metadata fixtures only and are never executed or treated as hardware proofs.
