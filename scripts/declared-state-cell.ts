import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DECLARED_STATE_CELL_DIRECTORY, DECLARED_STATE_MAX_BYTES } from '../src/cysts/declared-state-protocol.js';
import { CYST_INPUT_PATH } from '../src/host-kit/sessions/cyst-input-protocol.js';
import { restoreDeclaredStateBundle } from '../src/sdk/declared-state-restore.js';
import { incomeStrictJson } from '../src/selection/income-endpoints/json.js';

const hash = z.string().regex(/^0x[a-f0-9]{64}$/);
const argsSchema = z.tuple([hash, hash, hash, z.string().regex(/^[1-9][0-9]{0,77}$/),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), z.string().regex(/^[a-f0-9]{64}$/), z.literal(CYST_INPUT_PATH)]);
const receiptSchema = z.object({ protocol: z.literal('telomere-agent-current-cyst-file-restore-v1'),
  agentId: hash, targetRunId: hash, checkpointId: hash, revision: argsSchema.items[3], operationId: argsSchema.items[4],
  plaintextBytes: z.number().int().positive().max(DECLARED_STATE_MAX_BYTES), plaintextSha256: argsSchema.items[5] }).strict();

async function stdin(signal: AbortSignal): Promise<z.infer<typeof receiptSchema>> {
  const chunks: Buffer[] = []; let length = 0;
  const abort = () => process.stdin.destroy(new Error('Declared state input cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const input: AsyncIterable<unknown> = process.stdin;
    for await (const raw of input) {
      const bytes = z.instanceof(Buffer).parse(raw); length += bytes.length;
      if (length > 4096) throw new Error('Declared state input exceeds its bound'); chunks.push(bytes);
    }
    signal.throwIfAborted();
    return receiptSchema.parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))));
  } finally { signal.removeEventListener('abort', abort); process.stdin.pause(); }
}

/** Cell-only fixed-path adapter for AgentCurrentCystPaidFileRestore. No keys,
 * host extraction, selectable destination or executable archive metadata. */
async function main(): Promise<void> {
  const [agentId, targetRunId, checkpointId, revision, operationId, plaintextSha256, bundlePath] = argsSchema.parse(process.argv.slice(2));
  const controller = new AbortController();
  const abort = () => controller.abort(); process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), receipt = await stdin(signal);
    if (receipt.agentId !== agentId || receipt.targetRunId !== targetRunId || receipt.checkpointId !== checkpointId
      || receipt.revision !== revision || receipt.operationId !== operationId || receipt.plaintextSha256 !== plaintextSha256) throw new Error('Changed receipt');
    try { await mkdir(DECLARED_STATE_CELL_DIRECTORY, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = await lstat(bundlePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1n || stat.size > BigInt(DECLARED_STATE_MAX_BYTES)) throw new Error('Invalid bundle');
    if (stat.size !== BigInt(receipt.plaintextBytes)) throw new Error('Changed input size');
    await restoreDeclaredStateBundle({ bundlePath, destinationDirectory: join(DECLARED_STATE_CELL_DIRECTORY, operationId),
      expectedSha256: plaintextSha256, expectedBytes: receipt.plaintextBytes, signal });
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
}

void main().catch(() => { process.stderr.write('Declared state restore refused\n'); process.exitCode = 1; });
