import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readPublicRelease, unversionedRelease } from '../src/release.js';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'telomere-release-info-')); temporary.push(root);
  const path = join(root, 'release-info.json'); await writeFile(path, JSON.stringify(value)); return pathToFileURL(path);
}
const built = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), sourceDirty: false, packageLockSha256: 'b'.repeat(64),
  assets: Object.fromEntries(['index.html', 'dashboard.js', 'workspace-client.js', 'site.js', 'agent-panels.js'].map(name => [name, 'c'.repeat(64)])) };
describe('public release identity', () => {
  it('reads exact commit and browser asset hashes from generated build metadata', async () => {
    expect(await readPublicRelease(await fixture(built))).toEqual(built);
  });
  it('explicitly identifies an unbuilt source checkout rather than claiming a release', async () => {
    const path = await fixture(built); await rm(path); expect(await readPublicRelease(path)).toEqual(unversionedRelease);
  });
  it.each([{ ...built, sourceCommit: '../private' }, { ...built, token: 'SECRET' }, { ...built, assets: {} },
    { ...built, assets: { ...built.assets, '/private/config': 'c'.repeat(64) } }])('rejects invalid or extra metadata at startup', async value => {
    await expect(readPublicRelease(await fixture(value))).rejects.toThrow();
  });
});
