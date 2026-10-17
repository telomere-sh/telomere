import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Problem } from '../common.js';
import { CYST_CAPABILITIES } from './types.js';
import { cystCapabilitiesV2Schema, cystQuotaPolicySchema, type CystQuotaPolicy } from './quota-types.js';
export * from './quota-types.js';

/** Hash-pinned private operator file. No content is returned in errors or logs. */
export async function readCystQuotaPolicy(path: string, expectedSha256: string): Promise<CystQuotaPolicy> {
  try {
    if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid policy reference');
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n
      || process.platform !== 'win32' && ((before.mode & 0o077n) !== 0n
        || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) throw new Error('private policy required');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('policy changed');
      const buffer = Buffer.alloc(4097); let size = 0;
      while (size < buffer.length) {
        const result = await file.read(buffer, size, buffer.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const bytes = buffer.subarray(0, size), after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      if (bytes.byteLength !== Number(before.size) || [after, named].some(value => value.dev !== before.dev || value.ino !== before.ino
        || value.size !== before.size || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs || value.nlink !== 1n)
        || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('policy changed');
      return Object.freeze(cystQuotaPolicySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
    } finally { await file.close(); }
  } catch { throw new Error('Checkpoint quota policy is unavailable or differs from its reviewed hash'); }
}

export function cystQuotaVersion(header: string | undefined): 1 | 2 {
  if (header === undefined) return 1;
  if (header !== '2') throw new Problem(422, 'cyst_quota_profile_invalid', 'Select the explicitly supported checkpoint quota profile.');
  return 2;
}
/** Reviewed policy only; selecting the HTTP profile never raises an operator cap. */
export function cystCapabilities(policy: CystQuotaPolicy | undefined, version: 1 | 2) {
  if (version === 1) return CYST_CAPABILITIES;
  if (!policy) throw new Problem(409, 'cyst_quota_profile_unavailable', 'The operator has not enabled this checkpoint quota profile.');
  return cystCapabilitiesV2Schema.parse({ ...CYST_CAPABILITIES, maxOwnerCheckpoints: policy.maxOwnerCheckpoints, quotaPolicy: policy });
}
