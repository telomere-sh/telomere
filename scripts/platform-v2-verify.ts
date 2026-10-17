import { lstat, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { bytes32Schema } from '../src/common.js';
import { createPlatformReadOnlyBridge } from '../src/platform-runtime/read-only.js';
import { verifyPlatformV2CombinedEvidence } from '../src/receipts/platform-v2-combined.js';
import { platformV2PublicVerification } from '../src/receipts/platform-v2-routes.js';
import { PLATFORM_V2_CORE_MAX_BYTES, platformV2EvidenceCoreSchema } from '../src/receipts/platform-v2.js';

async function boundedJson(path: string, maximum: number): Promise<unknown> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > maximum) {
    throw new Error('Expected a bounded regular input file');
  }
  const handle = await open(path, 'r'), buffer = Buffer.alloc(maximum + 1);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum
      || before.dev !== initial.dev || before.ino !== initial.ino) throw new Error('Input file changed while opening');
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > maximum || length !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error('Input file changed or exceeds its bound');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
  } finally { buffer.fill(0); await handle.close(); }
}

let phase = 'arguments';
async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    pins: { type: 'string' }, core: { type: 'string' }, 'rpc-url': { type: 'string' },
    'open-transaction': { type: 'string' }, 'settlement-transaction': { type: 'string' },
    confirmations: { type: 'string' },
  } });
  const openHash = bytes32Schema.parse(values['open-transaction']);
  const settlementHash = bytes32Schema.parse(values['settlement-transaction']);
  const rpcUrl = z.string().url().parse(values['rpc-url'] ?? process.env.TELOMERE_PLATFORM_RPC_URL);
  const confirmations = values.confirmations === undefined ? 12
    : z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/).transform(Number).parse(values.confirmations);
  phase = 'pins';
  const pins = await boundedJson(z.string().min(1).parse(values.pins), 65_536);
  phase = 'core';
  const core = platformV2EvidenceCoreSchema.parse(await boundedJson(z.string().min(1).parse(values.core), PLATFORM_V2_CORE_MAX_BYTES));
  phase = 'chain';
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('verification_timeout')), 60_000);
  try {
    const bridge = createPlatformReadOnlyBridge(pins, rpcUrl, abort.signal);
    const result = await verifyPlatformV2CombinedEvidence(bridge, openHash, settlementHash, core, confirmations);
    if (abort.signal.aborted) throw new Error('verification_timeout');
    process.stdout.write(JSON.stringify({ readOnly: true, status: 'verified', ...platformV2PublicVerification(result) }) + '\n');
  } finally { clearTimeout(timeout); }
}

void main().catch(() => {
  // Untrusted files, private RPC paths and verifier internals stay out of output.
  process.stdout.write(JSON.stringify({ readOnly: true, status: 'rejected', phase,
    code: 'platform_v2_unverified' }) + '\n');
  process.exitCode = 1;
});
