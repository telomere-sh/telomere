import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { projectRoot } from '../scripts/compile-contracts.js';

const execute = promisify(execFile);
it.each(['spend-permissions', 'cpu-reservations', 'platform-types'])('loads %s first in native ESM without a payment/schema initialization cycle', async entry => {
  const first = entry === 'platform-types' ? './src/platform-runtime/types.ts' : './src/payments/' + entry + '.ts';
  const script = `await import(${JSON.stringify(first)});
    const legacy=await import('./src/payments/spend-permissions.ts');
    const leaf=await import('./src/payments/spend-permission-types.ts');
    const types=await import('./src/platform-runtime/types.ts');
    const cpu=await import('./src/payments/cpu-reservations.ts');
    if(legacy.spendPermissionFundingSchema!==leaf.spendPermissionFundingSchema
      || typeof types.platformQuoteInputSchema.safeParse!=='function'
      || typeof cpu.x402CpuProfileSchema.safeParse!=='function') throw new Error('Payment export initialization changed');
    process.stdout.write('payment imports ready');`;
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: projectRoot, timeout: 30_000, maxBuffer: 16_384, windowsHide: true });
  expect(result.stdout).toBe('payment imports ready');
}, 40_000);
