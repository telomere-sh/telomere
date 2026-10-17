import ast
import copy
import hashlib
import io
import json
import pathlib
import re
import types

root = pathlib.Path(__file__).resolve().parent.parent
runner = root / '.local/private-staging-rollout-attempt4-20261015/rollout.py'
source = runner.read_bytes()
tree = ast.parse(source)
nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in ['Refusal', 'require', 'dropin_text', 'cutover']]
base = pathlib.PurePosixPath('/opt/telomere-pilot')
run = 'staging-354fe7af62ea-launch04'
work = base / 'rollout' / run
childrun = 'staging-354fe7af62ea-final04'
childwork = base / 'rollout' / childrun
results = []


class Output(io.StringIO):
    def fileno(self): return 123
    def __exit__(self, *_): self.close()


def scenario(mode):
    clock, active, exists = [0], [True], [False]
    events, persisted, timers, recoveries, links = [], [], [], [], []
    state = {'stage': 'clone_accepted', 'run': run, 'revision': '354fe7af62ea6701faafc3b04522abb1b4524d2d',
             'archiveSha256': 'a' * 64, 'release': str(base / 'releases/354fe7af62ea6701faafc3b04522abb1b4524d2d-launch04'),
             'protectedIdentity': {'closed': 'pins'}, 'originalUnitStates': {'controller': {'NRestarts': '0'}},
             'latestReportSha256': 'latest', 'oldReportSha256': 'old', 'cleanupSha256': 'cleanup'}
    child = copy.deepcopy(state)
    child.update(run=childrun, parentRun=run, stage='prepared')
    baseline = {'schemaVersion': 1, 'rawChainSha256': 'old_boot_genesis', 'allOtherFields': 'same'}
    fresh = {**baseline, 'rawChainSha256': 'new_boot_genesis'}

    class File:
        def __init__(self, *parts): self.path = pathlib.PurePosixPath(*map(str, parts))
        def __str__(self): return str(self.path)
        def __truediv__(self, name): return File(self.path / name)
        def is_symlink(self): return False
        def exists(self): return exists[0] if self.path.name == '90-telomere-reviewed-release.conf' else False
        def glob(self, *_): return []
        def mkdir(self, **_): events.append('mkdir_dropdir')
        def unlink(self): events.append('unlink_pending')

    class Signals:
        SIGTERM, SIGALRM, SIG_IGN, ITIMER_REAL = 15, 14, 1, 0
        def __init__(self): self.handlers = {15: 0, 14: 0}
        def getsignal(self, number): return self.handlers[number]
        def signal(self, number, handler): self.handlers[number] = handler
        def setitimer(self, *args): timers.append(args)

    sig = Signals()

    def digest(path):
        path = str(path)
        if path.endswith('/clone/latest-acceptance.json'): return 'latest'
        if path.endswith('/clone/old-acceptance.json'): return 'old'
        if path.endswith('/clone-cleanup.json'): return 'cleanup'
        if '/.telomere-reviewed-release.pending-' in path or path.endswith('/90-telomere-reviewed-release.conf'):
            return hashlib.sha256(ns['dropin_text'](state).encode()).hexdigest()
        return 'closed-report-hash'

    def update(path, value):
        persisted.append((str(path), copy.deepcopy(value)))
        events.append('persist_' + ('parent' if path == work else 'child') + '_' + value['stage'])

    def stopped(path, value, label, **kwargs):
        assert path == childwork and kwargs == {'recover_on_failure': False}
        assert any(p == str(work) and v['stage'] == 'cutover_held' and v['heldStop']['active'] is True for p, v in persisted), 'stop without durable intent'
        active[0] = False
        events.append('stop_originals')
        return childwork / '.local/snapshot'

    def inactive():
        if active[0]: raise ns['Refusal']('held_original_units_not_inactive')

    def clone(args, **kwargs):
        assert kwargs == {'original_stopped': True}
        inactive(); events.append('full_fresh_clone')
        if mode in ['term', 'alarm']:
            number = 15 if mode == 'term' else 14
            try: sig.handlers[number](number, None)
            finally: assert sig.handlers[15] == 1 and timers[-1] == (0, 0)
        if mode == 'deadline': clock[0] = 121
        if mode == 'originals_resumed': active[0] = True
        child['stage'] = 'clone_accepted'

    def read_private(path):
        path = str(path)
        if path == str(work / 'snapshot-fingerprint.json'): return copy.deepcopy(baseline)
        if path == str(childwork / 'snapshot-fingerprint.json'): return copy.deepcopy(fresh)
        if path == str(childwork / 'preactivation-fingerprint.json'):
            return {**fresh, 'rawChainSha256': 'drifted'} if mode == 'raw_drift' else copy.deepcopy(fresh)
        raise AssertionError(path)

    def link(a, b): links.append((str(a), str(b))); exists[0] = True; events.append('publish_dropin')
    def restart():
        events.append('start_selected_code')
        if mode == 'activation_start_failure': raise ns['Refusal']('injected_start_failure')
        active[0] = True
    def recover(args, **kwargs):
        assert kwargs == {'in_process': True}
        assert ns['COMMAND_DEADLINE'] is None and sig.handlers[15] == 1
        recoveries.append({'dropinPublished': exists[0], 'deadlineCleared': True, 'termIgnored': True})
        active[0] = True; exists[0] = False
    def load(args): return (childwork, child) if args.run == childrun else (work, state)

    ns = {'Path': File, 'NODE': '/opt/node/bin/node', 'PROFILE': base / 'config/staging.env', 'UNITS': ['controller'], 'PHASE': 'arguments', 'COMMAND_DEADLINE': None,
          'argparse': types.SimpleNamespace(Namespace=types.SimpleNamespace),
          'time': types.SimpleNamespace(monotonic=lambda: clock[0], time=lambda: 1000 + clock[0]),
          'signal': sig, 'hashlib': hashlib, 're': re, 'secrets': types.SimpleNamespace(token_hex=lambda _: 'b' * 32),
          'os': types.SimpleNamespace(getpid=lambda: 43210, fsync=lambda _: None, link=link),
          'process_start': lambda _: '12345', 'load_state': load,
          'assert_protected': lambda *_: events.append('verify_protected'),
          'assert_release': lambda *_: events.append('verify_release'), 'digest': digest,
          'final_work': lambda *_: (types.SimpleNamespace(run=childrun), childwork, child), 'update': update,
          'stopped_capture': stopped, 'originals_inactive': inactive, 'read_private': read_private,
          'clone_validate': clone, 'helper': lambda *a, **k: events.append('fresh_full_fingerprint'),
          'protected_identity': lambda *_: state['protectedIdentity'], 'service_state': lambda: state['originalUnitStates'],
          'command': lambda *a, **k: state['release'] if '--property=WorkingDirectory' in a[0] else '',
          'restart_old_units': restart, 'recover_held': recover, 'open': lambda *a, **k: Output()}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(runner), 'exec'), ns)
    error = None
    try: ns['cutover'](types.SimpleNamespace(run=run))
    except ns['Refusal'] as error_value: error = str(error_value)
    assert sig.handlers == {15: 0, 14: 0} and ns['COMMAND_DEADLINE'] is None and timers[-1] == (0, 0)
    if mode == 'success':
        assert error is None and state['stage'] == 'activated' and state['heldStop']['active'] is False and not recoveries and len(links) == 1
    else:
        assert error is not None and len(recoveries) == 1
        if mode != 'activation_start_failure': assert not links
        assert active[0] is True
    assert events.index('persist_parent_cutover_held') < events.index('stop_originals')
    results.append({'case': mode, 'passed': True, 'reason': error, 'activationPublished': bool(links),
                    'recoveryCalls': len(recoveries), 'signalsRestored': True, 'operationDeadlineRestored': True})


for mode in ['success', 'term', 'alarm', 'deadline', 'raw_drift', 'originals_resumed', 'activation_start_failure']: scenario(mode)
assert runner.read_bytes() == source, 'runner source changed during cohort'
report = {'schemaVersion': 1, 'status': 'passed', 'runnerSha256': hashlib.sha256(source).hexdigest(),
          'actualCutoverFunctionAstSha256': hashlib.sha256(ast.dump(next(n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == 'cutover'), include_attributes=False).encode()).hexdigest(),
          'sourceUnchanged': True, 'cases': results, 'actualSignals': 0, 'actualExternalProcesses': 0,
          'actualFileOrServiceMutations': 0, 'actualSshCalls': 0, 'actualDockerCalls': 0, 'profileOrKeyReads': False,
          'recoveryBoundaryMocked': 'recover_held independently reviewed by owner_loop_review'}
path = root / '.local/independent-held-cutover-controls-20261015.json'
path.write_bytes((json.dumps(report, indent=2) + '\n').encode())
print(json.dumps({'status': report['status'], 'cases': len(results), 'runnerSha256': report['runnerSha256'], 'functionAstSha256': report['actualCutoverFunctionAstSha256'], 'actualExternalMutations': 0, 'sourceUnchanged': True}))
