import { describe, expect, it } from 'vitest';
import { MAX_COUNTED_HOST_COLLATERAL, selectCapacity, type Capacity } from '../src/scheduling/planner.js';

const imageDigest = `sha256:${'11'.repeat(32)}`;
const request = {
  hardwareClasses: ['cpu' as const], regions: ['eu-private'], images: [imageDigest], sealedOnly: false,
  lanes: ['standard' as const], seconds: 10, maxSpend: '2000', deadline: 200, now: 100,
};
function host(id: string, pricePerSecond: string, stake: string): Capacity {
  return { hostId: `0x${id.repeat(64)}`, hardwareClass: 'cpu', region: 'eu-private', imageDigest,
    sealed: false, lane: 'standard', pricePerSecond, reliabilityBps: 10000, strikes: 0, stake, availableAt: 100 };
}

describe('pre-audit counted host collateral ceiling', () => {
  it('counts every unit up to the exact 25,000-token boundary within the eligible price band', () => {
    expect(MAX_COUNTED_HOST_COLLATERAL).toBe(25_000_000_000n);
    const cheaper = host('1', '100', (MAX_COUNTED_HOST_COLLATERAL - 1n).toString());
    const dearer = host('2', '104', MAX_COUNTED_HOST_COLLATERAL.toString());
    expect(selectCapacity(request, [cheaper, dearer]).host.hostId).toBe(dearer.hostId);
  });

  it('gives no scheduling advantage to collateral above 25,000 tokens', () => {
    const cheaper = host('1', '100', MAX_COUNTED_HOST_COLLATERAL.toString());
    const oneUnitOver = host('2', '104', (MAX_COUNTED_HOST_COLLATERAL + 1n).toString());
    const farOver = host('2', '104', '9999999999999999999999999999');
    expect(selectCapacity(request, [oneUnitOver, cheaper]).host.hostId).toBe(cheaper.hostId);
    expect(selectCapacity(request, [farOver, cheaper]).host.hostId).toBe(cheaper.hostId);
    expect(selectCapacity(request, [cheaper, host('3', '106', farOver.stake)]).host.hostId).toBe(cheaper.hostId);
  });

  it('returns the actual bonded collateral unchanged while using the capped amount only for ordering', () => {
    const largeBond = host('2', '100', (MAX_COUNTED_HOST_COLLATERAL + 1n).toString());
    const smallerBond = host('1', '100', MAX_COUNTED_HOST_COLLATERAL.toString());
    const selected = selectCapacity(request, [largeBond, smallerBond]);
    expect(selected.host.hostId).toBe(smallerBond.hostId);
    expect(selectCapacity(request, [largeBond]).host.stake).toBe('25000000001');
  });
});
