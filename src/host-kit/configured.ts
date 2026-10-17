import { lstat, readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Database } from '../store.js';
import { Ed25519Identity } from './protocol.js';
import { HostKitClient } from './client.js';
import { ControllerHostKitCpu } from './controller.js';
export async function configuredHostKit(db: Database, config: Config): Promise<ControllerHostKitCpu> {
  if (!config.HOST_KIT_URL || !config.HOST_KIT_HOST_KEY || !config.HOST_KIT_CONTROL_PEM) throw new Error('Host Kit is unconfigured');
  try {
    const info = await lstat(config.HOST_KIT_CONTROL_PEM);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024
      || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('private control identity');
    const identity = new Ed25519Identity(await readFile(config.HOST_KIT_CONTROL_PEM, 'utf8'));
    return new ControllerHostKitCpu(db, new HostKitClient(config.HOST_KIT_URL, config.HOST_KIT_HOST_KEY, identity), config.CPU_IMAGE);
  } catch { throw new Error('Host Kit reviewed transport or private control identity is unavailable'); }
}
