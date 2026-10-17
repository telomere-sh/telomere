# Isolated staging restore acceptance

The complete PostgreSQL/Anvil restore exercise passed on the VPS on 8 October 2026 at 17:23:36 Moscow time. The verified private backup was created at 17:20:33. The public result is saved in `restore-acceptance.json`; private profile, database archive and chain state remain outside Git.

`scripts/restore-acceptance.ts` restored the PostgreSQL custom archive into an empty, uniquely named Docker database with a fresh password, tmpfs data directory, resource limits and loopback-only random port. It copied the matching saved Anvil state to a new private exercise directory and started a separate Anvil process on another loopback port. The exercise used the already installed PostgreSQL image ID; it did not pull a new image, mount the live database, replace the staging profile or start a Telomere controller.

The restored chain reported chain 31337 and the expected token, six decimals, quote signer and receipt signer. The previously accepted run remained completed with its exact receipt hash and settlement transaction. Verification passed the receipt body hash, EIP-712 signature, billing consistency, on-chain receipt anchor, canonical block hash, matching `RunSettled` event, stored journal hash and consumed journal nonce. The charge stayed 200 base units and the refund stayed 2800; CPU metering stayed at two billable seconds.

No transaction was sent and no NEAR inference was called. The script closed its database connection, stopped only its own Anvil child, and removed only its exact scratch container after checking the exercise label. The live staging installation was not changed by the restore exercise. Private copied chain state and the public acceptance report remain in the private exercise directory for review.

The first attempt stopped safely during PostgreSQL archive restore and removed its scratch resources. PostgreSQL initialization briefly exposes a temporary Unix-socket-only server; the readiness probe now waits for the final TCP listener before restoring. The fresh second attempt passed. This failure and correction did not alter the live staging database or chain.

To repeat against an already verified private staging capture on the VPS:

```sh
/opt/node-v22.23.3-linux-x64/bin/node --import=/opt/telomere-pilot/app/node_modules/tsx/dist/loader.mjs \
  /opt/telomere-pilot/app/scripts/restore-acceptance.ts \
  --directory /opt/telomere-pilot/backups/<verified UTC timestamp>
```

The command is Linux-only and validates the matching private backup before creating scratch resources. It intentionally checks the known accepted pilot run. A later pilot with different acceptance IDs needs a reviewed update to those expected public IDs. This exercise validates private staging recovery; restoring a database cannot roll back Robinhood's public chain or reverse a provider charge.
