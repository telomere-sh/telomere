import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CystCheckpointFileVault } from '../sdk/cyst-checkpoints-file-vault.js';
import { PaidLifecycleClientVault } from '../agents/paid-lifecycle-runner.js';
import { DurableVaultCompute, FRAMEWORK_COMPUTE_SCHEMA, frameworkComputeProfileSchema, frameworkComputeCommandSchema } from './durable-vault-compute.js';
import { createTelomereElizaPlugin } from './elizaos.js';
import { createTelomereAutomatonTools } from './automaton.js';

const argumentsSchema = z.object({ 'profile-file': z.string().min(1), 'journal-directory': z.string().min(1),
  'master-key-file': z.string().min(1), 'session-token-file': z.string().min(1), 'command-file': z.string().min(1),
  framework: z.enum(['elizaos', 'automaton']) }).strict();
async function file(path: string, limit: number, privateMaterial = false): Promise<string> {
  const absolute = resolve(path), before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid framework input file');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size > limit || stat.size < 1
      || privateMaterial && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Invalid framework input file');
    const bytes = Buffer.alloc(limit + 1);
    try {
      const result = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (result.bytesRead !== stat.size || result.bytesRead > limit || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new Error('Framework input file changed');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
    } finally { bytes.fill(0); }
  } finally { await handle.close(); }
}

/** Real starter CLI. Reads externally provisioned session/key files and executes
 * one framework command; only the separate agent wallet can send payRun.
 */
export async function frameworkComputeMain(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, options: { 'profile-file': { type: 'string' }, 'journal-directory': { type: 'string' },
    'master-key-file': { type: 'string' }, 'session-token-file': { type: 'string' }, 'command-file': { type: 'string' },
    framework: { type: 'string' } }, strict: true, allowPositionals: false });
  const options = argumentsSchema.parse(parsed.values);
  const profile = frameworkComputeProfileSchema.parse(JSON.parse(await file(options['profile-file'], 32768)));
  const command = frameworkComputeCommandSchema.parse(JSON.parse(await file(options['command-file'], 32768)));
  const master = z.string().regex(/^[a-fA-F0-9]{64}$/).parse((await file(options['master-key-file'], 65, true)).trim());
  const sessionToken = z.string().regex(/^[a-f0-9]{64}$/).parse((await file(options['session-token-file'], 65, true)).trim());
  const masterKey = Buffer.from(master, 'hex');
  const encrypted = new CystCheckpointFileVault({ directory: resolve(options['journal-directory']), masterKey });
  masterKey.fill(0);
  try {
    const journal = new PaidLifecycleClientVault(encrypted, { owner: profile.binding.owner,
      agent: profile.binding.agentWallet, applicationSchema: FRAMEWORK_COMPUTE_SCHEMA });
    const compute = new DurableVaultCompute({ profile, journal, sessionToken });
    if (options.framework === 'elizaos') {
      const action = createTelomereElizaPlugin(compute).actions[0]; if (!action) throw new Error('Missing framework action');
      const message = { content: { text: JSON.stringify(command) } };
      if (!await action.validate({}, message)) throw new Error('Invalid framework command');
      const result = await action.handler({}, message); if (!result.success) throw new Error('Framework command failed');
      process.stdout.write(result.text + '\n');
    } else {
      const tool = createTelomereAutomatonTools(compute)[0]; if (!tool) throw new Error('Missing framework tool');
      const result = await tool.execute(command, { identity: { address: profile.binding.agentWallet, creatorAddress: profile.binding.owner } });
      const status = z.object({ success: z.literal(true) }).passthrough().safeParse(JSON.parse(result));
      if (!status.success) throw new Error('Framework command failed');
      process.stdout.write(result + '\n');
    }
  } finally { encrypted.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void frameworkComputeMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('{"error":"telomere_framework_failed","reconciliationRequired":true}\n');
    process.exitCode = 1;
  });
}
