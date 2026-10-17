import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Config as RuntimeConfig } from '../../config.js';
import type { Database } from '../../store.js';
import { incomeStrictJson } from './json.js';
import { RpcIncomeEndpointReader } from './reader.js';
import { IncomeEndpointService } from './service.js';
import { incomeEndpointProfileSchema } from './types.js';

const maxProfileBytes = 8192;
function privateRegularFile(value: BigIntStats): void {
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.size < 1n || value.size > BigInt(maxProfileBytes)
    || process.platform !== 'win32' && (value.mode & 0o077n) !== 0n) throw new Error('Private reviewed profile required');
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
async function profileText(path: string): Promise<string> {
  const before = await lstat(path, { bigint: true }); privateRegularFile(before);
  // NOFOLLOW protects the final pathname component; NONBLOCK prevents a raced
  // FIFO/device replacement from blocking open before fstat can reject it.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); privateRegularFile(opened);
    if (!sameFile(before, opened)) throw new Error('Reviewed profile changed during open');
    const bytes = Buffer.alloc(maxProfileBytes + 1); let length = 0;
    while (length < bytes.byteLength) {
      const result = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break; length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    privateRegularFile(after); privateRegularFile(named);
    if (length < 1 || length > maxProfileBytes || BigInt(length) !== opened.size || !sameFile(opened, after) || !sameFile(after, named)) {
      throw new Error('Reviewed profile changed during bounded read');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Private operator configuration only. Initialization verifies a read-only RPC
 * deployment and never probes endpoint URLs, signs or broadcasts transactions.
 */
export async function configuredIncomeEndpoints(config: RuntimeConfig, db: Database): Promise<IncomeEndpointService | undefined> {
  if (!config.INCOME_ENDPOINTS_CONFIG) return undefined;
  try {
    const profile = incomeEndpointProfileSchema.parse(incomeStrictJson(await profileText(config.INCOME_ENDPOINTS_CONFIG)));
    const rpc = new URL(config.RPC_URL);
    if (profile.pins.chainId !== config.CHAIN_ID || profile.asset.toLowerCase() !== config.TOKEN_ADDRESS.toLowerCase()
      || config.MODE !== 'demo' && profile.pins.confirmations < 1
      || profile.localFixture && (config.MODE !== 'demo' || config.CHAIN_ID !== 31337 || !['127.0.0.1', '[::1]'].includes(rpc.hostname))) {
      throw new Error('Reviewed profile differs from the runtime network');
    }
    const service = new IncomeEndpointService(db, new RpcIncomeEndpointReader({ rpcUrl: config.RPC_URL, pins: profile.pins, asset: profile.asset }), profile);
    await service.initialize(); return service;
  } catch { throw new Error('Income endpoint configuration or reviewed deployment is unavailable'); }
}
