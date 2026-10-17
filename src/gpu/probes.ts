import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { gpuSnapshotSchema, gpuUuidSchema, type GpuSnapshot } from './inventory.js';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const gpuClassPolicySchema = z.object({
  classId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  minimumDriverMajor: z.number().int().min(550).max(9999),
  minimumMemoryMiB: z.number().int().min(1024).max(1_048_576),
  memoryChallengeMiB: z.number().int().min(1024).max(1_048_576),
  memoryHeadroomMiB: z.number().int().min(256).max(65_536),
  minimumPowerRatio: z.number().min(0.5).max(1),
  gemmTflops: z.object({ minimum: z.number().positive(), maximum: z.number().positive() }).strict(),
  bandwidthGiBs: z.object({ minimum: z.number().positive(), maximum: z.number().positive() }).strict(),
  probeImageDigest: digestSchema,
}).strict().refine(value => value.gemmTflops.minimum <= value.gemmTflops.maximum
  && value.bandwidthGiBs.minimum <= value.bandwidthGiBs.maximum
  && value.memoryChallengeMiB + value.memoryHeadroomMiB <= value.minimumMemoryMiB);
export type GpuClassPolicy = z.infer<typeof gpuClassPolicySchema>;

export const gpuProbeBindingSchema = z.object({
  uuid: gpuUuidSchema, isolation: z.enum(['gvisor_nvproxy', 'kata_gpu']),
  imageDigest: digestSchema,
}).strict();
export type GpuProbeBinding = z.infer<typeof gpuProbeBindingSchema>;

export const gpuChallengeSchema = z.object({ version: z.literal(1), kind: z.enum(['class', 'memory', 'warm']),
  runId: z.string().regex(/^0x[a-f0-9]{64}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/), seed: z.string().regex(/^[a-f0-9]{64}$/),
  uuid: gpuUuidSchema, requestedMemoryMiB: z.number().int().nonnegative(),
  issuedAtMs: z.number().int().nonnegative(), deadlineAtMs: z.number().int().nonnegative(),
}).strict();
export type GpuChallenge = z.infer<typeof gpuChallengeSchema>;
export type GpuAdmissionChallenge = GpuChallenge & { kind: 'class' | 'memory' };

export const gpuProbeReportSchema = z.object({ version: z.literal(1), kind: gpuChallengeSchema.shape.kind,
  runId: gpuChallengeSchema.shape.runId, nonce: gpuChallengeSchema.shape.nonce, seed: gpuChallengeSchema.shape.seed, uuid: gpuUuidSchema,
  startedAtMs: z.number().int().nonnegative(), finishedAtMs: z.number().int().nonnegative(),
  kernelElapsedMs: z.number().int().positive().max(20_000),
  gemmTflops: z.number().nonnegative().finite().max(100_000),
  bandwidthGiBs: z.number().nonnegative().finite().max(100_000),
  verifiedMemoryMiB: z.number().int().nonnegative().max(1_048_576),
  integrityPassed: z.boolean(), throttled: z.boolean(),
}).strict();
export type GpuProbeReport = z.infer<typeof gpuProbeReportSchema>;

/** The adapter MUST run reviewed fixed-seed admission kernels in isolated
 * probe cells, allocate/read back requested VRAM and confirm cleanup.
 * Warm probes are deliberately absent: GpuWarmCell runs those in the workload.
 * A caller-supplied JSON report is never a trusted implementation of this API. */
export interface GpuProbeDriver {
  readonly binding: GpuProbeBinding;
  run(challenge: GpuAdmissionChallenge, signal: AbortSignal): Promise<{ report: unknown; cleanupConfirmed: boolean }>;
}

const rejected = () => new Error('GPU probe rejected; device requires reconciliation');
export function checkGpuSnapshot(raw: unknown, policyRaw: unknown, uuid: string): GpuSnapshot {
  const snapshot = gpuSnapshotSchema.parse(raw), policy = gpuClassPolicySchema.parse(policyRaw);
  if (snapshot.uuid !== gpuUuidSchema.parse(uuid) || snapshot.driverMajor < policy.minimumDriverMajor
    || snapshot.totalMemoryMiB < policy.minimumMemoryMiB
    || snapshot.freeMemoryMiB < policy.memoryChallengeMiB + policy.memoryHeadroomMiB
    || snapshot.powerLimitWatts < snapshot.defaultPowerLimitWatts * policy.minimumPowerRatio) throw rejected();
  return snapshot;
}

export function newGpuChallenge<K extends GpuChallenge['kind']>(kind: K, uuid: string, runId: string,
  requestedMemoryMiB: number, nowMs = Date.now()): GpuChallenge & { kind: K } {
  return gpuChallengeSchema.parse({ version: 1, kind, nonce: randomBytes(32).toString('hex'), seed: randomBytes(32).toString('hex'),
    uuid, runId, requestedMemoryMiB, issuedAtMs: nowMs, deadlineAtMs: nowMs + (kind === 'memory' ? 15_000 : 10_000) }) as GpuChallenge & { kind: K };
}

export function checkGpuProbe(raw: unknown, challengeRaw: unknown, policyRaw: unknown, observedAtMs = Date.now()): {
  report: GpuProbeReport; evidenceHash: string;
} {
  const report = gpuProbeReportSchema.parse(raw), challenge = gpuChallengeSchema.parse(challengeRaw), policy = gpuClassPolicySchema.parse(policyRaw);
  if (report.kind !== challenge.kind || report.runId !== challenge.runId || report.nonce !== challenge.nonce || report.seed !== challenge.seed || report.uuid !== challenge.uuid
    || report.startedAtMs < challenge.issuedAtMs || report.finishedAtMs < report.startedAtMs
    || report.finishedAtMs > challenge.deadlineAtMs || report.finishedAtMs > observedAtMs + 1000
    || observedAtMs > challenge.deadlineAtMs + 1000
    || report.kernelElapsedMs > report.finishedAtMs - report.startedAtMs + 1000
    || !report.integrityPassed || report.throttled) throw rejected();
  if (challenge.kind === 'memory') {
    if (challenge.requestedMemoryMiB !== policy.memoryChallengeMiB || report.verifiedMemoryMiB < challenge.requestedMemoryMiB
      || report.gemmTflops !== 0 || report.bandwidthGiBs !== 0) throw rejected();
  } else if (challenge.requestedMemoryMiB !== 0 || report.verifiedMemoryMiB !== 0
    || report.gemmTflops < policy.gemmTflops.minimum || report.gemmTflops > policy.gemmTflops.maximum
    || report.bandwidthGiBs < policy.bandwidthGiBs.minimum || report.bandwidthGiBs > policy.bandwidthGiBs.maximum) throw rejected();
  return { report, evidenceHash: createHash('sha256').update(JSON.stringify({ challenge, report })).digest('hex') };
}
