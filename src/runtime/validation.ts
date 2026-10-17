import { z } from 'zod';
import { outputHash } from './meter.js';
import type { CpuRunResult, MeterTick } from './types.js';

const tickSchema = z.object({ runId: z.string(), sequence: z.number().int().min(0).max(128), timestamp: z.string().datetime(),
  elapsedMs: z.number().int().min(0).max(120000), billableSeconds: z.number().int().min(0).max(120),
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']), previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), outputHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const resultSchema = z.object({ output: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 16384),
  billableSeconds: z.number().int().min(0).max(120), ticks: z.array(tickSchema).max(128), exitCode: z.number().int(),
  status: z.enum(['completed', 'failed', 'cancelled', 'timed_out']) }).strict();

/** Validate durable host observations before recovery; this is not hardware attestation. */
export function validateTicks(value: unknown, runId: string, maxSeconds: number): MeterTick[] {
  const ticks: MeterTick[] = z.array(tickSchema).max(128).parse(value).map(tick => {
    const { outputHash: hash, ...required } = tick;
    return { ...required, ...(hash === undefined ? {} : { outputHash: hash }) };
  });
  let previous: MeterTick | undefined;
  for (const tick of ticks) {
    const record = { runId: tick.runId, sequence: tick.sequence, timestamp: tick.timestamp, elapsedMs: tick.elapsedMs,
      billableSeconds: tick.billableSeconds, state: tick.state, previousHash: tick.previousHash,
      ...(tick.outputHash === undefined ? {} : { outputHash: tick.outputHash }) };
    if (tick.runId !== runId || tick.sequence !== (previous ? previous.sequence + 1 : 0)
      || tick.previousHash !== (previous?.hash ?? null) || tick.elapsedMs > maxSeconds * 1000
      || tick.elapsedMs < (previous?.elapsedMs ?? 0) || tick.billableSeconds !== Math.floor(tick.elapsedMs / 1000)
      || (previous && Date.parse(tick.timestamp) < Date.parse(previous.timestamp))
      || tick.hash !== outputHash(JSON.stringify(record)) || (previous && previous.state !== 'running')) {
      throw new Error('Persisted CPU observations failed validation');
    }
    previous = tick;
  }
  return ticks;
}

export function validateCpuResult(value: unknown, runId: string, maxSeconds: number): CpuRunResult {
  const result = resultSchema.parse(value), ticks = validateTicks(result.ticks, runId, maxSeconds), final = ticks.at(-1);
  if (!final || final.state !== result.status || final.billableSeconds !== result.billableSeconds
    || final.outputHash !== outputHash(result.output)) throw new Error('Persisted CPU result failed validation');
  return { ...result, ticks };
}
