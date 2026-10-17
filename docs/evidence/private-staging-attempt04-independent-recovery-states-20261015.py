"""Local AST-function recovery matrix. No runner import/main or real effects.

All filesystem, signal, service, process and state I/O below are in-memory ports.
Only reading the runner and writing this local safe test report touch real files.
"""
import argparse
import ast
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import types


runner = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
before = runner.read_bytes()
tree = ast.parse(before.decode('utf-8-sig'), filename=str(runner))
names = {'Refusal', 'require', 'state_path', 'load_state', 'dropin_text', 'verify_held_link', 'assert_protected', 'recover_held', 'cutover'}
nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
if {node.name for node in nodes} != names:
    raise RuntimeError('Expected held recovery API not available')
compiled = compile(ast.Module(body=nodes, type_ignores=[]), str(runner), 'exec')
sha = lambda data: hashlib.sha256(data).hexdigest()
results = []


class Harness:
    def __init__(self):
        self.calls = []
        self.files = {}
        self.directories = set()
        self.symlinks = set()
        self.old_changed = False
        self.foreign_dropin = False
        self.cleanup_ok = True
        self.during_cleanup = None
        self.during_command = None
        self.parent_alive = False
        self.source = '/review/rollout.py'
        self.files[self.source] = before
        harness = self

        class VirtualPath(PurePosixPath):
            def exists(path):
                return str(path) in harness.files or str(path) in harness.directories or str(path) in harness.symlinks

            def is_symlink(path):
                return str(path) in harness.symlinks

            def is_file(path):
                return str(path) in harness.files and str(path) not in harness.symlinks

            def resolve(path):
                return path

            def rename(path, target):
                harness.calls.append(['rename', str(path), str(target)])
                harness.files[str(target)] = harness.files.pop(str(path))
                return target

        self.Path = VirtualPath
        self.run_id = 'staging-354fe7af62ea-launch04'
        self.final_run = 'staging-354fe7af62ea-final04'
        self.args = argparse.Namespace(run=self.run_id)
        self.base = VirtualPath('/opt/telomere-pilot')
        self.work = self.base / 'rollout' / self.run_id
        self.child_work = self.base / 'rollout' / self.final_run
        self.dropdir = VirtualPath('/etc/systemd/system/telomere-staging.service.d')
        self.dropin = self.dropdir / '90-telomere-reviewed-release.conf'
        self.original_identity = {'originalFilesAndUnits': 'reviewed'}
        self.ports = {'Path': VirtualPath, 'BASE': self.base, 'NODE': '/review/node', '__file__': self.source,
                      're': re, 'argparse': argparse, 'hashlib': hashlib, 'PHASE': 'fixture', 'COMMAND_DEADLINE': None}
        exec(compiled, self.ports)
        self.Refusal = self.ports['Refusal']
        common = {'schemaVersion': 1, 'revision': '354fe7af62ea6701faafc3b04522abb1b4524d2d',
                  'archiveSha256': 'reviewed-archive', 'release': '/opt/telomere-pilot/releases/reviewed-launch04',
                  'sourceManifestSha256': 'reviewed-manifest', 'releasePinsSha256': 'reviewed-pins',
                  'nodeHelperSha256': sha(b'reviewed helper'), 'runnerSha256': sha(before),
                  'protectedIdentity': self.original_identity, 'originalUnitStates': {}}
        held = {'schemaVersion': 1, 'parentRun': self.run_id, 'finalRun': self.final_run, 'intentId': 'a' * 32,
                'active': True, 'phase': 'intent', 'parentPid': 777, 'parentStart': '123456789',
                'activationDeadlineAt': 1120,
                'expectedDropinSha256': sha(self.ports['dropin_text'](common).encode())}
        self.parent = dict(common, run=self.run_id, stage='cutover_held', heldStop=copy.deepcopy(held))
        self.child = dict(common, run=self.final_run, parentRun=self.run_id, stage='prepared', heldStop=copy.deepcopy(held))
        for work, state in [(self.work, self.parent), (self.child_work, self.child)]:
            self.directories.add(str(work))
            self.files[str(work / 'clone-smoke.mjs')] = b'reviewed helper'
            self.store(work, state)
        self.ports.update({'digest': self.digest, 'read_private': self.read, 'update': self.update,
                           'protected_identity': self.protected, 'restart_old_units': self.restart,
                           'process_start': lambda _pid: '123456789' if self.parent_alive else None,
                           'cleanup_clone_resources': self.cleanup, 'command': self.command,
                           'signal': types.SimpleNamespace(SIGTERM=15, SIG_IGN=1, ITIMER_REAL=0,
                                                           signal=lambda *_args: None, setitimer=lambda *_args: None),
                           'time': types.SimpleNamespace(time=lambda: 1000.0, monotonic=lambda: 100.0)})

    def store(self, work, state):
        self.files[str(work / 'state.json')] = json.dumps(state, sort_keys=True).encode()

    def read(self, path):
        return json.loads(self.files[str(path)])

    def digest(self, path):
        return sha(self.files[str(path)])

    def update(self, work, state):
        self.calls.append(['update', str(work), state['stage']])
        self.store(work, state)

    def protected(self, owned_dropin=None, active_release=None):
        if self.old_changed or self.foreign_dropin:
            return {'unreviewed': True}
        if str(self.dropin) in self.files and owned_dropin is None:
            return {'newDropinAndDirectory': True}
        return self.original_identity

    def restart(self):
        self.calls.append(['restart_original_named_units'])

    def cleanup(self, *_args, **_kwargs):
        self.calls.append(['cleanup_owned_child_resources'])
        if self.during_cleanup:
            self.during_cleanup(self)
        return self.cleanup_ok

    def command(self, args, **_kwargs):
        if not (args == ['systemctl', 'daemon-reload'] or
                args[:2] == ['systemctl', 'stop'] and args[2] in ['telomere-staging-watchdog.service', 'telomere-staging.service']):
            raise AssertionError('Unreviewed service command: ' + repr(args))
        self.calls.append(['command', *args])
        if self.during_command:
            self.during_command(self, args)
        return ''

    def run(self):
        self.ports['recover_held'](self.args)

    def effects(self):
        return [call for call in self.calls if call[0] in ['command', 'rename', 'restart_original_named_units']]

    def installed(self):
        self.parent['stage'] = 'cutover_activating'
        self.store(self.work, self.parent)
        self.files[str(self.dropin)] = self.ports['dropin_text'](self.parent).encode()

    def refuse(self, operation, reason=None):
        try:
            operation()
        except self.Refusal as error:
            if reason is not None and str(error) != reason:
                raise AssertionError('Expected ' + reason + ', got ' + str(error)) from error
        else:
            raise AssertionError('Expected refusal')


def case(name, operation):
    harness = Harness()
    try:
        operation(harness)
        results.append({'id': name, 'status': 'passed', 'observedCalls': harness.calls})
    except BaseException as error:
        results.append({'id': name, 'status': 'failed', 'errorType': type(error).__name__, 'reason': str(error)[:250], 'observedCalls': harness.calls})


def noop(h, stage):
    h.parent['stage'] = stage
    h.store(h.work, h.parent)
    snapshot = copy.deepcopy(h.files)
    h.run()
    assert h.calls == [] and h.files == snapshot


case('activated_parent_recovery_noop', lambda h: noop(h, 'activated'))
case('already_recovered_parent_recovery_noop', lambda h: noop(h, 'cutover_recovered'))


def preintent_noop(h, stage):
    del h.parent['heldStop']
    noop(h, stage)
for preintent_stage in ['prepared', 'snapshotted', 'clone_accepted']:
    case('preintent_' + preintent_stage + '_noop', lambda h, stage=preintent_stage: preintent_noop(h, stage))


def recover_absent(h):
    h.run()
    state = h.read(h.work / 'state.json')
    assert state['stage'] == 'cutover_recovered' and state['dataRestored'] is False
    assert h.effects() == [['restart_original_named_units']]
case('preinstall_recovery_only_restarts_original_named_units', recover_absent)


def recover_installed(h):
    h.installed()
    h.run()
    assert str(h.dropin) not in h.files
    archive = h.dropin.with_name(h.dropin.name + '.disabled-' + h.args.run)
    assert str(archive) in h.files
    assert h.read(h.work / 'state.json')['stage'] == 'cutover_recovered'
    assert h.effects()[-1] == ['restart_original_named_units']
case('exact_owned_installed_dropin_can_recover', recover_installed)


def guarded(h, mutate, reason=None):
    mutate(h)
    h.refuse(h.run, reason)
    assert h.effects() == []


def changed_dropin(h):
    h.installed()
    h.files[str(h.dropin)] = b'unreviewed drop-in'
case('changed_dropin_holds_without_code_or_service_effects', lambda h: guarded(h, changed_dropin, 'owned_dropin_changed'))
case('foreign_dropin_holds_without_effects', lambda h: guarded(h, lambda x: setattr(x, 'foreign_dropin', True), 'protected_unit_or_old_code_changed'))
case('symlink_dropin_holds_without_effects', lambda h: guarded(h, lambda x: x.symlinks.add(str(x.dropin)), 'dropin_symlink'))
case('symlink_dropin_parent_holds_without_effects', lambda h: guarded(h, lambda x: x.symlinks.add(str(x.dropdir)), 'dropin_symlink'))
case('changed_original_runtime_holds_without_effects', lambda h: guarded(h, lambda x: setattr(x, 'old_changed', True), 'protected_unit_or_old_code_changed'))


def unknown_stage(h):
    h.parent['stage'] = 'unknown'
    h.store(h.work, h.parent)
case('unknown_stage_holds_without_effects', lambda h: guarded(h, unknown_stage, 'no_authorized_held_recovery'))


def wrong_child(h):
    h.child['parentRun'] = 'another-run'
    h.store(h.child_work, h.child)
case('mismatched_child_link_holds_without_effects', lambda h: guarded(h, wrong_child, 'held_child_identity'))
case('live_parent_refuses_external_recovery', lambda h: guarded(h, lambda x: setattr(x, 'parent_alive', True), 'held_parent_still_alive'))


def pending_cleanup(h):
    h.files[str(h.child_work / 'clone-resources.json')] = b'{}'
    h.cleanup_ok = False
    h.refuse(h.run, 'held_recovery_cleanup_incomplete')
    state = h.read(h.work / 'state.json')
    assert state['stage'] != 'cutover_recovered' and state['heldStop']['active'] is True
    h.cleanup_ok = True
    h.run()
    assert h.read(h.work / 'state.json')['stage'] == 'cutover_recovered'
    assert sum(call[0] == 'cleanup_owned_child_resources' for call in h.calls) == 2
case('cleanup_incomplete_remains_recoverable', pending_cleanup)


def changed_during_cleanup(h):
    h.installed()
    h.files[str(h.child_work / 'clone-resources.json')] = b'{}'
    h.during_cleanup = lambda x: x.files.__setitem__(str(x.dropin), b'replaced during owned cleanup')
    h.refuse(h.run, 'owned_dropin_changed')
    assert h.effects() == [] and h.files[str(h.dropin)] == b'replaced during owned cleanup'
case('dropin_replacement_during_cleanup_refuses_before_stop', changed_during_cleanup)


def changed_during_stop(h):
    h.installed()
    def replacement(x, args):
        if args == ['systemctl', 'stop', 'telomere-staging.service']:
            x.files[str(x.dropin)] = b'foreign replacement during awaited stop'
    h.during_command = replacement
    h.refuse(h.run, 'owned_dropin_changed')
    assert h.files[str(h.dropin)] == b'foreign replacement during awaited stop'
    assert not any(call[0] in ['rename', 'restart_original_named_units'] for call in h.calls)
case('dropin_replacement_during_stop_refuses_before_rename', changed_during_stop)


def tampered_helper(h):
    h.files[str(h.work / 'clone-smoke.mjs')] = b'unreviewed helper'
case('helper_hash_change_refused_before_effects', lambda h: guarded(h, tampered_helper, 'state_identity'))


def tampered_runner(h):
    h.files[h.source] = b'unreviewed runner'
case('runner_hash_change_refused_before_effects', lambda h: guarded(h, tampered_runner, 'runner_changed_after_prepare'))


def invalid_state(h, kind):
    target = str(h.work / 'state.json')
    if kind == 'missing':
        del h.files[target]
        expected = KeyError
    else:
        h.files[target] = b'not JSON'
        expected = json.JSONDecodeError
    try:
        h.run()
    except expected:
        pass
    else:
        raise AssertionError('Invalid original state must refuse')
    assert h.calls == []
case('missing_original_state_refuses_without_effects', lambda h: invalid_state(h, 'missing'))
case('corrupt_original_state_refuses_without_effects', lambda h: invalid_state(h, 'corrupt'))


def cutover_fixture(h, *, drift=None, release_failure_at=None):
    h.parent['stage'] = 'clone_accepted'
    del h.parent['heldStop']
    for field, relative in [('latestReportSha256', 'clone/latest-acceptance.json'),
                            ('oldReportSha256', 'clone/old-acceptance.json'), ('cleanupSha256', 'clone-cleanup.json')]:
        h.files[str(h.work / relative)] = b'reviewed clone proof'
        h.parent[field] = sha(b'reviewed clone proof')
    h.store(h.work, h.parent)
    fresh = {'profileSha256': 'original-profile', 'rawChainSha256': 'fresh-held-chain',
             'tableHashes': {'jobs': 'original-jobs'}, 'cysts': {'blobSha256': 'original-ciphertext'}}
    rehearsal = dict(fresh, rawChainSha256='older-resumed-chain')
    h.files[str(h.work / 'snapshot-fingerprint.json')] = json.dumps(rehearsal).encode()
    h.files[str(h.child_work / 'snapshot-fingerprint.json')] = json.dumps(fresh).encode()
    release_checks = []
    def assert_release(work, state):
        release_checks.append(str(work))
        h.calls.append(['assert_release', str(work)])
        if len(release_checks) == release_failure_at:
            raise h.Refusal('release_runtime_changed')
    def final_work(_work, _state):
        h.calls.append(['create_owned_final_work'])
        return argparse.Namespace(run=h.final_run), h.child_work, h.read(h.child_work / 'state.json')
    def snapshot(*_args, **_kwargs):
        h.calls.append(['fresh_stopped_snapshot'])
        return h.child_work / 'backup'
    def clone(args, **kwargs):
        assert args.run == h.final_run and kwargs == {'original_stopped': True}
        h.calls.append(['full_new_and_old_clone_while_original_stopped'])
        state = h.read(h.child_work / 'state.json')
        state['stage'] = 'clone_accepted'
        h.store(h.child_work, state)
    def fingerprint(_work, label, options):
        assert label == 'fingerprint-preactivation'
        value = copy.deepcopy(fresh)
        if drift == 'rawChainSha256': value['rawChainSha256'] = 'different-complete-chain-bytes'
        if drift == 'jobs': value['tableHashes']['jobs'] = 'different-jobs'
        if drift == 'cysts': value['cysts']['blobSha256'] = 'different-ciphertext'
        if drift == 'unknown': value['unexpectedField'] = 'unknown-field-must-refuse'
        h.files[options['output']] = json.dumps(value).encode()
        h.calls.append(['complete_preactivation_fingerprint'])
    h.ports.update({'assert_release': assert_release, 'final_work': final_work, 'stopped_capture': snapshot,
                    'originals_inactive': lambda: h.calls.append(['original_units_remain_inactive']),
                    'clone_validate': clone, 'helper': fingerprint,
                    'recover_held': lambda *_args, **_kwargs: h.calls.append(['recovery_port_after_refusal']),
                    'secrets': types.SimpleNamespace(token_hex=lambda n: 'a' * (2*n)),
                    'os': types.SimpleNamespace(getpid=lambda: 777),
                    'process_start': lambda _pid: '123456789',
                    'PROFILE': h.Path('/protected/profile.env'),
                    'signal': types.SimpleNamespace(SIGTERM=15, SIGALRM=14, SIG_IGN=1, ITIMER_REAL=0,
                        signal=lambda *_args: None, setitimer=lambda *_args: None, getsignal=lambda *_args: 0),
                    'open': lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Real open is forbidden'))})
    return lambda: h.ports['cutover'](h.args)


def release_guard_before_activation(h, index):
    operation = cutover_fixture(h, release_failure_at=index)
    h.refuse(operation, 'release_runtime_changed')
    assert h.effects() == [] and str(h.dropin) not in h.files
    assert not any(call[0] == 'update' and call[-1] == 'cutover_activating' for call in h.calls)
    if index == 1:
        assert not any(call[0] in ['create_owned_final_work', 'fresh_stopped_snapshot'] for call in h.calls)
    else:
        assert any(call[0] == 'full_new_and_old_clone_while_original_stopped' for call in h.calls)
case('new_release_guard_before_any_cutover_effect', lambda h: release_guard_before_activation(h, 1))
case('new_release_guard_rechecked_after_clone_before_dropin', lambda h: release_guard_before_activation(h, 2))


def fresh_drift(h, field):
    operation = cutover_fixture(h, drift=field)
    h.refuse(operation, 'fresh_snapshot_drift_no_activation')
    assert h.effects() == [] and str(h.dropin) not in h.files
    assert any(call[0] == 'full_new_and_old_clone_while_original_stopped' for call in h.calls)
    assert any(call[0] == 'recovery_port_after_refusal' for call in h.calls)
    assert not any(call[0] == 'update' and call[-1] == 'cutover_activating' for call in h.calls)
for field in ['rawChainSha256', 'jobs', 'cysts', 'unknown']:
    case('complete_fresh_fingerprint_' + field + '_drift_blocks_activation', lambda h, field=field: fresh_drift(h, field))


after = runner.read_bytes()
report = {'schemaVersion': 1, 'status': 'passed' if all(item['status'] == 'passed' for item in results) and before == after else 'failed',
          'runner': {'path': str(runner), 'bytes': len(before), 'sha256': sha(before), 'unchangedBeforeAfter': before == after},
          'extractedFunctions': sorted(names), 'tests': results, 'passed': sum(item['status'] == 'passed' for item in results),
          'failed': sum(item['status'] != 'passed' for item in results), 'python': sys.version.split()[0],
          'networkCalls': 0, 'subprocessCalls': 0, 'realServiceOperations': 0, 'realApplicationDataOperations': 0,
          'boundary': 'Actual recovery/state/link and negative cutover control-flow bodies with in-memory ports. Actual release byte guards have a separate filesystem cohort. Does not test Linux privileges, signals, process cleanup or real rollout.'}
output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': report['status'], 'passed': report['passed'], 'failed': report['failed'], 'sourceUnchanged': before == after, 'output': str(output)}))
sys.exit(0 if report['status'] == 'passed' else 1)
