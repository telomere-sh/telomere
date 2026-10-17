# Explicit local composed-evidence upload/launch helper, attempt02

`upload-launch.py` is prepared locally. It has made no SSH/SCP call and has created no true gate file. Each mutating upload/launch phase requires complete actual composed evidence; pending/missing inputs refuse. Explicit read-only `status` remains available if local evidence moves after a lost launch acknowledgement; it cannot start anything.

Attempt01 files, release, reports and units remain preserved. The new run/operator/outer-unit names contain launch02/attempt02 and cannot collide with its one-shot phase units. The only runner logic change is the backup `.local` path; the clone helper uses matching `clone/.local/cysts` for the same private-directory API. No attempt02 remote action has been performed during preparation.

The retained initial677 full run remains **FAIL:2281passed,1failed,19skipped**. Root and an independent reviewer classified its exact pinned failure as the test fixture's gas exhaustion. The only corrected path is `tests/selection-contracts.test.ts`: bounded gas300000 plus two comments, with no assertion/production/dependency/configuration change. The new exact685 source is Git354fe7af62ea6701faafc3b04522abb1b4524d2d, archive86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce. The gate independently recomputes the literal fixture replacement and continuity of all676 other original files plus all8 additive files from three actual archives/manifests.

The final input is `.local/selection-composed-corrected-linux-20261015/acceptance.json` plus its actual `selection-composed.json`: fresh install/build, all40Selection and71additive cases passed, zero failed/skipped, unchanged source/services and healthy original staging. The exact initial failed full report/raw identities and its actual16-case gVisor success remain separate inputs. The first composed harness's parser error is rejected even if its legacy `success` flag says true. Any `failureType`, `postflightFailureType`, timeout flag, absent node summary, failed command, unexpected failure/scope, or changed source refuses the gate. This is **composed acceptance, with no new clean full-suite claim**.

SchemaVersion2 gates bind revision/archive and explicit conditions `initialFullFailureClassifiedGasOnly`, `exactSourceContinuity`, `correctedSelectionCohortPassed`, `additive71Passed`, `paidFileGvisor16Passed`. No gate is created until all actual inputs pass. Failed initial evidence is never relabelled, edited, or copied into a green full report.

Root reviews and invokes each command separately from the repository root:

```text
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py check
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py upload
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py prepare
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py status --target prepare
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py snapshot
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py status --target snapshot
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py validate-clone
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py status --target validate-clone
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py cutover
python .local/private-staging-rollout-attempt2-20261015/upload-launch.py status --target cutover
```

No command invokes the next phase. Launch returns **launched**, without claiming completion. An owned transient systemd unit survives SSH/client disconnection, with output in a private operator log. Root checks successful exit and the existing runner's private state/proofs before the next invocation. A lost response is followed by explicit status, never automatic retry/new run/activation; an occupied phase unit refuses relaunch.

Upload creates only `/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt02`, refuses an occupied path, and uploads the frozen scripts/README, exact685 archive/manifest and verified gates/evidence hashes. After verification, generated local gate/evidence files remain under a new owned `upload-gates-*` audit directory; there is no automatic recursive cleanup. It checks all uploaded regular single-link files/hashes before writing its receipt. Launch rechecks receipt/files/evidence, then runs one phase with run ID `staging-354fe7af62ea-launch02`. OpenSSH uses the pinned existing key path and `BatchMode=yes`/`StrictHostKeyChecking=yes`; helper code reads no protected profile/key contents. Child stdout/stderr are suppressed from local summaries. There is no provider/public-chain action, phase chaining, automatic data restore or activation during preparation.
