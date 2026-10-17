import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import type { Database } from '../store.js';
import type { SelectionIndexer } from './indexer.js';
import type { SelectionReputation } from './reputation.js';
import { incomeStrictJson } from './income-endpoints/json.js';
import { selectionReputationTargetProfileSchema } from './reputation-deployment.js';
import { SelectionReputationPublisher } from './reputation-publisher.js';

const configuration = z.object({ authorised: z.literal(true), profile: selectionReputationTargetProfileSchema,
  signerKeyFile: z.string().min(1).max(4096), confirmations: z.number().int().min(0).max(10_000),
  maxPublications: z.number().int().min(1).max(4096).default(1024) }).strict();

function checked(stat: BigIntStats, maximum: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximum)
    || process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) throw new Error('Private reputation regular file required');
}
function same(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
async function privateText(path: string, maximum: number): Promise<string> {
  const before = await lstat(path, { bigint: true }); checked(before, maximum);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); checked(opened, maximum); if (!same(before, opened)) throw new Error('Private reputation file changed');
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true }); checked(after, maximum); checked(named, maximum);
    if (length < 1 || length > maximum || BigInt(length) !== opened.size || !same(opened, after) || !same(after, named)) throw new Error('Private reputation file changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Default-off composition helper. Initialization binds the database, without
 * broadcasting. Only maintenance after canonical Selection sync may publish.
 */
export async function configuredSelectionReputationPublisher(db: Database, feed: SelectionReputation, indexer: SelectionIndexer,
  input: { configurationFile?: string; rpcUrl: string; chainId: number; mode: 'demo' | 'testnet' | 'mainnet'; financialSigners: readonly string[] }) {
  if (!input.configurationFile) return undefined;
  try {
    const reviewed = configuration.parse(incomeStrictJson(await privateText(input.configurationFile, 16_384)));
    const url = new URL(input.rpcUrl);
    if (reviewed.profile.chainId !== input.chainId || input.mode !== 'demo' && (input.chainId !== (input.mode === 'mainnet' ? 8453 : 84532) || reviewed.confirmations < 1)
      || input.mode === 'demo' && (input.chainId !== 31337 || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Reputation network differs from reviewed runtime');
    const service = new SelectionReputationPublisher(db, feed, indexer, { ...reviewed, rpcUrl: input.rpcUrl,
      signerPrivateKey: bytes32Schema.parse((await privateText(reviewed.signerKeyFile, 80)).trim()), financialSigners: input.financialSigners });
    await service.initialize(); return service;
  } catch { throw new Error('Reputation publisher configuration, dedicated key or immutable deployment profile is unavailable'); }
}
