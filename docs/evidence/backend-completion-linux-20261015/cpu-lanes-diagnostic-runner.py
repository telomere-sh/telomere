import hashlib, json, os, pathlib, shutil, subprocess

original = pathlib.Path('/opt/telomere-host-runtime/backend-completion-20261015-d10f22b3259a')
target = pathlib.Path('/opt/telomere-host-runtime/cpu-lanes-diagnostic-20261015')
assert target.parent.resolve() == target.parent and not target.exists()
manifest = json.loads((original / '.local/source-manifest.json').read_bytes())
assert manifest['gitRevision'] == '7bb69e5e73199ab372ca6c263297792634648aaf'
replacement = pathlib.Path('/tmp/paid-cpu-jobs-diagnostic-20261015.test.ts').read_bytes()
expected_before = b"      throw new Error('Vault paid session did not start');"
expected_after = b"      const pending = (await store.db.select().from(platformRuns)).find(row => row.id === prepared.quote.runId);\n      throw new Error(`Vault paid session did not start (${pending?.status ?? 'missing'}/${pending?.errorCode ?? 'no-error'})`);"
old = (original / 'tests/paid-cpu-jobs.test.ts').read_bytes()
assert old.count(expected_before) == 1 and replacement == old.replace(expected_before, expected_after)
os.umask(0o077)
target.mkdir(mode=0o700)
for item in manifest['files']:
    source = original / item['path']
    assert source.is_file() and not source.is_symlink()
    raw = source.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == item['sha256']
    destination = target / item['path']; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(replacement if item['path'] == 'tests/paid-cpu-jobs.test.ts' else raw)
shutil.copytree(original / 'node_modules', target / 'node_modules', symlinks=True)
logs = target / '.local'; logs.mkdir(mode=0o700)
report = {'originalRevision': manifest['gitRevision'], 'diagnosticRevision': '2015b118fa34b7d4288e72afe529852baef0bfbb',
    'diagnosticTestSha256': hashlib.sha256(replacement).hexdigest(), 'sourceFiles': len(manifest['files']),
    'scope': 'One exact test diagnostic-only replacement; original703sourcefiles untouched; no production change.'}
(logs / 'diagnostic-source.json').write_text(json.dumps(report, indent=2) + '\n')
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
    'TELOMERE_ACCEPTANCE_GVISOR_SOCKET': '/run/telomere-declared-accept-20261015/docker.sock',
    'TELOMERE_ACCEPTANCE_GVISOR_IMAGE': '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe'}
with (logs / 'diagnostic.log').open('xb') as output:
    completed = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/paid-cpu-jobs.test.ts',
        '--reporter=json', '--outputFile=.local/diagnostic.json'], cwd=target, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=900)
raw = json.loads((logs / 'diagnostic.json').read_bytes())
print(json.dumps({'exitCode': completed.returncode, 'total': raw['numTotalTests'], 'passed': raw['numPassedTests'],
    'failed': raw['numFailedTests'], 'failures': [message for row in raw['testResults'] for case in row['assertionResults'] for message in case['failureMessages']]}))
