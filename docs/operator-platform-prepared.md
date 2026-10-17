# Read-only paid prepared-run audit

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`npm run operator:platform-prepared --` compares every `platform_runs.status = 'prepared'` row with the reviewed PlatformRunEscrow state at **one explicit historical block**. This is a manual pre-release check. It reads PostgreSQL and RPC only; it does not sign, broadcast, admit, refund, reconcile or update any row.

Supply public deployment pins and the reference block/hash from an **independently reviewed** source. Do not simply copy the values from the running profile:

```sh
npm run operator:platform-prepared -- \
  --env-file=/opt/telomere/profile.env \
  --expected-chain-id=84532 \
  --expected-escrow=<reviewed-escrow-address> \
  --expected-escrow-code-hash=<reviewed-runtime-code-hash> \
  --expected-quote-signer=<reviewed-quote-signer-address> \
  --expected-token=<reviewed-token-address> \
  --expected-receipt-root=<reviewed-receipt-root-address> \
  --expected-host-registry=<reviewed-host-registry-address> \
  --expected-fee-router=<reviewed-fee-router-address> \
  --reference-block=<reviewed-final-block-number> \
  --expected-reference-hash=<reviewed-block-hash>
```

The paid-platform profile must point to PostgreSQL and must match all supplied public pins. The command does not load the platform signer key. Its first database read uses a read-only, repeatable-read snapshot and requires the paid `platform_runs` table. It scans at most 1,024 prepared rows; a larger inventory fails and needs an archival review. A second read after the RPC scan must match the first, or `database_changed` makes the result critical. A concurrent change that reverses to the exact previous row content cannot be excluded by this check; quiesce paid admissions for a release audit.

The RPC must support `eth_getCode` and `eth_call` **at the supplied historical block**. Missing archive state, a missing block, pin mismatch or changed block hash fails closed. The audit validates each stored quote, workload hash, quote-signature domain and signer, row identity, paid-session duration, original spending limit, quote deadline and persisted ceiling. For a NEAR-backed quote it hashes the exact original model/prompt/policy request and requires a nonzero signed inference price; CPU-only quotes retain their original task hash and zero inference price. It also compares the row owner and agent with the on-chain Leash at that block; a changed Leash binding is `leash_binding_mismatch`. An on-chain run with a different payer, host, workload, class, CPU price, inference price, duration or ceiling is `quote_ceiling_mismatch`. For an unopened run it compares the persisted ceiling with the escrow's `quoteCeiling` at the anchor. That comparison uses the **current-at-anchor** fee policy, which can differ from the quote-time policy if fees changed; investigate before treating that count as corruption.

Only aggregate counts are printed. `unopened` means no on-chain run existed at the reviewed block; a legitimately unused or expired quote is informational. `open_unadmitted`, `refunded_unrecorded` and `settled_unrecorded` mean the database still says prepared while the escrow at that block is open, refunded or settled respectively. `invalid_row`, `quote_ceiling_mismatch`, `leash_binding_mismatch`, `unexpected_status`, `rpc_unavailable`, `pin_mismatch`, `anchor_reorged` and `database_changed` are also critical. A zero exit means the bounded, stable snapshot had only valid unopened quotes at that block. It does not prove those quotes could still be opened, that Vault clones belong to the reviewed Selection registry, or that later blocks are unchanged. Run the check again after the reviewed chain finality window and before admitting work.

Local tests use a disposable Anvil deployment to observe real unopened, opened and refunded escrow states at separate historical blocks, including a signed inference-only quote and its exact on-chain inference price. A controlled fixture covers settled and malformed states. No public-network transaction is made by the tests. This check has not yet been run against a funded Base Chain deployment.
