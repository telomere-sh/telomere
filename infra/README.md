# VPS pilot deployment

## Installed private staging

The isolated staging controller and EVM are installed as `telomere-staging.service` and `telomere-staging-chain.service`. The dedicated container is `telomere-staging-postgres`, with its own `telomere-staging-pg` volume. The existing Enclave services, ports and databases remain separate. API, EVM and PostgreSQL listen only on loopback ports 13280, 18547 and 15434 respectively. They use generated test-only accounts and a mock token on chain 31337; this is not Base and not a public paid service.

An active SSH preview forwards the API to `http://127.0.0.1:3281` and the EVM to local port 18547. To recreate it with the existing SSH identity:

```powershell
ssh -N -i C:/Users/Administrator/.ssh/enclave_pilot_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:3281:127.0.0.1:13280 -L 127.0.0.1:18547:127.0.0.1:18547 root@2.27.12.39
```

Do not read or paste that private key. The owner demo account can be selected in the private staging UI; no personal wallet is needed. Its server-side signing is limited to the two local pilot contracts. Cookie sessions on the two previews use the same hostname; signing in again may be necessary when switching ports.

`staging-bootstrap.sh` prepares only dedicated staging resources. Run `npm ci` and `npm run build` in the separate application directory first. The profile and chain state are persistent: never regenerate a profile or erase the database/chain to resolve an uncertain payment. `scripts/staging-smoke.ts --recover` is a read-only comparison of the previously accepted run, receipt and settlement after restart. The controller, chain and dedicated PostgreSQL were restarted and this comparison passed.

The NEAR verifier has a separate venv, copied hash-checked native NVIDIA artifacts including the loader soname, and an exact reviewed policy. Its separate private profile is not enabled in the controller. Live GET verification rejected a changed measured workload; no inference POST was made. Neither old policy dates nor new measurements are automatically accepted.

## Base/USDC rollout

The existing VPS has enough spare capacity for an initial single concurrent CPU cell. A low current load is not a throughput guarantee. Keep the controller and database in a dedicated `/opt/telomere-pilot` directory, separate from Enclave. Start with a loopback API; configure an HTTPS reverse proxy only after network/payment/provider acceptance.

The trusted controller needs Docker CLI access. That is host-level privilege: do not place the Docker socket inside workloads, expose it to users, or mount Enclave's application directories. Production configuration requires an immutable CPU image digest and an explicit owner allowlist.

Prepare a dedicated PostgreSQL database/user, isolated data directory, and service environment file with mode 0600. Bind the API to loopback. Do not reuse the existing Enclave database or its payment signer. The repository prepares separate unsigned Base Sepolia (84532) and Base mainnet (8453) deployment candidates only after a network, canonical Circle USDC address, reviewed proxy/implementation hashes and public roles are supplied. No Base wallet or funded public deployment is configured. Production should use an available Node 22 runtime; the staging service pins the installed VPS runtime path while the generic service unit uses `/usr/bin/node`.

Use the sample `telomere.service` only after filling the operator-controlled environment, deployed escrow address and dedicated service user. Limit controller CPU/memory in addition to per-cell limits. Start with one worker/controller; a database advisory lock rejects another active instance.

`scripts/cpu-smoke.ts` builds to a standalone Node bundle and checks allowlisted execution and actual container configuration. The VPS smoke verified SHA-256, prime enumeration, hash-chain work and pre-dispatch cancellation with no provider calls or surviving cells. A complete Base Sepolia acceptance still needs funded test accounts, reviewed Circle USDC archive pins and a currently accepted NEAR workload policy. The verified transport is implemented; live provider acceptance remains a separate check.
