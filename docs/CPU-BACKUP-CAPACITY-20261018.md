# Cyst backup capacity acceptance, 18 October 2026

The server capacity mismatch is corrected without reducing the configured **1 GiB Cyst quota**. A real full-quota encrypted fixture was copied through the restricted SSH export to an independent private recovery device, authenticated there and restored through the hosted restore implementation on the VPS. The application remains the immutable **a75ee7bc44ff9aaa8964023975f0b7147c92fee4** release with **758 verified pins**. No mainnet transaction was submitted.

Publication is explicitly separated from implementation: the user requested a local GitHub Desktop commit and deferred pushing. The capacity-aware hosted sources and workflow are prepared in this checkout, but have **not** been published to the separate private operations repository. This acceptance does **not** claim a GitHub-hosted full-quota run or large release-asset upload/readback. Existing scheduled operations continue using their previously published version. Follow [the private-source update instructions](../ops/cpu-cloud/README.md) to activate and test that final leg.

## One shared capacity policy

`ops/cpu-cloud/archive_policy.py` is consumed by the producer, forced SSH exporter, release storage client, cloud verifier/restore, recovery staging and additional Windows verifier.

| Component | Supported bound |
| --- | --- |
| Retained Cyst ciphertext | 1024 MiB |
| PostgreSQL custom-format dump | 256 MiB |
| Snapshot metadata / configuration / other data | 16 MiB each |
| Expanded data members combined | 1408 MiB |
| Encrypted data archive | 1536 MiB |
| Encrypted runtime archive / expanded runtime | 512 MiB / 2048 MiB |
| Archive member count | Fewer than 50,000 payload files, at most 50,000 including the manifest |
| Transfer / crypto / PostgreSQL restore deadline | 600 seconds each |
| Free restore working disk | At least 8 GiB |

These are independent byte, count and metadata budgets, not an unbounded-storage claim. The 1.5 GiB data envelope accommodates the full Cyst allowance, dump, configuration and archive/encryption overhead. It remains below GitHub's [2 GiB release-asset ceiling](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). Runtime retains its distinct existing 512 MiB limit.

The producer checks component budgets before sealing, refuses oversized encrypted output before atomic publication and removes its partial output on failure. The previous successful backup receipt remains authoritative on failure. Transfers use bounded chunks and deadlines. PostgreSQL restore uses a labelled disposable disk volume, a 512 MiB memory limit and network isolation; all table fingerprints are streamed. The restored-data API path now also uses a disk volume instead of a 512 MiB RAM filesystem. The production backup unit allows 30 minutes and 1536 MiB memory at 50% CPU. Monitoring warns before dump/archive saturation and at 45,000 payload files.

## Full-quota fixture and actual copy

The actual frozen Cyst SDK/service accepted **512 XChaCha20-Poly1305 checkpoints** across **32 synthetic owners**, each owner retaining 32 MiB, for exactly **1,073,741,824 ciphertext bytes**. The next upload was rejected with `cyst_global_capacity`. An existing checkpoint was downloaded and decrypted successfully while storage was full. No second human wallet or production signer was used.

A separate scratch PostgreSQL table added 208 MiB of random binary payload. Its actual custom-format dump was **248,920,914 bytes (237.389 MiB, 92.7% of its bound)**. The real producer copied every referenced ciphertext, checked its original digest and sealed **514 payload files** into an age archive of **1,324,007,290 bytes (1.2331 GiB)**. The server database verifier restored **48 tables / 3879 rows** in **23.005 seconds**, with every original fingerprint/count equal. Fixture generation, verification and sealing took 222.649 seconds.

The exact `backup-20261018T134213Z-5ac8888a` archive then passed the real forced-command SSH protocol using the existing restricted export key and pinned host key. It travelled to the additional Windows recovery device, outside Git, where its full SHA-256, authenticated age decryption and all manifest hashes passed. Transfer plus local verification took **446.288 seconds**. Its ciphertext checksum is `4998bde8e843d769f1be18ef0128801b1ca810104b3abef9897263ce416f6192`. This was an additional acceptance copy; it did not acknowledge itself as a production/cloud snapshot.

The hosted restore code then independently decrypted the same immutable ciphertext on the VPS, reconstructed and hashed **512 Cyst files / 1,073,741,824 bytes**, and restored all **48 tables / 3879 rows**. PostgreSQL restore/fingerprint verification took **21.162 seconds** after archive extraction. This invocation uses a local immutable encrypted-store adapter and the dedicated Docker socket on the VPS. It is explicitly not a hosted-runner or GitHub release-transport result. Temporary plaintext, fixture databases/volumes and restore resources were removed; the encrypted acceptance archive remains private.

The first fixture used 240 MiB of random database payload and stopped at its dump-size assertion, then cleaned up. Its exact dump byte count was not logged, so no precise rejected size is claimed. The accepted rerun reduced random payload to 208 MiB and recorded the dump size above. Both attempt logs are retained.

## Current production recovery and boundaries

The normal latest production backup `backup-20261018T134432Z-bd98efda` restored **47 tables / 44 rows** in **4.669 seconds**. A separate manual owner-authenticated recovery decrypted the current bound data/runtime pair and checked all 758 pins, then ran the exact restored-data API helper against disk-backed PostgreSQL. It recovered 2 real completed jobs, checked owner-scoped API data, rejected unauthenticated reads with 401 and a duplicate controller, removed its synthetic sessions, and retained every original table fingerprint. No production worker, signer or cloud acknowledgement was activated or changed by this check.

**84 Linux operator tests passed**. Coverage includes exact data/runtime size boundaries and one-byte overflow; sparse oversized files rejected by exporter/storage before network access; full Cyst/dump/metadata component bounds; unsafe/duplicate paths; missing/corrupt ready Cyst data; oversized encryption never published and partial output removed; authenticated age tamper rejection; and early capacity alerts. Actual deployed operator bytes and backup unit match the retained source objects.

Final recorded monitor alerts: `["OFFHOST_RUNTIME_NOT_VERIFIED"]`. A newly built runtime requires a fresh scheduled cloud receipt; the additional PC copy never conceals a missing cloud verification. The separately deferred capacity-source publication remains required before claiming cloud support for an archive above 512 MiB.

The read-only Base audit retained the original two completed settlements and journal checksum, signer nonce **2**, operator gas **98,462,564,567,330 wei**, owner **2.422567 USDC** and empty escrow. No funds moved during this acceptance.

## Previously running twelve-hour tests

Both earlier tests finished naturally with zero errors and successful cleanup; neither was stopped for this work.

| Test | Duration | Reads / writes | Real gVisor CPU runs | Result |
| --- | --- | --- | --- | --- |
| Original | 43200.697 seconds | 432,000 / 43,200 | 144 | Completed, zero errors |
| Archive-aware | 43200.654 seconds | 432,000 / 43,200 | 144 | Completed, zero errors; 400 journal rows retained, 272 archived in 34 batches |

See the [hashed evidence manifest](evidence/cpu-backup-capacity-20261018/manifest.json), [retained source record](evidence/cpu-backup-capacity-20261018/source-record.json) and [operator runbook](../ops/cpu-launch/README.md). Encrypted backup bodies, configuration, recovery identities and generated wallet secrets are outside Git.
