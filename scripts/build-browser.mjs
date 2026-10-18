import * as esbuild from 'esbuild';

if (esbuild.version !== '0.28.2') throw new Error('Install the reviewed esbuild version with npm ci');
// Whitespace minification removes machine-specific module-path comments. Preserve
// third-party notices as adjacent files; no UI styles or animation code is replaced.
for (const [entry, output] of [
  ['public/app.ts', 'dist/public/app.js'],
  ['public/workspace-client.ts', 'website/dist/workspace-client.js'],
]) {
  await esbuild.build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', minifyWhitespace: true, legalComments: 'external' });
}
