# Local 2 GiB Large Cyst boundary acceptance

On 13 October 2026, the exact Git source archive at `86a411b7192f99f27a0b23250fcaf25cc0403e05` ran in a disposable Windows workspace with Node 22.22.2. The archive SHA-256 and four relevant extracted Git blob IDs are recorded in [the machine-readable result](large-cyst-2gib-local-acceptance.json). The standalone driver, [large-cyst-capacity-acceptance.ts](../scripts/large-cyst-capacity-acceptance.ts), was copied into that snapshot and hashed separately. `npm ci` installed the pinned dependencies inside the snapshot. This did not use or change VPS services, wallets, a public chain, or external S3.

The driver created a `2,147,221,504`-byte source, the maximum permitted by the Large Cyst format (`2 GiB - 256 KiB`). It used a sparse zero-filled file with a distinct deterministic marker in every 4 MiB chunk. `saveLargeCystFile` still read and encrypted the full file and wrote all 512 ciphertext parts to the local private store at the exact `2,147,483,648`-byte package quota. The committed package consumed `2,147,297,254` bytes, leaving 186,394 bytes beneath the limit. The store was closed and reopened, the committed manifest remained identical, and `restoreLargeCystFile` produced a separate file of the same length. The driver read **every byte** of both files in 4 MiB chunks, compared them directly, and independently computed matching whole-file SHA-256 digests (`786918d9331a48be90d208e7762f6d1fc9ec0ed1bbfc1aebc662b4e1a12728e0`).

Measured wall time was 63.1 seconds for publication, 0.08 seconds to reopen, 23.2 seconds for restore, 2.7 seconds for byte comparison, and 90.0 seconds total. Driver-reported peak RSS was 165.9 MB; system free memory never fell below 4.33 GB and free disk never fell below 132.53 GB. One concurrent OS process listing showed a Node process with a larger working set, but its PID was not linked to this driver. The RSS figure therefore is an observation, not a proven production memory ceiling. The test ran with ample headroom and did not hit the driver's stop thresholds (8 GiB disk and 512 MiB RAM during work).

To repeat on a machine with at least 12 GiB free disk and 2 GiB free RAM, create a new absolute work directory whose basename begins `telomere-large-cyst-accept-`. Run the driver from an exact source snapshot after `npm ci`:

```powershell
npx tsx scripts\large-cyst-capacity-acceptance.ts smoke C:\private\telomere-large-cyst-accept-smoke
npx tsx scripts\large-cyst-capacity-acceptance.ts boundary C:\private\telomere-large-cyst-accept-boundary
```

The driver refuses an existing work directory and leaves generated files in that one directory for inspection. Remove it only after confirming the resolved absolute path is the intended disposable directory. The `boundary` mode uses about 6.4 GB of logical source, ciphertext and restored data; filesystem allocation can differ because the source is sparse.

This is **one local storage failure domain**. It proves the core file format, quota edge, restart and full byte recovery on this machine. It does not prove authenticated HTTP transfer, two independent S3 regions, outage repair, live overlay capture, public CystRegistry publication, or the target of completing a 2 GiB transfer within 20 seconds. The local publication alone took 63.1 seconds, so the 20-second target remains open and needs a defined measurement boundary and appropriately provisioned storage/network acceptance.
