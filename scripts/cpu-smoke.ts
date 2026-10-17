import { createDockerCpuExecutor } from '../src/runtime/index.js';
import { executeCommand } from '../src/runtime/command.js';
import { z } from 'zod';

const image = z.string().regex(/@sha256:[a-f0-9]{64}$/).parse(process.env.CPU_IMAGE);
let isolated = 0;
const configSchema = z.object({
  Config: z.object({ User: z.literal('10001:10001') }).passthrough(),
  HostConfig: z.object({ NetworkMode: z.literal('none'), ReadonlyRootfs: z.literal(true),
    CapDrop: z.array(z.string()).refine(items => items.includes('ALL')),
    SecurityOpt: z.array(z.string()).refine(items => items.includes('no-new-privileges:true')),
    Memory: z.literal(268435456), MemorySwap: z.literal(268435456), NanoCpus: z.literal(1000000000),
    PidsLimit: z.literal(64), Binds: z.array(z.string()).nullable().refine(items => !items?.length),
  }).passthrough(),
}).passthrough();
const executor = createDockerCpuExecutor({ image, command: async (args, options) => {
  const result = await executeCommand('docker', args, options);
  if (args[0] === 'create' && result.exitCode === 0) {
    const inspected = await executeCommand('docker', ['inspect', result.stdout.trim()], { signal: AbortSignal.timeout(5000), maxOutputBytes: 32768 });
    z.array(configSchema).length(1).parse(JSON.parse(inspected.stdout)); isolated++;
  }
  return result;
} });
const sha = await executor.run({ runId: 'vps-smoke-sha', task: { kind: 'sha256', text: 'hello' }, maxSeconds: 10 }, new AbortController().signal);
if (sha.status !== 'completed' || !sha.output.includes('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')) throw new Error('SHA task failed');
const primes = await executor.run({ runId: 'vps-smoke-primes', task: { kind: 'primes', limit: 2000000 }, maxSeconds: 10 }, new AbortController().signal);
if (primes.status !== 'completed' || !primes.output.includes('148933')) throw new Error('Prime task failed');
const chain = await executor.run({ runId: 'vps-smoke-chain', task: { kind: 'hash_chain', text: 'Telomere CPU meter', iterations: 2000000 }, maxSeconds: 30 }, new AbortController().signal);
if (chain.status !== 'completed' || !chain.output.includes('b74d158bb1f40831a9a2c1900cd7b52782906d1ecb4dda8a9b299dedf26e6205') || chain.billableSeconds < 1) throw new Error('Positive CPU metering failed');
const cancelled = new AbortController(); cancelled.abort();
const stop = await executor.run({ runId: 'vps-smoke-stop', task: { kind: 'sha256', text: 'unexecuted' }, maxSeconds: 10 }, cancelled.signal);
if (stop.status !== 'cancelled' || stop.billableSeconds !== 0) throw new Error('Cancellation failed');
const remaining = await executeCommand('docker', ['ps', '--all', '--filter', 'label=telomere.managed=true', '--format', '{{.Names}}'], { signal: AbortSignal.timeout(5000), maxOutputBytes: 16384 });
if (remaining.stdout.trim()) throw new Error('Pilot containers remain after smoke');
process.stdout.write(JSON.stringify({ status: 'passed', isolatedContainersChecked: isolated, cpuImage: image, tasks: [sha.status, primes.status, chain.status, stop.status],
  billableSeconds: [sha.billableSeconds, primes.billableSeconds, chain.billableSeconds], tickCounts: [sha.ticks.length, primes.ticks.length, chain.ticks.length], providerCalls: 0 }) + '\n');
