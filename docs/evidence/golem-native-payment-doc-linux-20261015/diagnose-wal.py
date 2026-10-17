import hashlib, json, os, pathlib, shutil, subprocess

parent = pathlib.Path('/opt/telomere-host-runtime')
source = parent / 'yagna-native-doc-20261015-74e8a76b12bc'
target = parent / 'yagna-native-doc-wal-probe-20261015'
assert not target.exists() and source.is_dir() and not source.is_symlink()
os.umask(0o077); target.mkdir(mode=0o700)
for name in ('src', 'docs/evidence/golem-allocation-upstream-20261015'):
    shutil.copytree(source / name, target / name)
shutil.copyfile(source / 'package.json', target / 'package.json')
(target / 'tests').mkdir(mode=0o700)
(target / '.local').mkdir(mode=0o700)
(target / '.local/tmp').mkdir(mode=0o700)
(target / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
worker = target / 'src/suppliers/golem-allocation-attribution-worker.ts'
original = worker.read_text()
assert original.count("} catch { parentPort?.postMessage({ unavailable: true }); }") == 1
instrumented = original.replace("} catch { parentPort?.postMessage({ unavailable: true }); }",
    "} catch (error) { parentPort?.postMessage({ unavailable: true, diagnostic: error instanceof Error ? error.message : 'unknown' }); }")
needle = "throw new Error('Source changed during snapshot');"
assert instrumented.count(needle) == 1
instrumented = instrumented.replace(needle,
    "throw new Error('Source changed during snapshot: ' + JSON.stringify({ database: same(before.database, after.database, false), wal: same(before.wal, after.wal, false), shm: same(before.shm, after.shm, true), descriptor: same(fstatSync(fd, { bigint: true }), after.database, false) }));")
worker.write_text(instrumented)
fixture_source = (source / 'tests/golem-allocation-attribution.test.ts').read_text()
prefix = fixture_source.split("it('reconstructs omitted allocation only", 1)[0]
prefix = prefix.replace("import { afterEach, expect, it } from 'vitest';\n", '')
prefix = prefix.replace('afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });\n', '')
probe = prefix + '''
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
async function inspect(path: string) {
  const info = await lstat(path, { bigint: true });
  return { device: info.dev.toString(), inode: info.ino.toString(), mode: (info.mode & 0o777n).toString(8),
    size: info.size.toString(), uid: info.uid.toString(), ctimeNs: info.ctimeNs.toString(), mtimeNs: info.mtimeNs.toString(),
    sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
}
try {
  const rows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const fixture = await setup(true);
    const before = await Promise.all([inspect(fixture.path), inspect(fixture.path + '-wal'), inspect(fixture.path + '-shm')]);
    const response = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../src/suppliers/golem-allocation-attribution-worker-loader.ts', import.meta.url), {
        workerData: { policy: fixture.policy, paymentId: fixture.wire.paymentId }, execArgv: ['--import', 'tsx'],
        stdout: true, stderr: true });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Diagnostic worker timed out')); }, 10000);
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const after = await Promise.all([inspect(fixture.path), inspect(fixture.path + '-wal'), inspect(fixture.path + '-shm')]);
    const diagnostic = response && typeof response === 'object' && 'diagnostic' in response ? response.diagnostic : 'success';
    rows.push({ attempt, diagnostic, before, after });
  }
  process.stdout.write(JSON.stringify({ diagnosticOnly: true, instrumentedWorker: true, rows }) + '\\n');
} finally {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
'''
(target / 'tests/wal-probe.ts').write_text(probe)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(target / '.local'), 'LANG': 'C.UTF-8', 'TMPDIR': str(target / '.local/tmp')}
with (target / '.local/wal-probe.json').open('xb') as output, (target / '.local/wal-probe.stderr').open('xb') as errors:
    result = subprocess.run(['node', '--import', 'tsx', 'tests/wal-probe.ts'], cwd=target, env=env, stdout=output, stderr=errors, timeout=90)
print(json.dumps({'exitCode': result.returncode, 'directory': str(target), 'workerOriginalSha256': hashlib.sha256(original.encode()).hexdigest(), 'workerInstrumentedSha256': hashlib.sha256(instrumented.encode()).hexdigest()}))
raise SystemExit(result.returncode)
