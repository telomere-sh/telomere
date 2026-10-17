import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

RELEASE = Path('/opt/telomere-mainnet-pilot/releases/ee6169d1007b11f037fbc409dc1f7575f15117c9')
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
TESTS = ['tests/contracts.test.ts', 'tests/bridge-circle-usdc.test.ts', 'tests/service.test.ts',
         'tests/worker.test.ts', 'tests/cysts.test.ts']
EXPECTED = {
    'tests/contracts.test.ts': 'cc903f8e5d0277b159631c25304975beefef52dff34ed608bbe51f639f264cbb',
    'tests/bridge-circle-usdc.test.ts': '6fa95c96daf624954b192cc32a346e01fa5d9d38908b3d9b0d414015cd7602f6',
    'tests/service.test.ts': '166a79f880d2eacf431c448b000b2daac6f002ba9ba35203c7df7ee5d4828fcc',
    'tests/worker.test.ts': 'b4732e32ea461974f9f8f29c4ee7d661140f4221b8af5ecc0537b4f9ebf098f2',
    'tests/cysts.test.ts': 'ca97b412e28d70ba2e8575038831bfa012cd44c56a0a20a91fdaadab43405844',
}

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_json(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')

def source_manifest():
    files = [RELEASE / name for name in ['package.json', 'package-lock.json', 'vitest.config.ts']]
    for directory in ['src', 'scripts', 'tests']:
        files += [p for p in (RELEASE / directory).rglob('*') if p.is_file() and p.suffix in ['.ts', '.mjs']]
    files += list((RELEASE / 'contracts').glob('*.sol'))
    return {p.relative_to(RELEASE).as_posix(): {'size': p.stat().st_size, 'sha256': digest(p)} for p in sorted(set(files))}

def owned_processes(group):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if os.getpgid(int(entry.name)) == group:
                found.append({'pid': int(entry.name), 'comm': (entry / 'comm').read_text().strip()})
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found

for name, expected in EXPECTED.items():
    if digest(RELEASE / name) != expected:
        raise RuntimeError('Requested test source does not match the inspected release')
if subprocess.check_output([NODE, '--version'], text=True).strip() != 'v22.23.3':
    raise RuntimeError('Expected Node 22.23.3')
for name in ['vitest/vitest.mjs', 'vitest/dist/config.js', 'viem/package.json', '@electric-sql/pglite/package.json',
             '@foundry-rs/anvil-linux-amd64/package.json']:
    if not (RELEASE / 'node_modules' / name).is_file():
        raise RuntimeError('Required installed test dependency unavailable')

work = Path(tempfile.mkdtemp(prefix='telomere-mainnet-linux-focused-20261015-'))
os.chmod(work, 0o700)
before = source_manifest()
write_json(work / 'manifest-before.json', before)
config = work / 'vitest.config.mjs'
config.write_text("import { defineConfig } from '" + str(RELEASE / 'node_modules/vitest/dist/config.js') + "';\n"
                  "export default defineConfig({ root: " + json.dumps(str(RELEASE)) + ", cacheDir: "
                  + json.dumps(str(work / 'vite-cache')) + ", test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, "
                  "hookTimeout: 30000, fileParallelism: false } });\n", encoding='utf-8')
environment = {
    'PATH': '/opt/node-v22.23.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TMPDIR': str(work), 'CI': '1', 'NO_COLOR': '1', 'NODE_ENV': 'test',
    'DOCKER_HOST': 'unix:///run/telomere-mainnet-docker/docker.sock',
}
command = [NODE, str(RELEASE / 'node_modules/vitest/vitest.mjs'), 'run', *TESTS, '--config', str(config),
           '--no-cache', '--reporter=json', '--outputFile=' + str(work / 'node.json')]
started = now()
print(json.dumps({'status': 'started', 'work': str(work), 'release': str(RELEASE), 'tests': TESTS,
                  'environmentKeys': sorted(environment), 'sourceFiles': len(before), 'startedAt': started}), flush=True)
timed_out = False
with (work / 'node.stdout').open('xb') as stdout, (work / 'node.stderr').open('xb') as stderr:
    process = subprocess.Popen(command, cwd=RELEASE, env=environment, stdout=stdout, stderr=stderr,
                               stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        exit_code = process.wait(timeout=1200)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            exit_code = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            exit_code = process.wait(timeout=10)

remaining = owned_processes(process.pid)
cleanup = []
if remaining:
    os.killpg(process.pid, signal.SIGTERM)
    time.sleep(1)
    cleanup = remaining
remaining = owned_processes(process.pid)
after = source_manifest()
write_json(work / 'manifest-after.json', after)
changed = [name for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]
result = json.loads((work / 'node.json').read_text()) if (work / 'node.json').is_file() else None
summary = None
if result:
    summary = {name: result.get(name) for name in ['success', 'numTotalTestSuites', 'numPassedTestSuites',
        'numFailedTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']}
    summary['files'] = [{'file': Path(row['name']).name, 'status': row['status'],
                         'passed': sum(case['status'] == 'passed' for case in row.get('assertionResults', [])),
                         'failed': sum(case['status'] == 'failed' for case in row.get('assertionResults', [])),
                         'pending': sum(case['status'] == 'pending' for case in row.get('assertionResults', []))}
                        for row in result.get('testResults', [])]
report = {'schemaVersion': 1, 'startedAt': started, 'finishedAt': now(), 'release': str(RELEASE),
          'nodeVersion': 'v22.23.3', 'tests': TESTS, 'command': command, 'environmentKeys': sorted(environment),
          'freshEnvironment': True, 'privateEnvFilesRead': 0, 'publicTransactionsSent': 0,
          'nodeExitCode': exit_code, 'timedOut': timed_out, 'summary': summary,
          'sourceFileCount': len(before), 'sourceChangedPaths': changed,
          'ownedProcessGroup': process.pid, 'ownedProcessesTerminatedAfterExit': cleanup,
          'ownedProcessesRemaining': remaining, 'generatedContractArtifactsExcludedFromSourceInventory': True,
          'isolatedVitestCache': str(work / 'vite-cache')}
report['files'] = [{'name': path.name, 'size': path.stat().st_size, 'sha256': digest(path)}
                   for path in sorted(work.iterdir()) if path.is_file()]
write_json(work / 'report.json', report)
print(json.dumps({'status': 'completed', 'work': str(work), 'reportSha256': digest(work / 'report.json'),
                  'exitCode': exit_code, 'timedOut': timed_out, 'summary': summary,
                  'sourceChangedPaths': changed, 'ownedProcessesRemaining': remaining}), flush=True)
