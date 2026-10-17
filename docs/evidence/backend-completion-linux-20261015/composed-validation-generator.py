"""Generate a new composed-evidence index only after every required proof exists.

No server access, source edits or historical evidence rewriting. No execution on
import. Invoke from the repository root without arguments to publish, or pass
--controls for in-memory refusal controls and a separate fresh controls receipt.
Every output is exclusive; a refusal produces no validation document.
"""
import collections
import contextlib
import copy
import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVIDENCE = pathlib.PurePosixPath('docs/evidence/backend-completion-linux-20261015')
OUTPUT = pathlib.PurePosixPath('docs/backend-completion-validation-2026-10-15.json')
BASE_REV = '7bb69e5e73199ab372ca6c263297792634648aaf'
BASE_ARCHIVE = 'd10f22b3259a9b677bdd0997650e2d786365203af4de0a3f418a0011733a73c1'
FINAL_REV = 'd4481aec92179df44a533699897db2f523fbd0a2'
FINAL_ARCHIVE = '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
CORRECTED_REV = '36d8a7f877038e4a15e91d03c6f5ae71283a1263'
CORRECTED_ARCHIVE = '9d9a5993f9d8b617ce8759a56f21c8172c3ecf0429abf596cd077db4bdf6a7c2'
FIRST_PYTHON_REV = '777b861f355cfd8da07b3fd0bbb2a03c8f0197be'
PROTECTED = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
BUILDER_SHA = '07a64947271d4af2277ce1e11e1e04ca7e36ca395dadbe32faac1a8f2e767859'
RESTORE_CJS = 'cfa48859ee1bbd45d01213670e95d10edf7df877298002eaf0dfe7f694fbff59'
CAPTURE_CJS = '25156597bb08017a689a152fde97e0d9324a07e9ffb5cd74c44305da78876aad'
SERVICES = {'telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service'}
FOCUSED_FILES = sorted(['tests/chunk-aead.test.ts', 'tests/cyst-key-wrap.test.ts', 'tests/declared-state-bundle.test.ts',
    'tests/declared-state-restore.test.ts', 'tests/declared-state-session-checkpoint.test.ts',
    'tests/large-cyst-agent-manifest.test.ts', 'tests/large-cyst-checkpoints.test.ts', 'tests/large-cyst-current-resolver.test.ts',
    'tests/large-cyst-publication.test.ts', 'tests/large-cyst-replication.test.ts', 'tests/large-cyst-s3.test.ts',
    'tests/paid-cpu-jobs.test.ts', 'tests/paid-cyst-file-cache-expiry.test.ts', 'tests/paid-cyst-file-restore.test.ts',
    'tests/platform-cpu-offers.test.ts'])
REQUIRED_CASES = [
    'restores declared-directory state through encrypted multi-chunk Cyst, real Vault payment and one application command',
    'runs a paid CPU job across two offers on one physical source and a separately funded standard target',
    'uses actual signed HTTP HostKit commands and encrypted Cyst upload, replaying the original tree after source cleanup (real gVisor)']
FIXTURE_FAILURES = {
    ('tests/declared-state-restore.test.ts', 'bounded declared state restore inside the application Cell restores a declared file across multiple bounded streaming chunks without materializing the whole payload'),
    ('tests/paid-cpu-jobs.test.ts', REQUIRED_CASES[1]),
}
FIXED_TESTS = sorted(['python/tests/test_vault_income_journal.py', 'tests/declared-state-restore.test.ts', 'tests/paid-cpu-jobs.test.ts'])
SOURCE_ROOTS = ['src', 'scripts', 'infra', 'contracts', 'tests', 'python', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']
TEST_CONTINUITY = EVIDENCE / 'final-test-only-source-continuity.json'
INITIAL_PYTHON = pathlib.PurePosixPath('docs/evidence/python-crypto-final-initial-20261015')
CORRECTED_PYTHON = pathlib.PurePosixPath('docs/evidence/python-crypto-posix-corrected-20261015')
NATIVE_TEST = 'tests/golem-allocation-attribution.test.ts'
NATIVE_READER = 'src/suppliers/golem-allocation-attribution.ts'
NATIVE_REV = '079bb31fa76217df9d3d3d0e309293bf4f58e89c'
NATIVE_BASE_REV = '2298f3f99c9d0d1e22ac8928f71bff7d06ec0135'
NATIVE_EVIDENCE = pathlib.PurePosixPath('docs/evidence/golem-native-payment-doc-linux-20261015')
NATIVE_SQL_ROOT = pathlib.PurePosixPath('docs/evidence/golem-allocation-upstream-20261015')
NATIVE_SQL_FIXTURES = [str(NATIVE_SQL_ROOT / ('core/payment/migrations/' + migration + '/up.sql')) for migration in
                       ['2020-01-23-123456_init', '2024-08-12-171012_extended_order']]
NATIVE_NEW_CASES = {'refuses populated native payment-document ' + name + ' for activity and agreement shares'
                    for name in ('invoice_id', 'debit_note_id')}
NATIVE_WAL_CASE = 'reads a real existing WAL snapshot without changing DB/WAL bytes and refuses WAL over the reviewed bound'
FOLLOWUP_REV = 'bc3ca04617c2ec6b0fec32ee59aa34af97ba867d'
FOLLOWUP_ARCHIVE = '3ed17e69fc55c944999ca0449a3384beba7c0ef8753589d502463fa55a332ee2'
FOLLOWUP_FILES = ['tests/platform-runtime.test.ts', 'tests/selection-reputation-publisher.test.ts']
LAG_CASE = 'full platform controller CPU admission, full financial proof and fee settlement never repeats a paid ambiguous POST, settles CPU at zero inference charge, and frees the receipt hour'
SELECTION_CASE = 'durable canonical Selection ERC-8004 death publication refuses partial replacement-branch evidence until later real revival blocks are fully indexed before revocation'
FOLLOWUP_FAILURES = {(FOLLOWUP_FILES[0], LAG_CASE), (FOLLOWUP_FILES[1], SELECTION_CASE)}
FROZEN_GENERATOR = EVIDENCE / 'composed-validation-generator.py'
CONTROL_RECEIPT = EVIDENCE / 'composed-generator-refusal-controls.json'
CONTROL_NAMES = {'mandatory_case_missing', 'mandatory_case_failed', 'mandatory_case_skipped',
    'production_blob_altered', 'image_binding_mismatch', 'baseline_unfinished', 'cleanup_failed',
    'python_crypto_dependency_skipped', 'native_additional_runtime_change', 'native_cohort_skipped',
    'native_unexplained_baseline_failure', 'native_fixture_blob_altered', 'native_root_identity',
    'full_passed_file_omitted', 'final_fixture_additional_production_path', 'final_fixture_case_identity_missing'}
_CONTROL_DRY_RUN = False


class Refusal(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def read(relative, maximum=64 * 1024 * 1024):
    name = pathlib.PurePosixPath(relative)
    require(not name.is_absolute() and '..' not in name.parts and str(name) == str(relative), 'Unsafe evidence path')
    path = ROOT.joinpath(*name.parts)
    require(path.resolve().is_relative_to(ROOT) and path.is_file() and not path.is_symlink(), 'Missing/unsafe evidence')
    for parent in path.parents:
        require(not parent.is_symlink(), 'Symlink evidence ancestor')
        if parent == ROOT:
            break
    before = path.stat()
    require(0 <= before.st_size <= maximum, 'Evidence exceeds bound')
    raw = path.read_bytes()
    after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and len(raw) == before.st_size,
            'Evidence changed while reading')
    return raw


def ref(relative):
    raw = read(relative)
    return {'path': str(relative), 'bytes': len(raw), 'sha256': sha(raw)}


def data(relative):
    return json.loads(read(relative), object_pairs_hook=unique_pairs)


def load(name):
    return data(str(EVIDENCE / name))


def passed(record):
    require(record.get('success') is True and 'failureType' not in record and 'postflightFailureType' not in record,
            'Required acceptance failed or uncertain')


def source(record, final):
    require(record['gitRevision'] == (FINAL_REV if final else BASE_REV)
            and record['archiveSha256'] == (FINAL_ARCHIVE if final else BASE_ARCHIVE), 'Wrong source cutoff')


def health(value):
    require(set(value) == {'live', 'ready'}, 'Incomplete health evidence')
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        row = value[name]
        require(row.get('statusCode', row.get('code')) == 200
                and row.get('status', row.get('body', {}).get('status')) == expected, 'Unhealthy original service')


def service_values(value):
    require(set(value) == SERVICES, 'Wrong protected service set')
    result = {}
    for name, text in value.items():
        if isinstance(text, dict):
            require(set(text) == {'ActiveState', 'SubState', 'MainPID', 'WorkingDirectory', 'NRestarts'}, 'Malformed service projection')
            row = text
        else:
            pairs = [line.split('=', 1) for line in text.splitlines()]
            require(all(len(row) == 2 for row in pairs), 'Malformed service projection')
            row = unique_pairs(pairs)
        require(row.get('ActiveState') == 'active' and row.get('SubState') == 'running'
                and re.fullmatch('[1-9][0-9]*', row.get('MainPID', '')) and int(row['MainPID']) > 1
                and row.get('NRestarts') == '0' and row.get('WorkingDirectory', '').startswith('/opt/telomere-pilot/'),
                'Original service identity/restart mismatch')
        result[name] = row
    return result


def protected_state(record, anchor, protected=False, inventories=False):
    require(service_values(record['servicesBefore']) == service_values(record['servicesAfter'])
            == service_values(anchor['servicesAfter']), 'Original service changed')
    require(record['profileBeforeSha256'] == record['profileAfterSha256'] == anchor['profileAfterSha256'], 'Original profile changed')
    health(record['healthBefore']); health(record['healthAfter'])
    if protected:
        require(record['protectedBeforeSha256'] == record['protectedAfterSha256'] == anchor['protectedContainerBeforeSha256'],
                'Protected registry changed')
    if inventories:
        require(record['globalContainersBefore'] == record['globalContainersAfter'], 'Global Docker inventory changed')
        require(record['ownedContainersBefore'] == record['ownedContainersAfter'] == [PROTECTED], 'Owned resources remain')
    require(record.get('publicTransactions') == record.get('paidProviderRequests') == 0, 'External operation claim')
    for flag in ('serviceMutations', 'stagingServiceMutations'):
        if flag in record:
            require(record[flag] is False, 'Staging mutation claim')


def command_passed(row):
    require(row['exitCode'] == 0 and not row.get('timedOut', False) and not row.get('logLimitExceeded', False), 'Command failed/timed out')


def vitest(raw, expected_files=None, all_passed=False, allow_failed=False):
    require(type(raw['success']) is bool and (allow_failed or raw['success'] is True), 'Vitest failed')
    records, file_names, cases = [], [], []
    for file in raw['testResults']:
        path = pathlib.PurePosixPath(file['name'].replace('\\', '/'))
        require('tests' in path.parts, 'Unexpected test result path')
        name = '/'.join(path.parts[path.parts.index('tests'):])
        require(name not in file_names and file['assertionResults'], 'Empty/duplicate test file')
        file_names.append(name)
        for case in file['assertionResults']:
            require(isinstance(case['fullName'], str) and case['fullName']
                    and case['status'] in ('passed', 'failed', 'skipped', 'pending', 'todo'), 'Unknown assertion')
            row = {'file': name, 'name': case['fullName'], 'status': case['status']}
            if case['status'] == 'failed':
                row['failureMessages'] = case['failureMessages']
            cases.append(row)
        records.append({'path': name, 'assertions': len(file['assertionResults']), 'status': file['status']})
    counts = dict(collections.Counter(case['status'] for case in cases))
    require(len(cases) == raw['numTotalTests'] and len(cases) > 0
            and counts.get('passed', 0) == raw['numPassedTests']
            and counts.get('failed', 0) == raw['numFailedTests']
            and counts.get('skipped', 0) + counts.get('pending', 0) == raw['numPendingTests']
            and counts.get('todo', 0) == raw.get('numTodoTests', 0), 'Inconsistent Vitest counts')
    failed_files = [row for row in raw['testResults'] if row['status'] == 'failed']
    require(bool(counts.get('failed', 0)) == bool(failed_files)
            and (raw['success'] is True) == (not failed_files and not counts.get('failed', 0)), 'Inconsistent Vitest verdict')
    if not allow_failed:
        require(raw['numFailedTests'] == raw['numFailedTestSuites'] == 0, 'Vitest failed')
    if expected_files is not None:
        require(sorted(file_names) == expected_files, 'Wrong focused cohort file list')
    if all_passed:
        require(counts == {'passed': len(cases)} and raw['numPendingTests'] == 0, 'Focused assertions skipped')
    return {'counts': {key: raw[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']},
            'actualStatuses': counts, 'files': records, 'cases': cases,
            'skips': [case for case in cases if case['status'] in ('skipped', 'pending', 'todo')],
            'failures': [case for case in cases if case['status'] == 'failed'], 'originalRunPassed': raw['success']}


def python(raw, allow_failed=False):
    text = raw.decode('utf-8', errors='strict')
    summaries = re.findall(r'^(OK(?: \([^\n]*\))?|FAILED \([^\n]*\))$', text, re.MULTILINE)
    runs = re.findall(r'^Ran ([0-9]+) tests? in ([0-9.]+)s$', text, re.MULTILINE)
    require(len(summaries) == len(runs) == 1 and int(runs[0][0]) > 0
            and (allow_failed or summaries[0].startswith('OK')), 'Python regression failed/incomplete')
    cases = []
    for line in text.splitlines():
        match = re.match(r'^(\S+) \(([^\n]+)\) \.\.\. (ok|FAIL|ERROR|skipped .+|expected failure|unexpected success)$', line)
        if match:
            cases.append({'method': match[1], 'name': match[2], 'status': match[3]})
    require(len(cases) == int(runs[0][0]), 'Python verbose case accounting incomplete')
    skips = [case for case in cases if case['status'].startswith('skipped ')]
    skip_count = re.search(r'(?:\(|,\s*)skipped=([0-9]+)', summaries[0])
    require(len(skips) == (int(skip_count[1]) if skip_count else 0), 'Python skip summary differs')
    failures = [case for case in cases if case['status'] in ('FAIL', 'ERROR', 'unexpected success')]
    require(summaries[0].startswith('OK') == (not failures), 'Inconsistent Python verdict')
    return {'testsRun': int(runs[0][0]), 'seconds': float(runs[0][1]), 'summary': summaries[0],
            'originalRunPassed': summaries[0].startswith('OK'), 'cases': cases, 'skips': skips, 'failures': failures,
            'knownJournalCloseOwnershipError': bool(re.search(r'^telomere_sdk\.vault_income\.VaultIncomeError: vault_income_journal_owned$', text, re.MULTILINE)
                and re.search(r'in close\n\s+self\._guard\(\)', text)),
            'skipInterpretation': 'Actual environment-dependent exclusions; no acceptance credit for skipped crypto or integrations.'}


def continuity(value):
    require(value['baselineRevision'] == BASE_REV and value['finalRevision'] == FINAL_REV and value['baselineIsAncestorOfFinal'] is True
            and value['workingTreeReadForSource'] is False and value['readinessRescore'] is False, 'Wrong continuity boundary')
    before = {item['path']: item for item in value['baselineInventory']}
    after = {item['path']: item for item in value['finalInventory']}
    require(len(before) == len(value['baselineInventory']) == 703 and len(after) == len(value['finalInventory']) == 708, 'Duplicate/wrong source inventory')
    for inventory in (before, after):
        for name, row in inventory.items():
            path = pathlib.PurePosixPath(name)
            require(not path.is_absolute() and str(path) == name and '..' not in path.parts
                    and type(row['bytes']) is int and row['bytes'] >= 0 and re.fullmatch('[a-f0-9]{64}', row['sha256'])
                    and re.fullmatch('[a-f0-9]{40}', row['gitBlob']) and row['mode'] == '100644', 'Invalid source entry')
    added, deleted = sorted(set(after) - set(before)), sorted(set(before) - set(after))
    modified = sorted(name for name in set(after) & set(before) if after[name] != before[name])
    unchanged = sorted(name for name in set(after) & set(before) if after[name] == before[name])
    expected_added = sorted(['scripts/declared-state-cell-capture.ts', 'src/cysts/chunk-aead.ts', 'src/sdk/declared-state-checkpoint.ts',
                             'tests/chunk-aead.test.ts', 'tests/declared-state-session-checkpoint.test.ts'])
    expected_modified = sorted(['infra/host-kit/Dockerfile.declared-state', 'src/cysts/large-checkpoints.ts', 'src/sdk/index.ts', 'tests/paid-cpu-jobs.test.ts'])
    require(added == expected_added and modified == expected_modified and not deleted and len(unchanged) == 699
            and sorted(value['unchangedPaths']) == unchanged and sorted(value['added']) == added and sorted(value['modified']) == modified,
            'Unexpected source changes')
    require(value['counts'] == {'baseline': 703, 'final': 708, 'unchanged': 699, 'added': 5, 'modified': 4, 'deleted': 0, 'modeOnlyChanges': 0},
            'Continuity counts differ')
    return {'baselineFiles': 703, 'finalFiles': 708, 'unchanged': 699, 'added': added, 'modified': modified, 'deleted': [],
            'interpretation': 'Changed production crypto, capture hook, exports and image have final focused evidence; unchanged runtime subsystems retain baseline full-regression evidence.'}


def git_inventory(revision, roots=None):
    require(re.fullmatch('[a-f0-9]{40}', revision), 'Invalid Git revision')
    listing = subprocess.check_output(['git', 'ls-tree', '-r', '-z', revision, '--', *(roots or SOURCE_ROOTS)], cwd=ROOT)
    entries = []
    for entry in listing.split(b'\0'):
        if not entry:
            continue
        metadata, encoded = entry.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        path = encoded.decode('utf-8')
        require(mode == b'100644' and kind == b'blob' and path not in {row[0] for row in entries}, 'Unexpected Git tree entry')
        entries.append((path, blob.decode('ascii')))
    entries.sort()
    result = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                                    input=''.join(blob + '\n' for _, blob in entries).encode('ascii'))
    offset, inventory = 0, {}
    for path, blob in entries:
        end = result.index(b'\n', offset)
        header = result[offset:end].split()
        require(len(header) == 3 and header[0].decode() == blob and header[1] == b'blob', 'Git batch object mismatch')
        size = int(header[2]); raw = result[end + 1:end + 1 + size]; offset = end + 2 + size
        require(len(raw) == size and hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + raw).hexdigest() == blob,
                'Git blob content mismatch')
        inventory[path] = {'sha256': sha(raw), 'bytes': size, 'gitBlob': blob}
    require(offset == len(result), 'Git batch trailing data')
    return inventory


def test_continuity(value, python_revision):
    require(value['schemaVersion'] == 1 and value['status'] == 'accepted'
            and value['imageGitRevision'] == FINAL_REV and value['finalGitRevision'] == CORRECTED_REV
            and value['imageArchiveSha256'] == FINAL_ARCHIVE and value['finalArchiveSha256'] == CORRECTED_ARCHIVE,
            'Wrong corrected/image source cutoffs')
    before, after, py = (git_inventory(rev) for rev in (FINAL_REV, CORRECTED_REV, python_revision))
    require(len(before) == len(after) == len(py) == 708 and set(before) == set(after) == set(py), 'Corrected source paths differ')
    changed = sorted(path for path in before if before[path] != after[path])
    python_changed = sorted(path for path in before if before[path] != py[path])
    require(changed == FIXED_TESTS and python_changed in ([FIXED_TESTS[0]], FIXED_TESTS),
            'Correction changed production or unexpected test source')
    require(all(py[path] == after[path] for path in python_changed if path != FIXED_TESTS[0]),
            'Node fixture changed after its accepted Node cutoff')
    require(value['filesBefore'] == value['filesAfter'] == 708 and value['unchangedFiles'] == 705
            and value['changedPaths'] == changed and value['addedPaths'] == value['deletedPaths'] == value['runtimeChangedPaths'] == [],
            'Test-only continuity totals differ')
    rows = {row['path']: row for row in value['files']}
    require(len(rows) == len(value['files']) == 708 and set(rows) == set(before), 'Wrong continuity inventory')
    for path, row in rows.items():
        require(row['before'] == before[path] and row['after'] == after[path]
                and row['changed'] is (path in changed), 'Git continuity bytes differ')
    return {'imageGitRevision': FINAL_REV, 'correctedNodeGitRevision': CORRECTED_REV,
            'correctedPythonGitRevision': python_revision, 'files': 708, 'unchanged': 705, 'modifiedTests': changed,
            'pythonModifiedTestsFromImage': python_changed,
            'productionSourceUnchanged': True, 'gitBlobsIndependentlyRecomputed': True,
            'pythonTestIdenticalBetweenCorrectedCutoffs': after[FIXED_TESTS[0]] == py[FIXED_TESTS[0]],
            'interpretation': 'The d448 image/build remains authoritative for identical production bytes. Node and Python corrections have separate source cutoffs; no full combined-cutoff test execution is claimed.'}


def sole_python_fixture_failure(value):
    require(len(value['failures']) == 1 and value['failures'][0]['method'] == 'test_posix_replaced_owner_is_detected'
            and value['failures'][0]['status'] == 'ERROR' and value['knownJournalCloseOwnershipError'] is True,
            'Unexpected unresolved Python failure')


def corrected_python():
    initial = data(str(INITIAL_PYTHON / 'report.json'))
    retained = data(str(INITIAL_PYTHON / 'retention.json'))
    before = python(read(str(INITIAL_PYTHON / 'unittest.stderr')), allow_failed=True)
    source(initial, True)
    require(initial['status'] == 'failed' and initial['sourceChangedDuringRun'] == []
            and before['testsRun'] == 236 and len(before['skips']) == 20
            and initial['unittest']['cryptoDependencySkips'] == [] and initial['unittest']['completedOk'] is False,
            'Initial Python failure was lost/relabeled')
    sole_python_fixture_failure(before)
    require(retained['originalFilesCopiedWithoutModification'] is True and retained['sourceBeforeAfterIdentical'] is True
            and retained['status'] == 'failed' and retained['failureCase'] == 'test_posix_replaced_owner_is_detected',
            'Initial Python retention differs')
    for row in retained['files']:
        actual = ref(str(INITIAL_PYTHON / row['path']))
        require(actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], 'Retained Python bytes changed')
    value = data(str(CORRECTED_PYTHON / 'report.json'))
    python_revision = value['gitRevision']
    require(re.fullmatch('[a-f0-9]{40}', python_revision) and python_revision not in (FINAL_REV, FIRST_PYTHON_REV)
            and re.fullmatch('[a-f0-9]{64}', value['archiveSha256'])
            and value['sourceFiles'] == 708 and value['originalGitRevision'] == FINAL_REV
            and value['originalArchiveSha256'] == FINAL_ARCHIVE
            and value['sourceDiffFromOriginal'] in ([FIXED_TESTS[0]], FIXED_TESTS) and value['productionSourceUnchanged'] is True
            and value['existingVenvReused'] == initial['venv'] and value['dependencyInstalls'] == 0
            and value['sourceChangedDuringRun'] == [], 'Corrected Python source/environment differs')
    require(set(value['initialFailureEvidenceSha256']) == {'report.json', 'unittest.stderr', 'unittest.stdout',
            'source-before.json', 'source-after.json', 'pip-install-report.json', 'pip-check.stdout', 'pip-freeze.stdout', 'crypto-probe.stdout'}
            and all(ref(str(INITIAL_PYTHON / name))['sha256'] == digest for name, digest in value['initialFailureEvidenceSha256'].items()),
            'Corrected Python initial failure bindings differ')
    require(set(value['unchangedInventoryGroups']) == {'source', 'original-source', 'venv', 'typescript-dist'},
            'Python inventory guards incomplete')
    require(value['status'] == 'passed' and value['providerCalls'] == value['publicTransactions'] == 0
            and value['globalPackageInstalls'] is False and value['serviceMutations'] is False
            and value['anvilOptInEnabled'] is False and value['initialFailurePreserved'] is True
            and 'failureType' not in value and 'sourceAuditFailureType' not in value, 'Corrected Python failed or external execution')
    for group in value['unchangedInventoryGroups']:
        before_inventory = data(str(CORRECTED_PYTHON / (group + '-before.json')))
        require(before_inventory == data(str(CORRECTED_PYTHON / (group + '-after.json'))), 'Corrected Python inventory bytes changed')
        if group in ('source', 'original-source'):
            require(before_inventory == git_inventory(python_revision if group == 'source' else FINAL_REV),
                    'Corrected Python source inventory differs from Git blobs')
    manifest = data(str(CORRECTED_PYTHON / 'source-manifest.json'))
    require(manifest['gitRevision'] == python_revision and manifest['archiveSha256'] == value['archiveSha256']
            and manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and value['sourceManifestSha256'] == ref(str(CORRECTED_PYTHON / 'source-manifest.json'))['sha256']
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in manifest['files']} == git_inventory(python_revision)
            and len(manifest['files']) == 708, 'Corrected Python archive provenance differs')
    commands = {row['name']: row for row in value['commands']}
    require(len(commands) == len(value['commands']), 'Duplicate Python command')
    for name, row in commands.items():
        command_passed(row)
        for suffix in ('stdout', 'stderr'):
            require(row[suffix + 'Sha256'] == ref(str(CORRECTED_PYTHON / (name + '.' + suffix)))['sha256'],
                    'Corrected Python command log binding differs')
    require({'crypto-probe', 'pip-check', 'focused-journal', 'unittest'} <= set(commands), 'Incomplete corrected Python commands')
    probe = data(str(CORRECTED_PYTHON / 'crypto-probe.stdout'))
    require(probe['userSiteEnabled'] is False and probe['verifierType'] == 'EthAccountVerifier'
            and probe['cipherType'] == 'PyCryptodomeCipher'
            and probe['keccakEmpty'] == 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
            'Optional crypto was not loaded')
    require(probe == value['runtimeAndPackages'] == initial['runtimeAndPackages']
            and value['requirementsSha256'] == initial['requirementsSha256'] == git_inventory(FINAL_REV)['python/requirements-crypto.txt']['sha256'],
            'Python environment or crypto requirements changed')
    normalized = lambda text: text.lower().replace('_', '-').replace('.', '-')
    packages = {normalized(name): version for name, version in probe['packages'].items()}
    require(value['exactRequestedPins'] == initial['exactRequestedPins'] and len(value['exactRequestedPins']) == 22
            and all(packages.get(normalized(name)) == version for name, version in value['exactRequestedPins'].items()),
            'Python crypto pins differ')
    after = python(read(str(CORRECTED_PYTHON / 'unittest.stderr')))
    journal = python(read(str(CORRECTED_PYTHON / 'focused-journal.stderr')))
    require(after['testsRun'] == 236 and len(after['skips']) == 20
            and [(row['name'], row['status']) for row in after['skips']] == [(row['name'], row['status']) for row in before['skips']],
            'Corrected Python case/exclusion set differs')
    for key, actual in [('unittest', after), ('focusedJournal', journal)]:
        summary = value[key]
        require(summary['testsRun'] == actual['testsRun'] and summary['skippedCount'] == len(actual['skips'])
                and summary['completedOk'] is True and summary['cryptoDependencySkips'] == []
                and summary['actualPosixReplacementCasePassed'] is True and summary['actualPosixForkCasePassed'] is True,
                'Corrected Python summary differs')
        require(any(row['method'] == 'test_posix_replaced_owner_is_detected' and row['status'] == 'ok' for row in actual['cases']),
                'POSIX replacement refusal case absent')
    first_path = pathlib.PurePosixPath('docs/evidence/python-crypto-posix-first-correction-20261015')
    first = data(str(first_path / 'report.json'))
    first_run = python(read(str(first_path / 'unittest.stderr')), allow_failed=True)
    require(first['gitRevision'] == FIRST_PYTHON_REV and first['status'] == 'failed' and first_run['testsRun'] == 236
            and len(first_run['failures']) == 1 and first_run['failures'][0]['method'] == 'test_posix_replaced_owner_is_detected',
            'First Python correction failure was lost/relabeled')
    first_retained = data(str(first_path / 'retention.json'))
    for row in first_retained['files']:
        actual = ref(str(first_path / row['path']))
        require(actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], 'First correction retained bytes changed')
    final_retained = data(str(CORRECTED_PYTHON / 'retention.json'))
    require(final_retained['status'] == 'passed' and final_retained['gitRevision'] == python_revision
            and final_retained['archiveSha256'] == value['archiveSha256']
            and final_retained['priorFailedEvidencePreserved'] is True
            and final_retained['originalFilesCopiedWithoutModification'] is True, 'Corrected Python retention differs')
    for row in final_retained['files']:
        actual = ref(str(CORRECTED_PYTHON / row['path']))
        require(actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], 'Corrected Python retained bytes changed')
    require({(row['method'], row['name']) for row in before['cases']} == {(row['method'], row['name']) for row in after['cases']},
            'Corrected Python test identity set differs')
    return {'initialFailedRun': before, 'firstCorrectionFailedRun': first_run, 'correctedRun': after, 'focusedJournal': journal,
            'gitRevision': python_revision, 'archiveSha256': value['archiveSha256'],
            'optionalCryptoLoaded': True, 'requirementsPins': 22, 'dependencyInstallsDuringCorrection': 0,
            'sourceAndVenvAndDistInventoriesUnchanged': True}


def native_reader_patch(full_node, full, anchor):
    initial_dir = NATIVE_EVIDENCE / 'initial-linux'
    initial = data(str(initial_dir / 'acceptance.json'))
    initial_cases = vitest(data(str(initial_dir / 'vitest.json')), [NATIVE_TEST], allow_failed=True)
    require(initial['gitRevision'] == '079bb31fa76217df9d3d3d0e309293bf4f58e89c'
            and initial['archiveSha256'] == '74e8a76b12bcbb17aaca41881d4294d59620330bd3ede6829213d1a70d853460'
            and initial['success'] is False and initial['failureType'] == 'AssertionError'
            and 'postflightFailureType' not in initial and initial['reader']['exitCode'] == 1
            and initial_cases['counts'] == {'numTotalTests': 27, 'numPassedTests': 26, 'numFailedTests': 1, 'numPendingTests': 0}
            and [row['name'] for row in initial_cases['failures']] == [NATIVE_WAL_CASE]
            and initial['sourceBefore'] == initial['sourceAfter'] == initial['originalSourceBefore'] == initial['originalSourceAfter']
                == {'unchanged': True, 'verified': 708, 'changed': []}, 'Historical native-reader WAL failure was lost/relabeled')
    protected_state(initial, anchor)
    value = data(str(NATIVE_EVIDENCE / 'acceptance.json'))
    passed(value)
    require(value['gitRevision'] == NATIVE_REV
            and value['baselineRevision'] == NATIVE_BASE_REV and re.fullmatch('[a-f0-9]{64}', value['archiveSha256'])
            and value['sourceFiles'] == 708 and value['changedRuntimePaths'] == sorted([NATIVE_READER, NATIVE_TEST]),
            'Wrong native-reader production patch boundary')
    before, after = git_inventory(NATIVE_BASE_REV), git_inventory(NATIVE_REV)
    require(len(before) == len(after) == 708 and set(before) == set(after)
            and sorted(path for path in before if before[path] != after[path]) == sorted([NATIVE_READER, NATIVE_TEST]),
            'Native-reader correction changed additional production/test files')
    require(value['sourceBefore'] == value['sourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []},
            'Native-reader source changed during validation')
    original_manifest = data(str(NATIVE_EVIDENCE / 'original-source-manifest.json'))
    require(value['originalGitRevision'] == original_manifest['gitRevision'] == FINAL_REV
            and original_manifest['archiveSha256'] == FINAL_ARCHIVE
            and original_manifest['source'] == 'committed_git_blobs_only' and original_manifest['workingTreeIncluded'] is False
            and value['originalSourceBefore'] == value['originalSourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []}
            and value['originalSourceManifestSha256'] == ref(str(NATIVE_EVIDENCE / 'original-source-manifest.json'))['sha256']
            and len(original_manifest['files']) == 708
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in original_manifest['files']} == git_inventory(FINAL_REV),
            'Native-reader validation changed original frozen source')
    manifest = data(str(NATIVE_EVIDENCE / 'source-manifest.json'))
    require(manifest['gitRevision'] == NATIVE_REV and manifest['archiveSha256'] == value['archiveSha256']
            and manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in manifest['files']} == after
            and len(manifest['files']) == 708, 'Native-reader source archive differs from Git blobs')
    protected_state(value, anchor)
    require(value['nodeVersion'] == 'v22.23.3' and value['productionYagna'] is False and value['hardwareAttestation'] is False,
            'Native-reader environment/scope differs')
    require(value['executionProfile'] == 'existing_nonroot_uid_65534_same_fixture_owner'
            and value['nodeIdentity'] == data(str(NATIVE_EVIDENCE / 'identity.log')) == {'uid': 65534, 'gid': 65534, 'groups': [65534]}
            and value['nonrootProcessesBefore'] == value['nonrootProcessesAfter'] == [],
            'Native-reader nonroot execution identity differs')
    ownership = value['sourceTreeOwnershipBefore']
    require(ownership == value['sourceTreeOwnershipAfter']
            and ownership['scope'] == 'every_preexisting_private_copy_path_including_runtime_fixtures_dependencies_and_directories'
            and ownership['uid'] == ownership['gid'] == 65534 and ownership['verified'] > 20000
            and ownership['unexpected'] == [] and ownership['unchanged'] is True, 'Native-reader private copy ownership differs')
    observations = value['fixtureOwnershipObservations']
    require(observations and all(row['uid'] == row['gid'] == 65534 for row in observations.values())
            and all(any(path.endswith('/' + suffix) for path in observations) for suffix in ('payment.db', 'payment.db-wal', 'payment.db-shm')),
            'Native-reader actual SQLite fixture ownership differs')
    command_passed(value['identity'])
    for name in ('typecheck', 'reader'):
        command_passed(value[name])
        require(not value.get(name + 'TimedOut', False), 'Native-reader command timed out')
    require(value['typecheck']['command'] == ['node', 'node_modules/typescript/bin/tsc', '--noEmit']
            and value['reader']['command'] == ['node', 'node_modules/vitest/vitest.mjs', 'run', NATIVE_TEST,
                 '--no-cache', '--reporter=json', '--outputFile=.local/vitest.json'], 'Native-reader command scope differs')
    raw = data(str(NATIVE_EVIDENCE / 'vitest.json'))
    result = vitest(raw, [NATIVE_TEST], all_passed=True)
    require(result['counts'] == {'numTotalTests': 27, 'numPassedTests': 27, 'numFailedTests': 0, 'numPendingTests': 0},
            'Native-reader Linux cohort not complete')
    expected_cases = data(str(NATIVE_EVIDENCE / 'expected-cases.json'))
    require(value['caseNames'] == expected_cases['cases'] == sorted(row['name'] for row in result['cases'])
            and expected_cases['gitRevision'] == NATIVE_REV and expected_cases['expectedTotal'] == 27
            and expected_cases['expectedSkipped'] == 0 and expected_cases['sourceTestSha256'] == after[NATIVE_TEST]['sha256']
            and value['posixSymlinkExercised'] is True, 'Native-reader expected scenario/POSIX proof differs')
    original_cases = [row for row in full_node['cases'] if row['file'] == NATIVE_TEST]
    original_ids = {row['name'] for row in original_cases}
    final_ids = {row['name'] for row in result['cases']}
    require(len(original_cases) == len(original_ids) == 25 and len(final_ids) == 27
            and final_ids - original_ids == NATIVE_NEW_CASES and original_ids <= final_ids,
            'Native-reader original25/new2 scenario identities differ')
    failed_setup = [row for row in original_cases if row['status'] == 'failed']
    if failed_setup:
        require(len(failed_setup) == 25, 'Partial native-reader failure cohort is not explained by missing setup fixtures')
        expected_paths = {full['sourceDirectory'] + '/' + name for name in NATIVE_SQL_FIXTURES}
        for row in failed_setup:
            messages = row['failureMessages']
            require(len(messages) == 1 and isinstance(messages[0], str), 'Unexpected native-reader setup failure shape')
            lines = messages[0].splitlines()
            match = re.fullmatch(r"Error: ENOENT: no such file or directory, open '([^'\n]+)'", lines[0] if lines else '')
            require(match is not None and match[1] in expected_paths
                    and all(line.startswith('    at ') or not line for line in lines[1:]),
                    'Native-reader baseline failure is not exact retained-SQL ENOENT setup failure')
    fixtures = data(str(NATIVE_EVIDENCE / 'upstream-fixture-manifest.json'))
    expected_fixtures = git_inventory(NATIVE_REV, [str(NATIVE_SQL_ROOT)])
    require(len(expected_fixtures) == 12 and set(NATIVE_SQL_FIXTURES) <= set(expected_fixtures), 'Wrong retained native fixture source set')
    require(expected_fixtures == git_inventory(BASE_REV, [str(NATIVE_SQL_ROOT)])
            == git_inventory(FINAL_REV, [str(NATIVE_SQL_ROOT)]) == git_inventory(NATIVE_BASE_REV, [str(NATIVE_SQL_ROOT)]),
            'Native-reader retained fixtures changed between historical source cutoffs')
    # The supplement is separate from the runtime archive. It is accepted only
    # as exact immutable committed documentation bytes, never as a source edit.
    require(fixtures['gitRevision'] == NATIVE_REV and fixtures['source'] == 'committed_git_blobs_only'
            and fixtures['workingTreeIncluded'] is False
            and fixtures['upstreamRevision'] == value['upstreamFixtures']['upstreamRevision'] == 'c256fce68c50c141a51d4bd2ca18292e4b006f15'
            and fixtures['archiveSha256'] == value['upstreamFixtures']['archiveSha256'] and value['upstreamFixtures']['files'] == 12
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in fixtures['files']} == expected_fixtures
            and len(fixtures['files']) == 12, 'Native-reader supplement differs from committed Git fixtures')
    for path, row in expected_fixtures.items():
        actual = ref(path)
        require(actual['sha256'] == row['sha256'] and actual['bytes'] == row['bytes'], 'Retained native fixture bytes changed')
    dependencies_before = read(str(NATIVE_EVIDENCE / 'dependency-inventory-before.json'))
    source_dependencies_before = read(str(NATIVE_EVIDENCE / 'source-dependency-inventory-before.json'))
    require(dependencies_before == read(str(NATIVE_EVIDENCE / 'dependency-inventory-after.json'))
            == source_dependencies_before == read(str(NATIVE_EVIDENCE / 'source-dependency-inventory-after.json'))
            and value['dependencyInventoryBeforeSha256'] == value['dependencyInventoryAfterSha256'] == sha(dependencies_before)
            and value['sourceDependencyInventoryBeforeSha256'] == value['sourceDependencyInventoryAfterSha256'] == sha(source_dependencies_before)
            and value['dependenciesUnchanged'] is True,
            'Native-reader dependency inventories changed')
    require(value['supplementBefore'] == value['supplementAfter'] == {'unchanged': True, 'verified': 12, 'changed': []}
            and read(str(NATIVE_EVIDENCE / 'upstream-fixture-inventory-before.json')) == read(str(NATIVE_EVIDENCE / 'upstream-fixture-inventory-after.json'))
            and value['supplementBeforeSha256'] == value['supplementAfterSha256'] == ref(str(NATIVE_EVIDENCE / 'upstream-fixture-inventory-before.json'))['sha256'],
            'Native-reader fixture guards differ')
    return {'gitRevision': NATIVE_REV, 'baselineRevision': NATIVE_BASE_REV, 'archiveSha256': value['archiveSha256'],
            'sourceFiles': 708, 'unchangedRuntimeFiles': 706, 'modifiedRuntimePaths': sorted([NATIVE_READER, NATIVE_TEST]),
            'gitBlobsIndependentlyRecomputed': True, 'fullAffectedLinuxCohort': result,
            'initialLinuxWalFailurePreserved': initial_cases,
            'original25ScenarioIdentitiesPreserved': True, 'newNegativeScenarios': sorted(NATIVE_NEW_CASES),
            'baselineSetupFailures': failed_setup, 'originalFullRunVerdictUnchanged': True,
            'runtimeArchiveExcludedFixturePaths': NATIVE_SQL_FIXTURES,
            'fixtureSupplementEntries': 12, 'fixtureSupplementGitBlobsVerified': True,
            'fixtureSupplementSeparateFromRuntimeArchive': True, 'fullLatestSourceSuiteExecuted': False,
            'executionProfile': 'nonroot_reader_same_uid_as_private_database_owner',
            'acceptanceNodeUid': 65534, 'acceptanceNodeGid': 65534,
            'actualDbWalShmOwnershipObservedDuringTests': True, 'rootWalProfileAccepted': False,
            'strictCtimeGuardsRetainedWithoutWorkerPatch': True,
            'productionPatchNotIncludedInPriorImageOrBuildRevision': True}


def supplemental_fixture_corrections(full_node, anchor):
    value = load('full-twofile-acceptance.json')
    passed(value)
    require(value['gitRevision'] == FOLLOWUP_REV and value['archiveSha256'] == FOLLOWUP_ARCHIVE
            and value['baselineRevision'] == NATIVE_REV and value['sourceFiles'] == 708
            and value['changedRuntimePaths'] == FOLLOWUP_FILES, 'Wrong final fixture correction boundary')
    before, after = git_inventory(NATIVE_REV), git_inventory(FOLLOWUP_REV)
    require(len(before) == len(after) == 708 and set(before) == set(after)
            and sorted(path for path in before if before[path] != after[path]) == FOLLOWUP_FILES,
            'Final fixture correction changed additional production/test files')
    manifest = load('full-twofile-source-manifest.json')
    require(manifest['gitRevision'] == FOLLOWUP_REV and manifest['archiveSha256'] == FOLLOWUP_ARCHIVE
            and manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and value['sourceManifestSha256'] == ref(str(EVIDENCE / 'full-twofile-source-manifest.json'))['sha256']
            and len(manifest['files']) == 708
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in manifest['files']} == after,
            'Final fixture source archive differs from Git blobs')
    proof = load('full-twofile-source-continuity.json')
    require(proof['status'] == 'accepted_source_continuity_only' and proof['baselineRevision'] == NATIVE_REV
            and proof['finalRevision'] == FOLLOWUP_REV and proof['archiveSha256'] == FOLLOWUP_ARCHIVE
            and proof['sourceManifestSha256'] == value['sourceManifestSha256']
            and proof['sourceFilesBefore'] == proof['sourceFilesAfter'] == 708 and proof['unchangedFiles'] == 706
            and proof['changedRuntimePaths'] == FOLLOWUP_FILES
            and proof['productionChangedPaths'] == proof['addedPaths'] == proof['deletedPaths'] == []
            and proof['source'] == 'independent_git_blobs_only' and proof['workingTreeIncluded'] is False,
            'Final fixture continuity boundary differs')
    recorded = {row['path']: row for row in proof['files']}
    require(len(recorded) == len(proof['files']) == 708 and set(recorded) == set(before), 'Final fixture continuity file set differs')
    for path, row in recorded.items():
        require(row['before'] == before[path] and row['after'] == after[path] and row['changed'] is (path in FOLLOWUP_FILES),
                'Final fixture continuity differs from actual Git blobs')
    protected_state(value, anchor)
    require(value['status'] == 'accepted_corrected_twofile_regressions'
            and value['productionChangedPaths'] == []
            and value['sourceContinuitySha256'] == ref(str(EVIDENCE / 'full-twofile-source-continuity.json'))['sha256']
            and value['preparerSha256'] == ref(str(EVIDENCE / 'full-twofile-preparer.py'))['sha256']
            and value['preparationSha256'] == ref(str(EVIDENCE / 'full-twofile-preparation.json'))['sha256']
            and value['originalFullNodeSha256'] == ref(str(EVIDENCE / 'full-node.json'))['sha256'],
            'Final fixture source/helper bindings differ')
    require(value['oldSourceBefore'] == value['oldSourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []}
            and value['baselineFullSourceBefore'] == value['baselineFullSourceAfter'] == {'unchanged': True, 'verified': 703, 'changed': []}
            and value['oldManifestSha256'] == ref(str(NATIVE_EVIDENCE / 'original-source-manifest.json'))['sha256']
            and value['dependenciesCopiedToOwnedDirectory'] is True and value['dependencyOrSourceMutations'] is False
            and value['reinstallPerformed'] is False and value['rebuildPerformed'] is False,
            'Final fixture original source/dependency ownership guards differ')
    dependencies = load('full-twofile-dependency-inventory.json')
    dependency_sha = sha((json.dumps(dependencies, sort_keys=True, separators=(',', ':')) + '\n').encode())
    require(set(dependencies) == {'node_modules', 'dist'} and len(dependencies['node_modules']) == 21050 and len(dependencies['dist']) == 585
            and value['dependencyEntries'] == {name: len(rows) for name, rows in dependencies.items()}
            and value['originalDependencyInventoryBeforeSha256'] == value['originalDependencyInventoryAfterSha256']
                == value['copiedDependencyInventoryBeforeSha256'] == value['copiedDependencyInventoryAfterSha256'] == dependency_sha,
            'Final fixture dependency inventories changed')
    preparation = load('full-twofile-preparation.json')
    passed(preparation)
    require(preparation['status'] == 'accepted_preparation_only' and preparation['gitRevision'] == FOLLOWUP_REV
            and preparation['archiveSha256'] == FOLLOWUP_ARCHIVE and preparation['sourceFiles'] == 708
            and preparation['oldSourceBefore'] == preparation['oldSourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []}
            and preparation['sourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []}
            and preparation['oldManifestSha256'] == value['oldManifestSha256']
            and preparation['dependencyInventoryBeforeSha256'] == preparation['dependencyInventoryAfterSha256']
                == preparation['copiedDependencyInventorySha256'] == dependency_sha,
            'Final fixture preparation identity differs')
    config = value['testRunnerConfig']
    source_config = subprocess.check_output(['git', 'show', FOLLOWUP_REV + ':vitest.config.ts'], cwd=ROOT).decode('utf-8')
    cache_dir = value['sourceDirectory'] + '/.local/vite-cache'
    derived_config = source_config.replace('defineConfig({ test:', 'defineConfig({ cacheDir: ' + json.dumps(cache_dir) + ', test:')
    require(config == {'cacheEnabled': False, 'configLoader': 'runner', 'cacheDir': cache_dir,
                'sourceConfigSha256': sha(source_config.encode()), 'derivedConfigSha256': sha(derived_config.encode())},
            'Final fixture isolated test configuration differs')
    require(value['originalFailedReportSha256'] == ref(str(EVIDENCE / 'full-acceptance.json'))['sha256']
            and value['ownedAnvilProcessesRemaining'] == [] and value['dockerOptInEnabled'] is False,
            'Final fixture ownership/historical binding differs')
    require(value['sourceBefore'] == value['sourceAfter'] == {'unchanged': True, 'verified': 708, 'changed': []},
            'Final fixture source changed')
    for name in ('typecheck', 'node'):
        command_passed(value[name])
    result = vitest(load('full-twofile-node.json'), FOLLOWUP_FILES, all_passed=True)
    expected = collections.Counter((row['file'], row['name']) for row in full_node['cases'] if row['file'] in FOLLOWUP_FILES)
    actual = collections.Counter((row['file'], row['name']) for row in result['cases'])
    require(result['counts'] == {'numTotalTests': 59, 'numPassedTests': 59, 'numFailedTests': 0, 'numPendingTests': 0}
            and actual == expected and {row['path']: row['assertions'] for row in result['files']}
                == {FOLLOWUP_FILES[0]: 29, FOLLOWUP_FILES[1]: 30}, 'Final fixture complete file/case identities differ')
    identity_sha = sha((json.dumps(sorted(actual.elements()), separators=(',', ':')) + '\n').encode())
    require(value['caseIdentitiesEqualOriginalFullSubsets'] is True
            and value['baselineCaseIdentitySha256'] == value['actualCaseIdentitySha256'] == identity_sha,
            'Final fixture case identity digest differs')
    lag = value['clockLagRegression']
    require(lag == {'testFileSha256': after[FOLLOWUP_FILES[0]]['sha256'], 'case': LAG_CASE,
                'status': 'passed', 'proofKind': 'reviewed_git_pinned_case_assertions_with_real_local_subprocess_and_Anvil',
                'assertions': ['original_endedAt_gt_canonical_head', 'canSeal_false_before_and_after_reopen',
                    'canonical_advance_only_to_original_endedAt', 'original_settlement_unchanged', 'receipt_recorded',
                    'paid_callback_once', 'closed_hour_canSeal_true_before_final_drain', 'final_completed']},
            'Final fixture canonical clock-lag proof differs')
    for case in (LAG_CASE, SELECTION_CASE):
        require(sum(row['name'] == case and row['status'] == 'passed' for row in result['cases']) == 1,
                'Final fixture mandatory regression absent')
    def git_text(revision, path):
        return subprocess.check_output(['git', 'show', revision + ':' + path], cwd=ROOT).decode('utf-8')
    selection_before, selection_after = (git_text(rev, FOLLOWUP_FILES[1]) for rev in (NATIVE_REV, FOLLOWUP_REV))
    old_end, new_end = '  });\n});\n', '  }, 45000);\n});\n'
    require(selection_before.endswith(old_end) and selection_after == selection_before[:-len(old_end)] + new_end,
            'Selection fixture changed more than its one explicit integration deadline')
    platform = git_text(FOLLOWUP_REV, FOLLOWUP_FILES[0])
    start = platform.index("  it('never repeats a paid ambiguous POST,")
    end = platform.index("  it('recovers a crash after durable NEAR dispatch intent", start)
    body = platform[start:end]
    require('await local.test.setBlockTimestampInterval({ interval: 0 }); runtime.delay = 1500;' in body
            and 'expect(original.endedAt).toBeGreaterThan(await bridge.now());' in body
            and body.count('expect(await service.canSeal(hour)).toBe(false);') == 2
            and 'await local.test.setNextBlockTimestamp({ timestamp: BigInt(original.endedAt) }); await local.test.mine({ blocks: 1 });' in body
            and 'expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).settlement).toEqual(original);' in body
            and 'expect(await receipts.hasRecorded(local.accounts.owner.address, original)).toBe(true);' in body
            and body.count('expect(near.provider.complete).toHaveBeenCalledTimes(1);') == 2
            and body.index('expect(await service.canSeal(hour)).toBe(true);') < body.index("status).toBe('completed')"),
            'Reviewed canonical lag causality regression changed')
    return {'gitRevision': FOLLOWUP_REV, 'archiveSha256': FOLLOWUP_ARCHIVE, 'baselineRevision': NATIVE_REV,
            'modifiedTests': FOLLOWUP_FILES, 'productionSourceUnchanged': True, 'unchangedRuntimeFiles': 706,
            'fullAffectedLinuxCohort': result, 'original59CaseIdentitiesPreserved': True,
            'originalFullRunStillFailed': True, 'explicitChainLagNegativeThenOriginalTimeCatchupRegressionPassed': True,
            'receiptSealGateAndOriginalSettlementAndOnceOnlyPostAssertionsPreserved': True,
            'selectionAssertionsUnchanged': True, 'selectionSingleCaseBudgetMs': 45000,
            'fullLatestSourceSuiteExecuted': False}


def publish_exclusive(path, raw):
    require(path.parent.is_dir() and path.parent.resolve().is_relative_to(ROOT), 'Unsafe output parent')
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '.pending-', dir=path.parent)
    temporary = pathlib.Path(name)
    published = False
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(raw); target.flush(); os.fsync(target.fileno())
        require(temporary.stat().st_size == len(raw) and sha(temporary.read_bytes()) == sha(raw), 'Output staging changed')
        os.link(temporary, path)
        published = True
    finally:
        # This exact fresh tempfile is the only cleanup target; never overwrite an existing report.
        temporary.unlink()
    require(published and path.read_bytes() == raw, 'Exclusive publication failed')


def refusal_controls():
    """Run the complete generator against cloned in-memory parsed evidence only.

    Even the positive control replaces publication with an in-memory sink. Raw
    evidence is read but never rewritten, and no server API is available here.
    The fresh controls receipt is the only file this mode publishes.
    """
    target = ROOT.joinpath(*EVIDENCE.parts, 'composed-generator-refusal-controls.json')
    require(not target.exists() and not target.is_symlink(), 'Control receipt already exists')
    original_data, original_publish, original_dry_run = data, publish_exclusive, _CONTROL_DRY_RUN
    results, positive, active_fault = [], [], None

    def changed(relative):
        value = copy.deepcopy(original_data(relative))
        if active_fault is None:
            return value
        name = pathlib.PurePosixPath(relative).name
        if name == 'completion-gvisor.json' and active_fault in ('mandatory_case_missing', 'mandatory_case_failed', 'mandatory_case_skipped'):
            match = [(file, row) for file in value['testResults'] for row in file['assertionResults']
                     if row['fullName'].endswith(REQUIRED_CASES[2])]
            require(len(match) == 1, 'Control cannot locate mandatory case')
            file, row = match[0]
            if active_fault == 'mandatory_case_missing':
                row['fullName'] += ' CONTROL_MUTATED_IDENTITY'
            elif active_fault == 'mandatory_case_failed':
                row['status'] = 'failed'; file['status'] = 'failed'; value['success'] = False
                value['numPassedTests'] -= 1; value['numFailedTests'] += 1; value['numFailedTestSuites'] += 1
            else:
                row['status'] = 'pending'; value['numPassedTests'] -= 1; value['numPendingTests'] += 1
        elif name == 'completion-gvisor-acceptance.json' and active_fault == 'mandatory_case_missing':
            match = [row for row in value['cases'] if row['name'].endswith(REQUIRED_CASES[2])]
            require(len(match) == 1, 'Control cannot locate summarized mandatory case')
            match[0]['name'] += ' CONTROL_MUTATED_IDENTITY'
        elif name == 'full-acceptance.json' and active_fault == 'baseline_unfinished':
            value['status'] = 'running'; value.pop('finishedAt', None)
        elif name == 'completion-gvisor-acceptance.json' and active_fault == 'image_binding_mismatch':
            value['imageGitRevision'] = '0' * 40
        elif name == 'cleanup.json' and active_fault == 'cleanup_failed':
            value['success'] = False
        elif name == 'final-test-only-source-continuity.json' and active_fault == 'production_blob_altered':
            match = [row for row in value['files'] if row['path'].startswith('src/')]
            require(match, 'Control cannot locate production blob')
            match[0]['after']['sha256'] = '0' * 64
        elif relative == str(CORRECTED_PYTHON / 'report.json') and active_fault == 'python_crypto_dependency_skipped':
            value['unittest']['cryptoDependencySkips'] = [{'case': 'CONTROL', 'reason': 'crypto unavailable'}]
        elif relative == str(NATIVE_EVIDENCE / 'acceptance.json') and active_fault == 'native_additional_runtime_change':
            value['changedRuntimePaths'].append('src/common.ts')
        elif relative == str(NATIVE_EVIDENCE / 'vitest.json') and active_fault == 'native_cohort_skipped':
            value['testResults'][0]['assertionResults'][0]['status'] = 'pending'
            value['numPassedTests'] -= 1; value['numPendingTests'] += 1
        elif name == 'full-node.json' and active_fault == 'native_unexplained_baseline_failure':
            match = [case for file in value['testResults'] if file['name'].replace('\\', '/').endswith('/' + NATIVE_TEST)
                     for case in file['assertionResults'] if case['status'] == 'failed']
            require(len(match) == 25, 'Control cannot locate expected native setup failures')
            match[0]['failureMessages'] = ['Error: EIO: CONTROL_UNEXPLAINED_FAILURE']
        elif relative == str(NATIVE_EVIDENCE / 'upstream-fixture-manifest.json') and active_fault == 'native_fixture_blob_altered':
            value['files'][0]['sha256'] = '0' * 64
        elif relative == str(NATIVE_EVIDENCE / 'acceptance.json') and active_fault == 'native_root_identity':
            value['nodeIdentity']['uid'] = 0
        elif name in ('full-node.json', 'full-acceptance.json') and active_fault == 'full_passed_file_omitted':
            actual = original_data(str(EVIDENCE / 'full-node.json'))
            excluded = set(FOCUSED_FILES + FOLLOWUP_FILES + [NATIVE_TEST])
            candidates = [row for row in actual['testResults']
                if '/'.join(pathlib.PurePosixPath(row['name']).parts[-2:]) not in excluded
                and row['assertionResults'] and all(case['status'] == 'passed' and not case['ancestorTitles'] for case in row['assertionResults'])]
            require(candidates, 'Control cannot locate an unrelated passed file without nested suites')
            victim = candidates[0]; count = len(victim['assertionResults'])
            summary = value if name == 'full-node.json' else value['nodeTests']
            for key, amount in [('numTotalTests', count), ('numPassedTests', count), ('numTotalTestSuites', 1), ('numPassedTestSuites', 1)]:
                summary[key] -= amount
            if name == 'full-node.json':
                value['testResults'] = [row for row in value['testResults'] if row['name'] != victim['name']]
            else:
                summary['files'] = [row for row in summary['files'] if row['name'] != pathlib.PurePosixPath(victim['name']).name]
                summary['actualAssertionStatuses']['passed'] -= count
        elif name == 'full-twofile-acceptance.json' and active_fault == 'final_fixture_additional_production_path':
            value['changedRuntimePaths'].append('src/common.ts')
        elif name == 'full-twofile-node.json' and active_fault == 'final_fixture_case_identity_missing':
            match = [case for file in value['testResults'] for case in file['assertionResults'] if case['fullName'] == LAG_CASE]
            require(len(match) == 1, 'Control cannot locate final clock-lag regression')
            match[0]['fullName'] += ' CONTROL_MUTATED_IDENTITY'
        return value

    def sink(path, raw):
        require(path == ROOT.joinpath(*OUTPUT.parts), 'Control attempted unexpected publication')
        positive.append(json.loads(raw))

    try:
        globals()['data'], globals()['publish_exclusive'], globals()['_CONTROL_DRY_RUN'] = changed, sink, True
        with contextlib.redirect_stdout(io.StringIO()):
            main()
        require(len(positive) == 1 and not ROOT.joinpath(*OUTPUT.parts).exists(), 'Positive dry-run failed/no-publication guard')
        print(json.dumps({'phase': 'positive_dry_run_validated', 'validationPublished': False}), flush=True)
        for fault, expected in [
            ('mandatory_case_missing', 'Missing required actual image/paid scenario'),
            ('mandatory_case_failed', 'Vitest failed'),
            ('mandatory_case_skipped', 'Focused assertions skipped'),
            ('production_blob_altered', 'Git continuity bytes differ'),
            ('image_binding_mismatch', 'Corrected Node/image source cutoffs differ'),
            ('baseline_unfinished', 'Baseline full regressions incomplete/interrupted'),
            ('cleanup_failed', 'Required acceptance failed or uncertain'),
            ('python_crypto_dependency_skipped', 'Corrected Python summary differs'),
            ('native_additional_runtime_change', 'Wrong native-reader production patch boundary'),
            ('native_cohort_skipped', 'Focused assertions skipped'),
            ('native_unexplained_baseline_failure', 'Native-reader baseline failure is not exact retained-SQL ENOENT setup failure'),
            ('native_fixture_blob_altered', 'Native-reader supplement differs from committed Git fixtures'),
            ('native_root_identity', 'Native-reader nonroot execution identity differs'),
            ('full_passed_file_omitted', 'Historical complete Node file/case inventory differs'),
            ('final_fixture_additional_production_path', 'Wrong final fixture correction boundary'),
            ('final_fixture_case_identity_missing', 'Final fixture complete file/case identities differ')]:
            active_fault = fault
            count_before = len(positive)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    main()
            except Refusal as error:
                require(str(error) == expected, 'Control refused for an unexpected reason: ' + fault + ': ' + str(error))
                require(len(positive) == count_before and not ROOT.joinpath(*OUTPUT.parts).exists(), 'Fault reached publication')
                results.append({'fault': fault, 'refused': True, 'reason': str(error), 'validationPublished': False})
                print(json.dumps({'phase': 'refusal_control_passed', 'fault': fault}), flush=True)
            else:
                raise Refusal('Fault was accepted: ' + fault)
    finally:
        globals()['data'], globals()['publish_exclusive'], globals()['_CONTROL_DRY_RUN'] = original_data, original_publish, original_dry_run
    require({row['fault'] for row in results} == CONTROL_NAMES and len(results) == len(CONTROL_NAMES) == 16,
            'Control receipt fault coverage incomplete')
    receipt = {'schemaVersion': 1, 'status': 'accepted', 'success': True,
               'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'generatorSourceSha256': sha(pathlib.Path(__file__).read_bytes()),
               'positiveCompleteGeneratorDryRunAccepted': True, 'positiveValidationPublished': False,
               'faults': results, 'faultCount': len(results), 'faultInjection': 'deep_copied_parsed_json_in_memory_only',
               'serverActions': 0, 'sourceEdits': False, 'historicalEvidenceEdits': False,
               'inputs': positive[0]['artifactReferences']}
    for expected in receipt['inputs']:
        require(ref(expected['path']) == expected, 'Control input bytes changed')
    original_publish(target, (json.dumps(receipt, indent=2) + '\n').encode())
    print(json.dumps({'status': receipt['status'], 'faultCount': len(results), 'path': target.relative_to(ROOT).as_posix(),
                      'sha256': sha(target.read_bytes()), 'validationPublished': False}))


def evidence_tree(directory):
    path = ROOT.joinpath(*pathlib.PurePosixPath(directory).parts)
    require(path.is_dir() and not path.is_symlink(), 'Missing evidence directory')
    refs = []
    for child in sorted(path.rglob('*')):
        require(not child.is_symlink(), 'Symlink in evidence directory')
        if child.is_file():
            refs.append(ref(child.relative_to(ROOT).as_posix()))
    require(0 < len(refs) <= 512, 'Unexpected evidence inventory')
    return refs


def referenced_evidence(record):
    result = []
    for expected in record['evidence']:
        actual = ref(expected['path'])
        require(actual['bytes'] == expected['bytes'] and actual['sha256'] == expected['sha256'], 'Referenced historical evidence changed')
        result.append(actual)
    return result


def main():
    require(len(sys.argv) == 1, 'No arguments accepted')
    output = ROOT.joinpath(*OUTPUT.parts)
    require(not output.exists() and not output.is_symlink(), 'Validation output already exists')
    generator_sha = sha(pathlib.Path(__file__).read_bytes())
    require(ref(str(FROZEN_GENERATOR))['sha256'] == generator_sha, 'Executed generator source is not frozen in evidence')
    if not _CONTROL_DRY_RUN:
        controls = data(str(CONTROL_RECEIPT))
        require(controls['status'] == 'accepted' and controls['success'] is True
                and controls['generatorSourceSha256'] == generator_sha
                and controls['positiveCompleteGeneratorDryRunAccepted'] is True and controls['positiveValidationPublished'] is False
                and controls['faultCount'] == len(controls['faults']) == len(CONTROL_NAMES) == 16
                and {row['fault'] for row in controls['faults']} == CONTROL_NAMES
                and all(row['refused'] is True and row['validationPublished'] is False for row in controls['faults'])
                and controls['faultInjection'] == 'deep_copied_parsed_json_in_memory_only'
                and controls['serverActions'] == 0 and controls['sourceEdits'] is False and controls['historicalEvidenceEdits'] is False,
                'Matching complete refusal controls have not passed')
        for expected in controls['inputs']:
            require(ref(expected['path']) == expected, 'Control input bytes changed before actual publication')
    prepare = load('prepare.json')
    require(prepare['status'] == 'prepared' and prepare['protectedContainerId'] == PROTECTED
            and prepare['servicesBefore'] == prepare['servicesAfter'] and prepare['profileBeforeSha256'] == prepare['profileAfterSha256'], 'Invalid original anchor')
    service_values(prepare['servicesAfter']); health(prepare['health'])
    baseline_install, full = load('install.json'), load('full-acceptance.json')
    passed(baseline_install); source(baseline_install, False); source(full, False)
    require(full['status'] in ('failed', 'accepted_default_regressions_with_recorded_exclusions')
            and full.get('finishedAt') and 'failureType' not in full and 'postflightFailureType' not in full,
            'Baseline full regressions incomplete/interrupted')
    require(baseline_install['sourceFiles'] == full['sourceFiles'] == 703 and baseline_install['changedSource'] == []
            and full['sourceDirectory'] == baseline_install['directory']
            == '/opt/telomere-host-runtime/backend-completion-20261015-d10f22b3259a', 'Baseline source changed')
    for name in ('npm-ci', 'build', 'cell-bundle'):
        command_passed(baseline_install[name])
    require(full['sourceBefore'] == full['sourceAfter'] == {'unchanged': True, 'verified': 703, 'changed': []}
            and full['ownedAnvilProcessesRemaining'] == [] and full['dockerOptInEnabled'] is False, 'Baseline source/process guard failed')
    baseline_manifest = load('full-source-manifest.json')
    require(baseline_manifest['gitRevision'] == BASE_REV and baseline_manifest['archiveSha256'] == BASE_ARCHIVE
            and baseline_manifest['source'] == 'committed_git_blobs_only' and baseline_manifest['workingTreeIncluded'] is False
            and full['sourceManifestSha256'] == ref(str(EVIDENCE / 'full-source-manifest.json'))['sha256']
            and len(baseline_manifest['files']) == 703
            and {row['path']: {key: row[key] for key in ('sha256', 'bytes', 'gitBlob')} for row in baseline_manifest['files']} == git_inventory(BASE_REV),
            'Full baseline source archive differs from immutable Git inventory')
    protected_state(full, prepare)
    for name in ('node', 'python'):
        require(full[name]['exitCode'] in (0, 1) and not full[name]['timedOut'] and not full[name]['logLimitExceeded'],
                'Baseline command incomplete/timed out')
    full_node = vitest(load('full-node.json'), allow_failed=True)
    expected_full_files = sorted(path for path in git_inventory(BASE_REV) if path.startswith('tests/') and path.endswith('.test.ts'))
    require(sorted(row['path'] for row in full_node['files']) == expected_full_files and len(expected_full_files) == 198
            and full_node['counts'] == {'numTotalTests': 2482, 'numPassedTests': 2434, 'numFailedTests': 28, 'numPendingTests': 20}
            and full_node['actualStatuses'] == {'passed': 2434, 'failed': 28, 'skipped': 20},
            'Historical complete Node file/case inventory differs')
    require(full['nodeTests']['accepted'] is full_node['originalRunPassed']
            and full['nodeTests']['numTotalTests'] == full_node['counts']['numTotalTests']
            and full['nodeTests']['numPassedTests'] == full_node['counts']['numPassedTests'], 'Baseline summarized counts differ')
    full_python = python(read(str(EVIDENCE / 'full-python.log')), allow_failed=True)
    require(full_python['testsRun'] == 236 and len(full_python['skips']) == 111, 'Historical Python cohort differs')
    require(full['pythonTests']['accepted'] is full_python['originalRunPassed']
            and full['pythonTests']['testsRun'] == full_python['testsRun'], 'Python summarized counts differ')
    require((full['node']['exitCode'] == 0) is full_node['originalRunPassed']
            and (full['python']['exitCode'] == 0) is full_python['originalRunPassed']
            and full['success'] is (full_node['originalRunPassed'] and full_python['originalRunPassed']),
            'Baseline verdict differs from original commands')
    if full_python['failures']:
        sole_python_fixture_failure(full_python)
    final_install, final = load('final-install.json'), load('completion-gvisor-acceptance.json')
    passed(final_install); passed(final); source(final_install, True)
    require(final['gitRevision'] == CORRECTED_REV and final['archiveSha256'] == CORRECTED_ARCHIVE
            and final['imageGitRevision'] == FINAL_REV and final['imageArchiveSha256'] == FINAL_ARCHIVE,
            'Corrected Node/image source cutoffs differ')
    require(final_install['sourceFiles'] == final['sourceFiles'] == 708 and final_install['changedSource'] == []
            and final['sourceChangesBefore'] == final['sourceChangesAfter'] == []
            and final['originalSourceChangesBefore'] == final['originalSourceChangesAfter'] == []
            and final['reinstallPerformed'] is False and final['rebuildPerformed'] is False, 'Final source changed')
    dependencies = load('reused-dependencies-before.json')
    require(set(dependencies) == {'node_modules', 'dist'}, 'Missing reused dependency inventory')
    canonical_dependency_sha = sha((json.dumps(dependencies, sort_keys=True, separators=(',', ':')) + '\n').encode())
    require(final['dependencyInventoryRawSha256'] == ref(str(EVIDENCE / 'reused-dependencies-before.json'))['sha256']
            and final['dependencyInventoryBeforeSha256'] == final['dependencyInventoryAfterSha256'] == canonical_dependency_sha
            and final['dependencyEntries'] == final['dependencyEntriesAfter'] == {key: len(rows) for key, rows in dependencies.items()}
            and len(dependencies['node_modules']) > 10000 and len(dependencies['dist']) > 50,
            'Reused dependencies changed')
    config = final['testRunnerConfig']
    require(config['cacheEnabled'] is False and config['configLoader'] == 'runner'
            and config['sourceConfigSha256'] == git_inventory(CORRECTED_REV)['vitest.config.ts']['sha256']
            and config['derivedConfigSha256'] == ref(str(EVIDENCE / 'corrected-vitest.config.ts'))['sha256'],
            'Derived test configuration binding differs')
    for name in ('npm-ci', 'build', 'cell-bundle', 'cell-capture-bundle'):
        command_passed(final_install[name])
    require(final_install['cellCjsSha256'] == RESTORE_CJS and final_install['cellCaptureCjsSha256'] == CAPTURE_CJS, 'Wrong built Cell helpers')
    require(baseline_install['nodeVersion'] == final_install['nodeVersion'] == full['nodeVersion'] == 'v22.23.3', 'Wrong Node version')
    command_passed(final['execution']); protected_state(final, prepare, protected=True)
    require(final['remainingContainers'] == [PROTECTED], 'Final host resources remain')
    final_node = vitest(load('completion-gvisor.json'), FOCUSED_FILES, all_passed=True)
    require(final_node['counts']['numTotalTests'] == 167
            and final['nodeTests']['numTotalTests'] == final_node['counts']['numTotalTests']
            and final['nodeTests']['numPassedTests'] == final_node['counts']['numPassedTests']
            and final['cases'] == [{'name': row['name'], 'status': row['status']} for row in final_node['cases']], 'Focused summaries differ')
    for required in REQUIRED_CASES:
        require(sum(row['name'].endswith(required) for row in final_node['cases']) == 1, 'Missing required actual image/paid scenario')
    initial_gvisor = load('completion-gvisor-initial-acceptance.json')
    initial_node = vitest(load('completion-gvisor-initial.json'), FOCUSED_FILES, allow_failed=True)
    source(initial_gvisor, True)
    require(initial_gvisor['success'] is False and initial_gvisor['execution']['exitCode'] == 1
            and initial_gvisor['nodeTests']['numTotalTests'] == initial_node['counts']['numTotalTests'] == 167
            and initial_node['counts'] == {'numTotalTests': 167, 'numPassedTests': 165, 'numFailedTests': 2, 'numPendingTests': 0}
            and {(row['file'], row['name']) for row in initial_node['failures']} == FIXTURE_FAILURES,
            'Initial failed gVisor report changed')
    protected_state(initial_gvisor, prepare, protected=True)
    require(initial_gvisor['sourceChangesBefore'] == initial_gvisor['sourceChangesAfter'] == []
            and initial_gvisor['remainingContainers'] == [PROTECTED]
            and collections.Counter((row['file'], row['name']) for row in initial_node['cases'])
                == collections.Counter((row['file'], row['name']) for row in final_node['cases']),
            'Corrected Node changed scenario identities/source safety')
    failures_resolved = {(row['file'], row['name']) for row in full_node['failures'] if row['file'] != NATIVE_TEST}
    initial_fixture_failure = {row for row in FIXTURE_FAILURES if row[0] == 'tests/declared-state-restore.test.ts'}
    require(failures_resolved == initial_fixture_failure | FOLLOWUP_FAILURES
            and initial_fixture_failure <= {(row['file'], row['name']) for row in final_node['cases'] if row['status'] == 'passed'},
            'Baseline Node failure has no approved correction evidence')
    image, failed_image = load('image-verification.json'), load('image-build-attempt03-failed.json')
    passed(image); source(image, True)
    require(failed_image['success'] is False and failed_image['status'] == 'failed'
            and failed_image['failureStage'] == 'image_push' and failed_image['failureType'] == 'Refusal', 'Historical image failure was relabeled')
    require(image['status'] == 'accepted' and image['scope'] == 'stored_blob_and_cached_image_identity_only'
            and image['httpManifestVerificationPassed'] is False and image['initialHttpManifestVerificationFailed'] is True
            and image['failedAttempt03ReportSha256'] == ref(str(EVIDENCE / 'image-build-attempt03-failed.json'))['sha256']
            and image['executedBuilderSha256'] == BUILDER_SHA and image['registryManifestVerified']['method'] == 'stored_blob_sha256_not_http'
            and image['cachedRepoDigestVerified'] is True and image['registryHttpRequests'] == image['dockerWrites'] == 0,
            'Image verification authority/method changed')
    protected_state(image, prepare, protected=True, inventories=True)
    require(image['sourceFilesVerified'] == image['sourceFilesVerifiedAfter'] == 708 and image['daemonBefore'] == image['daemonAfter']
            and image['cjsSha256'] == RESTORE_CJS and image['captureCjsSha256'] == CAPTURE_CJS
            and image['image'] == final['imageRepoDigest'] == failed_image['image']
            and image['imageId'] == final['derivedImageId'] == failed_image['imageId'], 'Image/source provenance differs')
    require(final['imageVerificationSha256'] == ref(str(EVIDENCE / 'image-verification.json'))['sha256']
            and final['daemonBefore'] == final['daemonAfter'] == image['daemonAfter']
            and final['globalContainersBefore'] == final['globalContainersAfter'] == image['globalContainersAfter'],
            'Corrected daemon/image/global guard differs')
    manifest = image['registryManifestVerified']; layers = image['layerBlobsVerified']; config = image['configBlobVerified']
    require(manifest['configDigest'] == image['imageId'] and 'sha256:' + manifest['sha256'] == image['manifestDigest']
            and image['image'].endswith('@' + image['manifestDigest']) and 'sha256:' + config['sha256'] == image['imageId']
            and manifest['schemaVersion'] == 2 and len(layers) == 7 and sum(row['bytes'] for row in layers) == image['compressedLayerBytes'], 'Image blob proof inconsistent')
    for layer in layers:
        require(layer['digest'] == 'sha256:' + layer['sha256'] and 0 < layer['bytes'] <= 512 * 1024 * 1024, 'Invalid layer proof')
    require(image['prepareSha256'] == ref(str(EVIDENCE / 'prepare.json'))['sha256'], 'Image prepare binding differs')
    cleanup = load('cleanup.json'); passed(cleanup)
    require(cleanup['status'] == 'owned_acceptance_stopped' and cleanup['unit'] == prepare['unit'] and cleanup['namespace'] == prepare['namespace']
            and cleanup['namespaceRemoved'] is True and cleanup['cgroupEmpty'] is True and cleanup['daemonPidGone'] is True
            and cleanup['socketUnusable'] is True and cleanup['globalDockerMutations'] is False and cleanup['dataOrImageDeletion'] is False
            and cleanup['protectedDiskBefore'] == cleanup['protectedDiskAfter'] and cleanup['ownedContainersBefore'] == [PROTECTED]
            and cleanup['protectedBeforeSha256'] == prepare['protectedContainerBeforeSha256']
            and cleanup['imageReportSha256'] == ref(str(EVIDENCE / 'image-verification.json'))['sha256']
            and cleanup['prepareSha256'] == ref(str(EVIDENCE / 'prepare.json'))['sha256'], 'Owned cleanup incomplete/changed authority')
    protected_state(cleanup, prepare)
    require(cleanup['globalContainersBefore'] == cleanup['globalContainersAfter'] == image['globalContainersAfter'], 'Cleanup changed global inventory')
    continuity_value = load('source-continuity.json')
    continuity_proof = continuity(continuity_value)
    for key, revision in [('baselineInventory', BASE_REV), ('finalInventory', FINAL_REV)]:
        actual = git_inventory(revision)
        recorded = {row['path']: {field: row[field] for field in ('sha256', 'bytes', 'gitBlob')} for row in continuity_value[key]}
        require(recorded == actual, 'Historical continuity differs from actual immutable Git blobs')
    python_proof = corrected_python()
    test_proof = test_continuity(data(str(TEST_CONTINUITY)), python_proof['gitRevision'])
    require(final['sourceContinuitySha256'] == ref(str(TEST_CONTINUITY))['sha256'], 'Corrected source continuity binding differs')
    native_reader_proof = native_reader_patch(full_node, full, prepare)
    followup_proof = supplemental_fixture_corrections(full_node, prepare)
    head_revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    require(git_inventory(head_revision) == git_inventory(FOLLOWUP_REV), 'Current committed runtime differs from reviewed final fixture cutoff')
    native_path = 'docs/cyst-native-aead-linux-validation-2026-10-15.json'
    baseline_path = 'docs/large-cyst-2g-stream-baseline-linux-validation-2026-10-15.json'
    native, old = data(native_path), data(baseline_path)
    native_refs, old_refs = referenced_evidence(native), referenced_evidence(old)
    measurement = native['measurement']
    require(native['status'] == 'ACCEPTED_COMPATIBLE_NATIVE_CRYPTO_AND_LOCAL_STREAM_MEASUREMENT'
            and native['linux']['compileExitCode'] == 0 and native['linux']['focused']['exitCode'] == 0
            and native['linux']['focused']['failed'] == 0 and native['linux']['changedTrackedArchiveFiles'] == []
            and native['linux']['changedDependencyEntries'] == [] and native['linux']['loadedCriticalModulesUnchanged'] is True
            and measurement['everyByteCompared'] is True and measurement['plaintextBytes'] == 2_147_221_504
            and measurement['sourceSha256'] == measurement['restoredSha256'] == old['sourceSha256'] == old['restoredSha256']
            and measurement['baselineRestoreMs'] == old['restoreMs'] and measurement['restoreMs'] < 20_000
            and native['fullSpecResumeTargetVerified'] is False, 'Native standalone proof differs')
    python_dirs = [INITIAL_PYTHON, pathlib.PurePosixPath('docs/evidence/python-crypto-posix-first-correction-20261015'), CORRECTED_PYTHON]
    python_refs = [item for directory in python_dirs for item in evidence_tree(str(directory))]
    native_reader_refs = evidence_tree(str(NATIVE_EVIDENCE)) + evidence_tree(str(NATIVE_SQL_ROOT))
    refs = evidence_tree(str(EVIDENCE))
    record = {'schemaVersion': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'COMPOSED_BACKEND_VALIDATION_WITH_EXPLICIT_SOURCE_CUTOFFS', 'success': True,
        'acceptanceScope': 'Immutable image/build, baseline full default regressions with explicit historical fixture/setup failures, corrected complete focused Node files, corrected full Python with optional crypto, a subsequent narrow native-reader production patch with its complete affected Linux test file, and 59 cases in the two final corrected fixture files. This is a composition across source cutoffs.',
        'baseline': {'gitRevision': BASE_REV, 'archiveSha256': BASE_ARCHIVE, 'sourceFiles': 703, 'freshInstallBuildAccepted': True,
                     'originalFullRegressionSuccess': full['success'], 'defaultNodeRegressions': full_node,
                     'defaultPythonRegressions': full_python,
                     'originalFailuresRetained': True, 'unresolvedFailuresOutsideApprovedCorrectionsAndVerifiedSetupFailures': []},
        'productionImageAndBuild': {'gitRevision': FINAL_REV, 'archiveSha256': FINAL_ARCHIVE, 'sourceFiles': 708,
                  'freshInstallBuildAccepted': True, 'typecheckAcceptedThroughFreshBuild': True,
                  'image': image['image'], 'imageConfigId': image['imageId'],
                  'restoreCjsSha256': RESTORE_CJS, 'captureCjsSha256': CAPTURE_CJS},
        'correctedNode': {'gitRevision': CORRECTED_REV, 'archiveSha256': CORRECTED_ARCHIVE,
                          'actualGvisorFocused': final_node, 'initialFailedGvisorRun': initial_node,
                          'sameScenarioIdentities': True, 'completeAffectedTestFilesRerun': True},
        'correctedPython': python_proof,
        'subsequentNativeReaderProductionPatch': native_reader_proof,
        'finalSupplementalFixtureCorrections': followup_proof,
        'fullFinal708SuiteExecuted': False, 'countsMustNotBeSummed': True, 'readinessRescore': False,
        'sourceContinuity': continuity_proof,
        'testOnlySourceContinuity': test_proof,
        'repositoryHeadAtValidation': head_revision,
        'committedRuntimeMatchesFinalReviewedFixtureCutoff': True,
        'productionSourceUnchangedAfterNativeReaderPatch': True,
        'fullProjectBuildAtLatestSourcePerformedByThisComposition': False,
        'originalState': {'threeServicesExactPidsWorkingDirectoriesAndZeroRestarts': True, 'profileUnchanged': True,
                          'healthHttp200': True, 'protectedRegistryMetadataUnchanged': True, 'globalDockerInventoryUnchanged': True},
        'ownedAcceptanceResources': {'unitStopped': True, 'namespaceRemoved': True, 'cgroupEmpty': True, 'daemonPidGone': True,
                                    'socketUnusable': True, 'dataAndImagesRetained': True},
        'imageVerification': {'method': 'stored_blob_sha256_not_http', 'httpVerificationPassed': False,
                              'initialFailedImageAttemptPreserved': True, 'cachedRepoDigestAndConfigVerified': True,
                              'compressedLayerCount': len(layers), 'independentLayerDecompressionClaimed': False},
        'standaloneLocalPerformance': {'plaintextBytes': measurement['plaintextBytes'], 'restoreMs': measurement['restoreMs'],
                                     'baselineRestoreMs': old['restoreMs'], 'fullSpecResumeTargetVerified': False},
        'historicalFailuresRemainHistorical': True,
        'optionalPythonCryptoEvidence': {'loadedAndExecuted': True, 'dependencySkips': 0,
                                        'separateSourceCutoffExplicit': True, 'overlappingTestCountsMustNotBeSummed': True},
        'nonClaims': ['No complete final708suite execution.', 'Overlapping cohorts are not unique additional tests.',
            'No public Base/USDC transaction, paid provider execution, production deployment or readiness rescore.',
            'Actual small capture HostKit fixture does not establish funded escrow/CystRegistry admission or a second target Cell.',
            'One physical VPS does not establish independent physical-host recovery or hardware attestation.',
            'Local2GiB authenticated stream timing excludes network/registry/new-Cell admission, in-Cell application restore and sealed key release.',
            'Default baseline Python skips remain explicit; optional crypto is established only by the separately pinned corrected run.'],
        'artifactReferences': refs + python_refs + native_reader_refs + [ref(native_path), ref(baseline_path)] + native_refs + old_refs,
        'serverActionsByGenerator': 0, 'publicTransactionsByGenerator': 0, 'paidProviderRequestsByGenerator': 0,
        'sourceOrHistoricalEvidenceEditsByGenerator': False,
        'generatorSourceSha256': sha(pathlib.Path(__file__).read_bytes())}
    # Recheck every referenced byte before the exclusive new index publication.
    for expected in record['artifactReferences']:
        require(ref(expected['path']) == expected, 'Evidence changed before publication')
    require(evidence_tree(str(EVIDENCE)) == refs and [item for directory in python_dirs for item in evidence_tree(str(directory))] == python_refs,
            'Evidence directory membership changed before publication')
    require(evidence_tree(str(NATIVE_EVIDENCE)) + evidence_tree(str(NATIVE_SQL_ROOT)) == native_reader_refs,
            'Native-reader evidence membership changed before publication')
    raw = (json.dumps(record, indent=2) + '\n').encode()
    publish_exclusive(output, raw)
    print(json.dumps({'status': record['status'], 'path': str(OUTPUT), 'bytes': len(raw), 'sha256': sha(raw),
                      'baselineNode': full_node['counts'], 'finalFocusedNode': final_node['counts'],
                      'finalAdditionalNode': followup_proof['fullAffectedLinuxCohort']['counts'],
                      'finalNativeReaderNode': native_reader_proof['fullAffectedLinuxCohort']['counts'],
                      'baselinePythonTests': full_python['testsRun'], 'correctedPythonTests': python_proof['correctedRun']['testsRun'],
                      'fullFinal708SuiteExecuted': False}))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == '--controls':
            sys.argv = [sys.argv[0]]
            refusal_controls()
        else:
            main()
    except Exception as error:
        print(json.dumps({'success': False, 'status': 'REFUSED_COMPOSED_VALIDATION', 'failureType': type(error).__name__,
                          'reason': str(error) if isinstance(error, Refusal) else 'Required evidence absent or schema invalid'}))
        sys.exit(1)
