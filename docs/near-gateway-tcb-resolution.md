# Gateway TCB appraisal and reproducible evidence

The saved Cloud Gateway quote fails the existing strict CPU check because its **platform TCB is `OutOfDate`**. Native verification returned well-formed status objects and advisory arrays. This is an actual TCB verdict, not a schema or missing-advisory-array error. Keep `CPU_TCB_REJECTED` and the current admission policy unchanged.

The report was captured at **2026-10-08 14:39:01 UTC**. The new appraisal ran at **15:37:24 UTC**, followed by successful offline replay at **15:37:45 UTC**. Both results are evidence appraisal only; the report is historical and its nonce does not authorize a future request. [Safe result and artifact digests](near-gateway-appraisal.json).

| Native scope | Status | Advisory IDs |
| --- | --- | --- |
| Overall | `OutOfDate` | `INTEL-SA-01192`, `INTEL-SA-01245`, `INTEL-SA-01312`, `INTEL-SA-01313` |
| Quoting enclave | `UpToDate` | Empty array |
| Platform | `OutOfDate` | Same four advisory IDs |

The native verifier checked the quote and signed Intel collateral. The TDX collateral was issued on October 8 at 14:22:42 UTC and the QE collateral at 14:46:11 UTC; both have a November 7 expiry and evaluation number 20. These validity windows contain the appraisal time. The archived signed collateral independently reproduces the rejected platform verdict. The application did not infer an installed firmware version from the advisory IDs.

All seven diagnostic bindings passed: quote report data to the recorded nonce, signer and TLS SPKI; echoed nonce; echoed SPKI; recorded socket certificate SPKI; app-compose hash to MRCONFIGID; RTMR3 event-log replay; and clear debug bit. Passing bindings does not override the rejected TCB status or establish publisher provenance.

## Provider-side remedy

The four returned IDs identify firmware/TDX issues. Intel recommends manufacturer updates and TCB recovery; the appropriate current update depends on the provider's actual processor and firmware inventory. These older advisory thresholds identify affected releases, not a sufficient current deployment target:

| Returned advisory | Intel affected component and remedy |
| --- | --- |
| [INTEL-SA-01192](https://www.intel.com/content/www/us/en/security-center/advisory/intel-sa-01192.html) | TDX module before 1.5.07.00.774; obtain a manufacturer TDX update. |
| [INTEL-SA-01245](https://www.intel.com/content/www/us/en/security-center/advisory/intel-sa-01245.html) | TDX module before 1.5.13 on listed Xeon generations, or 2.0.8 on the Xeon 6 family; update and complete the applicable TCB recovery. |
| [INTEL-SA-01312](https://www.intel.com/content/www/us/en/security-center/advisory/intel-sa-01312.html) | TDX module before 1.5.16 on listed fourth/fifth-generation Xeon and Xeon 6 E-core systems, or 2.0.8 on Xeon 6 P-core systems; manufacturer update. |
| [INTEL-SA-01313](https://www.intel.com/content/www/us/en/security-center/advisory/intel-sa-01313.html) | Xeon processor/ACTM firmware issues; use the matching manufacturer's current firmware mitigation. |

The provider must patch the Gateway host's relevant firmware/TDX components, complete any required TCB recovery/provisioning and restart or migrate the Gateway as required by that platform. A subsequent fresh quote with current signed collateral must pass the existing `UpToDate`/empty-advisory checks. Our VPS does not control the NEAR Gateway host. [Intel's recovery guidance](https://www.intel.com/content/www/us/en/developer/topic-technology/software-security-guidance/trusted-computing-base-recovery-attestation.html) describes comparing platform evidence with the signed recovery reference.

This conclusion does not establish that the host was exploited, identify its exact installed firmware version, or complete the separate image/source/workload review. NEAR's [verification policy](https://docs.near.ai/cloud/verification/reference/verification-policy) requires predefined TCB/advisory rules and rejection of failed required checks; it also requires independent provenance verification. [Official policy source](https://raw.githubusercontent.com/nearai/docs/main/cloud/verification/reference/verification-policy.mdx).

## Private archive and offline replay

`scripts/near-appraisal.py` provides two explicit modes. `capture` reads an existing saved Cloud packet and invokes Intel PCS collateral fetching once with a 40-second deadline; it never fetches a NEAR report or calls inference. `replay` uses the archived quote and signed collateral at the recorded verification time and has no collateral-fetch path. The full report, nonce, certificate, quote, collateral and native verdict stay private. The public summary contains approved field names, enum statuses, advisory IDs and artifact hashes only.

The archive is `/opt/telomere-pilot/work/gateway-appraisal-replay-2026-10-08T15-37-13Z`, with directory mode `0700` and every file `0600`. It contains `quote.bin`, `intel-collateral.json`, `native-verdict.json`, `gateway-evidence.json` and `summary.json`. Raw artifacts were not downloaded into the repository. Replay validates file names, lengths and SHA-256 hashes before using them; these hashes detect archive changes but do not replace the native signature checks or authenticate the archive's recorded wall-clock time.

The real replay ran under a separate Linux network namespace with **no network access**:

```sh
unshare --net timeout --signal=TERM --kill-after=2s 15s \
  /opt/telomere-pilot/near-runtime/venv/bin/python \
  /opt/telomere-pilot/app/scripts/near-appraisal.py replay \
  --archive /opt/telomere-pilot/work/gateway-appraisal-replay-2026-10-08T15-37-13Z
```

It reproduced the complete native verdict, all diagnostic bindings and strict rejection. A changed signed quote byte and a changed Intel TCB-info signature were each rejected independently by offline cryptographic verification. The [dcap-qvl Python API](https://raw.githubusercontent.com/Phala-Network/dcap-qvl/master/python-bindings/README.md) separates collateral fetching from synchronous `verify(quote, collateral, timestamp)`; `parse_quote` alone is not used as a verification result.

For reproducibility, use the reviewed `dcap-qvl==0.6.3` runtime from `infra/near/requirements-linux.lock` and this repository's `infra/near/verifier.py` for event-log replay. Replaying the archive at its recorded time proves the captured evidence and rejection, not current service readiness. The TS diagnostic classifier in `src/providers/verified/appraisal.ts` strips native report/PPID data and rejects malformed or missing status/advisory fields; 10 regression tests cover the observed verdict, acceptable strict status, other rejection scopes and redaction.

This capture used one Intel collateral-fetch invocation; the native library does not expose its internal HTTP GET count. Replay used zero fetches. There were **zero new NEAR report GETs and zero inference POSTs**. No accepted policy was created, extended or changed, and no stage provider was activated.
