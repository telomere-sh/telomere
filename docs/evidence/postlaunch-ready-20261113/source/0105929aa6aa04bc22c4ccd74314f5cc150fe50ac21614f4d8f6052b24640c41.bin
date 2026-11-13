/** Editable spending suggestions. This module never submits or signs a policy. */
export type LeashLimits = {maxPerHourAtomic: string; maxPerDayAtomic: string};
export type LeashAmounts = LeashLimits & {hourly: string; daily: string};
export type LeashValidation<T> = {ok: true; value: T} | {ok: false; field: 'hourly' | 'daily' | 'both'; message: string};

const SCALE = 1_000_000n;
export const LEASH_PREAUDIT_LIMITS: Readonly<LeashLimits> = Object.freeze({
  maxPerHourAtomic: '250000000', maxPerDayAtomic: '1000000000',
});
export const LEASH_PRESETS = Object.freeze([
  Object.freeze({id: 'conservative', label: 'Conservative', hourly: '0.1', daily: '1'}),
  Object.freeze({id: 'standard', label: 'Standard', hourly: '1', daily: '10'}),
  Object.freeze({id: 'selection-max', label: 'Selection-max', hourly: '20', daily: '200'}),
]);

/** Decimal notation only: no floating point, rounding, signs or exponents. */
export function parseUsdcAtomic(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'))).toString();
}

function atomic(value: unknown): bigint | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,18})$/.test(value) ? BigInt(value) : null;
}

/** Canonical decimal string suitable for an existing number input. */
export function formatUsdcAtomic(value: string): string {
  const amount = atomic(value);
  if (amount === null) throw new TypeError('Expected an unsigned atomic USDC string.');
  const fraction = (amount % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / SCALE}${fraction ? `.${fraction}` : ''}`;
}

export function resolveLeashLimits(limits: LeashLimits = LEASH_PREAUDIT_LIMITS): LeashValidation<LeashLimits> {
  if (typeof limits !== 'object' || limits === null) return {ok: false, field: 'both', message: 'Spending limit configuration is unavailable. Keep editing the existing fields.'};
  const hour = atomic(limits.maxPerHourAtomic);
  const day = atomic(limits.maxPerDayAtomic);
  if (hour === null || day === null || hour <= 0n || day <= 0n
    || hour > BigInt(LEASH_PREAUDIT_LIMITS.maxPerHourAtomic)
    || day > BigInt(LEASH_PREAUDIT_LIMITS.maxPerDayAtomic) || day < hour) {
    return {ok: false, field: 'both', message: 'Spending limit configuration is invalid. Keep editing the existing fields.'};
  }
  return {ok: true, value: {maxPerHourAtomic: hour.toString(), maxPerDayAtomic: day.toString()}};
}

export function validateLeashValues(hourly: unknown, daily: unknown, limits?: LeashLimits): LeashValidation<LeashAmounts> {
  const cap = resolveLeashLimits(limits);
  if (!cap.ok) return cap;
  const hour = parseUsdcAtomic(hourly);
  const day = parseUsdcAtomic(daily);
  if (hour === null || BigInt(hour) <= 0n) return {ok: false, field: 'hourly', message: 'Use a positive hourly amount with up to six decimal places.'};
  if (day === null || BigInt(day) <= 0n) return {ok: false, field: 'daily', message: 'Use a positive daily amount with up to six decimal places.'};
  if (BigInt(day) < BigInt(hour)) return {ok: false, field: 'daily', message: 'The daily limit must be at least the hourly limit.'};
  if (BigInt(hour) > BigInt(cap.value.maxPerHourAtomic)) return {ok: false, field: 'hourly', message: `This preset exceeds the hourly cap of ${formatUsdcAtomic(cap.value.maxPerHourAtomic)} USDC. Choose a lower preset or edit the hourly field.`};
  if (BigInt(day) > BigInt(cap.value.maxPerDayAtomic)) return {ok: false, field: 'daily', message: `This preset exceeds the daily cap of ${formatUsdcAtomic(cap.value.maxPerDayAtomic)} USDC. Choose a lower preset or edit the daily field.`};
  return {ok: true, value: {hourly: formatUsdcAtomic(hour), daily: formatUsdcAtomic(day), maxPerHourAtomic: hour, maxPerDayAtomic: day}};
}

export function resolveLeashPreset(id: unknown, limits?: LeashLimits): LeashValidation<LeashAmounts> {
  const preset = LEASH_PRESETS.find(item => item.id === id);
  if (!preset) return {ok: false, field: 'both', message: 'Choose one of the listed spending presets.'};
  return validateLeashValues(preset.hourly, preset.daily, limits);
}

/** Check native number constraints before either field changes. */
function supportedValue(input: HTMLInputElement, value: string): boolean {
  if (input.disabled || input.readOnly) return false;
  const amount = parseUsdcAtomic(value);
  const minText = input.getAttribute('min');
  const maxText = input.getAttribute('max');
  const stepText = input.getAttribute('step');
  const min = minText === null ? '0' : parseUsdcAtomic(minText);
  const max = maxText === null ? null : parseUsdcAtomic(maxText);
  if (amount === null || min === null || (maxText !== null && max === null)) return false;
  const units = BigInt(amount);
  if (units < BigInt(min) || (max !== null && units > BigInt(max))) return false;
  if (stepText === 'any') return true;
  const step = parseUsdcAtomic(stepText ?? '1');
  return step !== null && BigInt(step) > 0n && (units - BigInt(min)) % BigInt(step) === 0n;
}

const mounts = new WeakMap<HTMLFormElement, {limits: LeashLimits | undefined; clear: () => void}>();
let nextMessageId = 0;

export function mountLeashPresets(form: HTMLFormElement, limits?: LeashLimits): void {
  const existing = mounts.get(form);
  if (existing) {
    existing.limits = limits;
    existing.clear();
    return;
  }
  const hourly = form.querySelector<HTMLInputElement>('input[name="hourly"][type="number"]');
  const daily = form.querySelector<HTMLInputElement>('input[name="daily"][type="number"]');
  if (!hourly || !daily) return;
  const doc = form.ownerDocument;
  const region = doc.createElement('div');
  region.className = 'leash-presets';
  region.setAttribute('role', 'group');
  region.setAttribute('aria-label', 'Editable spending presets');
  const help = doc.createElement('p');
  help.className = 'form-help';
  help.textContent = 'Choose a starting limit, then edit the amounts. Presets fill the hourly and daily fields. Review and save the policy when ready. Selection-max sets limits only; it does not create a Selection Vault.';
  const controls = doc.createElement('div');
  controls.className = 'leash-presets-actions';
  const error = doc.createElement('p');
  error.className = 'form-error';
  error.setAttribute('role', 'alert');
  do { error.id = `leash-preset-message-${++nextMessageId}`; } while (doc.getElementById(error.id));
  const status = doc.createElement('p');
  status.className = 'form-help leash-presets-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  for (const input of [hourly, daily]) {
    const descriptions = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    input.setAttribute('aria-describedby', [...descriptions, error.id].join(' '));
  }
  let applying = false;
  const clear = () => {
    if (applying) return;
    error.textContent = '';
    status.textContent = '';
    delete region.dataset['appliedPreset'];
  };
  const state = {limits, clear};
  mounts.set(form, state);
  for (const preset of LEASH_PRESETS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'pill';
    button.textContent = `${preset.label} · ${preset.hourly}/hour · ${preset.daily}/day`;
    button.setAttribute('aria-label', `${preset.label}: ${preset.hourly} USDC per hour, ${preset.daily} USDC per day`);
    button.addEventListener('click', () => {
      clear();
      const result = resolveLeashPreset(preset.id, state.limits);
      if (!result.ok) { error.textContent = result.message; return; }
      if (!supportedValue(hourly, result.value.hourly) || !supportedValue(daily, result.value.daily)) {
        error.textContent = 'This preset does not fit the current hourly or daily field limits. Edit the fields or choose another preset.';
        return;
      }
      applying = true;
      try {
        hourly.value = result.value.hourly;
        daily.value = result.value.daily;
        const EventClass = doc.defaultView?.Event ?? Event;
        for (const input of [hourly, daily]) {
          input.dispatchEvent(new EventClass('input', {bubbles: true}));
          input.dispatchEvent(new EventClass('change', {bubbles: true}));
        }
      } finally { applying = false; }
      region.dataset['appliedPreset'] = preset.id;
      status.textContent = `${preset.label} applied: ${result.value.hourly} USDC per hour and ${result.value.daily} USDC per day. Amounts remain editable. Review and save when ready.`;
    });
    controls.append(button);
  }
  region.append(help, controls, error, status);
  form.insertBefore(region, hourly.closest('.form-row') ?? hourly.closest('.field') ?? hourly);
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
  form.addEventListener('reset', clear);
}
