# Private staging rollout runner, 2026-10-15

This ignored operator preparation is **not executed** by creating these files. Run it only after root reviews the scripts and accepts the exact composed Linux evidence below. It changes only the existing **private demo chain31337** staging when explicitly invoked on the VPS. It neither deploys to Base nor enables any new payment/provider/sealed/supplier profile. No wallet, external paid request, provider POST, Enclave action, or automatic data restore is present.

Files:

* `rollout.py`: explicit release preparation, stopped snapshot, owned clone, controller-only cutover, and code-only rollback phases.
* `clone-smoke.mjs`: bounded private-profile checks, original-column DB/Cyst fingerprints, same-clone latest/old startup and five canonical receipt/event/journal proofs.

The original app, chain unit/binary/state path, watchdog app/unit, protected profile and Cyst tree remain in place. All new release files are root-owned and readable by group `telomere`; directories/executables0750 and other files0640. Clone inputs/outputs/secrets remain0600 (Cyst directories0700). The controller retains its existing user/group, protected env file, hardening, limits and only-existing-data write allowlist.

## Reviewed source and gates

The proposed source is Git `354fe7af62ea6701faafc3b04522abb1b4524d2d`,685 files, archive SHA256 `86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce`. Its676 prior core files and all8 additive files are byte-identical; the only changed path is the Selection test fixture's bounded settle gas default300000 and two comments. Production, dependencies, configuration and every other test remain unchanged.

The retained initial677 full run is **FAIL:2281passed,1failed,19skipped**. The one failure is the specifically reviewed Selection fixture gas exhaustion; it is never relabelled a clean full pass. Composed acceptance requires this exact initial failure identity/raw counts, its reviewed gas-only classification, retained actual16-case gVisor success, exact source continuity and a fresh corrected685 install/build with **all40Selection and71additive cases passing (111total,zero fail/skip)**. The first composed harness's output-parser error is also historical; only the corrected fresh harness's actual reports may satisfy the final gate.

Only `upload-launch.py` may create the private gate file after reading and verifying all actual evidence. SchemaVersion2 binds revision/archive and five explicit true conditions: `initialFullFailureClassifiedGasOnly`, `exactSourceContinuity`, `correctedSelectionCohortPassed`, `additive71Passed`, `paidFileGvisor16Passed`. There is no clean-full-success flag. Missing, pending, unexpected failure or inconsistent evidence refuses all transport/activation.

Upload these three reviewed files to a new private operator directory; upload or reference the exact accepted source archive and its685-file manifest. **No command below was run during preparation.** Substitute existing absolute archive/manifest/gate paths; never paste profile contents or keys into commands. The example run ID is fixed for one attempt; use a fresh suffix for a new attempt, never reuse an incomplete work directory.

```text
python3 rollout.py prepare --run staging-354fe7af62ea-launch01 --archive /ABSOLUTE/accepted.tar.gz --manifest /ABSOLUTE/accepted.tar.gz.manifest.json --revision 354fe7af62ea6701faafc3b04522abb1b4524d2d --sha256 86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce --gates /ABSOLUTE/verified-composed-gates.json
python3 rollout.py snapshot --run staging-354fe7af62ea-launch01
python3 rollout.py validate-clone --run staging-354fe7af62ea-launch01
```

Review private results before a separate invocation:

```text
python3 rollout.py cutover --run staging-354fe7af62ea-launch01
```

Code rollback is a separate deliberate phase:

```text
python3 rollout.py rollback-code --run staging-354fe7af62ea-launch01
```

## Phase boundaries

1. **Prepare** checks the exact Git/archive/685-file manifest; rejects every unsafe tar member/link and every occupied release/work path. It extracts into `/opt/telomere-pilot/releases/<full-Git>-<attempt-suffix>`, runs locked `npm ci --offline --ignore-scripts` and build before any service interruption, then verifies original source hashes and normalizes only this new release's permissions. A cache miss fails preparation; there is no online dependency fallback. A new attempt uses a fresh suffix/release and preserves all old attempts. It retains the protected unit-file/static-property and old compiled-code/lock/Anvil/Node identities for later rechecks.
2. **Snapshot** stops watchdog→controller→chain, verifies no managed Cells, invokes the latest existing `backup:staging` and `backup:verify` CLIs, requires backupv2 and takes bounded hashes of all original DB columns, exact private profile, complete raw chain file and the existing single93-byte encrypted Cyst/counters. It restarts the OLD chain→controller→watchdog immediately. Thus clone validation does not consume maintenance time. Target maintenance is under two minutes; timeouts prioritize a safe old-service restart and cannot guarantee a bound if the OS/service manager itself stalls.
3. **Validate clone** restores only a new labelled scratch PostgreSQL on a loopback unused port, a copied zero-default-account Anvil state on another loopback port, copied Cysts and separate DATA_DIR. A third unused port serves the clone. The exact installed CPU image is exported from the explicit global Docker socket and loaded into a NEW dedicated daemon/netns/data-root; no image pull or registry operation occurs. Clone CPU_IMAGE uses the verified identical image ID because Docker save/load does not promise retaining a repo digest reference. Both new and old controllers inherit the dedicated socket in the actual process environment and run as `telomere` under equivalent systemd hardening/limits. The new controller first migrates/starts/closes; the old controller then starts/closes against that SAME migrated DB/Cyst tree. Each proves all five old receipt signatures, exact row/run/billing, canonical escrow RunSettled event, original journal hash/nonce, unchanged original columns/Cyst counters, and unchanged canonical chain head/account/nonce/balance/code/run/Leash digest before startup and after close. New columns are allowed only for the explicitly reviewed additive jobs.agent_address and transaction_journal.nonce; every pre-existing column remains fingerprinted. The new CPU executor also runs one bounded real container task in the owned daemon; it creates no new paid job or blockchain transaction.
4. **Cleanup** independently stops the exact owned transient Node units, owned Anvil child, owned dockerd unit and empty netns, and removes only scratch PG with its exact full ID+owner label. No old data, image, registry, original daemon resource or application tree is deleted. All clone data, image archive, backup and private reports remain for inspection. An incomplete/ambiguous cleanup fails the gate and prevents cutover. The older one-run restore CLI is not launched: its independently randomized child resources would complicate timeout ownership, while this tracked clone provides stronger five-run migration and rollback acceptance.
5. **Cutover** requires the preserved clone proofs and old code/unit identities, makes a FRESH stopped backupv2 and requires exact equality of protected profile, complete original-column DB semantics, Cyst data and raw chain fingerprint with the accepted snapshot. `pg_dump`/manifest byte equality is deliberately not used. Raw Anvil file equality is an additional conservative guard: a volatile-only raw-file change still refuses activation until investigated and the clone proof repeated; no unexplained field is silently dropped and no ignore-drift switch exists. On agreement it installs only `/etc/systemd/system/telomere-staging.service.d/90-telomere-reviewed-release.conf`, resetting WorkingDirectory/ExecStart to the new immutable release. It reloads, starts the same chain/controller/watchdog and polls bounded live/ready responses. Other unit/profile settings remain inherited.

## Rollback and limits

Any cutover failure attempts to stop the new controller, preserve its exact owned drop-in, disable it with a **same-directory** rename, reload, and restart the original units against the current data. A successful explicit code rollback follows the same path. Both rely on the prior old-source startup against the already migrated clone. No snapshot is automatically restored, and a new source transaction/response loss never justifies rewinding DB or chain alone.

If consistent bundle recovery is ever needed, stop services, preserve failed new data, and review/reconcile any new work before restoring **DB+chain+Cysts+profile together**. This is outside the runner. A live health response is a service check; the durable clone reports hold the complete historical proofs. All child output stays in owned private logs, and stdout/stderr expose fixed status/phase only. Root must inspect private artifacts through sanitized summaries and preserve all earlier attempts.
