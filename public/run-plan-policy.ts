/** Planning feedback only. The server and contract still authorize every run. */
export interface RunPlanLeash {
  name?: string;
  hourly: unknown;
  daily: unknown;
  hardware?: string;
  expiry?: string;
  sealed?: boolean;
  killed?: boolean;
}
export interface RunPlanValues {
  hardware: string;
  lane: string;
  minutes: unknown;
  rate: unknown;
  ceiling: unknown;
}
export type RunPlanField = 'minutes' | 'rate' | 'ceiling' | 'hardware' | 'lane' | 'leash';
export interface RunPlanContext {
  leash?: RunPlanLeash;
  maxSeconds: unknown;
  budget?: unknown;
  allocatedCeiling?: unknown;
  now?: number;
}

const epsilon = 1e-9;
function amount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
export function formatPlanAmount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : 'Unavailable';
}
/** Retain the original planner's first-hour formula, including lane allowance. */
export function planningHourlySpend(rate: number, minutes: number, lane: string): number {
  return rate * Math.min(Math.max(minutes, 0) / 60, 1) * (lane === 'Sealed' ? 1.12 : 1.09);
}
export function runPlanLimits(leash: RunPlanLeash | undefined, maximumSeconds: unknown) {
  const maximum = amount(maximumSeconds);
  const cpuMaxSeconds = maximum !== null && Number.isSafeInteger(maximum) && maximum > 0 ? maximum : null;
  return {
    cpuMaxSeconds,
    cpuMaxMinutes: cpuMaxSeconds === null ? null : cpuMaxSeconds / 60,
    hourly: leash ? amount(leash.hourly) : null,
    daily: leash ? amount(leash.daily) : null,
    expiry: leash?.expiry || null,
    hardware: leash?.hardware || 'Any',
    sealed: leash?.sealed === true,
    killed: leash?.killed === true,
  };
}
export function validateRunPlan(values: RunPlanValues, context: RunPlanContext): {
  errors: Partial<Record<RunPlanField, string>>;
  estimated: number | null;
  firstHour: number | null;
} {
  const errors: Partial<Record<RunPlanField, string>> = {};
  const minutes = amount(values.minutes), rate = amount(values.rate), ceiling = amount(values.ceiling);
  const limits = runPlanLimits(context.leash, context.maxSeconds);
  const cpu = values.hardware === 'CPU';
  if (minutes === null || minutes <= 0 || minutes > 1440) {
    errors.minutes = 'Maximum minutes: enter a duration greater than 0 and no more than 1,440 minutes.';
  } else if (cpu && limits.cpuMaxSeconds === null) {
    errors.minutes = 'Maximum minutes: the CPU time limit is unavailable. Reload the workspace before saving a CPU plan.';
  } else if (cpu && minutes * 60 < 1 - epsilon) {
    errors.minutes = 'Maximum minutes: allow at least 1 second of CPU time (1/60 of a minute).';
  } else if (cpu && limits.cpuMaxSeconds !== null && minutes * 60 > limits.cpuMaxSeconds + epsilon) {
    errors.minutes = `Maximum minutes: this CPU profile allows up to ${String(limits.cpuMaxSeconds / 60)} minutes (${limits.cpuMaxSeconds} seconds). Enter that duration or less.`;
  }
  if (rate === null) errors.rate = 'Planning rate: enter a non-negative USDC amount per hour.';
  if (ceiling === null || ceiling < 0.01 || ceiling > 250) errors.ceiling = 'Spending ceiling: enter at least 0.01 and no more than 250 USDC.';
  else if (!/^\d+(?:\.\d{1,6})?$/.test(String(ceiling))) errors.ceiling = 'Spending ceiling: USDC supports up to 6 decimal places. Round this amount to 6 decimal places or fewer.';
  const estimated = minutes !== null && rate !== null ? rate * minutes / 60 * (values.lane === 'Sealed' ? 1.12 : 1.09) : null;
  const firstHour = minutes !== null && rate !== null ? planningHourlySpend(rate, minutes, values.lane) : null;

  if (context.leash) {
    if (limits.killed) errors.leash = 'Leash policy: this policy is revoked. Choose an active Leash.';
    else if (limits.hourly === null || limits.daily === null) errors.leash = 'Leash policy: spending limits are unavailable. Reload the workspace or choose another policy.';
    if (limits.expiry) {
      const expiry = Date.parse(limits.expiry + 'T23:59:59.999Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(limits.expiry) || !Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 10) !== limits.expiry) errors.leash = 'Leash policy: the expiry date is invalid. Reload the workspace or choose another policy.';
      else if (expiry < (context.now ?? Date.now())) errors.leash = 'Leash policy: this policy has expired. Choose an active Leash.';
    }
    if (limits.hardware !== 'Any' && limits.hardware !== values.hardware) errors.hardware = `Hardware class: this Leash permits ${limits.hardware}. Choose that hardware or a different Leash.`;
    if (limits.sealed && values.lane !== 'Sealed') errors.lane = 'Lane: this Leash requires Sealed hosts. Choose Sealed or a different Leash.';
    if (ceiling !== null && limits.daily !== null && ceiling > limits.daily + epsilon) {
      errors.ceiling = `Spending ceiling: the selected Leash allows at most ${formatPlanAmount(limits.daily)} USDC per day. Enter that amount or less.`;
    }
    if (firstHour !== null && limits.hourly !== null && firstHour > limits.hourly + epsilon) {
      errors.rate = `Planning rate: this duration would use ${formatPlanAmount(firstHour)} USDC within the first hour, above the Leash limit of ${formatPlanAmount(limits.hourly)} USDC. Lower Planning rate or Maximum minutes.`;
    }
  }
  const budget = amount(context.budget), allocated = amount(context.allocatedCeiling ?? 0);
  const remaining = budget !== null && budget > 0 && allocated !== null ? Math.max(0, budget - allocated) : null;
  if (ceiling !== null && remaining !== null && ceiling > remaining + epsilon) {
    errors.ceiling = `Spending ceiling: only ${formatPlanAmount(remaining)} USDC remains in the workspace planning budget. Lower this ceiling or increase the workspace budget.`;
  }
  const upper = Math.min(context.leash && limits.daily !== null ? limits.daily : Infinity, remaining ?? Infinity, 250);
  if (estimated !== null && estimated > upper + epsilon) {
    errors.rate = `Planning rate: the estimated ${formatPlanAmount(estimated)} USDC exceeds the allowed ceiling of ${formatPlanAmount(upper)} USDC. Lower Planning rate or Maximum minutes; increasing the ceiling cannot fit this plan within the current limits.`;
  } else if (estimated !== null && ceiling !== null && estimated > ceiling + epsilon && !errors.ceiling) {
    errors.ceiling = `Spending ceiling: this plan needs at least ${formatPlanAmount(estimated)} USDC. Increase the ceiling within its limits, or lower Planning rate or Maximum minutes.`;
  }
  return { errors, estimated, firstHour };
}
