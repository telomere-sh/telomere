Base RPC transport used by the mainnet CPU acceptance on 2026-10-17

Build the separate operator executable with the repository's locked esbuild:
  npx esbuild scripts/base-rpc-router.ts --bundle --platform=node --format=esm --external:pino --outfile=router.mjs
Verify with:
  npx vitest run tests/base-rpc-router.test.ts
  npm run typecheck

The VPS executable lives at /opt/telomere-mainnet-pilot/operator/base-rpc-router/router.mjs.
That folder is root-owned and has a root-controlled node_modules symlink to the frozen
application release's dependencies, providing pino. router.sha256 contains the reviewed
SHA-256 followed by the absolute executable filename. The service verifies it before start.
Install the supplied service as telomere-mainnet-rpc.service and the supplied rpc-router.conf
as the controller's systemd drop-in. The router listens only on 127.0.0.1:18545.

Changing RPC_URL to http://127.0.0.1:18545 also requires rebinding profileSha256 in BOTH
the protected expected.json and activation.json. Keep root-only backups of all three
original files. Re-run the unchanged --verify-activation guard with the exact profile
environment before restarting the controller. Preserve its release, source, runtime,
asset, deployment and signer pins. Restore all three originals on failure; never change
the guard to make the new profile pass. This is configuration recovery, not a new contract.

Read requests may fail over. Signed broadcasts use exactly one upstream per router
request; the controller alone owns durable hash reconciliation and rebroadcast policy.
No cache, canonical-block rewrite, signing key, public listener or authentication bypass
is introduced. Shared public upstreams offer no availability guarantee.
