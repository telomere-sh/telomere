import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import { platformPinsSchema } from '../platform-runtime/types.js';
import { platformVaultPinsSchema } from '../platform-runtime/vault-client.js';

const profileSchema = z.object({ pins: platformPinsSchema, vaultPins: platformVaultPinsSchema.optional() }).strict();

/** Public reviewed deployment pins only; never load the controller's signer configuration. */
export async function readPlatformMcpProfile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Expected a regular public pins file');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev
      || current.size < 1 || current.size > 16_384) throw new Error('Expected a bounded public pins file');
    const bytes = Buffer.alloc(16_385); let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size < 1 || size > 16_384) throw new Error('Public pins exceed their bound');
    return profileSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
  } finally { await file.close(); }
}
