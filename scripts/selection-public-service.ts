import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createPublicClient, http } from 'viem';
import pino from 'pino';
import { z } from 'zod';
import { chainForId } from '../src/chain/chains.js';
import { openStore } from '../src/store.js';
import { createSelectionReader } from '../src/selection/rpc.js';
import { createSelectionPublicService, selectionPublicProfileSchema } from '../src/selection/public-service.js';
import { selectionPublicJson, selectionPublicOrigin } from '../src/selection/public-http.js';

const configuration = z.object({ SELECTION_PUBLIC_PROFILE: z.string().min(1), SELECTION_PUBLIC_DATA_DIR: z.string().min(1),
  SELECTION_PUBLIC_RPC_URL: z.string().url().refine(v => { const u = new URL(v); return !u.username && !u.password && !u.hash
    && (u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)); }),
  SELECTION_PUBLIC_PORT: z.coerce.number().int().min(1024).max(65535), SELECTION_PUBLIC_FEATURE_ORIGIN: selectionPublicOrigin });

export async function runSelectionPublicService(environment: NodeJS.ProcessEnv = process.env) {
  const config = configuration.parse(environment), profilePath = resolve(config.SELECTION_PUBLIC_PROFILE);
  if (!(await stat(profilePath)).isFile() || (await stat(profilePath)).size > 8192) throw new Error('Invalid reviewed public profile');
  const profile = selectionPublicProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')) as unknown);
  const client = createPublicClient({ chain: chainForId(profile.chainId), transport: http(config.SELECTION_PUBLIC_RPC_URL, { timeout: 10000, retryCount: 0 }) });
  const reader = createSelectionReader(config.SELECTION_PUBLIC_RPC_URL);
  const [receipt, block, head, codeHash] = await Promise.all([client.getTransactionReceipt({ hash: profile.creationTransaction as `0x${string}` }),
    reader.block(BigInt(profile.startBlock)), reader.head(), reader.codeHash(profile.registryAddress)]);
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== profile.registryAddress || receipt.blockNumber !== BigInt(profile.startBlock)
    || receipt.blockHash.toLowerCase() !== profile.creationBlockHash || block.hash !== profile.creationBlockHash
    || head - BigInt(profile.startBlock) + 1n < BigInt(profile.confirmations) || codeHash !== profile.registryCodeHash) throw new Error('Reviewed Selection creation changed');
  const store = await openStore({ DATA_DIR: config.SELECTION_PUBLIC_DATA_DIR, DATABASE_URL: undefined });
  const service = createSelectionPublicService({ db: store.db, profile: { reviewed: true, chainId: profile.chainId, registryAddress: profile.registryAddress,
    registryCodeHash: profile.registryCodeHash, startBlock: BigInt(profile.startBlock), confirmations: profile.confirmations }, reader,
    features: async () => z.object({ enabled: z.array(z.string()).max(32) }).parse(await selectionPublicJson(config.SELECTION_PUBLIC_FEATURE_ORIGIN, '/api/public/features')).enabled });
  const log = pino({ name: 'selection-public', level: 'info' });
  try {
    await service.maintain();
    const server = serve({ fetch: service.app.fetch, hostname: '127.0.0.1', port: config.SELECTION_PUBLIC_PORT });
    const timer = setInterval(() => { void service.maintain().catch(() => log.warn('selection_sync_unavailable')); }, 30000).unref();
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true; clearInterval(timer);
      await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); });
      await service.close(); await store.close();
    };
    process.once('SIGTERM', () => { void close().catch(() => { log.error('selection_close_failed'); process.exitCode = 1; }); });
    process.once('SIGINT', () => { void close().catch(() => { log.error('selection_close_failed'); process.exitCode = 1; }); });
    log.info({ port: config.SELECTION_PUBLIC_PORT, chainId: profile.chainId, signingKeysLoaded: false }, 'selection_public_started');
    return { service, server, close };
  } catch (error) { await service.close(); await store.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runSelectionPublicService().catch(() => { pino().error('selection_public_start_failed'); process.exitCode = 1; });
}
