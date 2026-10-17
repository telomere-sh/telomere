"""Local-only review of exact AST-extracted operator release byte guards.

Never imports the runner, calls main, starts a process, or opens an application DB.
The Linux private-reader port is replaced with a fixture JSON reader explicitly;
this cohort does not claim POSIX permissions or live rollout acceptance.
"""
import ast
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch


def sha(data):
    return hashlib.sha256(data).hexdigest()


runner = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
source = runner.read_bytes()
tree = ast.parse(source.decode('utf-8-sig'), filename=str(runner))
names = {'Refusal', 'require', 'digest', 'within', 'safe_member_name', 'release_pins', 'assert_release'}
nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
if {node.name for node in nodes} != names:
    raise RuntimeError('Expected exact guard functions are not yet available')
ports = {'Path': Path, 'hashlib': hashlib}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(runner), 'exec'), ports)
ports['read_private'] = lambda path: json.loads(Path(path).read_text(encoding='utf-8'))
Refusal = ports['Refusal']
results = []
started = time.monotonic()


def case(name, operation):
    try:
        operation()
        results.append({'id': name, 'status': 'passed'})
    except BaseException as error:
        results.append({'id': name, 'status': 'failed', 'errorType': type(error).__name__, 'reason': str(error)[:200]})


def refused(operation, expected):
    try:
        operation()
    except Refusal as error:
        if str(error) != expected:
            raise AssertionError('Expected ' + expected + ', got ' + str(error)) from error
    else:
        raise AssertionError('Expected guard refusal: ' + expected)


owned = output.parent.resolve()
owned.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='release-pins-', dir=owned) as temporary:
    root = Path(temporary).resolve()
    # Verify the absolute recursive-cleanup target before leaving it to TemporaryDirectory.
    if root.parent != owned or not root.name.startswith('release-pins-'):
        raise RuntimeError('Unexpected disposable fixture root')
    release = root / 'release'
    work = root / 'work'
    (release / 'src').mkdir(parents=True)
    (release / 'dist' / 'src').mkdir(parents=True)
    work.mkdir()
    rows = []
    for index in range(685):
        relative = 'src/input-' + str(index).zfill(4) + '.ts'
        data = ('export const fixture = ' + str(index) + ';\n').encode()
        (release / relative).write_bytes(data)
        rows.append({'path': relative, 'bytes': len(data), 'sha256': sha(data)})
    main = release / 'dist/src/main.js'
    dependency = release / 'dist/src/dependency.js'
    main.write_bytes(b'export const fixtureMain = true;\n')
    dependency.write_bytes(b'export const fixtureDependency = true;\n')
    manifest = {'files': rows}
    manifest_path = work / 'source-manifest.json'
    manifest_bytes = (json.dumps(manifest, sort_keys=True) + '\n').encode()
    manifest_path.write_bytes(manifest_bytes)
    pins = ports['release_pins'](release, manifest)
    pins_path = work / 'release-pins.json'
    pins_bytes = (json.dumps(pins, sort_keys=True) + '\n').encode()
    pins_path.write_bytes(pins_bytes)
    state = {'release': str(release), 'sourceManifestSha256': sha(manifest_bytes), 'releasePinsSha256': sha(pins_bytes)}
    check = lambda: ports['assert_release'](work, state)

    def baseline():
        assert len(pins['source']) == 685 and len(pins['runtime']) == 2
        check()
    case('all_retained_source_and_runtime_bytes_match', baseline)

    original_source = release / rows[0]['path']
    source_bytes = original_source.read_bytes()
    def changed_source():
        original_source.write_bytes(source_bytes.replace(b'0', b'1'))
        try:
            refused(check, 'release_source_changed')
        finally:
            original_source.write_bytes(source_bytes)
    case('same_length_source_change_refused', changed_source)

    def missing_source():
        original_source.unlink()
        try:
            refused(check, 'release_source_file')
        finally:
            original_source.write_bytes(source_bytes)
    case('missing_original_source_refused', missing_source)

    dependency_bytes = dependency.read_bytes()
    def changed_runtime():
        dependency.write_bytes(dependency_bytes.replace(b'true', b'null'))
        try:
            refused(check, 'release_runtime_changed')
        finally:
            dependency.write_bytes(dependency_bytes)
    case('same_length_built_runtime_change_refused', changed_runtime)

    def extra_runtime():
        extra = release / 'dist/src/extra.js'
        extra.write_bytes(b'export const extra = true;\n')
        try:
            refused(check, 'release_runtime_changed')
        finally:
            extra.unlink()
    case('extra_built_runtime_file_refused', extra_runtime)

    def missing_runtime():
        dependency.unlink()
        try:
            refused(check, 'release_runtime_changed')
        finally:
            dependency.write_bytes(dependency_bytes)
    case('missing_built_dependency_refused', missing_runtime)

    main_bytes = main.read_bytes()
    def missing_main():
        main.unlink()
        try:
            refused(check, 'release_runtime_missing')
        finally:
            main.write_bytes(main_bytes)
    case('missing_built_entrypoint_refused', missing_main)

    def changed_manifest():
        manifest_path.write_bytes(manifest_bytes + b'\n')
        try:
            refused(check, 'retained_source_manifest_changed')
        finally:
            manifest_path.write_bytes(manifest_bytes)
    case('retained_manifest_byte_change_refused_before_read', changed_manifest)

    def changed_pins():
        pins_path.write_bytes(pins_bytes + b'\n')
        try:
            refused(check, 'release_pins_changed')
        finally:
            pins_path.write_bytes(pins_bytes)
    case('retained_runtime_pins_byte_change_refused_before_read', changed_pins)

    def traversal():
        hostile = {'files': [dict(row) for row in rows]}
        hostile['files'][0]['path'] = '../outside.ts'
        refused(lambda: ports['release_pins'](release, hostile), 'unsafe_tar_member')
    case('source_traversal_refused', traversal)

    def wrong_count():
        refused(lambda: ports['release_pins'](release, {'files': rows[:-1]}), 'release_source_count')
    case('incomplete_source_manifest_refused', wrong_count)

    def runtime_symlink():
        link = release / 'dist/src/linked.js'
        link.write_bytes(b'fixture symlink observation; not an OS symlink\n')
        original = Path.is_symlink
        try:
            with patch.object(Path, 'is_symlink', lambda path: path == link or original(path)):
                refused(check, 'release_runtime_symlink')
        finally:
            link.unlink()
    case('reported_runtime_symlink_refused', runtime_symlink)
    case('all_fixture_bytes_restored_after_negative_cases', check)

source_after = runner.read_bytes()
report = {
    'schemaVersion': 1,
    'status': 'local_actual_function_guard_cases_passed' if all(item['status'] == 'passed' for item in results) else 'failed',
    'runner': {'path': str(runner), 'bytes': len(source), 'sha256': sha(source), 'unchangedBeforeAfter': source == source_after},
    'extractedFunctions': sorted(names),
    'tests': results,
    'passed': sum(item['status'] == 'passed' for item in results),
    'failed': sum(item['status'] != 'passed' for item in results),
    'durationSeconds': round(time.monotonic() - started, 3),
    'python': sys.version.split()[0],
    'networkCalls': 0,
    'subprocessCalls': 0,
    'applicationDatabaseOpened': False,
    'ports': {'read_private': 'Injected disposable JSON fixture reader; production Linux permissions are not exercised',
              'Path.is_symlink': 'One targeted mocked symlink observation; no OS symlink creation/permission claim'},
    'limits': ['Only extracted release byte guards, not full cutover/recovery execution', 'Local disposable filesystem, not Linux UID/systemd/signal acceptance', 'Runner may still be in development; final frozen recovery cohort is separate']
}
output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': report['status'], 'passed': report['passed'], 'failed': report['failed'], 'sourceUnchanged': source == source_after, 'output': str(output)}))
sys.exit(0 if report['failed'] == 0 and source == source_after else 1)
