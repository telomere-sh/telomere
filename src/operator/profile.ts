import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { addressSchema } from '../common.js';
import { loadConfig, type Config } from '../config.js';

/** This subset accepts the profiles produced by staging-prepare; it never evaluates shell code. */
export function parseProfile(text: string): NodeJS.ProcessEnv {
  if (Buffer.byteLength(text, 'utf8') > 65536 || text.includes('\0')) throw new Error('Invalid operator profile');
  const values: NodeJS.ProcessEnv = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || values[match[1]] !== undefined) throw new Error('Invalid operator profile');
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.at(-1) !== value[0] || value.length < 2) throw new Error('Invalid operator profile');
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function readProfile(path: string): Promise<Config> {
  const location = resolve(z.string().min(1).max(4096).parse(path));
  const metadata = await stat(location);
  if (!metadata.isFile() || metadata.size > 65536) throw new Error('Invalid operator profile');
  // The normal config schema enforces chain/mode isolation. The CLI never logs its errors or values.
  return loadConfig(parseProfile(await readFile(location, 'utf8')));
}

export function publicProfile(config: Config) {
  const owners = config.PILOT_ALLOWED_OWNERS.split(',').map(value => value.trim()).filter(Boolean).map(value => addressSchema.parse(value));
  return { mode: config.MODE, chainId: config.CHAIN_ID, escrow: config.ESCROW_ADDRESS, token: config.TOKEN_ADDRESS,
    signer: privateKeyToAccount(config.SIGNER_PRIVATE_KEY).address,
    ...(config.DEMO_PRIVATE_KEY ? { demoOwner: privateKeyToAccount(config.DEMO_PRIVATE_KEY).address } : {}),
    allowedOwners: owners, cpu: { mode: config.CPU_MODE, image: config.CPU_IMAGE, digestPinned: /@sha256:[a-f0-9]{64}$/.test(config.CPU_IMAGE) },
    database: config.DATABASE_URL ? 'postgresql' : 'pglite',
    near: { configured: !!config.NEAR_ENDPOINT, verification: config.NEAR_ENDPOINT ? config.NEAR_VERIFICATION_MODE : 'disabled',
      ...(config.NEAR_MODEL ? { model: config.NEAR_MODEL } : {}) } };
}
