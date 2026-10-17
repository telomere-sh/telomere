import ast
import copy
import hashlib
import json
import pathlib
import re
import types

root = pathlib.Path(__file__).resolve().parent.parent
runner = root / '.local/private-staging-rollout-attempt4-20261015/rollout.py'
source = runner.read_bytes()
tree = ast.parse(source)
names = {'Refusal', 'require', 'resource_identity', 'clone_resources', 'cleanup_clone_resources', 'owned_container', 'global_inventory'}
nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
base = pathlib.PurePosixPath('/opt/telomere-pilot')
run = 'staging-354fe7af62ea-final04'
work, old = base / 'rollout' / run, base / 'app'
results = []


def scenario(name, change=None, expected=True, previous=None, recovery=False):
    state = {'pg': False, 'pgId': 'a' * 64, 'pgOwner': run, 'ns': False,
             'namespacePids': '', 'daemon': False, 'helpers': {}, 'killHelper': False,
             'daemonFail': False, 'pidStart': None, 'members': [], 'cgroupExists': True}
    calls, kills, writes, deadlines = [], [], {}, []

    class File:
        def __init__(self, *parts): self.path = str(pathlib.PurePosixPath(*map(str, parts)))
        def exists(self):
            if self.path.startswith('/run/netns/'): return state['ns']
            if self.path.startswith('/sys/fs/cgroup/'): return state['cgroupExists']
            raise AssertionError(('unexpected exists', self.path))
        def read_text(self):
            assert self.path.startswith('/sys/fs/cgroup/'), self.path
            return '\n'.join(state['members'])
        def read_bytes(self):
            assert self.path == '/proc/43210/cmdline', self.path
            return (str(old / 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil') + '\0--load-state\0' + str(work / 'clone/chain.json') + '\0').encode()

    def check_budget():
        deadlines.append(ns['COMMAND_DEADLINE'])
        if ns['COMMAND_DEADLINE'] is not None and ns['COMMAND_DEADLINE'] <= 100:
            raise ns['Refusal']('bounded_operation_deadline')

    def command(args, **kwargs):
        check_budget(); calls.append(list(args))
        if args[0] == 'systemctl':
            action = args[1]
            unit = args[-1] if action == 'kill' else args[2]
            is_daemon = unit == identity['daemonUnit']
            present = state['daemon'] if is_daemon else unit in state['helpers']
            active = state['daemon'] if is_daemon else state['helpers'].get(unit, False)
            if action == 'show':
                if args[3] == '--property=LoadState': return 'loaded' if present else 'not-found'
                if args[3] == '--property=ActiveState': return 'active' if active else 'inactive'
                if args[3] == '--property=MainPID': return '777' if active else '0'
            if action == 'stop':
                if is_daemon and state['daemonFail']: raise ns['Refusal']('injected_daemon_stop')
                if not is_daemon and state['killHelper']:
                    state['killHelper'] = False
                    raise ns['Refusal']('injected_helper_stop')
                if is_daemon: state['daemon'] = False
                else: state['helpers'][unit] = False
                return ''
            if action == 'kill': state['helpers'][unit] = False; return ''
        if args[:3] == ['ip', 'netns', 'pids']: return state['namespacePids']
        if args[:3] == ['ip', 'netns', 'delete']: state['ns'] = False; return ''
        raise AssertionError(('unexpected command', args))

    def docker(*args, **kwargs):
        check_budget(); calls.append(['docker', *args])
        if args[:2] == ('ps', '--all'):
            if '--no-trunc' in args: return (state['pgId'] + ' ' + identity['container']) if state['pg'] else ''
            return 'aaaaaaaaaaaa' if state['pg'] else ''
        if args[:2] == ('image', 'ls'): return ''
        if args[:2] == ('container', 'inspect'): return state['pgId'] + ' ' + state['pgOwner']
        if args[:2] == ('container', 'rm'):
            assert args[3] == state['pgId']; state['pg'] = False
            return state['pgId']
        raise AssertionError(('unexpected docker', args))

    def kill(pid, sig):
        assert pid == 43210
        kills.append((pid, sig)); state['pidStart'] = None

    ns = {'BASE': base, 'OLD': old, 'GLOBAL': 'unix:///var/run/docker.sock', 'Path': File,
          're': re, 'hashlib': hashlib, 'time': types.SimpleNamespace(monotonic=lambda: 100, sleep=lambda _: None),
          'os': types.SimpleNamespace(getpid=lambda: 65432, kill=kill), 'signal': types.SimpleNamespace(SIGTERM=15, SIGKILL=9),
          'subprocess': types.SimpleNamespace(TimeoutExpired=TimeoutError), 'secrets': types.SimpleNamespace(token_hex=lambda _: 'f' * 16),
          'COMMAND_DEADLINE': previous, 'command': command, 'docker': docker, 'process_start': lambda pid: state['pidStart'],
          'private_json': lambda p, v, **kwargs: writes.__setitem__(str(p), copy.deepcopy(v)),
          'atomic_private': lambda p, n, v: writes.__setitem__(str(p / n), copy.deepcopy(v))}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(runner), 'exec'), ns)
    identity = ns['resource_identity'](work, run)
    resource = {'schemaVersion': 1, 'run': run, 'identity': identity,
                'inventory': {'containerIdentities': [], 'imageIdentities': []},
                'postgresRequested': False, 'postgresId': None, 'namespaceRequested': False,
                'daemonRequested': False, 'helperUnitsRequested': [], 'anvilRequested': False,
                'anvilPid': None, 'anvilStart': None,
                'outerCgroup': '/system.slice/telomere-private-staging-354fe7af62ea-launch04-cutover.service'}
    ns['read_private'] = lambda path: copy.deepcopy(resource)
    if change: change(resource, state, identity)
    error = None
    try: actual = ns['cleanup_clone_resources'](work, run, recovery=recovery)
    except ns['Refusal'] as error_value: actual, error = None, str(error_value)
    assert actual is expected, (name, actual, expected, error, calls, writes)
    assert ns['COMMAND_DEADLINE'] == previous, (name, 'deadline not restored')
    if expected is None: assert not calls and not kills, (name, 'mutated before refusal')
    result = {'case': name, 'passed': True, 'complete': actual, 'reason': error,
              'mockMutations': [c for c in calls if (c[0] == 'systemctl' and c[1] in ['stop', 'kill']) or c[:3] == ['ip', 'netns', 'delete'] or c[:3] == ['docker', 'container', 'rm']],
              'mockPidSignals': kills, 'deadlinesObserved': sorted(set(x for x in deadlines if x is not None))}
    results.append(result)
    return result


scenario('no_requested_objects_is_noop')
def pg(r, s, i): r.update(postgresRequested=True, postgresId='a' * 64); s['pg'] = True
scenario('exact_owned_pg_full_id_removed', pg)
def lost_pg(r, s, i): pg(r, s, i); r['postgresId'] = None
scenario('lost_pg_ack_resolves_exact_name_label_full_id', lost_pg)
def wrong_id(r, s, i): pg(r, s, i); r['postgresId'] = 'b' * 64
scenario('mismatched_pg_id_held', wrong_id, False)
def wrong_owner(r, s, i): pg(r, s, i); s['pgOwner'] = 'other-run'
scenario('mismatched_pg_owner_label_held', wrong_owner, False)
def namespace_busy(r, s, i): r['namespaceRequested'] = True; s.update(ns=True, namespacePids='999')
scenario('occupied_namespace_not_deleted', namespace_busy, False)
def namespace_clear(r, s, i): r['namespaceRequested'] = True; s['ns'] = True
scenario('empty_owned_namespace_deleted', namespace_clear)
def daemon_failure(r, s, i): r['daemonRequested'] = True; s.update(daemon=True, daemonFail=True)
scenario('daemon_stop_failure_not_complete', daemon_failure, False)
def helper_kill(r, s, i): r['helperUnitsRequested'] = [i['helperUnits'][0]]; s['helpers'][i['helperUnits'][0]] = True; s['killHelper'] = True
scenario('exact_helper_stop_failure_uses_exact_kill', helper_kill)
def anvil_reused(r, s, i): r.update(anvilRequested=True, anvilPid=43210, anvilStart='100'); s['pidStart'] = '200'
assert not scenario('reused_pid_is_never_signalled', anvil_reused)['mockPidSignals']
def anvil_exact(r, s, i): r.update(anvilRequested=True, anvilPid=43210, anvilStart='100'); s['pidStart'] = '100'
assert scenario('exact_start_and_cmdline_anvil_stopped', anvil_exact)['mockPidSignals'] == [(43210, 15)]
def anvil_unproven(r, s, i): r.update(anvilRequested=True, anvilPid=43210, anvilStart=None); s['pidStart'] = '100'
assert not scenario('live_pid_without_original_start_held', anvil_unproven, False)['mockPidSignals']
def ack_lost(r, s, i): r['anvilRequested'] = True; s['members'] = ['65432']
scenario('lost_anvil_ack_exact_cgroup_empty_except_guard', ack_lost)
def ack_other(r, s, i): ack_lost(r, s, i); s['members'].append('11111')
scenario('lost_anvil_ack_other_cgroup_child_held', ack_other, False)
def wrong_cgroup(r, s, i): r['outerCgroup'] = r['outerCgroup'].replace('354fe7af62ea', 'aaaaaaaaaaaa')
scenario('foreign_outer_cgroup_rejected_before_mutation', wrong_cgroup, None)
def invalid_inventory(r, s, i): r['inventory']['imageIdentities'] = ['invalid']
scenario('invalid_inventory_rejected_before_mutation', invalid_inventory, None)
def invalid_flag(r, s, i): r['postgresRequested'] = 1
scenario('nonboolean_request_rejected_before_mutation', invalid_flag, None)
assert scenario('cleanup_has_independent_allowance_after_operation_expired', previous=95)['deadlinesObserved'] == [145]
assert scenario('recovery_cleanup_respects_remaining_recovery_budget', previous=120, recovery=True)['deadlinesObserved'] == [120]
assert runner.read_bytes() == source, 'runner source changed during cohort'
report = {'schemaVersion': 1, 'status': 'passed', 'runnerSha256': hashlib.sha256(source).hexdigest(),
          'actualCleanupFunctionAstSha256': hashlib.sha256(ast.dump(next(n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == 'cleanup_clone_resources'), include_attributes=False).encode()).hexdigest(),
          'sourceUnchanged': True, 'cases': results, 'actualDockerCalls': 0, 'actualSshCalls': 0,
          'actualSignals': 0, 'actualProcessSpawns': 0, 'profileOrKeyReads': False}
path = root / '.local/independent-held-cleanup-controls-20261015.json'
path.write_bytes((json.dumps(report, indent=2) + '\n').encode())
print(json.dumps({'status': report['status'], 'cases': len(results), 'runnerSha256': report['runnerSha256'], 'functionAstSha256': report['actualCleanupFunctionAstSha256'], 'actualExternalMutations': 0, 'sourceUnchanged': True}))
