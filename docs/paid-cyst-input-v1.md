# Declared application-file restore into a paid CPU session

This optional backend path extends the existing encrypted, multipart Large Cyst format to an explicitly declared data file in a paid CPU session. The bounded profile passed actual Linux gVisor acceptance on 15 October 2026 with a 4,194,561-byte, two-chunk checkpoint. It does not establish the original full filesystem, 2-GiB or 20-second recovery requirements.

## Authority and data flow

`AgentCurrentCystPaidFileRestore` prepares one explicit operation in a private local directory. Preparation requires no wallet: it resolves the agent's current canonical Cyst, unwraps the recovery key locally, authenticates the encrypted chunks, streams the plaintext to a private file and retains bounded encrypted operation metadata. The returned task declares the original checkpoint, revision, operation ID, exact plaintext length and SHA-256. A separate checked Vault SDK operation obtains, funds and admits that task's paid quote.

The descriptor is part of the signed workload and paid session lease. A host must advertise an explicitly reviewed byte limit and answer the signed capacity challenge after checking its spool quota and disk headroom. Host admission reserves those bytes before acknowledging the lease. An unconfigured or undersized host cannot silently accept the file task.

The agent then uploads the original file through authenticated `PUT /api/platform/vaults/:vault/runs/:id/inputs/:operationId`, with matching `Idempotency-Key`, exact `Content-Length` and `application/octet-stream`. The binary transport uses the same origin and Vault as the checked runtime client. Paths on the agent's computer, recovery keys and file contents are not added to the JSON command journal.

HostKit first stages bytes outside the directory mounted into the Cell. After the complete length and hash are verified, the controller rechecks the current Cyst, original paid lease and live spending policy before issuing a separate signed commit. Only that commit publishes `/run/telomere-cyst/state.bin` in the read-only mounted directory. A reviewed application command consumes the fixed data path; no tenant-selected extraction path is accepted. Interrupted, mismatched or stale uploads do not publish a partial file.

A retry that reaches an already staged or committed file still consumes and verifies the exact duplicate HTTP body before acknowledgment. It uses the original signed lease deadline, performs no file rewrite and repeats live authority checks before committing or returning a successful upload result. This also handles the file becoming ready between the SDK's status read and its PUT, without cancelling a valid incoming request before its response can be delivered. The SDK can return a previously signed committed status without opening or sending a local source file.

Upload time consumes the existing paid lease. The 120-second session limit, command count, memory allowance and temporary filesystem limits remain in force. The agent-side preparation has separate finite time, byte, free-space and plaintext-lifetime limits. An uncertain financial or restore outcome retains its original operation rather than obtaining a fresh payment or dispatch identity.

## Operator configuration

The controller enables new file-input authority explicitly with `PAID_CYST_INPUTS_ENABLED=true`. It requires the reviewed Vault runtime, canonical CystRegistry configuration and at least one reviewed session host with `cystInputMaxBytes`. The default is disabled. Read and cleanup recovery of original records remain distinct from authorizing a new file task.

HostKit separately needs `HOST_KIT_CYST_INPUTS_CONFIG` pointing to an absolute private JSON file and `HOST_KIT_CYST_INPUTS_CONFIG_SHA256` containing its reviewed raw SHA-256. Both are required together. For example:

```json
{
  "directory": "/opt/telomere-host/private/cyst-inputs",
  "maxInputBytes": 16777216,
  "globalBytes": 67108864,
  "maxOperations": 64,
  "minimumFreeBytes": 1073741824
}
```

The file and its immediate parent must be private. Plaintext spool and HostKit journal roots must occupy separate directory trees, in either ancestor direction, so journal backup cannot capture input plaintext. The spool policy permits at most 256 retained operations and must reserve at least one maximum-size input in its global budget. Changing the directory or quota policy changes the persisted HostKit session-backend identity. The paid path requires reviewed gVisor or Kata isolation; the Docker development mode cannot enable it.

Host cleanup precedes releasing spool authority. Missing unfinished reservations, unmatched retained inputs and uncertain container removal require reconciliation. A terminal record whose cleanup was already durably confirmed can retain that historical fact without recreating plaintext.

## Backup scope

For a file-capable HostKit, both `backup:platform` and `restore:platform:verify` take the same explicit pair:

```text
--host-cyst-inputs-config /absolute/private/input-policy.json
--host-cyst-inputs-sha256 <reviewed-raw-file-sha256>
```

For this profile, `restore:platform:verify` also requires `--host-directory` identifying the original HostKit journal root to repeat the directory-separation preflight. The backup command already requires that argument.

These commands read the bounded policy and calculate the same host identity without opening or scanning the plaintext spool. Omitting or changing the policy produces a different identity and cannot certify the original host scope. The stopped-state backup preserves encrypted Cyst data and signed lifecycle records; it does not copy transient plaintext input files. Recovery must not convert a missing unfinished input into newly confirmed cleanup.

## Supported trust and acceptance boundary

This first profile restores a declared application data file into an ordinary paid CPU Cell. The key remains on the agent side, but the selected ordinary host receives plaintext. It does not claim sealed CPU admission or attestation-gated key release. It also does not restore an arbitrary tar archive, writable container layer, CRIU checkpoint or VM snapshot. GPU Cells are unrelated to this path.

Schema limits permit large files, but supported size, duration and memory claims must come from the combined encrypted-Cyst, paid-lease, HostKit and application acceptance drill. The standalone HTTP middleware test establishes streamed intake and authentication only. It is not evidence of a paid restore by itself. Public Base execution, independent physical-host failover and live activation of this paid-file profile remain separate acceptance stages.

## Measured acceptance

The historical corrected cohort passed **15/15 with zero failures or skips** from committed source `abf941bef4688fa3f81eb986523fa16037cc3abc`. All 672 original archive inputs remained unchanged. Fresh dependency installation and the production build also passed. The [validation report](paid-cyst-input-validation-2026-10-15.json) retains that archive identity, raw results, source manifest, earlier failed run and exact claim boundaries.

The actual paid scenario used disposable compiled contracts on local chain 31337 and two separately funded runs. A guardian freeze after staging prevented file publication and application execution; the normal monitor stopped and cleaned that run. After unfreezing, a new explicit operation and a new payment restored the file into a nonroot gVisor application, recovered lost upload and command responses, and advanced application state from counter 71 to 72. Both original reservations settled with charge plus refund equal to their respective ceilings.

The drill checked the read-only file mount, denied an application write, and checked the 256-MiB memory limit, 16-MiB scratch limit and disabled network. These are enforced profile settings, not a measurement of peak memory or a two-gigabyte recovery benchmark. The cohort's 55.668-second duration includes several scenarios and is not a restore-latency result. No public transaction or paid provider request was sent, staging stayed healthy, and cleanup affected only this acceptance host key's containers.

The historical source cutoff is retained independently of the [agent-cache expiry follow-up](paid-cyst-input-cache-expiry-validation-2026-10-15.json). That small change disposes of expired authenticated private plaintext before a changed-registry rejection after an agent process restarts. Its deterministic no-wallet, no-compute-session test fails on the accepted older module and passes on the corrected module with 18 focused input hashes unchanged. The existing operation, private path and encrypted-journal lock checks still precede deletion.

The later actual Linux/gVisor cohort passed **16/16 with zero failures or skips**, including that TTL follow-up, from the 677-file archive for `b042c1bc3119754e06f6b662f2e46c108a63db36`. Its [composed validation](backend-composed-linux-validation-2026-10-15.json) preserves the source boundary and the separate initial full-regression failure plus corrected 111-case cohort. The gVisor cohort took 54.912 seconds across its scenarios; this is not a restore-latency measurement or a clean full-suite pass.

The [actual private staging rollout](private-staging-rollout-validation-2026-10-15.json) activated the later `354fe7a` source while preserving the original legacy demo profile. Its checks preserved the existing one 93-byte small Cyst and original database records; they did not enable `PAID_CYST_INPUTS_ENABLED` or run this paid-file profile on the live controller. The [postoperation review](private-staging-postoperation-independent-review-2026-10-15.json) and [current readiness report](backend-current-readiness-2026-10-15.md) keep that operational acceptance separate from the real gVisor paid-file drill and remaining launch gates.
