# Closed Base mainnet pilot preparation, 15 October 2026

This record proves preparation up to the owner signature boundary. It contains
public data only. No owner key, service key, password, private environment or
review session token is retained here. No public transaction was sent.

The operator runbook is `docs/legacy-mainnet-pilot-launch.md`.

## Main records

- `vps/vps-source-record.json`: actual archived application commit `ee6169d`,
  archive digest and 2,029 source-file digests. Relative source paths are
  observations of that archived Git commit, not files duplicated in this folder.
- `vps/build-validation.json`: actual Linux dependency installation and build
  exit codes and output digests.
- `linux/linux-tests-report.json`: 72/72 focused backend tests passed in a fresh
  Linux environment. Before/after source manifests match. The SSH reporting
  connection reset was recovered without rerunning or changing the test result.
- `guard-tests.json` and raw outputs: the retained guards' 59 Node fixtures and
  8 Python tests pass locally. Two initial fixture-relocation path failures are
  retained; imports were corrected for the tracked `ops` directory before the
  passing run. The installed guard implementation did not change during that
  path correction. These are pure public fixtures, not host network operations.
- `vps/executor-smoke.json`: actual application `DockerCpuExecutor`, new UID995,
  gVisor, exact pinned image, metering and confirmed cleanup, with no chain call.
- `vps/database-schema-validation.json`: 43 new tables; only five migration
  locks populated, zero financial records and no chain binding.
- `vps/activation-boundary-validation.json`: deliberately refused activation
  because no signed deployment or activation record exists.
- `vps/owner-review-preparation.json`: actual read-only review, zero ETH balance,
  nonce-zero proposal, full L2/L1/operator estimate and no wallet request.
- `final-runtime-audit.json`: independent final HTTP/socket/service inspection.
  `reviewToken` appears only as an API field name; its value was not retained.

## Corrected infrastructure and scope

`vps/network-repair.json` records the actual staging interruption caused by
starting a second Docker daemon with `bridge=none`, the exact bridge/endpoint
restoration and the precisely bounded stale PostgreSQL backend termination.
The original staging config and financial data were retained. Its controller
restarted, so this is not an uninterrupted-operation claim.

`vps/final-isolation-validation.json` is the authoritative final guard/config
record. It supersedes the earlier `controller-preparation.json` manifest hash
and the interim bridge/namespace observations. Final guards preserve all
non-owned interfaces across daemon startup, and actual Docker info confirms
separate container and plugin namespaces. Both daemons share system containerd
and the kernel. The installed Docker JSON namespace option mismatch and tested
CLI workaround are retained under `linux/`.

`preexisting-service-observation.json` shows the unrelated Enclave API restart
loop already existed before the preparation incident. Web, PostgreSQL and
Redis probes succeeded; a whole-Enclave API health claim is not made.

The exact owner-review overlay is `operator-helper-8f5f41e.tar.gz`. It has 22
regular public files, no links or dependency binaries. Its immutable plan matches
`vps/deployment-plan-base-mainnet.json`. Controller and helper use separate
reviewed source snapshots, recorded in the runbook. Instance-specific guards
and templates are tracked under `ops/legacy-mainnet`.

The original website still matches all 411 handoff file hashes. The selected
deployment is the legacy trusted-operator CPU pilot with Base native USDC and
no HostRegistry collateral. Mainnet deployment, owner deposits and live paid
acceptance remain behind explicit wallet actions; none are inferred from these
preparation tests.
