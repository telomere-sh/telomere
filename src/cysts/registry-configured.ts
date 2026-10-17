import { lstat, readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { CystService } from './service.js';
import { cystRegistryPinsSchema } from './registry-types.js';
import { RpcCystRegistryReader } from './registry-reader.js';
import { CystRegistryService } from './registry-service.js';

/** Operator-reviewed deployment pins only. No private wallet or automatic broadcaster is configured. */
export async function configuredCystRegistry(cysts: CystService | undefined, config: Config): Promise<CystRegistryService | undefined> {
  if (!config.CYST_REGISTRY_CONFIG) return undefined;
  try {
    if (!cysts) throw new Error('Ciphertext storage required');
    const info = await lstat(config.CYST_REGISTRY_CONFIG);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 8192
      || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Private reviewed file required');
    const pins = cystRegistryPinsSchema.parse(JSON.parse(await readFile(config.CYST_REGISTRY_CONFIG, 'utf8')));
    if (pins.chainId !== config.CHAIN_ID || config.MODE !== 'demo' && pins.confirmations < 1) throw new Error('Reviewed chain and confirmation policy required');
    const service = new CystRegistryService(cysts, new RpcCystRegistryReader({ pins, rpcUrl: config.RPC_URL }));
    await service.initialize(); return service;
  } catch { throw new Error('Cyst registry configuration or reviewed deployment is unavailable'); }
}
