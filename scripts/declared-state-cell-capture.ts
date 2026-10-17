import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { captureDeclaredStateCheckpoint } from '../src/sdk/declared-state-checkpoint.js';

const source = '/tmp/telomere-declared-application';
const scratch = '/tmp/telomere-declared-capture';
const argsSchema = z.tuple([z.string().regex(/^0x[a-f0-9]{64}$/), z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)]);

/** Cell-only onCyst hook. The application quiesces this fixed private data root;
 * no caller-selected host path, shell, executable metadata or key is accepted. */
async function main(): Promise<void> {
  const [sourceRunId, operationId] = argsSchema.parse(process.argv.slice(2));
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    try { await mkdir(scratch, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const output = await captureDeclaredStateCheckpoint({ sourceDirectory: source, scratchDirectory: scratch,
      sourceRunId, operationId, signal });
    signal.throwIfAborted();
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
}

void main().catch(() => { process.stderr.write('Declared state checkpoint refused\n'); process.exitCode = 1; });
