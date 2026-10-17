import { build } from 'esbuild';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLocalChain, deployLocalContracts } from './local-chain.js';
import { loadConfig } from '../src/config.js';
import { startPilot } from '../src/main.js';
import pino from 'pino';

const logger = pino();
await mkdir('dist/public', { recursive: true }); await mkdir('.local', { recursive: true });
await build({ entryPoints: ['public/app.ts'], bundle: true, format: 'esm', outfile: 'dist/public/app.js' });
await promisify(execFile)(process.execPath, ['scripts/copy-public.mjs'], { timeout: 30000 });
const local = await startLocalChain({ port: 8547 });
try {
  const deployed = await deployLocalContracts(local);
  const dataDir = await mkdtemp('.local/demo-');
  const config = loadConfig({ ...process.env, MODE: 'demo', CPU_MODE: 'demo', CHAIN_ID: '31337', RPC_URL: local.rpcUrl,
    TOKEN_ADDRESS: deployed.tokenAddress, ESCROW_ADDRESS: deployed.escrowAddress, SIGNER_PRIVATE_KEY: deployed.keys.signer,
    DEMO_PRIVATE_KEY: deployed.keys.owner, DATA_DIR: dataDir, CYSTS_ENABLED: 'true', CYSTS_DIR: dataDir + '-cysts',
    PORT: '3280', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3280' });
  const pilot = await startPilot(config);
  logger.info({ url: config.PUBLIC_ORIGIN, mode: 'demo', chainId: 31337, ephemeral: true }, 'demo_ready');
  let stopping = false;
  const close = () => {
    if (stopping) return; stopping = true;
    pilot.close().finally(() => local.close()).then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch (error) { await local.close(); throw error; }
