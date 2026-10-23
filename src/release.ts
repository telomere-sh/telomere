import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const builtRelease = z.object({ schemaVersion: z.literal(1), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDirty: z.boolean(), packageLockSha256: sha,
  assets: z.object({ 'index.html': sha, 'dashboard.js': sha, 'workspace-client.js': sha, 'site.js': sha, 'agent-panels.js': sha }).strict(),
}).strict();
export const unversionedRelease = { schemaVersion: 1, sourceCommit: null, sourceDirty: null, packageLockSha256: null, assets: {} } as const;
export type PublicRelease = z.infer<typeof builtRelease> | typeof unversionedRelease;

export async function readPublicRelease(path = new URL('../release-info.json', import.meta.url)): Promise<PublicRelease> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    // Source-mode development has no generated release metadata. A malformed build fails startup.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return unversionedRelease;
    throw error;
  }
  if (source.length > 4096) throw new Error('Release metadata exceeds the supported size');
  return builtRelease.parse(JSON.parse(source));
}
