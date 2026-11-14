import { it, expect, vi } from 'vitest';
import { selectionPublicStatusProbe } from '../src/updates/selection-public-status.js';
import { ServiceStatusService } from '../src/updates/service-status.js';
const now = Date.parse('2030-01-01T12:00:00Z');
const healthy = { version: 1, state: 'ready', chainId: 8453, registryAddress: '0x' + '1'.repeat(40), confirmations: 3,
  indexedThrough: '42', asOfSeconds: String(now / 1000 - 2), stale: false };
const probe = (raw: unknown) => selectionPublicStatusProbe('http://127.0.0.1:3287', 8453, { now: () => now, fetch: vi.fn(async () => Response.json(raw)) });
it('reports the external index without configuring the CPU financial Selection runtime', async () => {
  const service = new ServiceStatusService({ explorer: probe(healthy) }, () => now);
  const status = await service.snapshot(); expect(status.state).toBe('ready');
  expect(status.components.find(c => c.id === 'explorer')).toMatchObject({ state: 'ready', stale: false });
  expect(JSON.stringify(status)).not.toContain(healthy.registryAddress); expect(JSON.stringify(status)).not.toContain('3287');
});
it.each([{ ...healthy, stale: true }, { ...healthy, state: 'syncing' }, { ...healthy, asOfSeconds: String(now / 1000 - 901) }])
  ('never calls old or syncing evidence ready: %j', async raw => { expect(await probe(raw)()).toEqual({ state: 'degraded' }); });
it.each([{ ...healthy, chainId: 1 }, { ...healthy, privateOperatorPath: '/private' }, { ...healthy, asOfSeconds: null },
  { ...healthy, asOfSeconds: String(now / 1000 + 301) }, { ...healthy, state: 'unavailable' }, { ...healthy, confirmations: 0 }])
  ('rejects mismatched and unavailable reports: %j', async raw => { expect(await probe(raw)()).toEqual({ state: 'unavailable' }); });
it('returns a public failure without echoing upstream exceptions', async () => {
  const read = selectionPublicStatusProbe('http://127.0.0.1:3287', 8453, { fetch: vi.fn(async () => { throw Error('PRIVATE_ENDPOINT_TOKEN'); }) });
  expect(await read()).toEqual({ state: 'unavailable' });
});
