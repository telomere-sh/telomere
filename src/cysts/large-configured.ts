import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import { LargeCystPrivateStore, type LargeCystStore } from './large-checkpoints.js';
import { LargeCystQuotaShadowStore } from './large-quota-shadow.js';
import { S3LargeCystStore } from './large-s3.js';

const destinationSchema = z.object({
  endpoint: z.string().url(), bucket: z.string(), region: z.string(),
  failureDomain: z.string(), reviewed: z.literal(true),
  allowInsecureLoopback: z.boolean().optional(),
  credentials: z.object({
    accessKeyId: z.string(), secretAccessKey: z.string(), sessionToken: z.string().optional(),
  }).strict(),
}).strict();

const configSchema = z.object({
  version: z.literal(1), destinations: z.tuple([destinationSchema, destinationSchema]),
}).strict();

export type ConfiguredLargeCystStore = LargeCystStore & { close(): Promise<void>; readonly readOnly?: boolean };

/** Resolve the exact same reviewed and pinned destinations for the controller
 * and its separate read-only operator diagnostic. No object or marker is written.
 */
export async function readReviewedLargeCystReplication(config: Config, shadowDirectory: string): Promise<{
  destinations: readonly [S3LargeCystStore, S3LargeCystStore]; topologySha256: string;
}> {
  const path = config.CYSTS_LARGE_REPLICATION_CONFIG;
  if (!path || !config.CYSTS_LARGE_REPLICATION_CONFIG_SHA256) throw new Error('Missing Large Cyst replication pin');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 32768
    || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('private config');
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length > 32768) throw new Error('changed config');
  const hash = '0x' + createHash('sha256').update(bytes).digest('hex');
  if (hash !== config.CYSTS_LARGE_REPLICATION_CONFIG_SHA256.toLowerCase()) throw new Error('unpinned config');
  const parsed = configSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (config.MODE !== 'demo' && parsed.destinations.some(item => item.allowInsecureLoopback)) {
    throw new Error('insecure public Base storage');
  }
  const makeStore = (item: z.infer<typeof destinationSchema>) => new S3LargeCystStore({
    endpoint: item.endpoint, bucket: item.bucket, region: item.region,
    failureDomain: item.failureDomain, reviewed: true,
    credentials: { accessKeyId: item.credentials.accessKeyId,
      secretAccessKey: item.credentials.secretAccessKey,
      ...(item.credentials.sessionToken ? { sessionToken: item.credentials.sessionToken } : {}) },
    ...(item.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: item.allowInsecureLoopback }),
  });
  const first = makeStore(parsed.destinations[0]), second = makeStore(parsed.destinations[1]);
  if (first.destination.endpoint === second.destination.endpoint
    || first.destination.region === second.destination.region
    || first.destination.failureDomain === second.destination.failureDomain) throw new Error('shared destination');
  const topologySha256 = createHash('sha256').update(JSON.stringify({ version: 1,
    shadowDirectory, destinations: [first.destination, second.destination] })).digest('hex');
  return { destinations: [first, second], topologySha256 };
}

/** The local ciphertext copy is the quota/retry authority. A remote commit needs
 * two separately configured S3 destinations; the config bytes are pinned by env.
 */
export async function configuredLargeCysts(config: Config): Promise<ConfiguredLargeCystStore | undefined> {
  if (!config.CYSTS_LARGE_DIR) return undefined;
  if (!config.CYSTS_LARGE_GLOBAL_BYTES || !config.CYSTS_LARGE_OWNER_BYTES) {
    throw new Error('Large Cyst quotas are unconfigured');
  }
  const shadow = new LargeCystPrivateStore(config.CYSTS_LARGE_DIR,
    { globalMaxBytes: config.CYSTS_LARGE_GLOBAL_BYTES, ownerMaxBytes: config.CYSTS_LARGE_OWNER_BYTES });
  if (!config.CYSTS_LARGE_REPLICATION_CONFIG) {
    await shadow.initialize();
    try { await shadow.assertRemoteTopology(); return shadow; }
    catch (error) { await shadow.close(); throw error; }
  }
  let managed: LargeCystQuotaShadowStore | undefined;
  try {
    const { destinations, topologySha256 } = await readReviewedLargeCystReplication(config, shadow.directory);
    managed = new LargeCystQuotaShadowStore(shadow, destinations, topologySha256);
    await managed.initialize();
    return managed;
  } catch {
    await managed?.close().catch(() => undefined);
    throw new Error('Large Cyst replication configuration is unavailable or unreviewed');
  }
}
