"""Frozen, owned Linux acceptance for bounded M8 CPU replan; no service changes.

Arguments: uploaded archive, uploaded manifest, exact Git revision, archive SHA256.
Only a fresh private extraction and copied reviewed Node cache may be written.
"""
import collections
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request

BASE = pathlib.Path('/opt/telomere-host-runtime')
CACHE = BASE / 'backend-completion-final-20261015-090932a350a5'
VENV = CACHE / '.local/python-crypto-venv'
CACHE_REVISION = 'd4481aec92179df44a533699897db2f523fbd0a2'
CACHE_MANIFEST_SHA = '16b7ddcfb62c1d6fde5bd0f6c4a2b55013d0dbe508c62e4ff233efd896e69028'
PROFILE_SHA = 'a400feb3475b91168a5419d0a98c00ea804ba817c1c0ad34dea65d7d8808df8f'
SERVICES = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
FILES = ['tests/paid-cpu-job-replan-runner.test.ts', 'tests/paid-cpu-jobs.test.ts',
         'tests/paid-host-preemption.test.ts', 'tests/paid-vault-preemption-handoff.test.ts']
MAX_LOG = 32 * 1024 * 1024


def require(value):
    if not value:
        raise RuntimeError('Frozen M8 acceptance guard refused')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, maximum=MAX_LOG):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1
            and info.st_uid == os.getuid() and info.st_size <= maximum)
    data = path.read_bytes()
    require(len(data) == info.st_size)
    return data


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.pending')
    with temporary.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    if path.exists():
        regular(path)
    os.replace(temporary, path)


def source_check(root, manifest):
    changed = []
    for row in manifest['files']:
        try:
            data = regular(root / row['path'])
            require(len(data) == row['bytes'] and sha(data) == row['sha256'])
        except (OSError, RuntimeError):
            changed.append(row['path'])
    return {'unchanged': not changed, 'verified': len(manifest['files']) - len(changed), 'changed': changed}


def tree_inventory(root):
    require(root.is_dir() and not root.is_symlink())
    rows = []
    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort(); files.sort()
        base = pathlib.Path(directory)
        for name in list(directories):
            path = base / name
            if path.is_symlink():
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
                directories.remove(name)
        for name in files:
            path = base / name
            if path.is_symlink():
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
                continue
            first = path.lstat()
            require(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and first.st_uid == os.getuid())
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            last = path.lstat()
            require((first.st_dev, first.st_ino, first.st_size, first.st_mtime_ns, first.st_ctime_ns)
                    == (last.st_dev, last.st_ino, last.st_size, last.st_mtime_ns, last.st_ctime_ns))
            rows.append({'path': path.relative_to(root).as_posix(), 'type': 'file', 'bytes': first.st_size,
                         'mode': stat.S_IMODE(first.st_mode), 'sha256': digest.hexdigest()})
    return sorted(rows, key=lambda row: row['path'])


def inventory_sha(rows):
    return sha((json.dumps(rows, sort_keys=True, separators=(',', ':')) + '\n').encode())


def services():
    result = {}
    for name in SERVICES:
        text = subprocess.check_output(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
                                        '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory'],
                                       text=True, timeout=15)
        row = dict(line.split('=', 1) for line in text.strip().splitlines())
        require(row['ActiveState'] == 'active' and row['SubState'] == 'running' and row['NRestarts'] == '0'
                and int(row['MainPID']) > 1)
        result[name] = row
    return result


def profile_sha():
    return sha(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes())


def health():
    result = {}
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response)
            require(response.status == 200 and body['status'] == expected)
            result[name] = {'statusCode': response.status, 'body': body}
    return result


def owned_processes(source):
    rows = []
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            args = (proc / 'cmdline').read_bytes()
            cwd = (proc / 'cwd').resolve()
            executable = (proc / 'exe').resolve()
            first_argument = args.split(b'\0', 1)[0]
            if executable.is_relative_to(source) or cwd.is_relative_to(source) or first_argument.startswith(str(source).encode() + b'/'):
                rows.append({'pid': int(proc.name), 'executable': executable.name,
                             'executableInOwnedSource': executable.is_relative_to(source),
                             'cwdInOwnedSource': cwd.is_relative_to(source)})
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return rows


def run(name, argv, source, environment, logs, timeout, report):
    report['phase'] = name
    write_json(logs / 'acceptance.json', report)
    started = time.monotonic()
    timed_out = limited = False
    path = logs / (name + '.log')
    with path.open('xb') as output:
        child = subprocess.Popen(argv, cwd=source, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while child.poll() is None:
                if os.fstat(output.fileno()).st_size > MAX_LOG:
                    limited = True
                    break
                if time.monotonic() - started > timeout:
                    timed_out = True
                    break
                time.sleep(0.5)
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=5)
    row = {'argv': argv, 'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3),
           'timedOut': timed_out, 'logLimitExceeded': limited, 'logBytes': path.stat().st_size,
           'logSha256': sha(regular(path))}
    report['commands'][name] = row
    write_json(logs / 'acceptance.json', report)
    print(json.dumps({'phase': name + '_complete', **{key: row[key] for key in ['exitCode', 'seconds', 'timedOut']}}), flush=True)
    return row


def node_results(path):
    raw = json.loads(regular(path))
    rows = raw['testResults']
    cases = [case for row in rows for case in row['assertionResults']]
    counts = dict(collections.Counter(case['status'] for case in cases))
    require(len(rows) == len(FILES) and {pathlib.Path(row['name']).name for row in rows}
            == {pathlib.Path(name).name for name in FILES})
    require(len(cases) == raw['numTotalTests'] > 0 and counts.get('passed', 0) == raw['numPassedTests'])
    return {'total': len(cases), 'passed': raw['numPassedTests'], 'failed': raw['numFailedTests'],
            'assertionStatuses': counts, 'success': raw['success'], 'unhandledErrors': raw.get('numUnhandledErrors', 0),
            'files': [{'name': pathlib.Path(row['name']).name, 'status': row['status'],
                       'cases': len(row['assertionResults'])} for row in rows],
            'failures': [{'file': pathlib.Path(row['name']).name, 'name': case['fullName']}
                         for row in rows for case in row['assertionResults'] if case['status'] == 'failed'],
            'accepted': raw['success'] is True and counts == {'passed': len(cases)} and all(row['assertionResults'] for row in rows)
                        and raw.get('numUnhandledErrors', 0) == 0 and raw.get('numFailedTestSuites', 0) == 0}


def python_results(path):
    text = regular(path).decode('utf-8')
    matches = re.findall(r'^Ran ([0-9]+) tests in ([0-9.]+)s$', text, re.M)
    require(len(matches) == 1)
    rows = re.findall(r'^(test\S+) \(([^\n]+)\) \.\.\. (ok|FAIL|ERROR|skipped [^\n]+)$', text, re.M)
    total = int(matches[0][0])
    statuses = dict(collections.Counter(row[2] for row in rows))
    require(len(rows) == total > 0)
    return {'total': total, 'passed': statuses.get('ok', 0), 'statuses': statuses,
            'skips': [{'method': row[0], 'case': row[1], 'status': row[2]} for row in rows if row[2].startswith('skipped')],
            'completedOk': bool(re.search(r'^OK$', text, re.M)),
            'accepted': statuses == {'ok': total} and bool(re.search(r'^OK$', text, re.M))}


def main():
    archive_arg, manifest_arg, revision, archive_sha = sys.argv[1:]
    require(re.fullmatch('[0-9a-f]{40}', revision) and re.fullmatch('[0-9a-f]{64}', archive_sha))
    archive, manifest_path = pathlib.Path(archive_arg), pathlib.Path(manifest_arg)
    require(archive.parent == manifest_path.parent == pathlib.Path('/tmp'))
    require(archive.name == 'telomere-paid-cpu-replan-20261015.tar.gz'
            and manifest_path.name == archive.name + '.manifest.json')
    manifest_bytes = regular(manifest_path, 2 * 1024 * 1024)
    manifest = json.loads(manifest_bytes)
    require(manifest['gitRevision'] == revision and manifest['source'] == 'committed_git_blobs_only'
            and manifest['workingTreeIncluded'] is False and manifest['archiveSha256'] == archive_sha
            and sha(regular(archive)) == archive_sha)
    rows = {row['path']: row for row in manifest['files']}
    require(708 <= len(rows) == len(manifest['files']) <= 1000 and set(FILES).issubset(rows))
    old_manifest_bytes = regular(CACHE / '.local/source-manifest.json', 2 * 1024 * 1024)
    require(sha(old_manifest_bytes) == CACHE_MANIFEST_SHA)
    old_manifest = json.loads(old_manifest_bytes)
    require(old_manifest['gitRevision'] == CACHE_REVISION and source_check(CACHE, old_manifest)['unchanged'])
    old_rows = {row['path']: row for row in old_manifest['files']}
    for path in ['package.json', 'package-lock.json', 'python/requirements-crypto.txt']:
        require(rows[path] == old_rows[path])
    require(CACHE.resolve() == CACHE and VENV.is_dir() and not VENV.is_symlink())
    source = BASE / ('paid-cpu-replan-20261015-' + archive_sha[:12])
    require(BASE.resolve() == BASE and not source.exists())
    os.umask(0o077)
    source.mkdir(mode=0o700)
    logs = source / '.local'; logs.mkdir(mode=0o700)
    (logs / 'source-manifest.json').write_bytes(manifest_bytes)
    report = {'schemaVersion': 1, 'kind': 'FROZEN_BOUNDED_PAID_CPU_REPLAN_LINUX_ACCEPTANCE',
              'status': 'running', 'startedAtUtc': now(), 'gitRevision': revision, 'archiveSha256': archive_sha,
              'sourceDirectory': str(source), 'sourceFiles': len(rows), 'sourceManifestSha256': sha(manifest_bytes),
              'cacheDirectory': str(CACHE), 'cacheRevision': CACHE_REVISION,
              'cacheManifestSha256': CACHE_MANIFEST_SHA, 'existingCryptoVenv': str(VENV),
              'nodeTestFiles': FILES, 'pythonPattern': 'test_platform*.py', 'phase': 'preparing', 'commands': {},
              'dependencyInstalls': 0, 'dockerOptInEnabled': False, 'serviceMutations': False,
              'paidProviderRequests': 0, 'publicTransactions': 0, 'deploymentPerformed': False,
              'scope': 'Four complete focused Node files with actual disposable local EVM/process integration, complete Python platform-family tests with crypto, strict typecheck and fresh application build. Not a full backend regression, real supplier, gVisor or production acceptance.'}
    before = {}
    accepted = False
    try:
        report['cacheSourceBefore'] = source_check(CACHE, old_manifest)
        require(report['cacheSourceBefore']['unchanged'])
        report['servicesBefore'], report['profileBeforeSha256'], report['healthBefore'] = services(), profile_sha(), health()
        require(report['profileBeforeSha256'] == PROFILE_SHA)
        require(subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.23.3')
        report['nodeVersion'] = 'v22.23.3'
        for name, root in [('cache-node-modules', CACHE / 'node_modules'), ('cache-dist', CACHE / 'dist'), ('crypto-venv', VENV)]:
            before[name] = tree_inventory(root)
            write_json(logs / (name + '-before.json'), before[name])
        required = sum(row.get('bytes', 0) for row in before['cache-node-modules']) + sum(row['bytes'] for row in rows.values())
        require(shutil.disk_usage(BASE).free > required + 1024 * 1024 * 1024)
        with tarfile.open(archive, 'r:gz') as packed:
            members = packed.getmembers()
            require(len(members) == len(rows) and {member.name for member in members} == set(rows))
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                require(member.isfile() and not path.is_absolute() and '..' not in path.parts
                        and not any(part in {'.local', '.git', 'node_modules', '.env'} for part in path.parts))
                raw = packed.extractfile(member).read()
                require(len(raw) == rows[member.name]['bytes'] and sha(raw) == rows[member.name]['sha256'])
                target = source / path
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open('xb') as output:
                    output.write(raw)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
        shutil.copytree(CACHE / 'node_modules', source / 'node_modules', symlinks=True)
        copied = tree_inventory(source / 'node_modules')
        report['dependencyCopySha256'] = inventory_sha(copied)
        require(copied == before['cache-node-modules'])
        report['sourceBefore'] = source_check(source, manifest)
        require(report['sourceBefore']['unchanged'])
        private_config = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ cacheDir: '.local/vite-cache', test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000, fileParallelism: false, pool: 'forks', maxWorkers: 1, isolate: true } });\n"
        (logs / 'vitest.config.ts').write_text(private_config)
        home, temporary = logs / 'home', logs / 'tmp'
        home.mkdir(mode=0o700); temporary.mkdir(mode=0o700)
        environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8',
                       'TMPDIR': str(temporary), 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                       'PYTHONPATH': str(source / 'python/src'), 'NPM_CONFIG_UPDATE_NOTIFIER': 'false'}
        for name, argv, timeout in [('typecheck', ['npm', 'run', 'typecheck'], 300),
                                    ('build', ['npm', 'run', 'build'], 600)]:
            result = run(name, argv, source, environment, logs, timeout, report)
            require(result['exitCode'] == 0 and not result['timedOut'] and not result['logLimitExceeded'])
        report['buildOutputInventorySha256'] = inventory_sha(tree_inventory(source / 'dist'))
        python_probe = "import importlib.metadata,json,platform; print(json.dumps({'python':platform.python_version(),'packages':{name:importlib.metadata.version(name) for name in ['eth-account','eth-hash','eth_abi','hexbytes','pycryptodome']}}))"
        result = run('crypto-probe', [str(VENV / 'bin/python'), '-B', '-c', python_probe], source, environment, logs, 30, report)
        require(result['exitCode'] == 0)
        report['runtimeAndPackages'] = json.loads(regular(logs / 'crypto-probe.log'))
        for name, value in report['runtimeAndPackages']['packages'].items():
            require(re.search(r'^' + re.escape(name) + '==' + re.escape(value) + r'$', regular(source / 'python/requirements-crypto.txt').decode(), re.M))
        result = run('node', ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config=.local/vitest.config.ts',
                             '--no-cache', '--reporter=json', '--outputFile=.local/node.json', *FILES],
                     source, environment, logs, 1800, report)
        report['nodeTests'] = node_results(logs / 'node.json')
        require(result['exitCode'] == 0 and not result['timedOut'] and not result['logLimitExceeded'] and report['nodeTests']['accepted'])
        result = run('python', [str(VENV / 'bin/python'), '-B', '-m', 'unittest', 'discover', '-s', 'python/tests',
                               '-p', 'test_platform*.py', '-v'], source, environment, logs, 300, report)
        report['pythonTests'] = python_results(logs / 'python.log')
        accepted = result['exitCode'] == 0 and not result['timedOut'] and not result['logLimitExceeded'] and report['pythonTests']['accepted']
    except BaseException as error:
        report['failureType'] = type(error).__name__
    finally:
        try:
            report['sourceAfter'] = source_check(source, manifest)
            report['cacheSourceAfter'] = source_check(CACHE, old_manifest)
            report['sourceManifestUnchanged'] = sha(regular(logs / 'source-manifest.json')) == sha(manifest_bytes)
            report['inventories'] = {}
            for name, root in [('cache-node-modules', CACHE / 'node_modules'), ('cache-dist', CACHE / 'dist'), ('crypto-venv', VENV)]:
                if name in before:
                    after = tree_inventory(root)
                    write_json(logs / (name + '-after.json'), after)
                    report['inventories'][name] = {'entries': len(after), 'beforeSha256': inventory_sha(before[name]),
                                                   'afterSha256': inventory_sha(after), 'unchanged': before[name] == after}
            if (source / 'node_modules').is_dir() and 'cache-node-modules' in before:
                final_copied = tree_inventory(source / 'node_modules')
                report['copiedNodeModulesUnchanged'] = final_copied == before['cache-node-modules']
                write_json(logs / 'copied-node-modules-after.json', final_copied)
            report['servicesAfter'], report['profileAfterSha256'], report['healthAfter'] = services(), profile_sha(), health()
            report['ownedProcessesRemaining'] = owned_processes(source)
            require(report['sourceAfter']['unchanged'] and report['cacheSourceAfter']['unchanged']
                    and report['sourceManifestUnchanged'] and report.get('copiedNodeModulesUnchanged')
                    and all(row['unchanged'] for row in report['inventories'].values())
                    and report['servicesAfter'] == report['servicesBefore']
                    and report['profileAfterSha256'] == report['profileBeforeSha256'] and not report['ownedProcessesRemaining'])
        except BaseException as error:
            accepted = False
            report['postflightFailureType'] = type(error).__name__
        report['success'] = bool(accepted)
        report['status'] = 'accepted_focused_linux_cpu_replan' if accepted else 'failed'
        report['phase'] = 'finished'
        report['finishedAtUtc'] = now()
        write_json(logs / 'acceptance.json', report)
        print(json.dumps({'status': report['status'], 'success': report['success'], 'source': str(source),
                          'node': report.get('nodeTests'), 'python': report.get('pythonTests'),
                          'failureType': report.get('failureType'), 'postflightFailureType': report.get('postflightFailureType')}), flush=True)
    return 0 if accepted else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'refused_before_owned_report', 'failureType': type(error).__name__}), flush=True)
        raise SystemExit(1)
