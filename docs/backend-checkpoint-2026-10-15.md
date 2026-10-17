# Backend checkpoint, 15 October 2026

The completed engineering batch is commit `edc788c`: bounded paid CPU lifecycle, current-rate Metabolism, explicit private/public checkpoint capacity, durable finite owner funding, mounted owner-approved CPU job replacement, optional economics profiles and framework starters. The active public settlement target is Base/native USDC. Arbitrary GPU Cells remain optional. The independent functional estimate for the original nine mandatory milestones is [approximately 75%](backend-functional-rescore-2026-10-15.md), not a public-launch score.

## Accepted source boundary

The isolated Linux archive has SHA256 `763ad81f8bbf4fd1aa601c2c8dd875e65f677a0531e39209a42bb6ecd84362db`, containing 624 source/assets/configuration files. Every archived file matched after acceptance. It was tested in a new private directory with the reviewed Node 22 dependency lock, separate local contracts and the dedicated gVisor acceptance socket. These results apply to that archive, not to later in-progress payment-rail changes.

- Linux: 65 passing cases, 6 intentionally unselected cases, no failures. Both lifecycle policies used real runsc containers with full/lean/torpor CPU quotas, retained checkpoint restore and exact original financial accounting. The owner-approved interruptible-to-standard job used two HostKit identities with actual gVisor execution on one physical VPS. The queued-kill case remained an explicitly identified local fixture.
- Python: 224 passing cases, 7 actual Windows/POSIX skips, no failures. Crypto-enabled native Anvil income/restart/reorg acceptance was enabled; Python source was unchanged before/after the run. See [the Python report](python-full-validation-2026-10-15.json).
- Owner adapter: 12 safety cases plus one real Anvil funding case passed. Ambiguous wallet outcomes, admission response loss, independent quota negotiation, delayed storage preflight and mixed-age journal recovery are covered. See [owner-loop validation](paid-owner-lifeline-validation-2026-10-15.json).
- Storage: 960 actual HTTP checkpoints and 21,120 real encrypted private records over 960 logical hops were retained and restored. The private Linux capacity run took 1,117.646 seconds; it is not a 24-hour wall-clock soak. See [capacity evidence](lifecycle-vault-v3-validation-2026-10-14.json).
- Backup: 47 passing cases and 2 Windows/POSIX skips, including explicit quota v2, read-only restored metadata and two HTTP/S3 replicas. See [backup validation](backup-quota-v2-validation-2026-10-15.json).
- Build and type checking passed. Production dependency audit reported zero known vulnerabilities. The enlarged whole-suite Node regression was still running when this checkpoint was written; it is not pre-announced as passed. [Final Linux details](backend-linux-validation-2026-10-15.json) retain the exact archive manifest, results and before/after environment checks. Seven files differ from Git's stored text only in CRLF/LF; the archive hash is the exact tested byte boundary.

The original staging services were checked after reboot and during acceptance: SSH reachable, all three Telomere services active, no service restarts, liveness/readiness HTTP 200. Existing staging remains a private local-chain demonstration; this archive was not rolled over the live service. Enclave API independently continues to reject its expired acceptance policy. Its policy was not extended and no paid provider request was made.

After acceptance, the temporary dedicated Docker unit was stopped, its namespace was verified empty and removed, and staging health remained HTTP 200. Original data, images, registry metadata and source snapshots were preserved.

## New phase and remaining gates

Work after this accepted batch targets two missing payment paths: explicit Base Spend Permission-funded CPU admission and finalized Solana USDC-to-Base Vault treasury credit. They are not included in the 75% assessment until their own complete integration and acceptance pass. Existing exact x402-to-Vault-to-Selection income already works; it must not be implemented or credited again as though missing.

Public launch still needs a reviewed current inference policy/completion, real bounded external supplier operation, sealed CPU admission/key release, independent physical-host/storage recovery, prescribed governance/audits and funded public Base acceptance. The present VPS exposes an ordinary AMD KVM guest without a TDX/SEV guest attestation interface. A working local verifier or remote model inference API does not turn it into a sealed CPU Cell.

Application restore is bounded to 4,096 bytes; each paid CPU lease remains at most 120 seconds. Current lifecycle continuation does not satisfy a 2-GiB filesystem restore under 20 seconds or prove a day of continuously renewed compute. The owner wallet remains the last public test stage, as requested. The backend has not yet reached 90% of the original mandatory specification.
