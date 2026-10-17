"""Linux-only isolated rerun; reuse pinned dependencies and preserve the initial failure."""
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
import tarfile
import time

BASE = pathlib.Path('/opt/telomere-host-runtime')
ORIGINAL = BASE / 'backend-completion-final-20261015-090932a350a5'
OLD_REVISION = 'd4481aec92179df44a533699897db2f523fbd0a2'
OLD_ARCHIVE = '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
TEST_PATH = 'python/tests/test_vault_income_journal.py'
archive_arg, manifest_arg, revision, archive_sha = sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}', revision) and re.fullmatch('[0-9a-f]{64}', archive_sha)
archive, manifest_path = pathlib.Path(archive_arg), pathlib.Path(manifest_arg)
upload = BASE / ('python-crypto-posix-upload-20261015-' + archive_sha[:12])
assert archive.parent == manifest_path.parent == upload and upload.resolve() == upload
assert archive.name == 'telomere-python-crypto-posix-corrected-20261015.tar.gz'
assert manifest_path.name == archive.name + '.manifest.json'
assert archive.is_file() and not archive.is_symlink() and not manifest_path.is_symlink()
assert ORIGINAL.resolve() == ORIGINAL and ORIGINAL.is_dir()
source = BASE / ('python-crypto-posix-corrected-20261015-' + archive_sha[:12])
assert source.parent.resolve() == BASE and not source.exists()
venv = ORIGINAL / '.local/python-crypto-venv'
assert venv.is_dir() and not venv.is_symlink() and (venv / 'bin/python').is_file()
os.umask(0o077)
started = time.monotonic()
deadline = started + 300


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


manifest = json.loads(manifest_path.read_bytes())
old_manifest = json.loads((ORIGINAL / '.local/source-manifest.json').read_bytes())
assert manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha == sha(archive)
assert old_manifest['gitRevision'] == OLD_REVISION and old_manifest['archiveSha256'] == OLD_ARCHIVE
for value in (manifest, old_manifest):
    assert value['source'] == 'committed_git_blobs_only' and value['workingTreeIncluded'] is False
    assert len(value['files']) == len({row['path'] for row in value['files']}) == 708
new_rows = {row['path']: row for row in manifest['files']}
old_rows = {row['path']: row for row in old_manifest['files']}
assert new_rows.keys() == old_rows.keys()
changed = [name for name in new_rows if new_rows[name] != old_rows[name]]
assert changed == [TEST_PATH]
source.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers()
    assert len(members) == len(new_rows)
    assert len({member.name for member in members}) == len(members)
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        assert member.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        assert member.name in new_rows
        raw = packed.extractfile(member).read()
        expected = new_rows[member.name]
        assert len(raw) == expected['bytes'] and hashlib.sha256(raw).hexdigest() == expected['sha256']
        destination = source / member.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(raw)
        os.chmod(destination, 0o700 if member.mode & 0o111 else 0o600)
assert 'self.assertCode("vault_income_journal_owned", journal.close)' in (source / TEST_PATH).read_text()
local = source / '.local'
local.mkdir(mode=0o700)
(local / 'source-manifest.json').write_bytes(manifest_path.read_bytes())
logs = local / 'python-crypto-posix-corrected-20261015'
logs.mkdir(mode=0o700)
home, temporary = logs / 'home', logs / 'tmp'
home.mkdir(mode=0o700)
temporary.mkdir(mode=0o700)
for name in ('dist', 'node_modules'):
    target = ORIGINAL / name
    assert target.is_dir() and not target.is_symlink()
    (source / name).symlink_to(target, target_is_directory=True)
assert (source / 'dist/src/sdk/cysts.js').is_file()
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8',
               'TMPDIR': str(temporary), 'PIP_CONFIG_FILE': '/dev/null', 'PIP_DISABLE_PIP_VERSION_CHECK': '1',
               'PIP_NO_INPUT': '1', 'PIP_NO_CACHE_DIR': '1', 'PYTHONNOUSERSITE': '1',
               'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(source / 'python/src')}
report = {'schema': 1, 'kind': 'GIT_PINNED_POSIX_FIX_OPTIONAL_PYTHON_CRYPTO_VALIDATION',
          'gitRevision': revision, 'archiveSha256': archive_sha, 'sourceFiles': 708,
          'source': str(source), 'sourceManifestSha256': sha(local / 'source-manifest.json'),
          'startedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'running',
          'originalGitRevision': OLD_REVISION, 'originalArchiveSha256': OLD_ARCHIVE,
          'originalSource': str(ORIGINAL), 'initialFailurePreserved': True,
          'sourceDiffFromOriginal': changed, 'productionSourceUnchanged': True,
          'existingVenvReused': str(venv), 'dependencyInstalls': 0, 'globalPackageInstalls': False,
          'existingTypeScriptBuildReused': str(ORIGINAL / 'dist'), 'serviceMutations': False,
          'providerCalls': 0, 'publicTransactions': 0, 'anvilOptInEnabled': False,
          'commands': [], 'sourceChangedDuringRun': []}


def save(name, value):
    (logs / name).write_text(json.dumps(value, indent=2) + '\n')


def inventory(root, rows):
    result = {}
    for row in rows.values():
        path = root / row['path']
        assert path.is_file() and not path.is_symlink()
        value = {'bytes': path.stat().st_size, 'sha256': sha(path), 'gitBlob': row['gitBlob']}
        assert value['bytes'] == row['bytes'] and value['sha256'] == row['sha256']
        result[row['path']] = value
    return result


def tree_inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            result[name] = {'symlink': os.readlink(path)}
        elif stat.S_ISREG(metadata.st_mode):
            result[name] = {'bytes': metadata.st_size, 'sha256': sha(path)}
        else:
            assert stat.S_ISDIR(metadata.st_mode)
    return result


def run(name, arguments, timeout):
    remaining = deadline - time.monotonic()
    assert remaining > 1
    save('progress.json', {'phase': name, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    begin = time.monotonic()
    with (logs / (name + '.stdout')).open('xb') as stdout, (logs / (name + '.stderr')).open('xb') as stderr:
        child = subprocess.Popen(arguments, cwd=source, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=stdout, stderr=stderr, start_new_session=True)
        timed_out = False
        try:
            child.wait(timeout=min(timeout, remaining))
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=3)
    row = {'name': name, 'argv': arguments, 'exitCode': child.returncode, 'timedOut': timed_out,
           'seconds': time.monotonic() - begin, 'stdoutSha256': sha(logs / (name + '.stdout')),
           'stderrSha256': sha(logs / (name + '.stderr'))}
    report['commands'].append(row)
    save('report.json', report)
    return row


def parse_tests(name, command):
    text = (logs / (name + '.stdout')).read_text() + (logs / (name + '.stderr')).read_text()
    summary = re.search(r'Ran ([0-9]+) tests in ([0-9.]+)s', text)
    assert summary
    skipped = [{'case': case, 'reason': reason} for case, reason in
               re.findall(r'^(test[^\n]+) \.\.\. skipped ([^\n]+)$', text, re.M)]
    return {'exitCode': command['exitCode'], 'testsRun': int(summary.group(1)), 'seconds': float(summary.group(2)),
            'skips': skipped, 'skippedCount': len(skipped),
            'cryptoDependencySkips': [row for row in skipped if 'Actual Windows ACL API' not in row['reason']
                                     and 'Explicitly enable disposable Anvil acceptance' not in row['reason']],
            'completedOk': bool(re.search(r'^OK(?: \(skipped=[0-9]+\))?$', text, re.M)),
            'actualPosixReplacementCasePassed': bool(re.search(
                r'^test_posix_replaced_owner_is_detected .* \.\.\. ok$', text, re.M)),
            'actualPosixForkCasePassed': bool(re.search(
                r'^test_posix_fork_cannot_reuse_inherited_owner .* \.\.\. ok$', text, re.M))}


before = {}
try:
    before['source'] = inventory(source, new_rows)
    before['original-source'] = inventory(ORIGINAL, old_rows)
    before['venv'] = tree_inventory(venv)
    before['typescript-dist'] = tree_inventory(ORIGINAL / 'dist')
    for name, value in before.items():
        save(name + '-before.json', value)
    initial_log = ORIGINAL / '.local/python-crypto-final-20261015'
    initial_names = ('report.json', 'unittest.stderr', 'unittest.stdout', 'source-before.json', 'source-after.json',
                     'pip-install-report.json', 'pip-check.stdout', 'pip-freeze.stdout', 'crypto-probe.stdout')
    initial_hashes = {name: sha(initial_log / name) for name in initial_names}
    report['initialFailureEvidenceSha256'] = initial_hashes
    old_report = json.loads((initial_log / 'report.json').read_bytes())
    assert old_report['status'] == 'failed' and old_report['unittest']['testsRun'] == 236
    assert old_report['unittest']['exitCode'] == 1 and not old_report['sourceChangedDuringRun']
    requirements = source / 'python/requirements-crypto.txt'
    pins = {}
    for line in requirements.read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_-]+)==([A-Za-z0-9.]+)', line)
        assert match
        pins[match.group(1).lower().replace('_', '-')] = match.group(2)
    assert len(pins) == 22 and pins == old_report['exactRequestedPins']
    report['requirementsSha256'] = sha(requirements)
    report['exactRequestedPins'] = pins
    python = str(venv / 'bin/python')
    assert run('pip-check', [python, '-B', '-m', 'pip', '--disable-pip-version-check', 'check'], 20)['exitCode'] == 0
    assert run('pip-freeze', [python, '-B', '-m', 'pip', '--disable-pip-version-check', 'freeze', '--all'], 20)['exitCode'] == 0
    probe = ("import sys,json,ssl,importlib.metadata,shutil;from telomere_sdk import EthAccountVerifier,PyCryptodomeCipher;"
             "v=EthAccountVerifier();c=PyCryptodomeCipher();print(json.dumps({'python':sys.version,'executable':sys.executable,"
             "'openssl':ssl.OPENSSL_VERSION,'userSiteEnabled':__import__('site').ENABLE_USER_SITE,"
             "'verifierType':type(v).__name__,'cipherType':type(c).__name__,'nodePath':shutil.which('node'),"
             "'keccakEmpty':v.keccak256(b'').hex(),'packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}))")
    assert run('crypto-probe', [python, '-B', '-c', probe], 20)['exitCode'] == 0
    details = json.loads((logs / 'crypto-probe.stdout').read_text())
    normalized = {name.lower().replace('_', '-'): version for name, version in details['packages'].items()}
    assert all(normalized.get(name) == version for name, version in pins.items())
    assert details['verifierType'] == 'EthAccountVerifier' and details['cipherType'] == 'PyCryptodomeCipher'
    assert details['userSiteEnabled'] is False and details['nodePath']
    assert details['keccakEmpty'] == 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    assert details == old_report['runtimeAndPackages']
    report['runtimeAndPackages'] = details
    focused = run('focused-journal', [python, '-B', '-m', 'unittest', 'discover', '-s', 'python/tests',
                                      '-p', 'test_vault_income_journal.py', '-v'], 60)
    report['focusedJournal'] = parse_tests('focused-journal', focused)
    assert focused['exitCode'] == 0 and report['focusedJournal']['completedOk']
    assert report['focusedJournal']['actualPosixReplacementCasePassed'] and report['focusedJournal']['actualPosixForkCasePassed']
    full = run('unittest', [python, '-B', '-m', 'unittest', 'discover', '-s', 'python/tests', '-v'], 120)
    report['unittest'] = parse_tests('unittest', full)
    assert full['exitCode'] == 0 and report['unittest']['completedOk']
    assert report['unittest']['testsRun'] == 236 and report['unittest']['skippedCount'] == 20
    assert not report['unittest']['cryptoDependencySkips']
    assert report['unittest']['actualPosixReplacementCasePassed'] and report['unittest']['actualPosixForkCasePassed']
    assert all(sha(initial_log / name) == value for name, value in initial_hashes.items())
    report['status'] = 'passed'
except BaseException as error:
    report['status'] = 'failed'
    report['failureType'] = type(error).__name__
finally:
    try:
        after = {'source': inventory(source, new_rows), 'original-source': inventory(ORIGINAL, old_rows),
                 'venv': tree_inventory(venv), 'typescript-dist': tree_inventory(ORIGINAL / 'dist')}
        for name, value in after.items():
            save(name + '-after.json', value)
        changes = [name for name in before if before[name] != after[name]]
        report['sourceChangedDuringRun'] = changes
        report['unchangedInventoryGroups'] = [name for name in before if before[name] == after[name]]
        if changes:
            report['status'] = 'failed'
    except BaseException as error:
        report['sourceAuditFailureType'] = type(error).__name__
        report['status'] = 'failed'
    report['seconds'] = time.monotonic() - started
    report['finishedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save('report.json', report)
    print(json.dumps({'status': report['status'], 'gitRevision': revision, 'source': str(source),
                      'logs': str(logs), 'seconds': report['seconds']}), flush=True)
sys.exit(0 if report['status'] == 'passed' else 1)
