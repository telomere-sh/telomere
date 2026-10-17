import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { captureBoundedProcess, defaultWatchdogPolicy, FileWatchdogState, watchdogCycle } from '../src/operator/watchdog.js';

let phase = 'arguments';
try {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string' }, 'state-file': { type: 'string' },
    'api-url': { type: 'string' }, 'interval-ms': { type: 'string' },
    'expected-mode': { type: 'string' }, 'expected-chain-id': { type: 'string' },
    'expected-escrow': { type: 'string' }, 'expected-token': { type: 'string' },
    'expected-signer': { type: 'string' },
    once: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  const envFile = z.string().min(1).max(4096).parse(values['env-file']);
  const state = new FileWatchdogState(z.string().min(1).max(4096).parse(values['state-file']));
  const intervalMs = z.coerce.number().int().min(30_000).max(300_000).parse(values['interval-ms'] ?? '60000');
  const apiUrl = values['api-url'];
  const publicAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
  const policy = { ...defaultWatchdogPolicy, expected: {
    mode: z.enum(['demo', 'testnet']).parse(values['expected-mode']),
    chainId: z.coerce.number().int().positive().safe().parse(values['expected-chain-id']),
    escrow: publicAddress.parse(values['expected-escrow']),
    token: publicAddress.parse(values['expected-token']),
    signer: publicAddress.parse(values['expected-signer']),
  } };
  // The only child is this repository's read-only operator diagnostic. No shell or user-supplied executable.
  const isTypeScript = import.meta.url.endsWith('.ts');
  const statusPath = fileURLToPath(new URL(isTypeScript ? './operator-status.ts' : './operator-status.js', import.meta.url));
  const args = [...(isTypeScript ? ['--import', 'tsx'] : []), statusPath, `--env-file=${envFile}`,
    ...(apiUrl ? [`--api-url=${apiUrl}`] : [])];
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  phase = 'monitor';
  do {
    let result;
    try {
      result = await watchdogCycle(state,
        () => captureBoundedProcess(process.execPath, args, 60_000, 262_144, shutdown.signal),
        () => Date.now(), policy, shutdown.signal);
    } catch (error) {
      if (shutdown.signal.aborted) break;
      throw error;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    if (values.once) { if (result.health !== 'ok') process.exitCode = 1; break; }
    if (!shutdown.signal.aborted) await delay(intervalMs, undefined, { signal: shutdown.signal })
      .catch(error => { if (!shutdown.signal.aborted) throw error; });
  } while (!shutdown.signal.aborted);
} catch {
  // Child stderr and parser exceptions may contain credentials or private paths.
  process.stderr.write(JSON.stringify({ status: 'watchdog_failed', phase,
    detail: 'Inspect the private watchdog state, operator profile and local diagnostic connectivity.' }) + '\n');
  process.exitCode = 1;
}
