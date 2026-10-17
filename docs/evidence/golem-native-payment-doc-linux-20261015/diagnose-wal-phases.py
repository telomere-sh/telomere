import hashlib, json, os, pathlib, shutil, subprocess

parent = pathlib.Path('/opt/telomere-host-runtime')
source = parent / 'yagna-native-doc-20261015-74e8a76b12bc'
target = parent / 'yagna-native-doc-wal-phase-probe-20261015'
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
instrumented = original.replace('try {\n  const { policy:', 'const phases: unknown[] = [];\ntry {\n  const { policy:', 1)
declaration = 'const { policy: p, paymentId } = input.parse(workerData), path = p.databasePath, directory = dirname(path);'
assert instrumented.count(declaration) == 1
instrumented = instrumented.replace(declaration, declaration + '''
  const observe = (phase: string) => {
    const value = lstatSync(path + '-wal', { bigint: true });
    phases.push({ phase, dev: value.dev.toString(), ino: value.ino.toString(), uid: value.uid.toString(),
      mode: (value.mode & 0o777n).toString(8), size: value.size.toString(), mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString() });
  };
''')
replacements = [
    ('let db: DatabaseSync | undefined;', "observe('before_constructor'); let db: DatabaseSync | undefined;"),
    ('db = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });',
     "db = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false }); observe('after_constructor');"),
    ("db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA mmap_size=0; PRAGMA cache_size=-2048; BEGIN;');",
     "db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA mmap_size=0; PRAGMA cache_size=-2048; BEGIN;'); observe('after_pragmas_begin');"),
    ('const schemaHash = golemAttributionSchemaHash(schema);', "observe('after_schema_select'); const schemaHash = golemAttributionSchemaHash(schema);"),
    ("db.exec('COMMIT'); snapshot =", "observe('after_queries'); db.exec('COMMIT'); observe('after_commit'); snapshot ="),
    ('} finally { db?.close(); }', "} finally { db?.close(); observe('after_close'); }"),
    ('parentPort?.postMessage(result);', "parentPort?.postMessage({ diagnostic: 'success', phases });"),
    ('} catch { parentPort?.postMessage({ unavailable: true }); }',
     "} catch (error) { parentPort?.postMessage({ unavailable: true, diagnostic: error instanceof Error ? error.message : 'unknown', phases }); }"),
]
for old, new in replacements:
    assert instrumented.count(old) == 1, old
    instrumented = instrumented.replace(old, new)
worker.write_text(instrumented)
fixture_source = (source / 'tests/golem-allocation-attribution.test.ts').read_text()
prefix = fixture_source.split("it('reconstructs omitted allocation only", 1)[0]
prefix = prefix.replace("import { afterEach, expect, it } from 'vitest';\n", '')
prefix = prefix.replace('afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });\n', '')
probe = prefix + '''
import { Worker } from 'node:worker_threads';
try {
  const rows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const fixture = await setup(true);
    const response = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../src/suppliers/golem-allocation-attribution-worker-loader.ts', import.meta.url), {
        workerData: { policy: fixture.policy, paymentId: fixture.wire.paymentId }, execArgv: ['--import', 'tsx'],
        stdout: true, stderr: true });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Diagnostic worker timed out')); }, 10000);
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
    });
    rows.push({ attempt, response });
  }
  process.stdout.write(JSON.stringify({ diagnosticOnly: true, instrumentedWorker: true, rows }) + '\\n');
} finally { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
'''
(target / 'tests/wal-phase-probe.ts').write_text(probe)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(target / '.local'), 'LANG': 'C.UTF-8', 'TMPDIR': str(target / '.local/tmp')}
with (target / '.local/wal-phase-probe.json').open('xb') as output, (target / '.local/wal-phase-probe.stderr').open('xb') as errors:
    result = subprocess.run(['node', '--import', 'tsx', 'tests/wal-phase-probe.ts'], cwd=target, env=env, stdout=output, stderr=errors, timeout=90)
print(json.dumps({'exitCode': result.returncode, 'directory': str(target), 'workerOriginalSha256': hashlib.sha256(original.encode()).hexdigest(), 'workerInstrumentedSha256': hashlib.sha256(instrumented.encode()).hexdigest()}))
raise SystemExit(result.returncode)
