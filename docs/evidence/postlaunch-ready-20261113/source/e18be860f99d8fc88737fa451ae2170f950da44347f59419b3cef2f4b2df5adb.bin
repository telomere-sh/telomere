import {describe, expect, it} from 'vitest';
import {calculateHostRevenue, formatHostUsdc, HostRevenueInputError, type HostRevenueInput} from '../src/updates/host-revenue.js';

const standard: HostRevenueInput = {priceBasis: 'hour', priceUsdc: '1', paidHoursPerDay: '8', days: '30', feeModel: 'standard'};

describe('host revenue scenario arithmetic', () => {
  it('calculates daily and period amounts exactly for both fee scenarios', () => {
    expect(calculateHostRevenue(standard)).toEqual({feePercent: '9', days: '30', daily: {grossAtomic: '8000000', feeAtomic: '720000', netAtomic: '7280000'}, period: {grossAtomic: '240000000', feeAtomic: '21600000', netAtomic: '218400000'}});
    expect(calculateHostRevenue({...standard, feeModel: 'sealed'}).daily).toEqual({grossAtomic: '8000000', feeAtomic: '960000', netAtomic: '7040000'});
  });
  it('keeps per-second and equivalent hourly scenarios identical', () => {
    const perSecond = calculateHostRevenue({...standard, priceBasis: 'second', priceUsdc: '0.000123', paidHoursPerDay: '1.234567'});
    const hourly = calculateHostRevenue({...standard, priceUsdc: '0.4428', paidHoursPerDay: '1.234567'});
    expect(perSecond).toEqual(hourly);
    expect(perSecond.daily).toEqual({grossAtomic: '546666', feeAtomic: '49200', netAtomic: '497466'});
  });
  it('rounds daily gross down and fee up, then sums daily rounded totals', () => {
    const result = calculateHostRevenue({...standard, priceUsdc: '0.000003', paidHoursPerDay: '0.5', days: '2'});
    expect(result.daily).toEqual({grossAtomic: '1', feeAtomic: '1', netAtomic: '0'});
    expect(result.period).toEqual({grossAtomic: '2', feeAtomic: '2', netAtomic: '0'});
    expect(calculateHostRevenue({...standard, priceUsdc: '0.000001', paidHoursPerDay: '0.5'}).daily).toEqual({grossAtomic: '0', feeAtomic: '0', netAtomic: '0'});
  });
  it('does not add a fee unit when the percentage is already exact', () => {
    expect(calculateHostRevenue({...standard, priceUsdc: '0.0001', paidHoursPerDay: '1'}).daily).toEqual({grossAtomic: '100', feeAtomic: '9', netAtomic: '91'});
  });
  it('accepts genuine zero price or paid time and the maximum bounded scenario', () => {
    for (const input of [{...standard, priceUsdc: '0'}, {...standard, paidHoursPerDay: '0'}]) {
      expect(calculateHostRevenue(input).period).toEqual({grossAtomic: '0', feeAtomic: '0', netAtomic: '0'});
    }
    const maximum = calculateHostRevenue({...standard, priceBasis: 'second', priceUsdc: '1000000000.000000', paidHoursPerDay: '24.000000', days: '366', feeModel: 'sealed'});
    expect(maximum.period).toEqual({grossAtomic: '31622400000000000000000', feeAtomic: '3794688000000000000000', netAtomic: '27827712000000000000000'});
  });
  it('formats six decimals without converting atomic amounts to floating point', () => {
    expect(formatHostUsdc('0')).toBe('0.000000 USDC');
    expect(formatHostUsdc('1')).toBe('0.000001 USDC');
    expect(formatHostUsdc('31622400000000000000000')).toBe('31622400000000000.000000 USDC');
    for (const value of ['-1', '1.1', '1e9', '00', '9'.repeat(100)]) expect(() => formatHostUsdc(value)).toThrow();
  });
});

describe('host revenue scenario validation', () => {
  it.each(['', ' ', ' 1', '1 ', '-1', '+1', '1e3', '1E3', '.1', '1.', '01', '1,000', 'NaN', 'Infinity', '0x10', '1\n', '1.0000001', '9'.repeat(1000), '1000000000.000001'])('rejects malformed, over-precision or overflowing prices: %j', priceUsdc => {
    expect(() => calculateHostRevenue({...standard, priceUsdc})).toThrow(HostRevenueInputError);
  });
  it.each(['-1', '24.000001', '25', '0.1234567', '1e1', ''])('rejects invalid paid hours: %j', paidHoursPerDay => {
    expect(() => calculateHostRevenue({...standard, paidHoursPerDay})).toThrow(HostRevenueInputError);
  });
  it.each(['0', '367', '1.0', '-1', '01', '1e2', ' 30', '', '9'.repeat(1000)])('rejects invalid days: %j', days => {
    expect(() => calculateHostRevenue({...standard, days})).toThrow(HostRevenueInputError);
  });
  it('reports the invalid field and rejects unlisted price and fee models', () => {
    for (const [field, value] of [['priceBasis', 'minute'], ['feeModel', 'legacy'], ['priceUsdc', 1], ['paidHoursPerDay', 1], ['days', 1]] as const) {
      try {
        calculateHostRevenue({...standard, [field]: value} as HostRevenueInput);
        expect.fail('Expected field validation');
      } catch (failure: unknown) {
        expect(failure).toBeInstanceOf(HostRevenueInputError);
        expect((failure as HostRevenueInputError).field).toBe(field);
      }
    }
  });
});
