import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = '/opt/telomere-mainnet-pilot/operator-wallet';
const release = '/opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9';
const node = '/opt/node-v22.23.3-linux-x64/bin/node';
const sourceCommit = '8f5f41e9e0fd94c95c37992ff910f098bf7908b4';
const planSha256 = '2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8';
const sha = data => createHash('sha256').update(data).digest('hex');
const safeRelative = path => typeof path === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(path)
  && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..');
async function regular(path, max = 2_097_152) {
  const state = await lstat(path);
  assert(state.isFile() && !state.isSymbolicLink() && state.nlink === 1 && state.uid === 0
    && (state.mode & 0o022) === 0 && state.size > 0 && state.size <= max, 'Unsafe operator input');
  return readFile(path);
}
async function directory(path) {
  const state = await lstat(path);
  assert(state.isDirectory() && !state.isSymbolicLink() && state.uid === 0 && (state.mode & 0o022) === 0,
    'Operator directory is not root-controlled');
}
try {
  assert(process.platform === 'linux' && process.arch === 'x64' && process.versions.node === '22.23.3', 'Unexpected Node runtime');
  assert(resolve(dirname(fileURLToPath(import.meta.url)), '..') === root && await realpath(root) === root, 'Unexpected operator root');
  assert(await realpath(process.execPath) === node, 'Unexpected Node executable');
  await regular(node, 134_217_728);
  for (const path of ['/opt', '/opt/telomere-mainnet-pilot', root, release]) await directory(path);
  const manifest = JSON.parse((await regular(join(root, 'PACKAGE-MANIFEST.json'))).toString('utf8'));
  assert(manifest.schemaVersion === 1 && manifest.sourceCommit === sourceCommit
    && manifest.appDependencyCommit === 'ee6169d1007b11f037fbc409dc1f7575f15117c9'
    && manifest.planSha256 === planSha256 && Array.isArray(manifest.files) && manifest.files.length > 16
    && manifest.files.length < 64, 'Unexpected operator package');
  const names = new Set();
  for (const entry of manifest.files) {
    assert(safeRelative(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256) && !names.has(entry.path), 'Invalid package member');
    names.add(entry.path);
    const full = join(root, entry.path);
    for (let parent = dirname(full); parent !== root; parent = dirname(parent)) {
      assert(parent.startsWith(root + '/'), 'Package member escaped root'); await directory(parent);
    }
    assert(sha(await regular(full)) === entry.sha256, 'Operator package input changed');
  }
  for (const path of ['scripts/owner-wallet-deployment.ts', 'src/deployment/owner-wallet-browser.ts',
    'contracts/TelomereRunEscrow.sol', 'package-lock.json', 'run-review.sh', 'runtime/preflight.mjs', 'frozen/deployment-plan-base-mainnet.json']) {
    assert(names.has(path), 'Required operator input missing');
  }
  assert(sha(await regular(join(root, 'frozen/deployment-plan-base-mainnet.json'))) === planSha256, 'Frozen plan changed');
  const modules = await lstat(join(root, 'node_modules'));
  assert(modules.isSymbolicLink() && modules.uid === 0
    && await realpath(join(root, 'node_modules')) === release + '/node_modules', 'Unexpected dependency link');
  await directory(release + '/node_modules');
  assert(sha(await regular(join(root, 'package-lock.json'))) === sha(await regular(join(release, 'package-lock.json'))), 'Dependency lock differs');
  const versions = { viem: '2.57.3', zod: '3.25.76', solc: '0.8.28', esbuild: '0.28.1', tsx: '4.21.0', '@openzeppelin/contracts': '5.4.0' };
  for (const [name, version] of Object.entries(versions)) {
    const entry = JSON.parse((await regular(join(release, 'node_modules', name, 'package.json'))).toString('utf8'));
    assert(entry.name === name && entry.version === version, 'Unexpected installed dependency');
  }
  await regular(release + '/node_modules/tsx/dist/loader.mjs');
  process.stdout.write(JSON.stringify({ status: 'operator_overlay_inputs_valid', sourceCommit,
    filesVerified: names.size, planSha256, chainId: 8453, bind: '127.0.0.1:3283',
    ownerKeysLoaded: false, transactionsSent: 0, controllerStarted: false }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ status: 'operator_overlay_preflight_refused', ownerKeysLoaded: false, transactionsSent: 0 }) + '\n');
  process.exitCode = 1;
}
