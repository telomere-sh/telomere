/** A local scenario model, independent of live prices, booking and settlement. */
export type HostPriceBasis = 'second' | 'hour';
export type HostFeeModel = 'standard' | 'sealed';
export type HostRevenueInput = {
  priceBasis: HostPriceBasis;
  priceUsdc: string;
  paidHoursPerDay: string;
  days: string;
  feeModel: HostFeeModel;
};
export type HostRevenueField = keyof HostRevenueInput;
export type HostRevenueAmount = {grossAtomic: string; feeAtomic: string; netAtomic: string};
export type HostRevenueScenario = {
  feePercent: '9' | '12';
  days: string;
  daily: HostRevenueAmount;
  period: HostRevenueAmount;
};

export class HostRevenueInputError extends Error {
  constructor(public readonly field: HostRevenueField, message: string) {
    super(message);
    this.name = 'HostRevenueInputError';
  }
}

const SCALE = 1_000_000n;
const MAX_PRICE_ATOMIC = 1_000_000_000n * SCALE;
const MAX_ATOMIC = (1n << 256n) - 1n;

function decimal(value: string, field: HostRevenueField, maximum: bigint, message: string): bigint {
  // Bound the text before BigInt parsing. No exponents, signs, grouping or implicit trimming.
  if (typeof value !== 'string' || value.length > 24 || value.trim() !== value || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new HostRevenueInputError(field, 'Enter a plain decimal with up to six decimal places, without signs, spaces or grouping.');
  }
  const [whole = '', fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (atomic > maximum) throw new HostRevenueInputError(field, message);
  return atomic;
}

function amount(gross: bigint, fee: bigint): HostRevenueAmount {
  if (gross > MAX_ATOMIC || fee > gross) throw new RangeError('Scenario exceeds the supported atomic amount.');
  return {grossAtomic: gross.toString(), feeAtomic: fee.toString(), netAtomic: (gross - fee).toString()};
}

/**
 * Gross = price × completed paid time. Fractional hours are modeled continuously.
 * Round gross down to 6 USDC decimals daily, then round that day's fee up to the
 * next atomic unit. Period totals sum identical rounded daily amounts. This is
 * a scenario policy, not a reproduction of any deployed settlement contract.
 */
export function calculateHostRevenue(input: HostRevenueInput): HostRevenueScenario {
  if (input.priceBasis !== 'second' && input.priceBasis !== 'hour') {
    throw new HostRevenueInputError('priceBasis', 'Choose per second or per hour.');
  }
  if (input.feeModel !== 'standard' && input.feeModel !== 'sealed') {
    throw new HostRevenueInputError('feeModel', 'Choose a listed fee scenario.');
  }
  const price = decimal(input.priceUsdc, 'priceUsdc', MAX_PRICE_ATOMIC, 'Price must be between 0 and 1,000,000,000 USDC per chosen unit.');
  const hours = decimal(input.paidHoursPerDay, 'paidHoursPerDay', 24n * SCALE, 'Paid hours must be between 0 and 24 per day.');
  if (typeof input.days !== 'string' || input.days.trim() !== input.days || !/^[1-9]\d{0,2}$/.test(input.days) || BigInt(input.days) > 366n) {
    throw new HostRevenueInputError('days', 'Enter a whole number of days from 1 to 366.');
  }
  const days = BigInt(input.days);
  const feePercent = input.feeModel === 'standard' ? '9' : '12';
  const timeMultiplier = input.priceBasis === 'second' ? 3_600n : 1n;
  const gross = price * hours * timeMultiplier / SCALE;
  const fee = (gross * BigInt(feePercent) + 99n) / 100n;
  return {feePercent, days: input.days, daily: amount(gross, fee), period: amount(gross * days, fee * days)};
}

/** Always display all six decimal places so the rounding unit is visible. */
export function formatHostUsdc(atomic: string): string {
  if (typeof atomic !== 'string' || atomic.trim() !== atomic || !/^(?:0|[1-9]\d{0,77})$/.test(atomic) || BigInt(atomic) > MAX_ATOMIC) throw new RangeError('Invalid atomic USDC amount.');
  const value = BigInt(atomic);
  return `${value / SCALE}.${(value % SCALE).toString().padStart(6, '0')} USDC`;
}
