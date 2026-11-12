# Primary domain migration

The public origin is **https://my-telomere.com**. Workspace is at
https://my-telomere.com/dashboard/. The existing Base chain (8453), Circle USDC,
escrow, signer, database, encrypted checkpoints and application release remain in
place. This is a deployment configuration change, with no contract deployment or
payment. Historical evidence intentionally keeps its original URLs.

`migrate.py` is a root-only, fixed-target operator tool for the Debian VPS. It does
not accept arbitrary domains or paths. It shares the audited-rollout lock, checks
the existing configuration pins, waits for an idle worker, pauses operational
timers, saves a PostgreSQL dump and private configuration checkpoint, and verifies
the financial journal and on-chain balances before and after the switch.
The profile changes only `PUBLIC_ORIGIN`; its SHA-256 is updated in expected and
activation metadata. All deployment and authority bindings are preserved.

Run `prepare`, then issue a webroot certificate for `my-telomere.com` and
`www.my-telomere.com` using the existing Certbot installation and ACME account.
Run `activate` only after that certificate exists. nginx syntax is checked before
each reload; trusted HTTPS and release identity must pass before enabling the old
domain redirect. Asynchronous nginx worker reloads are bounded by a readiness
retry. A failed activation restores the previous configuration and controller.
Private rollback checkpoints stay under `private/before-domain-*`, never in Git.
The final nginx site and HTTP challenge configuration retain their canonical
backup filenames. The checker resides under `operator/domain-migration`, so both
it and its monitor drop-in are included by the existing runtime backup inventory.

The former apex redirects GET/HEAD requests to the new apex, preserving path and
query. Unsafe methods return 409 so a stale tab cannot redirect a payment request.
The www alias redirects to the new apex. ACME challenges retain their HTTP route;
the existing certificate renewal timer renews the new certificate too. The
historical, credential-protected `review.telomere.sh` deployment helper remains
separate from public Workspace and retains its existing access restrictions.

Browser cookies, connection preferences and local transaction journals belong to
their original browser origin. Users sign in again on the new domain. The move
does not copy or clear browser journals, sign wallet messages, or replay payments.
Any previously pending wallet transaction must be checked in wallet history or
Base before manually repeating its intent. Server-side account data is unchanged;
checkpoint recovery continues to use the already exported recovery key file.

`domain_health.py` runs as `ExecStartPost` on the existing operational monitor. It
checks the primary certificate, readiness, chain, token and escrow. Failures merge
into the existing monitor result for the configured Telegram pager, retaining
financial and backup alerts. A healthy check does not clear those alerts.

Verification:

```powershell
python -B -m unittest discover -s ops/domain-migration -p test_migration.py
python -B ops/domain-migration/verify.py
```

The external verifier checks pages, current release asset hashes, HTTPS/redirects,
old-origin write rejection, and the new sign-in challenge domain. It requests one
short-lived nonce for a synthetic public address; it signs nothing and sends no
chain transaction. For manual rollback, stop the controller and operational
timers, restore the indexed files listed in the private checkpoint's
`files.json`, remove the primary-domain monitor drop-in, reload systemd, start the
controller through its activation preflight, then validate/reload nginx and
resume the timers. Do not restore the database dump over newer user activity.
