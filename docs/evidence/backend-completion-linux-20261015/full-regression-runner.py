"""Full frozen-source regressions only; no install/build/deploy or opt-in Docker.
Usage: python3 HELPER SOURCE_DIRECTORY REVISION ARCHIVE_SHA256
The separate preparer owns verified extraction/install/build. This runner reads
SOURCE_DIRECTORY/.local/source-manifest.json and records actual counts/skips.
"""
import collections
import datetime
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request

SERVICES = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
MAX_LOG_BYTES = 16 * 1024 * 1024


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('Frozen regression precondition refused')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private_directory(path):
    require(path.is_absolute() and path.resolve() == path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
    for value in [path, *path.parents]:
        require(stat.S_ISDIR(value.lstat().st_mode) and not value.is_symlink())


def read_json(path, maximum):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1
            and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= maximum)
    data = path.read_bytes()
    require(len(data) == info.st_size and len(data) <= maximum)
    return json.loads(data)


def inspect(command):
    value = subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL, timeout=15)
    require(len(value) <= 65_536)
    return value.strip()


def services():
    return {name: inspect(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
                          '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory']) for name in SERVICES}


def profile_hash():
    return sha(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes())


def health():
    result = {}
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response)
            require(response.status == 200 and body['status'] == expected)
            result[name] = {'statusCode': response.status, 'body': body}
    return result


def verify_sources(source, inventory):
    changed = []
    for name, item in inventory.items():
        try:
            relative = pathlib.PurePosixPath(name)
            require(not relative.is_absolute() and '..' not in relative.parts
                    and not any(part in ('.git', '.local', 'node_modules', '.env') for part in relative.parts))
            path = source / name
            require(path.is_file() and not path.is_symlink())
            data = path.read_bytes()
            require(len(data) == item['bytes'] and sha(data) == item['sha256'])
        except (OSError, Refusal, KeyError):
            changed.append(name)
    return {'unchanged': not changed, 'verified': len(inventory) - len(changed), 'changed': changed}


def run(command, source, environment, log, timeout):
    started = time.monotonic()
    timed_out = False
    limited = False
    with log.open('xb') as output:
        child = subprocess.Popen(command, cwd=source, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while child.poll() is None:
                if os.fstat(output.fileno()).st_size > MAX_LOG_BYTES:
                    limited = True
                    raise Refusal('Private diagnostic limit reached')
                if time.monotonic() - started >= timeout:
                    timed_out = True
                    raise subprocess.TimeoutExpired(command, timeout)
                time.sleep(0.5)
        except BaseException:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=10)
            if not timed_out and not limited:
                raise
    return {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3),
            'timedOut': timed_out, 'logLimitExceeded': limited, 'logBytes': log.stat().st_size}


def node_result(raw):
    rows = raw['testResults']
    cases = [case for row in rows for case in row['assertionResults']]
    counts = dict(collections.Counter(case['status'] for case in cases))
    require(len(cases) == raw['numTotalTests'] and raw['numTotalTests'] > 0
            and counts.get('passed', 0) == raw['numPassedTests'])
    keys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests',
            'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'success']
    result = {key: raw.get(key) for key in keys}
    result['actualAssertionStatuses'] = counts
    result['files'] = [{'name': pathlib.Path(row['name']).name, 'status': row['status'],
                        'assertions': len(row['assertionResults'])} for row in rows]
    result['skips'] = [{'file': pathlib.Path(row['name']).name, 'name': case['fullName'], 'status': case['status']}
                       for row in rows for case in row['assertionResults'] if case['status'] not in ('passed', 'failed')]
    result['failures'] = [{'file': pathlib.Path(row['name']).name, 'name': case['fullName'], 'status': case['status']}
                          for row in rows for case in row['assertionResults'] if case['status'] == 'failed']
    result['accepted'] = raw['success'] is True and raw['numFailedTests'] == 0 and raw.get('numFailedTestSuites', 0) == 0
    result['accepted'] = result['accepted'] and all(case['status'] in ('passed', 'skipped', 'pending', 'todo') for case in cases)
    result['skipInterpretation'] = 'Recorded opt-in/platform exclusions remain untested; skipped requirements receive no acceptance credit.'
    return result


def python_result(text):
    runs = re.findall(r'^Ran ([0-9]+) tests? in ([0-9.]+)s$', text, re.MULTILINE)
    require(len(runs) == 1 and int(runs[0][0]) > 0)
    summaries = re.findall(r'^(OK(?: \([^\n]*\))?|FAILED \([^\n]*\))$', text, re.MULTILINE)
    require(len(summaries) == 1)
    rows = []
    for line in text.splitlines():
        found = re.match(r'^(\S+) \(([^\n]+)\) \.\.\. (ok|FAIL|ERROR|skipped .+|expected failure|unexpected success)$', line)
        if found:
            rows.append({'name': found[2], 'method': found[1], 'status': found[3]})
    return {'testsRun': int(runs[0][0]), 'seconds': float(runs[0][1]), 'summary': summaries[0],
            'namedResults': rows, 'skips': [value for value in rows if value['status'].startswith('skipped ')],
            'failures': [value for value in rows if value['status'] in ('FAIL', 'ERROR', 'unexpected success')],
            'accepted': summaries[0].startswith('OK')}


def persist(path, value):
    temporary = path.with_suffix('.pending.json')
    with temporary.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    if path.exists():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
    os.replace(temporary, path)


def main(argv):
    require(len(argv) == 3)
    source, revision, archive_sha = pathlib.Path(argv[0]), argv[1], argv[2]
    require(re.fullmatch('[a-f0-9]{40}', revision) and re.fullmatch('[a-f0-9]{64}', archive_sha))
    private_directory(source)
    require(source.is_relative_to(pathlib.Path('/opt/telomere-host-runtime')))
    local = source / '.local'
    private_directory(local)
    manifest_path = local / 'source-manifest.json'
    manifest = read_json(manifest_path, 1_048_576)
    require(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha)
    inventory = {item['path']: item for item in manifest['files']}
    require(685 <= len(inventory) == len(manifest['files']) <= 1500)
    paths = {name: local / name for name in ['full-acceptance.json', 'full-node.json', 'full-node.log', 'full-python.log']}
    require(all(not value.exists() and not value.is_symlink() for value in paths.values()))
    os.umask(0o077)
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    require(inspect(['node', '--version']) == 'v22.23.3')
    before = verify_sources(source, inventory)
    require(before['unchanged'])
    report = {'schemaVersion': 1, 'status': 'running', 'startedAt': now(), 'gitRevision': revision,
              'archiveSha256': archive_sha, 'sourceDirectory': str(source), 'sourceFiles': len(inventory),
              'sourceManifestSha256': sha(manifest_path.read_bytes()), 'sourceBefore': before,
              'nodeVersion': 'v22.23.3', 'servicesBefore': services(), 'profileBeforeSha256': profile_hash(),
              'healthBefore': health(), 'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0,
              'dockerOptInEnabled': False, 'buildOrInstallPerformed': False,
              'scope': 'Full default Node/Python regressions on frozen source; explicit opt-in cases may skip. Not a deployment or live provider/public-chain acceptance.'}
    require(all('ActiveState=active' in value for value in report['servicesBefore'].values()))
    accepted = False
    persist(paths['full-acceptance.json'], report)
    def interrupted(_signum, _frame):
        raise Refusal('Frozen regressions interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        report['node'] = run(['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=.local/full-node.json'],
                             source, environment, paths['full-node.log'], 6000)
        try:
            report['nodeTests'] = node_result(read_json(paths['full-node.json'], 32 * 1024 * 1024))
        except (Refusal, OSError, KeyError, ValueError, TypeError) as error:
            report['nodeResultFailureType'] = type(error).__name__
        persist(paths['full-acceptance.json'], report)
        print(json.dumps({'phase': 'node_complete', 'exitCode': report['node']['exitCode'],
                          'counts': {key: report.get('nodeTests', {}).get(key) for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']}}), flush=True)
        report['python'] = run(['python3', '-m', 'unittest', 'discover', '-s', 'python/tests', '-v'],
                               source, environment, paths['full-python.log'], 600)
        try:
            report['pythonTests'] = python_result(paths['full-python.log'].read_text('utf-8', errors='strict'))
        except (Refusal, OSError, ValueError) as error:
            report['pythonResultFailureType'] = type(error).__name__
        accepted = report['node']['exitCode'] == report['python']['exitCode'] == 0
        accepted = accepted and report.get('nodeTests', {}).get('accepted', False) and report.get('pythonTests', {}).get('accepted', False)
        accepted = accepted and not any(report[phase][field] for phase in ('node', 'python') for field in ('timedOut', 'logLimitExceeded'))
    except BaseException as error:
        report['failureType'] = type(error).__name__
        accepted = False
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            report['sourceAfter'] = verify_sources(source, inventory)
            report['servicesAfter'], report['profileAfterSha256'], report['healthAfter'] = services(), profile_hash(), health()
            require(report['sourceAfter']['unchanged'] and sha(manifest_path.read_bytes()) == report['sourceManifestSha256'])
            require(report['servicesAfter'] == report['servicesBefore'] and report['profileAfterSha256'] == report['profileBeforeSha256'])
        except BaseException as error:
            report['postflightFailureType'] = type(error).__name__
            accepted = False
        remaining = []
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                argv = (entry / 'cmdline').read_bytes()
                if b'anvil' in argv and str(source).encode() in argv:
                    remaining.append(int(entry.name))
            except (FileNotFoundError, PermissionError):
                pass
        report['ownedAnvilProcessesRemaining'] = remaining
        report['success'] = bool(accepted and not remaining)
        report['status'] = 'accepted_default_regressions_with_recorded_exclusions' if report['success'] else 'failed'
        report['finishedAt'] = now()
        persist(paths['full-acceptance.json'], report)
        print(json.dumps(report, separators=(',', ':')), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print(json.dumps({'schemaVersion': 1, 'success': False, 'status': 'refused_before_or_during_regression',
                          'failureType': type(error).__name__}), flush=True)
        sys.exit(1)
