import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPublicClient, http } from 'viem';
import { z } from 'zod';
import { baseMainnet, baseSepolia, baseUsdcForChainId } from '../src/chain/chains.js';
import { assertCircleUsdcArchiveHistory } from '../src/payments/circle-usdc-archive.js';
import { vaultIncomeRpcFetch } from '../src/payments/vault-income-rpc.js';
import { baseChainIdForNetwork, hashSchema, implementationPinsSchema } from './base-usdc-deployment.js';

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const profileSchema = z.object({ chainId: z.union([z.literal(8453), z.literal(84532)]),
  expectedTokenCodeHash: hashSchema, implementationPins: implementationPinsSchema,
  archiveAnchor: z.object({ number: decimal, hash: hashSchema, timestamp: decimal }).strict(),
}).strict();

async function main() {
  const { values } = parseArgs({ options: { network: { type: 'string' }, 'public-profile': { type: 'string' } },
    strict: true, allowPositionals: false });
  const chainId = baseChainIdForNetwork(values.network);
  const path = z.string().min(1).max(4096).parse(values['public-profile']);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
    throw new Error('A bounded regular reviewed profile is required');
  }
  const profile = profileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (profile.chainId !== chainId) throw new Error('Reviewed anchor belongs to another network');
  const rawUrl = process.env.BASE_ARCHIVE_RPC_URL;
  const url = new URL(rawUrl ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || ['mainnet.base.org', 'sepolia.base.org'].includes(url.hostname)) {
    throw new Error('Set a private HTTPS Base archive RPC URL');
  }
  const client = createPublicClient({ chain: chainId === 8453 ? baseMainnet : baseSepolia, cacheTime: 0,
    transport: http(url.href, { retryCount: 0, timeout: 10_000, fetchFn: vaultIncomeRpcFetch }) });
  const asset = baseUsdcForChainId(chainId)!;
  await assertCircleUsdcArchiveHistory(client, { chainId, asset,
    tokenCodeHash: profile.expectedTokenCodeHash,
    assetImplementation: profile.implementationPins, archiveAnchor: profile.archiveAnchor });
  process.stdout.write(JSON.stringify({ ready: true, chainId, asset,
    proxyCodeHash: profile.expectedTokenCodeHash, implementation: profile.implementationPins,
    archiveAnchor: profile.archiveAnchor, historicalState: true,
    checkedAt: new Date().toISOString(), publicTransactionsSent: 0 }) + '\n');
}

main().catch(() => {
  // Errors from RPC clients may contain private provider URLs. Suppress them.
  process.stderr.write(JSON.stringify({ ready: false, code: 'reviewed_usdc_archive_unavailable' }) + '\n');
  process.exitCode = 1;
});
