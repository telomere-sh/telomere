# One-shot CPU commands

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

The full financial platform accepts an optional `exec` task through the existing EOA and Vault quote/admission APIs, Node/Python clients and financial MCP tools. Each reservation executes one command in one reviewed immutable CPU image. This supplies a command primitive for future Cells; persistent sessions, `POST /cells`, repeated `cell.exec`, streamed output and filesystem snapshots remain separate work.

## Admission and payment

Operators explicitly add `execEnabled: true` to each reviewed host in the private platform configuration. Omission or `false` allows only the existing four CPU algorithms. Public configuration exposes `execEnabled: true` only for an opted-in host, with its existing image digest, region and price. No host is enabled automatically.

Host capability and image changes take effect when the controller restarts with the updated reviewed configuration.

```ts
const config = await client.config();
const host = config.capacity.find(candidate => candidate.execEnabled === true);
if (!host) throw new Error('No reviewed command capacity');
const seconds = 30;
const base = BigInt(seconds) * BigInt(host.pricePerSecond);
const prepared = await client.quote({
  leashId,
  task: {
    kind: 'exec', imageDigest: host.imageDigest,
    argv: ['/usr/local/bin/node', '-e',
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s));'],
    stdin: 'Telomere проверка 🧬\n',
  },
  maxSeconds: seconds,
  deadline: Math.floor(Date.now() / 1000) + 90,
  maxSpend: (base + (base * 900n + 9999n) / 10000n).toString(),
  regions: [host.region],
}, 'original-command-quote');
const unsignedPlan = await client.openPlan(prepared);
```

`client` is an authenticated checked EOA or Vault platform client with reviewed deployment pins. The returned plan is externally reviewed, signed and confirmed before its original hash is submitted to `admit`. Quotes and SDK/MCP calls never sign or broadcast wallet transactions. A Vault quote/admission requires the agent wallet; its human owner retains stop access. Financial amounts are integer token base units and include the rounded 9% platform fee.

The signed workload hash binds the entire task, including argv, optional stdin and requested image digest. Image/region hashes and allowlist proofs retain their existing onchain scope. Both clients re-read configuration before returning financial plans and reject an unavailable or changed command capability. The request body retains its actual streamed 32 KiB bound.

## Execution and recovery

Immediately before claiming queued work, the controller checks the durable input hash and signed workload hash, then the original host's current opt-in and exact image. Revoking opt-in or changing the host image leaves an otherwise runnable funded intent queued without a HostKit lease. Explicit restoration of the original reviewed configuration can resume that same intent. Stop/kill/expiry/freeze can still finalize zero-work reservations, and canonical timeout refunds remain accessible.

The complete signed host lease is persisted before admission. The observer verifies its owner, host, image, maximum duration, argv and stdin. Signed ticks and control acknowledgments are persisted before ACK. Original-lease recovery works even with new command admission disabled and never executes a replacement command. Results use the existing hourly financial leaf, canonical settlement, fee/refund conservation, automatic Vault burn synchronization and reorg/transaction-journal recovery.

## Bounds and sandbox

- One command per reservation, 1..120 seconds, one active platform executor and the existing bounded recovery inventory.
- 1..32 nonempty argv strings; at most 4096 UTF-16 code units each and 8192 aggregate UTF-8 bytes. Common shell entrypoint names are rejected; argv is passed directly with `shell: false`.
- Optional stdin: at most 8192 UTF-16 code units and 8192 UTF-8 bytes. argv/stdin require valid Unicode and reject NUL before persistence. Omitted stdin and JavaScript `undefined` are equivalent.
- Results contain stdout text only. The trusted init bounds combined raw stdout/stderr to 16 KiB. stdout bytes are accumulated within that bound and decoded once, preserving multibyte characters across writes and normalizing an initial UTF-8 BOM away before persistence and hashing. NUL or invalid/incomplete UTF-8 produces a durable failed result with a fixed safe diagnostic after cleanup; binary result transport is not supported.
- The sandbox retains gVisor/Kata admission, one CPU, 256 MiB RAM, 64 PIDs, no network, a read-only root, non-root user and restricted temporary storage. Requests cannot supply environment variables, mounts, devices, ports or Docker flags.

Images remain operator-reviewed and must contain `/usr/local/bin/node` for the trusted init. Selecting a digest does not install a runtime or admit an arbitrary OCI image. Local subprocess tests require the explicit fixture-only runtime; production clients reject it.

## Evidence

`tests/platform-exec-runtime.test.ts` exercises actual authenticated HTTP, Anvil contracts, real child commands and disk reopen for EOA/Vault payment, fee/burn/refund accounting, capability/image revocation, persisted-input tampering, zero-work stop and original-lease recovery. `tests/platform-exec-client.test.ts` checks actual viem signatures and unsigned ABI plans over HTTP and official paired MCP transports, including fresh capability checks and response substitution. `tests/host-kit-command.test.ts` covers actual child execution, durable evidence ordering, cancellation, deadlines, bounded output and text decoding failures. Python independently verifies the same viem command vectors and real HTTP transport.

The Linux full financial driver supports `node --import tsx scripts/platform-runtime-acceptance.ts --exec`. It uses the previously reviewed running HostKit/image, fresh disposable local contracts/accounts and a private controller/database, verifies the exact command/Unicode stdin and independent two-million-step hash result, settles its actual receipt and reopens without redispatch. See `platform-exec-validation.json` and `platform-exec-acceptance.json` for dated results. This establishes the bounded EOA gVisor path; delegated Vault command execution is separately covered by local Anvil/child acceptance. No public Base transaction or paid provider request is needed.

`node --import tsx scripts/host-text-acceptance.ts` separately exercises the updated Docker runtime with a fresh private HostKit identity, the actual reviewed socket `/var/run/telomere-host-docker/docker.sock` and immutable image. Four fixed commands verify split UTF-8/BOM normalization, durable NUL/incomplete-text rejection, subsequent valid admission, paired terminal evidence, cleanup and journal reopen. Its report is `host-text-acceptance.json`. It leaves the existing HostKit daemon and services running unchanged. The first preflight used an illustrative documentation socket path and failed before creating a journal; pinning the observed dedicated socket resolved that setup issue. Live acceptance then exposed the short-command terminal-tick race, which is covered by its own deterministic HTTP regression and the final passing gVisor run.
