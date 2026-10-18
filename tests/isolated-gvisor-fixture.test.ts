import { expect, it } from 'vitest';
import { parseIsolatedGvisorFixture, verifyIsolatedGvisorIdentity } from './fixtures/isolated-gvisor.js';

const profile = { version: 1, fixtureId: 'gvisor-nine-20261018', socket: '/run/telomere-audit-gvisor-nine-20261018/docker.sock',
  parent: '/var/tmp/telomere-audit-gvisor-nine-20261018/sessions', dockerRoot: '/var/tmp/telomere-audit-gvisor-nine-20261018/data',
  image: 'node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402',
  runscPath: '/opt/telomere-audit-gvisor-nine-20261018/gvisor/runsc', runscSha256: '210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a' };
it('requires one isolated namespace, exact image digest and private profile schema', () => {
  expect(parseIsolatedGvisorFixture(profile)).toEqual(profile);
  for (const change of [{ socket: '/run/telomere-mainnet-docker/docker.sock' }, { parent: '/opt/telomere-host-runtime' },
    { dockerRoot: '/var/lib/docker' }, { fixtureId: '../escape' }, { image: 'node:latest' }, { runscPath: '/opt/../bin/runsc' },
    { runscSha256: '' }, { extra: true }]) expect(() => parseIsolatedGvisorFixture({ ...profile, ...change })).toThrow();
});
it('requires the actual daemon namespace, runsc binary hash and image rather than trusting a runtime label', () => {
  const p = parseIsolatedGvisorFixture(profile), actual = { dockerRoot: p.dockerRoot, runtime: 'runsc',
    runscPath: p.runscPath, runscSha256: p.runscSha256, imageDigests: [p.image] };
  expect(() => verifyIsolatedGvisorIdentity(p, actual)).not.toThrow();
  for (const change of [{ dockerRoot: '/var/lib/docker' }, { runtime: 'runc' }, { runscPath: '/opt/other/runsc' },
    { runscSha256: 'b'.repeat(64) }, { imageDigests: [] }]) {
    expect(() => verifyIsolatedGvisorIdentity(p, { ...actual, ...change })).toThrow();
  }
});
