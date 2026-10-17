# Independent Platform v2 receipt CLI

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`npm run operator:platform-v2` verifies a caller-provided redacted v2 evidence core directly against a reviewed archive RPC. It needs no Telomere API session, database, wallet, or operator key. `createPlatformReadOnlyBridge` constructs only a public RPC client. Its deployment, token implementation/facet, and canonical-receipt checks are shared with `PlatformBridge`, so the standalone reader follows the same pin policy as the paid controller.

Supply a dedicated `PlatformPins` JSON file from an independently reviewed deployment record, a core JSON file, and the original opening and settlement transaction hashes. The pins file is not the complete runtime profile and contains no private key. Pin and core files must be single-link regular files bounded to 64 KiB and 256 KiB respectively. The CLI checks the actual bytes and file stability while reading.

```powershell
$env:TELOMERE_PLATFORM_RPC_URL = 'https://your-reviewed-private-archive-rpc.example'
npm run operator:platform-v2 -- `
  --pins ./reviewed-public-pins.json `
  --core ./redacted-v2-core.json `
  --open-transaction 0xYOUR_ORIGINAL_OPEN_TRANSACTION_HASH `
  --settlement-transaction 0xYOUR_SETTLEMENT_TRANSACTION_HASH
```

Replace the filenames and hashes with actual reviewed inputs. The RPC URL can also be supplied as `--rpc-url`; using the environment avoids retaining a private RPC path in command history. HTTPS is required except for literal loopback HTTP. Local chain 31337 requires loopback. Confirmation depth defaults to 12; `--confirmations` accepts 1–128 and should only be reduced for a reviewed local acceptance fixture. The proof has a 60-second wall deadline and 10-second individual RPC deadlines; the wall deadline aborts outstanding fetches.

Exit code zero accompanies one JSON verdict with `readOnly: true`, `status: "verified"`, and the same financial and committed-meter checks as the [HTTP v2 API](platform-v2-public-api.md). Opening block number and confirmation count are decimal strings. The original v1 receipt cannot be relabeled v2. Wrong deployment pins, modified evidence, missing historical state, or a reverted settlement produce exit code one and a sanitized `platform_v2_unverified` JSON result. Input contents, RPC URLs, and internal exception messages are not printed.

The verdict retains `independentlyPublished: false`, `historicalDelegationIssuanceTimeProven: false`, `physicalTickStreamCompletenessProven: false`, `executionStatusProven: false`, and `outputVerified: false`. This CLI verifies a provided core and its canonical chain commitment. It does not issue a v2 receipt, retrieve independent copies, prove execution correctness, or publish evidence.

Local acceptance runs the actual CLI as a separate Node process with a clean environment and no signing key against a real Anvil/HostKit v2 settlement. It checks the positive verdict, unchanged signer nonce, wrong-token-pin rejection, and rejection after a chain rollback. The independent transport test also aborts a real stalled loopback RPC request. Neither test supplies a funded Base wallet or independently published evidence.
