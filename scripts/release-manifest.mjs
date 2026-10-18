import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'dist');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function inventory(directory, prefix = '') {
  const result = [];
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Release directory must be a regular directory');
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid release member name');
    const path = resolve(directory, name), local = prefix ? prefix + '/' + name : name;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Release links are forbidden');
    if (stat.isDirectory()) result.push(...await inventory(path, local));
    else if (stat.isFile()) result.push({ path: local, bytes: stat.size, sha256: sha256(await readFile(path)) });
    else throw new Error('Release special files are forbidden');
    if (result.length > 10000) throw new Error('Release inventory exceeds the reviewed file limit');
  }
  return result;
}

export async function buildManifest() {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Missing source commit');
  const sourceDirty = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const files = (await inventory(output)).filter(row => row.path !== 'release-manifest.json');
  const manifest = { schemaVersion: 1, sourceCommit, sourceDirty, node: process.versions.node,
    packageLockSha256: sha256(await readFile(resolve(root, 'package-lock.json'))),
    websiteLockSha256: sha256(await readFile(resolve(root, 'website/package-lock.json'))),
    esbuild: lock.packages['node_modules/esbuild'].version, files };
  await writeFile(resolve(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyManifest(requireClean = false) {
  const manifest = JSON.parse(await readFile(resolve(output, 'release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || typeof manifest.sourceDirty !== 'boolean'
    || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 10000) throw new Error('Invalid release manifest');
  const actual = (await inventory(output)).filter(row => row.path !== 'release-manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Release bytes or inventory differ from the manifest');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (head !== manifest.sourceCommit || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head)) throw new Error('Release source commit differs');
  for (const [name, expected] of [['package-lock.json', manifest.packageLockSha256], ['website/package-lock.json', manifest.websiteLockSha256]]) {
    if (sha256(await readFile(resolve(root, name))) !== expected) throw new Error('Release lockfile differs');
  }
  if (requireClean && (manifest.sourceDirty || execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim())) {
    throw new Error('Release acceptance requires a clean source commit');
  }
  return { sourceCommit: head, sourceDirty: manifest.sourceDirty, verifiedFiles: actual.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (relative(root, output).startsWith('..' + sep)) throw new Error('Unsafe release output');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--verify', '--require-clean'].includes(arg))) throw new Error('Unknown manifest argument');
  const result = args.includes('--verify') ? await verifyManifest(args.includes('--require-clean')) : await buildManifest();
  console.log(JSON.stringify(args.includes('--verify') ? result : { sourceCommit: result.sourceCommit, sourceDirty: result.sourceDirty, files: result.files.length }));
}
