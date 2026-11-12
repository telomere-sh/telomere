import { describe, expect, it } from 'vitest';
import { formatPlanAmount, planningHourlySpend, runPlanLimits, validateRunPlan, type RunPlanLeash, type RunPlanValues } from '../public/run-plan-policy.js';

const leash: RunPlanLeash = { name: 'test-prerelease', hourly: '0.01', daily: '0.05', hardware: 'CPU', expiry: '2026-11-13', killed: false };
const now = Date.parse('2026-11-12T17:00:00Z');
const plan: RunPlanValues = { hardware: 'CPU', lane: 'Standard', minutes: '1', rate: '0.36', ceiling: '0.01' };
const validate = (values: Partial<RunPlanValues> = {}, policy: RunPlanLeash | undefined = leash, maxSeconds: unknown = 120) =>
  validateRunPlan({ ...plan, ...values }, { leash: policy, maxSeconds, now });

describe('run-plan limits and actionable feedback', () => {
  it('accepts the short CPU plan that fits the selected real policy boundaries', () => {
    const result = validate();
    expect(result.errors).toEqual({});
    expect(result.estimated).toBeCloseTo(0.00654, 10);
    expect(result.firstHour).toBeCloseTo(0.00654, 10);
  });
  it('explains all three independent problems in the supplied 50-minute example', () => {
    const result = validate({ minutes: '50', rate: '1', ceiling: '5' });
    expect(result.errors.minutes).toContain('120 seconds');
    expect(result.errors.minutes).toContain('2 minutes');
    expect(result.errors.ceiling).toContain('0.05 USDC');
    expect(result.errors.rate).toContain('Planning rate');
    expect(result.errors.rate).toContain('Lower');
  });
  it('uses changed server duration instead of a hardcoded two-minute cap', () => {
    expect(runPlanLimits(leash, 90).cpuMaxMinutes).toBe(1.5);
    expect(validate({ minutes: '2', rate: '0' }, leash, 90).errors.minutes).toContain('90 seconds');
    expect(validate({ minutes: '1.5', rate: '0' }, leash, 90).errors).toEqual({});
    expect(validate({ minutes: '5', rate: '0' }, leash, 600).errors.minutes).toBeUndefined();
  });
  it.each([undefined, null, 0, -1, 'not-a-limit', Infinity, 1.5])('fails closed when CPU duration metadata is invalid: %s', maximum => {
    expect(runPlanLimits(leash, maximum).cpuMaxSeconds).toBeNull();
    expect(validateRunPlan(plan, { leash, maxSeconds: maximum, now }).errors.minutes).toContain('unavailable');
  });
  it('does not apply CPU duration limits to GPU planning', () => {
    expect(validate({ hardware: 'RTX', minutes: '50', rate: '0' }, { ...leash, hardware: 'Any' }, 120).errors.minutes).toBeUndefined();
  });
  it('can save an unattached draft without inventing a policy', () => {
    const result = validateRunPlan(plan, { maxSeconds: 120, now });
    expect(result.errors).toEqual({});
    expect(runPlanLimits(undefined, 120)).toMatchObject({ hourly: null, daily: null, expiry: null });
  });
  it('clears errors when amounts or policy are corrected', () => {
    expect(validate({ ceiling: '5' }).errors.ceiling).toBeDefined();
    expect(validate().errors).toEqual({});
    expect(validate({ ceiling: '5' }, { ...leash, daily: 10 }).errors.ceiling).toBeUndefined();
  });
  it('names rate rather than suggesting an impossible ceiling increase', () => {
    const result = validate({ minutes: 2, rate: 1, ceiling: 0.01 }, { ...leash, daily: 0.02, hourly: 1 });
    expect(result.errors.rate).toContain('increasing the ceiling cannot fit');
    expect(result.errors.ceiling).toBeUndefined();
  });
  it('names the ceiling when estimate fits policy but exceeds the entered ceiling', () => {
    const result = validate({ rate: 0.9 }, { ...leash, daily: 1, hourly: 1 });
    expect(result.errors.ceiling).toContain('0.01635 USDC');
    expect(result.errors.rate).toBeUndefined();
  });
  it('preserves hourly allowance across plans longer than one hour', () => {
    expect(planningHourlySpend(1, 50, 'Standard')).toBeCloseTo(0.9083333333);
    expect(planningHourlySpend(1, 120, 'Standard')).toBeCloseTo(1.09);
    expect(planningHourlySpend(1, 60, 'Sealed')).toBeCloseTo(1.12);
  });
  it('keeps exact cap equality valid and a larger value invalid', () => {
    expect(validate({ ceiling: '0.05', rate: 0 }).errors.ceiling).toBeUndefined();
    expect(validate({ ceiling: '0.050001', rate: 0 }).errors.ceiling).toContain('0.05');
  });
  it('preserves expiry, revocation, hardware and sealed restrictions', () => {
    expect(validate({}, { ...leash, expiry: '2026-11-11' }).errors.leash).toContain('expired');
    expect(validate({}, { ...leash, expiry: '2026-02-30' }).errors.leash).toContain('invalid');
    expect(validate({}, { ...leash, killed: true }).errors.leash).toContain('revoked');
    expect(validate({ hardware: 'RTX' }).errors.hardware).toContain('CPU');
    expect(validate({}, { ...leash, sealed: true }).errors.lane).toContain('Sealed');
  });
  it('fails malformed selected policy limits instead of treating them as unlimited', () => {
    expect(validate({}, { ...leash, daily: '' }).errors.leash).toContain('unavailable');
    expect(validate({}, { ...leash, hourly: 'bad' }).errors.leash).toContain('unavailable');
  });
  it.each([{ minutes: '' }, { rate: -1 }, { rate: 'bad' }, { ceiling: 0 }, { ceiling: 251 }, { ceiling: 0.001 }])('rejects invalid amount input %j', input => {
    expect(Object.keys(validate(input).errors).length).toBeGreaterThan(0);
  });
  it('checks workspace remaining budget without changing the Leash', () => {
    const result = validateRunPlan({ ...plan, ceiling: 0.03 }, { leash, maxSeconds: 120, budget: 1, allocatedCeiling: 0.98, now });
    expect(result.errors.ceiling).toContain('0.02 USDC');
    expect(result.errors.ceiling).toContain('workspace');
    expect(leash.daily).toBe('0.05');
  });
  it('uses a minimum of one CPU second', () => {
    expect(validate({ minutes: 0.01 }).errors.minutes).toContain('at least 1 second');
    expect(validate({ minutes: 1 / 60 }, leash, 1).errors.minutes).toBeUndefined();
  });
  it('shows meaningful precision for sub-cent USDC amounts', () => {
    expect(formatPlanAmount(0.00654)).toBe('0.00654');
    expect(formatPlanAmount(0.01)).toBe('0.01');
    expect(formatPlanAmount(5)).toBe('5');
  });
  it('rejects ceiling precision that the wallet transaction cannot represent', () => {
    expect(validate({ ceiling: '0.0100000001' }).errors.ceiling).toContain('6 decimal places');
    expect(validate({ ceiling: '0.01000000000001' }).errors.ceiling).toContain('6 decimal places');
    expect(validate({ ceiling: 0.10000000000000002 }, { ...leash, daily: 1 }).errors.ceiling).toContain('6 decimal places');
    expect(validate({ ceiling: '0.010001' }).errors.ceiling).toBeUndefined();
  });
  it('does not suggest a minute bound that would reject itself', () => {
    const maximum = 119, minutes = String(maximum / 60);
    expect(validate({ minutes, rate: '0' }, leash, maximum).errors.minutes).toBeUndefined();
    expect(validate({ minutes: '2', rate: '0' }, leash, maximum).errors.minutes).toContain(minutes);
  });
});
