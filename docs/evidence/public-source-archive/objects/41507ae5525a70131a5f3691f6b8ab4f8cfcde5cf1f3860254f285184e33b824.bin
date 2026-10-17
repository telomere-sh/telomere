import { mkdir, copyFile, lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const root = resolve('.'), source = join(root, 'website', 'dist'), output = join(root, 'dist');
const websiteOutput = join(output, 'website'), files = [];
let entries = 0;
async function inventory(directory, relative = '') {
  const identity = await lstat(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Static source must contain only regular directories');
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (++entries > 2048 || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(item.name)) throw new Error('Invalid static source inventory');
    const local = relative ? relative + '/' + item.name : item.name, path = join(directory, item.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Static source links are forbidden');
    if (stat.isDirectory()) await inventory(path, local);
    else if (stat.isFile()) files.push(local);
    else throw new Error('Static source contains a special file');
  }
}
await inventory(source);
if (!files.includes('index.html') || !files.includes('page.html')) throw new Error('Static entry points are missing');
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink() || !websiteOutput.startsWith(root + sep) || websiteOutput !== resolve(root, 'dist', 'website')) {
  throw new Error('Unsafe static build output');
}
try { if ((await lstat(websiteOutput)).isSymbolicLink()) throw new Error('Static build output is a link'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
await mkdir(join(output, 'public'), { recursive: true });
await Promise.all(['index.html', 'styles.css'].map(file => copyFile(join(root, 'public', file), join(output, 'public', file))));
// This verified path is generated build output only; remove stale bundles without touching the supplied frontend.
await rm(websiteOutput, { recursive: true, force: true });
for (const file of files) {
  await mkdir(resolve(websiteOutput, file, '..'), { recursive: true });
  await copyFile(join(source, file), join(websiteOutput, file));
}
