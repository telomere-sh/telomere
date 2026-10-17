# Frozen local owner-review overlay

Source: `8f5f41e9e0fd94c95c37992ff910f098bf7908b4`.
Dependency release: `/opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9`.
Destination proposal: `/opt/telomere-mainnet-pilot/operator-wallet`.

This archive contains public frozen source/plan data and operator drafts. It
contains no dependency binaries, signer key, private environment, database,
original website, modified controller, or enabled systemd unit. Preparing or
extracting it starts nothing and cannot authorize a wallet transaction.

## Runtime choice

No `dist` build is required. The app's locked `tsx@4.21.0` exports its root as
`./dist/loader.mjs`, which is accepted by Node 22 `--import`. The review helper
loads the frozen TypeScript sources through that exact absolute loader path.
The helper needs `tsx`, `solc` and `esbuild`, so an app installation omitting dev
dependencies is insufficient. Reuse the already Linux-built release's complete
`node_modules`; do not upload Windows dependencies or run npm against a shared
symlink. Source compilation and the browser bundle stay in memory. No app
entry point, worker, migration or ordinary contracts build is invoked.

The recursive relative-import closure is recorded in `PACKAGE-MANIFEST.json`.
This includes source needed by server and browser entries, the original legacy
contract, original package files, and byte-identical frozen deployment plan.
External dependencies are resolved from the reviewed release only.

## Manual installation for later operator review

These steps are instructions, not actions performed by the package. As root,
first review the archive SHA-256 and manifest reported by the preparing agent,
verify the destination does not already exist, and check archive members are
only directories and the manifest's regular files (no links or path escapes).
Extract to a newly created destination, never overlay an existing directory.
Keep every directory root-owned, group `telomere-mainnet`, mode `0750`; files
root-owned, same group, mode `0640`. The wrapper may remain `0640` because the
unit explicitly invokes `/bin/sh`.

Create exactly this dependency symlink after confirming its destination is the
expected root-controlled release and the overlay has no existing node_modules:

```sh
ln -s /opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9/node_modules /opt/telomere-mainnet-pilot/operator-wallet/node_modules
```

`runtime/preflight.mjs` checks root-controlled inputs and versions, the exact
Node path/version, dependency link, lockfile equality and every package-member
hash. No private directory, environment or wallet is read.

Review `telomere-owner-review.service.draft` before separately installing it as
`/etc/systemd/system/telomere-owner-review.service`. It uses a separate systemd
DynamicUser with group access only for reading the frozen release. Private
configuration, controller data, staging tree and Docker endpoints are explicitly
inaccessible. It has no `[Install]` section, no automatic restart and no
controller dependency. Do not enable it for boot. After separately approved
installation, `systemctl start telomere-owner-review.service` starts the review
HTTP server only; `systemctl stop telomere-owner-review.service` stops it.
The wrapper first runs its static preflight, then executes this precise command
inside a cleared environment:

```sh
cd /opt/telomere-mainnet-pilot/operator-wallet
/usr/bin/env -i PATH=/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin HOME=/nonexistent TMPDIR=/tmp TSX_DISABLE_CACHE=1 RPC_URL=https://mainnet.base.org \
  /opt/node-v22.23.3-linux-x64/bin/node \
  --import /opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9/node_modules/tsx/dist/loader.mjs \
  scripts/owner-wallet-deployment.ts \
  --plan /opt/telomere-mainnet-pilot/operator-wallet/frozen/deployment-plan-base-mainnet.json \
  --plan-sha256 2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8 \
  --review-digest 0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f \
  --owner 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d \
  --signer 0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38 \
  --treasury 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d \
  --max-gas 4000000 --max-fee-per-gas-wei 20000000 \
  --max-total-gas-budget-wei 100000000000000 --port 3283
```

Starting the HTTP helper makes no wallet call and sends no financial
transaction. Before opening an owner wallet, operator-only checks can confirm
`127.0.0.1:3283` is the sole listening address and GET `/` and GET `/api/plan`
return expected immutable public data. No wallet button needs to be clicked.
The controller on `3282` must remain inactive until separately verified
deployment and activation.

For a later desktop review, an explicitly authorized SSH forward can map
`127.0.0.1:3283` on the computer to `127.0.0.1:3283` on the VPS. Do not expose
the server's port publicly. A phone cannot reach the computer's loopback URL;
a mobile-wallet acceptance route needs a separately configured HTTPS origin
and access controls. This package fixes loopback only and changes no proxy.

## Owner signature boundary

The owner, dedicated quote/receipt signer and proposed treasury are all visible
in the frozen plan. Treasury equal to the owner remains a proposal for explicit
review. The total `0.0001 ETH` limit is a local all-fee snapshot review guard,
not an onchain hard cap on future Base L1 fees. Read the included
`docs/owner-wallet-deployment-review.md` before any owner interaction.

Deploy must precede a separately reviewed outgoing owner transfer to fund the
service signer, because that transfer would consume the deployment nonce.
Connecting requests no signature; only the separate trusted Deploy click can
call the wallet once. No call has been made during packaging. An ambiguous
attempt is retained and must be reconciled manually before any retry.
