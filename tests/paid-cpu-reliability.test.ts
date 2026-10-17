import { describe, expect, it } from 'vitest';
import { hashJson } from '../src/common.js';
import { platformWorkloadHash, validatedPlatformQuoteInputSchema } from '../src/platform-runtime/types.js';
import { paidCpuJobInputSchema } from '../src/scheduling/paid-job-types.js';
import { paidCpuReliability } from '../src/scheduling/paid-reliability.js';

const id: `0x${string}` = `0x${'1'.repeat(64)}`;
const other: `0x${string}` = `0x${'2'.repeat(64)}`;
const imageDigest = `sha256:${'a'.repeat(64)}`;
describe('paid CPU consent and observed thirty-day reliability', () => {
  it('preserves omitted-field signatures and binds every replacement authority field', () => {
    const task = { kind: 'session' as const, imageDigest, maxCommands: 4 };
    expect(platformWorkloadHash({ task })).toBe(hashJson({ task }));
    const input = { task, cpuScheduling: { version: 1 as const, lane: 'interruptible' as const,
      interruptibleConsent: { minimumNoticeSeconds: 30 as const },
      job: { jobId: id, intentHash: other, sourceRunId: id, sourceQuoteHash: other, decisionHash: id, targetHostId: other } } };
    const signature = platformWorkloadHash(input);
    expect(signature).not.toBe(platformWorkloadHash({ task }));
    for (const field of ['jobId', 'intentHash', 'sourceRunId', 'sourceQuoteHash', 'decisionHash', 'targetHostId'] as const) {
      const changed = structuredClone(input); changed.cpuScheduling.job[field] = `0x${'3'.repeat(64)}`;
      expect(platformWorkloadHash(changed)).not.toBe(signature);
    }
    expect(platformWorkloadHash({ ...input, cpuScheduling: { ...input.cpuScheduling, lane: 'standard' } })).not.toBe(signature);
  });
  it('rejects unconsented and short interruptible work at both initial quote and owner job boundaries', () => {
    const base = { leashId: id, task: { kind: 'session', imageDigest, maxCommands: 4 }, maxSeconds: 60,
      deadline: 1000, maxSpend: '10000', regions: [] };
    for (const scheduling of [{ version: 1, lane: 'interruptible' },
      { version: 1, lane: 'interruptible', interruptibleConsent: { minimumNoticeSeconds: 29 } },
      { version: 1, lane: 'standard', interruptibleConsent: { minimumNoticeSeconds: 30 } }]) {
      expect(validatedPlatformQuoteInputSchema.safeParse({ ...base, cpuScheduling: scheduling }).success).toBe(false);
    }
    expect(validatedPlatformQuoteInputSchema.safeParse({ ...base, maxSeconds: 30,
      cpuScheduling: { version: 1, lane: 'interruptible', interruptibleConsent: { minimumNoticeSeconds: 30 } } }).success).toBe(false);
    expect(paidCpuJobInputSchema.safeParse({ protocol: 'telomere-paid-cpu-job-v1', leashId: id, task: base.task,
      workSeconds: 60, deadline: 1000, maxSpend: '10000', lanes: ['standard', 'interruptible'] }).success).toBe(false);
  });
  it('scopes observations by host and original lane, expires old samples, and exposes the neutral prior', () => {
    const now = 40 * 86400, from = now - 30 * 86400;
    const records = [
      { hostId: id, lane: 'interruptible' as const, endedAt: from, cleanOutcome: true },
      { hostId: id, lane: 'interruptible' as const, endedAt: now, cleanOutcome: false },
      { hostId: id, lane: 'standard' as const, endedAt: now, cleanOutcome: true },
      { hostId: other, lane: 'interruptible' as const, endedAt: now, cleanOutcome: true },
      { hostId: id, lane: 'interruptible' as const, endedAt: from - 1, cleanOutcome: true },
      { hostId: id, lane: 'interruptible' as const, endedAt: now + 1, cleanOutcome: true },
    ];
    expect(paidCpuReliability(id, 'interruptible', now, records, 1)).toMatchObject({ eligible: 2, completed: 1,
      reliabilityBps: 5000, excludedUnverified: 1, marketWide: false, scope: 'verified-local-controller-history' });
    expect(paidCpuReliability(other, 'standard', now, records)).toMatchObject({ eligible: 0, completed: 0,
      reliabilityBps: 10000, noHistoryPrior: 10000 });
    expect(paidCpuReliability(id, 'interruptible', now + 31 * 86400, records).eligible).toBe(0);
  });
});
