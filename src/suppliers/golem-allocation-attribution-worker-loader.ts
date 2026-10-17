// Source-mode workers need an explicit TSX import scope to resolve this ESM
// project's .js specifiers to .ts files. Compiled production uses only Node.
if (import.meta.url.endsWith('.ts')) {
  const { tsImport } = await import('tsx/esm/api');
  await tsImport(new URL('./golem-allocation-attribution-worker.ts', import.meta.url).href, import.meta.url);
} else {
  await import('./golem-allocation-attribution-worker.js');
}
