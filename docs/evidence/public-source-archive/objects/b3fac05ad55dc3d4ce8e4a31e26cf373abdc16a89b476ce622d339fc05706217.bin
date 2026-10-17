import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import { CystService } from './service.js';
import { ReplicatedCystStorage } from './replicated.js';
import { S3CiphertextStorage } from './s3.js';
import type { Database } from '../store.js';
import type { CystQuotaPolicy } from './quota-types.js';

const destination = z.object({ endpoint: z.string().url(), bucket: z.string(), region: z.string(),
  failureDomain: z.string(), reviewed: z.literal(true), allowInsecureLoopback: z.boolean().optional(),
  credentials: z.object({ accessKeyId: z.string(), secretAccessKey: z.string(), sessionToken: z.string().optional() }).strict() }).strict();
const replication = z.object({ version: z.literal(1), destinations: z.tuple([destination, destination]) }).strict();
/** Operator-owned file only. Its credentials never enter API config, logs, checkpoints or backups. */
export async function configuredCysts(db: Database, config: Config, options: { quotaPolicy?: CystQuotaPolicy } = {}): Promise<CystService | undefined> {
  if (!config.CYSTS_ENABLED) return undefined;
  if (!config.CYSTS_REPLICATION_CONFIG) {
    if (!config.CYSTS_DIR) throw new Error('Private checkpoint storage is unconfigured');
    return new CystService(db, config.CYSTS_DIR, options);
  }
  try {
    const info = await stat(config.CYSTS_REPLICATION_CONFIG);
    if (!info.isFile() || info.size > 32768 || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('private config');
    const parsed = replication.parse(JSON.parse(await readFile(config.CYSTS_REPLICATION_CONFIG, 'utf8')));
    const stores = parsed.destinations.map(item => new S3CiphertextStorage({ endpoint: item.endpoint, bucket: item.bucket,
      region: item.region, failureDomain: item.failureDomain, reviewed: true,
      credentials: { accessKeyId: item.credentials.accessKeyId, secretAccessKey: item.credentials.secretAccessKey,
        ...(item.credentials.sessionToken ? { sessionToken: item.credentials.sessionToken } : {}) },
      ...(item.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: item.allowInsecureLoopback }) }));
    const [a, b] = stores; if (!a || !b) throw new Error('two replicas');
    return new CystService(db, new ReplicatedCystStorage([a, b]), options);
  } catch { throw new Error('Checkpoint replication configuration is unavailable or unreviewed'); }
}
