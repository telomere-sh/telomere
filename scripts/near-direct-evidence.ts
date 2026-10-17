import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { captureDirectCandidate, saveDirectCandidate, type DirectCandidateSummary,
  type DirectCandidateTransport } from '../src/providers/direct-candidate.js';

type Result = { summary: DirectCandidateSummary; exitCode: number } | { summary: {
  status: 'capture_failed'; reasonCode: 'INVALID_CONFIGURATION_OR_OUTPUT'; approval: 'UNAPPROVED';
  hardwareVerified: false; reportGets: 0; paidPosts: 0 }; exitCode: 1 };

/** Configuration is operator-protected. The inference API key is never read or sent by this GET-only capture. */
export async function runDirectEvidence(args: string[], env: NodeJS.ProcessEnv = process.env,
  request?: DirectCandidateTransport): Promise<Result> {
  try {
    const parsed = parseArgs({ args, options: { output: { type: 'string' } }, strict: true, allowPositionals: false });
    const directory = parsed.values.output;
    const endpoint = env.NEAR_ENDPOINT, model = env.NEAR_MODEL, allowlist = env.NEAR_ALLOWED_MODELS;
    if (!directory || !isAbsolute(directory) || !endpoint || !model || !allowlist
      || !allowlist.split(',').map(value => value.trim()).includes(model)) throw new Error();
    const capture = await captureDirectCandidate({ endpoint, model }, request ? { request } : undefined);
    await saveDirectCandidate(directory, capture);
    return { summary: capture.summary, exitCode: capture.summary.status === 'captured' ? 0 : 1 };
  } catch {
    return { summary: { status: 'capture_failed', reasonCode: 'INVALID_CONFIGURATION_OR_OUTPUT',
      approval: 'UNAPPROVED', hardwareVerified: false, reportGets: 0, paidPosts: 0 }, exitCode: 1 };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDirectEvidence(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.summary) + '\n');
  process.exitCode = result.exitCode;
}
