import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { captureCloudCandidate, saveCloudCandidate } from '../src/providers/cloud-candidate.js';

try {
  const { values } = parseArgs({ options: { model: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const model = z.string().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/).parse(values.model ?? process.env.NEAR_MODEL);
  const apiKey = z.string().trim().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value)).parse(process.env.NEAR_API_KEY);
  const allowlist = z.string().min(1).parse(process.env.NEAR_ALLOWED_MODELS).split(',').map(item => item.trim());
  if (!allowlist.includes(model)) throw new Error('Model outside protected allowlist');
  const directory = resolve(values.output ?? `.local/cloud-candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const capture = await captureCloudCandidate({ apiKey, model });
  await saveCloudCandidate(directory, capture);
  process.stdout.write(JSON.stringify(capture.summary) + '\n');
  if (capture.summary.status !== 'captured') process.exitCode = 1;
} catch {
  process.stderr.write(JSON.stringify({ status: 'capture_failed', reasonCode: 'INVALID_CONFIGURATION_OR_OUTPUT', approval: 'UNAPPROVED',
    hardwareVerified: false, paidPosts: 0, detail: 'Check protected model/key configuration and use a new private output directory. No retry was attempted.' }) + '\n');
  process.exitCode = 1;
}
