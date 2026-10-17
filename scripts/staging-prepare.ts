import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { deployLocalContracts } from './local-chain.js';
import { loadConfig } from '../src/config.js';

/** Fresh test-only accounts on a separate private local chain. Never use real funds. */
const profile = resolve(process.env.STAGING_PROFILE ?? '.local/staging.env');
try { await access(profile); throw new Error('Staging profile already exists; preserve its chain state and identities'); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
const rpcUrl = process.env.STAGING_RPC_URL ?? 'http://127.0.0.1:18547';
const deployed = await deployLocalContracts({ rpcUrl, publicClient: createPublicClient({ chain: localChain, transport: http(rpcUrl, { retryCount: 0 }) }) });
const values = { MODE: 'demo', PORT: '13280', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3281',
  RPC_URL: rpcUrl, CHAIN_ID: '31337', ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress,
  SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
  CPU_MODE: 'docker', CPU_IMAGE: process.env.CPU_IMAGE ?? '',
  DATABASE_URL: process.env.DATABASE_URL ?? '', DATA_DIR: '/opt/telomere-pilot/data', LOG_LEVEL: 'info' };
if (!/@sha256:[a-f0-9]{64}$/.test(values.CPU_IMAGE) || !values.DATABASE_URL) throw new Error('Staging requires pinned CPU image and dedicated PostgreSQL');
loadConfig(values);
await mkdir(dirname(profile), { recursive: true, mode: 0o700 });
await writeFile(profile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ mode: 'private_staging', chainId: 31337, escrow: deployed.escrowAddress, token: deployed.tokenAddress,
  owner: deployed.accounts.owner.address, cpuMode: 'docker', profileWritten: true, realFunds: false }));
