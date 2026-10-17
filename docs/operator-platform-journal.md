# Read-only platform transaction journal audit

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`npm run operator:platform-journal --` audits the dedicated paid-platform signer's persisted raw transactions against canonical chain receipts. It reads PostgreSQL and RPC only; it does not broadcast, sign, reconcile or change journal rows. Supply the independently reviewed public pins, rather than copying them from the running profile:

```sh
npm run operator:platform-journal -- \
  --env-file=/opt/telomere/profile.env \
  --expected-chain-id=84532 \
  --expected-signer=<reviewed-platform-signer-address> \
  --expected-escrow=<reviewed-platform-escrow-address> \
  --expected-receipt-root=<reviewed-receipt-root-address> \
  --initial-signer-nonce=<reviewed-nonce-before-first-platform-journal-entry>
```

The profile must configure the paid platform, PostgreSQL and the same chain. The command reads the platform profile's public pins and refuses a mismatch. It never reads the platform signer key file. The initial nonce must come from a separately reviewed signer/deployment record; choosing the current chain nonce would hide missing historical journal entries. A repeatable-read, read-only database snapshot must contain the journal table and at most 4,096 rows; exceeding that cap requires archival review before the audit can pass. Every nonce from the initial value through the reference block's confirmed signer nonce must have a valid journal row. The command rejects a signer nonce change during the scan, receipts mined only after the reference block, and a changed reference-block hash at completion. Each row's original signed bytes must match its persisted hash, destination, calldata, nonce, chain and reviewed signer, with zero native value. The current key classes constrain settlement to the pinned escrow's `settleRun`, root publication to the pinned receipt root's `postRoot`, and Vault final sync to the key-named address's `syncRun`; their first calldata argument must match the keyed run or hour. The matching transaction receipt must be successful and its block hash must still be canonical. A missing receipt fails the audit; if the reference block's nonce already passed the journal nonce, the report classifies it separately as `nonce_consumed`. Reverted and reorged receipts also fail. RPC or database errors fail closed.

Run the full audit only in a reviewed quiescent release window: stop new paid admissions and transaction submissions, wait for already signed transactions to receive canonical receipts, and investigate any unresolved transaction before treating the audit as passed. The command verifies that the dedicated signer nonce remains stable during its scan. The database snapshot and chain reference block are not atomic with each other. During live paid traffic, a normal newly signed or mined transaction can appear as `receipt_missing`, `nonce_gap` or `nonce_changed`. The command intentionally fails closed in those cases; its output must not be wired into a minute-by-minute production pager. A bounded incremental monitor with pending-age and finality semantics remains an open launch task.

Only aggregate issue counts are printed. No raw transaction, journal key, private endpoint or provider error is included. Exit code zero means all rows in that snapshot and the reviewed nonce interval passed at the anchored block. A nonzero exit requires an operator to preserve the original journal and investigate canonical history before sending any new transaction with that dedicated signer. This check does not independently prove that a Vault address belongs to the Selection registry or that every settlement matches the application ledger; those canonical operation checks remain in the existing runtime paths. This is a deliberate pre-release/manual check, not continuous monitoring or evidence that the public Base deployment has passed. A historical receipt can change after the command finishes; rerun after the reviewed chain finality window.

The focused test uses real locally signed EIP-1559 bytes and covers canonical success, tampered intent, unapproved destination, keyed selector/argument, missing journal nonce, absent receipt, consumed nonce, revert, reorg and RPC failure. It does not establish live chain acceptance. The separate watchdog currently observes paid runs but does not invoke this potentially long 4,096-row RPC scan every minute.
