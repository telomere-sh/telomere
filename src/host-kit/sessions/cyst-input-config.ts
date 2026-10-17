import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { incomeStrictJson } from '../../selection/income-endpoints/json.js';
import { readPrivateBounded } from '../../operator/backup.js';
import { paidCystInputSpoolConfigSchema, type PaidCystInputSpoolConfig } from './cyst-input-spool.js';

/** Plaintext input must never enter the recursively captured host journal. */
export function assertPaidCystInputLocation(config: PaidCystInputSpoolConfig | undefined, hostDirectory: string): void {
  if (!config) return;
  const spool = resolve(config.directory), journal = resolve(hostDirectory);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
  };
  if (contains(spool, journal) || contains(journal, spool)) throw new Error('Paid input plaintext and HostKit journal require separate directory trees');
}

/** Read-only operator configuration. This never opens the plaintext spool. */
export async function readPaidCystInputConfig(path?: string, expectedSha256?: string): Promise<PaidCystInputSpoolConfig | undefined> {
  if (path === undefined && expectedSha256 === undefined) return undefined;
  try {
    if (!path || !isAbsolute(path) || !expectedSha256 || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(expectedSha256)) throw new Error('Invalid policy reference');
    const bytes = await readPrivateBounded(path, 1, 32_768);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256.replace(/^0x/, '').toLowerCase()) throw new Error('Policy hash differs');
    return Object.freeze(paidCystInputSpoolConfigSchema.parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
  } catch { throw new Error('Paid Cyst input configuration is unavailable or differs from its reviewed hash'); }
}
