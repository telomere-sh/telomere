import ast
import hashlib
import json
import pathlib
import types

root = pathlib.Path(__file__).resolve().parent.parent
runner = root / '.local/private-staging-rollout-attempt4-20261015/rollout.py'
source = runner.read_bytes()
tree = ast.parse(source)
nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in ['Refusal', 'require', 'command']]
results = []


class TimeoutExpired(Exception):
    pass


def case(name, deadline, now, mode='ok', requested=30):
    calls, kills, waits, spawns = [], [], [], []

    class Child:
        pid, returncode = 123456, (2 if mode == 'exit_failure' else 0)
        def communicate(self, timeout):
            calls.append(timeout)
            if mode == 'timeout': raise TimeoutExpired()
            if mode == 'signal': raise ns['Refusal']('injected_termination')
            return (b'x' * 1048577 if mode == 'oversize' else b' bounded output \n'), None
        def wait(self, timeout):
            waits.append(timeout)
            if len(waits) == 1: raise TimeoutExpired()
            return 0

    def popen(*args, **kwargs): spawns.append(kwargs); return Child()
    ns = {'subprocess': types.SimpleNamespace(Popen=popen, PIPE=-1, DEVNULL=-3, STDOUT=-2, TimeoutExpired=TimeoutExpired),
          'os': types.SimpleNamespace(killpg=lambda pid, sig: kills.append((pid, sig))),
          'signal': types.SimpleNamespace(SIGTERM=15, SIGKILL=9),
          'time': types.SimpleNamespace(monotonic=lambda: now), 'COMMAND_DEADLINE': deadline}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(runner), 'exec'), ns)
    reason = None
    try: value = ns['command'](['fixed-private-child'], timeout=requested)
    except (ns['Refusal'], TimeoutExpired) as error:
        reason = type(error).__name__ if isinstance(error, TimeoutExpired) else str(error)
    if mode == 'ok' and (deadline is None or now < deadline): assert value == 'bounded output' and reason is None
    if deadline is not None and now >= deadline: assert reason == 'bounded_operation_deadline' and not spawns
    elif mode in ['timeout', 'signal']: assert len(spawns) == 1 and kills == [(123456, 15), (123456, 9)] and waits == [2, 5]
    elif mode == 'exit_failure': assert reason == 'private_child_failed'
    elif mode == 'oversize': assert reason == 'command_output_bound'
    if spawns: assert spawns[0]['start_new_session'] is True and spawns[0]['stdin'] == -3
    results.append({'case': name, 'passed': True, 'communicateTimeouts': calls,
                    'signalsToMockOwnedGroup': [s for _, s in kills], 'reason': reason})


case('no_operation_deadline', None, 100)
case('requested_child_timeout_clamped_to_remaining_deadline', 105, 100)
assert results[-1]['communicateTimeouts'] == [5]
case('smaller_child_timeout_preserved', 150, 100, requested=3)
assert results[-1]['communicateTimeouts'] == [3]
case('expired_before_spawn_refused', 100, 100)
case('child_timeout_kills_only_own_group', None, 100, 'timeout')
case('controlled_termination_during_child_kills_only_own_group', 150, 100, 'signal')
case('child_nonzero_fixed_refusal', None, 100, 'exit_failure')
case('oversized_output_fixed_refusal', None, 100, 'oversize')
assert runner.read_bytes() == source, 'runner source changed during cohort'
report = {'schemaVersion': 1, 'status': 'passed', 'runnerSha256': hashlib.sha256(source).hexdigest(),
          'actualCommandFunctionAstSha256': hashlib.sha256(ast.dump(next(n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == 'command'), include_attributes=False).encode()).hexdigest(),
          'sourceUnchanged': True, 'cases': results, 'actualProcessSpawns': 0, 'actualSignals': 0,
          'actualSshCalls': 0, 'actualDockerCalls': 0, 'profileOrKeyReads': False}
path = root / '.local/independent-held-command-controls-20261015.json'
path.write_bytes((json.dumps(report, indent=2) + '\n').encode())
print(json.dumps({'status': report['status'], 'cases': len(results), 'runnerSha256': report['runnerSha256'], 'functionAstSha256': report['actualCommandFunctionAstSha256'], 'actualExternalMutations': 0, 'sourceUnchanged': True}))
