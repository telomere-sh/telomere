# Cyst count and 50,000-member recovery acceptance, 18 October 2026

The candidate now limits global Cyst admission to **49,000 records**, including pending uploads, leaving **1,000 archive members for recovery data including the manifest**. Controller admission and Python backup/restore consume the same checked-in JSON contract. The exact boundary passed on PostgreSQL with 49,000 actual encrypted files and a 50,000-member tar/age archive; all recovered checkpoint ciphertexts were authenticated and decrypted.

**This is a local-commit and isolated-candidate result.** No Git push, private cloud update, production application activation, production operator replacement or mainnet transaction occurred. The live application remains immutable release `a75ee7bc44ff9aaa8964023975f0b7147c92fee4`. Activation of a reviewed count-aware application and its matching operator contract is still a deployment step; pushing the application repository alone does not activate either deployment.

## Admission and archive contract

`ops/cpu-cloud/cyst-capacity.json` defines 50,000 total members, 49,000 Cyst records and 1,000 reserved members. `src/cysts/capacity.ts` validates/imports it; Python loads its sibling copy directly. The TypeScript compiler emits the application runtime copy at `dist/ops/cpu-cloud/cyst-capacity.json`. Keep that artifact in the reviewed runtime pins and deployment package. The operator JSON must stay beside `archive_policy.py`.

| Bound | Enforced behavior |
| --- | --- |
| Global Cyst metadata | Default 49,000; pending and ready both count |
| Operator count setting | `CYSTS_GLOBAL_CHECKPOINTS`, integer 1–49,000 |
| Cyst files/references in CPU backup | At most 49,000 |
| Other payload files | At most 999 |
| Manifest | One additional member, making at most 50,000 total |

The existing byte budgets remain independent: the CPU backup profile permits 1 GiB of Cyst ciphertext, a 256 MiB dump and a 1.5 GiB encrypted data envelope. Per-owner checkpoint/byte limits remain authoritative too. The older JSON staging-backup tool has its separate smaller bounds; this acceptance targets the production CPU tar/age path.

Every new global reservation acquires the existing database admission-row lock before checking durable owner counters. The missing lock rejects admission before owner metadata or files are written. A matched idempotent replay returns its original record before the global capacity check, so a pending upload can finish at capacity without a second reservation. Failed new admissions roll back their owner insert and counters. Lowering the setting preserves existing data, reads and original retries; it never deletes historical checkpoints.

## Actual PostgreSQL boundary and recovery

The isolated candidate copied the live release and patched only five compiled artifacts: config, configured storage, service, capacity module and emitted contract JSON. All **758 production pins** still match production; **755 unchanged candidate pins** match their original bytes, and all five candidate patch hashes are retained. This is a tested candidate clone, not a newly activated full production release.

The fixture seeded **48,998 historical checkpoint records** using the actual SDK's XChaCha20-Poly1305 encryption, valid owner metadata, distinct nonces and real private ciphertext files. Bulk SQL seeding is explicitly separate from API/service acceptance; this is not a claim of 49,000 HTTP uploads or a public load benchmark. A real service upload was interrupted after its pending reservation persisted. Sixteen concurrent service calls, across two service instances sharing a real PostgreSQL pool, then competed for the one remaining slot: **one succeeded and 15 returned `cyst_global_checkpoint_capacity`**.

A newly constructed Cyst service completed the original pending retry and replayed the first seeded checkpoint while full. Another new upload was rejected and an existing checkpoint remained readable. Reopening here means reconstructing `CystService` over the same PostgreSQL database; a process-kill/reboot is not claimed by this count fixture. Final metadata count, owner counter sum and physical file count were exactly **49,000**. Ciphertext total was only **833,000 bytes**, proving the new record bound rather than byte exhaustion caused refusal.

The actual production-style copier and sealer then archived:

- **49,000** Cyst ciphertext files;
- **997** synthetic configuration files;
- one database dump and one metadata snapshot;
- one manifest, for exactly **50,000 logical regular-file archive members**.

The dump was **7,563,097 bytes** and snapshot metadata **10,346,118 bytes**, within their existing bounds. The resulting encrypted archive was **130,704,728 bytes**. Its exact ID is `backup-20261018T141121Z-1b6acfc3` and ciphertext SHA-256 is `bad5defac35699943f8ab32028fea7f71213ba200f00c1a5617eb9aff82c00c6`.

An actual encrypted-file copy matched the entire ciphertext checksum. The normal recovery unpacker authenticated age decryption, validated the 50,000-member inventory and every payload checksum, and reconstructed the files. A separate Node invocation authenticated and decrypted **all 49,000 recovered checkpoints** using the disposable fixture key and retained original metadata. The source metadata matches the restored database through all-table fingerprint comparisons.

The server verifier restored **47 tables / 49,105 rows in 7.154 seconds**. The hosted restore implementation, executed separately on this VPS through a local encrypted-store adapter and the dedicated Docker socket, restored the same tables/rows in **6.865 seconds** after archive extraction and recreated/hashed all 49,000 ciphertexts. Both databases had networking disabled, labelled disposable disk volumes and 512 MiB memory caps; neither started a mainnet controller. A hosted GitHub runner and remote release transport were not exercised by this fixture.

Adding one more configuration file caused producer rejection; the already accepted encrypted archive retained its exact checksum and no partial output remained. Unit checks additionally reject 49,001 Cyst files/references and 1,000 non-Cyst payload files even when the overall archive could otherwise fit. The complete accepted fixture took **85.094 seconds**, excluding initial clone/staging and final cleanup.

The first seeder attempt failed with PostgreSQL foreign-key error **23503** because it inserted checkpoint metadata before its owner rows. The seeder now creates owners first and fills their counters after historical insertion. The failed attempt's exact source/log, successful attempt and cleanup are retained; no production record was involved. All fixture databases, volumes, plaintext trees and disposable recovery keys were removed. Only synthetic encrypted archive bodies remain in private candidate storage outside Git.

## Verification and publication status

- `npx tsc` completed successfully, including strict checking and emitting the shared JSON dependency. Frontend bundles were not rebuilt.
- Four focused Cyst suites passed **58 tests**, with **two explicit POSIX-only skips** on Windows. They include configured global limits, invalid overrides, concurrent slots, missing-lock rejection and pending/replay at capacity, plus existing encryption, per-owner quota and backup behavior.
- Linux operator suites passed **86 tests**: 29 cloud/policy and 57 launch/recovery cases. The integrated Linux acceptance separately used real PostgreSQL, 49,000 filesystem objects, age, both restore implementations and full recovered-checkpoint decryption.
- The read-only production audit still has two completed settlements, original journal fingerprint `d26dcd891a949f492e0457fb8bc94f06ded34993caf1724dc27389098143593e`, signer nonce **2**, operator gas **98,462,564,567,330 wei**, owner **2.422567 USDC** and empty escrow.

The prepared update needs a reviewed application deployment that retains/pins the emitted JSON and a matched operator deployment that installs the JSON before the policy consumer. Check existing Cyst metadata against the selected limit before activation. Update the separate private cloud sources together and obtain a fresh matching backup/runtime verification. No deployment or publication is represented as completed here.

See the [hashed evidence manifest](evidence/cpu-cyst-count-20261018/manifest.json), [candidate provenance](evidence/cpu-cyst-count-20261018/provenance.json), [source record](evidence/cpu-cyst-count-20261018/source-record.json) and [operator instructions](../ops/cpu-cloud/README.md).
