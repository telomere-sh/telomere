import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import type { PlatformRuntimeClient } from '../platform-runtime/client.js';
import type { ClientAgentRunner } from './client.js';

const operationIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const checkpointOutputSchema = z.object({
  protocol: z.literal('telomere-paid-app-checkpoint-v1'),
  sourceRunId: bytes32Schema,
  operationId: operationIdSchema,
  stateBase64: z.string().min(4).max(16_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

/** Base64 and JSON overhead must fit the host's 16 KiB per-command output limit. */
export const PAID_SESSION_CHECKPOINT_MAX_BYTES = 12_000;

/** The owner chooses a reviewed executable inside the paid session image. It
 * receives sourceRunId and operationId as its final argv values and must make
 * the application capture idempotent for that operationId. This adapter uses
 * only the existing paid command/output API; it has no Cell snapshot ability.
 */
export class PaidSessionCheckpointRunner implements Pick<ClientAgentRunner, 'checkpoint'> {
  private readonly client: Pick<PlatformRuntimeClient, 'command'>;
  private readonly argvPrefix: readonly string[];
  private readonly maxBytes: number;

  constructor(options: { client: Pick<PlatformRuntimeClient, 'command'>; argvPrefix: readonly string[]; maxBytes?: number }) {
    if (!options.client || typeof options.client.command !== 'function') throw new Error('A paid session command client is required');
    const maxBytes = options.maxBytes ?? PAID_SESSION_CHECKPOINT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAID_SESSION_CHECKPOINT_MAX_BYTES) {
      throw new Error('Paid checkpoint byte limit is invalid');
    }
    this.client = options.client;
    this.argvPrefix = Object.freeze([...options.argvPrefix]);
    // Validate the fixed command before use; the run and operation are checked
    // again after they have been appended for each capture.
    sessionCommandSchema.parse({ commandId: 'checkpoint-validation',
      argv: [...this.argvPrefix, '0x' + '0'.repeat(64), 'cyst-hook-' + '0'.repeat(64)] });
    this.maxBytes = maxBytes;
  }

  async checkpoint(sourceRunId: string, operationId: string): Promise<Uint8Array> {
    const runId = bytes32Schema.parse(sourceRunId), id = operationIdSchema.parse(operationId);
    // 248 digest bits leave room for the commandId prefix under Host Kit's
    // 64-character ID limit. The same pending Cyst operation always replays
    // the same paid command, even after an owner-daemon restart.
    const commandId = 'cp' + createHash('sha256')
      .update(JSON.stringify(['telomere-paid-app-checkpoint-v1', runId, id])).digest('hex').slice(0, 62);
    const command = sessionCommandSchema.parse({ commandId, argv: [...this.argvPrefix, runId, id] });
    const result = checkedSessionCommand(await this.client.command(runId, command), command);
    if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== '') {
      throw new Error('Paid application checkpoint command did not complete cleanly');
    }
    if (Buffer.byteLength(result.stdout, 'utf8') > 16_384) throw new Error('Paid checkpoint output exceeds host command limit');
    let output: z.infer<typeof checkpointOutputSchema>;
    try { output = checkpointOutputSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new Error('Paid application checkpoint output is invalid'); }
    if (output.sourceRunId !== runId || output.operationId !== id) {
      throw new Error('Paid application checkpoint output changed run or operation');
    }
    const state = Buffer.from(output.stateBase64, 'base64');
    if (state.toString('base64') !== output.stateBase64 || state.length < 1 || state.length > this.maxBytes) {
      state.fill(0);
      throw new Error('Paid application checkpoint state exceeds the reviewed bound');
    }
    try { return new Uint8Array(state); }
    finally { state.fill(0); }
  }
}
