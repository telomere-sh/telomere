#!/bin/sh
set -eu
cd /opt/telomere-mainnet-pilot/operator-wallet
NODE=/opt/node-v22.23.3-linux-x64/bin/node
LOADER=/opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9/node_modules/tsx/dist/loader.mjs
PATH_VALUE=/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin
/usr/bin/env -i PATH="$PATH_VALUE" HOME=/nonexistent TMPDIR=/tmp TSX_DISABLE_CACHE=1 "$NODE" runtime/preflight.mjs
exec /usr/bin/env -i PATH="$PATH_VALUE" HOME=/nonexistent TMPDIR=/tmp TSX_DISABLE_CACHE=1 RPC_URL=https://mainnet.base.org \
  "$NODE" --import "$LOADER" scripts/owner-wallet-deployment.ts \
  --plan /opt/telomere-mainnet-pilot/operator-wallet/frozen/deployment-plan-base-mainnet.json \
  --plan-sha256 2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8 \
  --review-digest 0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f \
  --owner 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d \
  --signer 0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38 \
  --treasury 0xa67c6a174409b9b44e67d24cdd386a31d44edb1d \
  --max-gas 4000000 --max-fee-per-gas-wei 20000000 \
  --max-total-gas-budget-wei 100000000000000 --port 3283
