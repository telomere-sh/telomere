# CPU server rollout, 19 October 2026

The public Base/USDC service was promoted from `a75ee7bc44ff9aaa8964023975f0b7147c92fee4` to the audited application build `e11d42d56ab30a9167ca4f24e7a376a62836452a`. Its 999 deployment pins were checked before startup. Contract addresses, authorities, the financial profile and the production database were retained. A stopped database dump and the previous application/operator/configuration remain available for rollback; application rollback must not overwrite live financial data.

All 47 original table fingerprints matched across promotion. Both completed financial journal records, their original signed bytes, the operator nonce and the observed wallet/escrow balances were unchanged. No mainnet transaction was submitted by rollout tooling.

## HTTPS website routing

The audited frontend contains finite, checksum-bound local Framer CMS exports. Its datastore requests concatenated byte slices with `?range=`. Static nginx serving ignores this query and returns the full file, which caused a browser hydration failure during verification. The previous website was restored while routing was corrected.

The narrow [CMS location](../ops/public-wallet-launch/cms-location.conf) now forwards that asset namespace to the existing bounded read-only Website handler. All 16 CMS files passed full-file checksum and concatenated-range checks through public HTTPS, including from an external Windows client. The homepage, Workspace sign-in and the Proof Chain interaction were checked in the browser. The design and frontend source were not edited during this rollout. Missing assets/private source paths return 404, and unauthenticated owner APIs return 401.

## Scheduled backup publication

The actual hardened backup service exposed `EXDEV`: its separate `ReadWritePaths` bind mounts prevent a direct rename from private working storage to the backup directory, despite sharing a physical filesystem. Operator fix `1f22da678ea8a08cc67151ed057c3bb8609eddc7` copies completed ciphertext into exclusive private-mode scratch on the destination mount, verifies and fsyncs it, then publishes with a same-mount atomic rename. Startup reclaims strictly named, owned, single-link interrupted ciphertext publications under the exclusive backup lock. Plaintext stays in the existing reclaimable private workspace. Service sandbox restrictions remain in place.

All 122 CPU operator tests passed on Linux, including seven new publication/failure/recovery cases. The installed changed Python files were checked against the exact Git bytes. The real systemd backup service then completed successfully with its original sandbox.

Fresh data backup: `backup-20261018T222009Z-7437d509` (the identifier is UTC). Matching complete runtime: `runtime-e11d42d56ab30a9167ca4f24e7a376a62836452a-bfa192b36556415a`, 500,489,045 encrypted bytes, 42,446 files. The producer's network-isolated PostgreSQL restore matched 47 tables and 53 rows. The runtime includes the complete gVisor distribution.

The existing private hosted workflow [39171832968](https://github.com/telomere-sh/telomere-ops-backups/actions/runs/39171832968) completed successfully: authenticated archive verification, independent encrypted storage/readback and an isolated PostgreSQL restore. The server acknowledged this exact data/runtime pair. No source commit was pushed to either repository.

The matching pair then passed application recovery in 90.76 seconds: authenticated decryption of 20 data members and 42,446 runtime members, all 999 runtime pins, 47 tables/53 rows, two authenticated historical job reads, isolated TLS/private-path checks, and a generated-wallet local-chain CPU lifecycle using the archived Node and actual gVisor runtime. Fifty synthetic users passed a 1,000-request burst and a separate 60-second exercise with 600 reads, 60 writes and one CPU run, with zero errors. This was application recovery on the existing host, not another complete VPS rebuild. The production controller was not restarted by the rehearsal, and its mainnet signer was not supplied to the restored application. Scratch runtime cleanup succeeded. Final monitoring reported no alerts.

## Remaining publication boundary

The hosted verifier still runs private-repository commit `21cc594cd087cea1688308602470e32e143f2fdd`, with its earlier 512 MiB archive limit. This current small data snapshot and its runtime fit that published version and were verified. The separately prepared capacity-aware private workflow still requires publication before claiming hosted verification at the full 1 GiB Cyst quota. Current-pair verification does not establish that larger acceptance.

No private deferred-update package was included in Git or this deployment. Public `main` remained `40fa1755f9430f40b16a379d94bc38f618826b83` at verification. Second-wallet acceptance, a new contract deployment and GPU Cells were not part of this update.
