"""Actual AST-extracted cutover/signal/launcher controls. All ports mocked; local synthetic files only."""
import argparse
import ast
import copy
import hashlib
import json
import os
from pathlib import Path as RealPath
import re
import secrets
import tempfile
import types

HERE = RealPath(__file__).resolve().parent
RUNNER = HERE / 'rollout.py'
TREE = ast.parse(RUNNER.read_text())
NAMES = {'Refusal', 'require', 'dropin_text', 'cutover'}
NODES = [node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in NAMES]
assert len(NODES) == len(NAMES)
COHORT = RealPath(tempfile.mkdtemp(prefix='held-cutover-offline-', dir=HERE)).resolve()
assert COHORT.parent == HERE

class FakeSignal:
    SIGTERM, SIGALRM, ITIMER_REAL, SIG_IGN = 15, 14, 0, 'ignore'
    def __init__(self): self.handlers = {15:'original_term',14:'original_alarm'}; self.timers=[]
    def getsignal(self, kind): return self.handlers[kind]
    def signal(self, kind, handler): self.handlers[kind]=handler
    def setitimer(self, kind, value): self.timers.append(value)

class FakeTime:
    def __init__(self): self.now=100.0
    def monotonic(self): return self.now
    def time(self): return 1000.0+self.now

results=[]
def run_case(name, fault=None):
    root=COHORT/name;root.mkdir()
    parent=root/'parent';child=root/'child';release=root/'release'
    for path in [parent,child,release]:path.mkdir()
    (parent/'clone').mkdir()
    def encoded(value):return (json.dumps(value,sort_keys=True)+'\n').encode()
    def write(path,value):path.write_bytes(encoded(value))
    def digest(path):return hashlib.sha256(RealPath(path).read_bytes()).hexdigest()
    old={'schemaVersion':1,'rawChainSha256':'original_raw_before_rehearsal_restart','profileSha256':'same_profile',
        'tableHashes':{'jobs':'same_jobs'},'cysts':{'count':1},'transactionsSent':0}
    fresh={**old,'rawChainSha256':'fresh_raw_with_proven_restart_genesis'}
    write(parent/'snapshot-fingerprint.json',old)
    for name in ['latest-acceptance.json','old-acceptance.json']:write(parent/'clone'/name,{'status':'passed'})
    write(parent/'clone-cleanup.json',{'allOwned':True})
    state={'run':'staging-354fe7af62ea-launch04','revision':'354fe7af62ea6701faafc3b04522abb1b4524d2d',
        'release':str(release),'stage':'clone_accepted','protectedIdentity':{'old':'pinned'},
        'originalUnitStates':{'a':{'NRestarts':'0'}},
        'latestReportSha256':digest(parent/'clone/latest-acceptance.json'),
        'oldReportSha256':digest(parent/'clone/old-acceptance.json'),'cleanupSha256':digest(parent/'clone-cleanup.json')}
    states={state['run']:state};events=[];running=[True];clone_done=[False];release_checks=[0]
    sig=FakeSignal();clock=FakeTime();ns={}
    def mapped_path(value,*parts):
        if isinstance(value,str) and value.startswith('/etc/'):
            return root/'etc'/value[len('/etc/'):]
        return RealPath(value,*parts)
    dropdir=mapped_path('/etc/systemd/system/telomere-staging.service.d');dropdir.parent.mkdir(parents=True)
    def update(work,value):
        states[value['run']]=copy.deepcopy(value);write(work/'state.json',value)
        if value['stage']=='cutover_held':events.append('durable_held_intent')
    def load(args):
        value=copy.deepcopy(states[args.run]);return (parent if args.run==state['run'] else child),value
    def check_release(work,value):
        release_checks[0]+=1;events.append('release_pins')
        if fault=='changed_runtime' and release_checks[0]>1:raise ns['Refusal']('release_runtime_changed')
    def final_work(work,value):
        if fault=='occupied_final_work':raise ns['Refusal']('final_work_exists')
        args=argparse.Namespace(run='staging-354fe7af62ea-final04')
        final={**copy.deepcopy(value),'run':args.run,'parentRun':value['run'],'stage':'prepared'}
        update(child,final);return args,child,final
    def capture(work,value,label,*,recover_on_failure=True):
        assert not recover_on_failure
        assert states[state['run']]['stage']=='cutover_held' and states[state['run']]['heldStop']['active']
        assert sig.timers[-1]==120
        events.append('stop_originals_after_durable_intent');running[0]=False
        if fault=='snapshot_failed':raise ns['Refusal']('backup_failed')
        write(child/'snapshot-fingerprint.json',fresh)
        backup=child/'.local/snapshot';backup.mkdir(parents=True)
        return backup
    def inactive():
        events.append('check_originals_inactive')
        if running[0]:raise ns['Refusal']('held_original_units_not_inactive')
    def clone(args,*,original_stopped=False):
        assert original_stopped and not running[0]
        assert states[args.run]['stage']=='snapshotted'
        events.append('full_latest_then_old_clone');clone_done[0]=True
        if fault=='clone_failed':raise ns['Refusal']('clone_incomplete')
        if fault in ['sigterm','alarm']:
            sig.handlers[sig.SIGTERM if fault=='sigterm' else sig.SIGALRM](0,None)
        if fault=='original_restarted':running[0]=True
        if fault=='activation_deadline':clock.now+=121
        value=copy.deepcopy(states[args.run]);value['stage']='clone_accepted';update(child,value)
    def helper(work,label,options):
        assert label=='fingerprint-preactivation' and clone_done[0] and not running[0]
        events.append('full_fresh_fingerprint')
        value={**fresh,'rawChainSha256':'unexpected_after_clone'} if fault=='raw_drift' else fresh
        write(RealPath(options['output']),value)
    def restart():
        assert clone_done[0] and (dropdir/'90-telomere-reviewed-release.conf').exists()
        events.append('activate_only_after_full_fresh_clone');running[0]=True
        if fault=='health_failed':raise ns['Refusal']('not_ready')
    def recover(args,*,in_process=False):
        assert in_process and states[args.run]['heldStop']['active']
        assert sig.handlers[sig.SIGTERM]==sig.SIG_IGN
        assert ns['COMMAND_DEADLINE'] is None
        events.append('authorized_old_code_recovery');running[0]=True
        value=copy.deepcopy(states[args.run]);value.update(stage='cutover_recovered');value['heldStop']['active']=False;update(parent,value)
    def command(args,**kwargs):
        assert args[0] in ['systemctl','systemd-analyze'];events.append(args[0]+':'+args[1])
        if args[:2]==['systemctl','show']:return str(release)
        return ''
    ns.update({'argparse':argparse,'hashlib':hashlib,'re':re,'Path':mapped_path,
        'open':lambda *args,**kwargs:open(*args,newline='\n',**kwargs),'os':types.SimpleNamespace(
        getpid=lambda:4242,open=os.open,fsync=os.fsync,link=os.link),
        'time':clock,'signal':sig,'secrets':secrets,'NODE':'/synthetic/node-never-executed','PROFILE':root/'synthetic-profile-never-read',
        'PHASE':'test','COMMAND_DEADLINE':None,'UNITS':['a'],'load_state':load,
        'assert_protected':lambda value:events.append('old_code_pins'),'assert_release':check_release,
        'digest':digest,'final_work':final_work,'process_start':lambda pid:None if fault=='missing_parent_start' else '111',
        'update':update,'stopped_capture':capture,'originals_inactive':inactive,
        'read_private':lambda path:json.loads(RealPath(path).read_bytes()),'clone_validate':clone,'helper':helper,
        'command':command,'restart_old_units':restart,'protected_identity':lambda *args:{'old':'pinned'},
        'service_state':lambda:{'a':{'NRestarts':'0'}},'recover_held':recover})
    exec(compile(ast.Module(body=NODES,type_ignores=[]),str(RUNNER),'exec'),ns)
    error=None
    try:ns['cutover'](argparse.Namespace(run=state['run']))
    except ns['Refusal'] as caught:error=str(caught)
    if fault is None:
        assert error is None and states[state['run']]['stage']=='activated', (error, events)
        assert events.index('full_latest_then_old_clone')<events.index('full_fresh_fingerprint')<events.index('activate_only_after_full_fresh_clone')
        assert not states[state['run']]['heldStop']['active']
    elif fault in ['occupied_final_work','missing_parent_start']:
        assert error and 'stop_originals_after_durable_intent' not in events
    else:
        assert error and states[state['run']]['stage']=='cutover_recovered' and running[0]
        assert 'authorized_old_code_recovery' in events
        if fault!='health_failed':assert 'activate_only_after_full_fresh_clone' not in events
        assert sig.handlers=={15:'original_term',14:'original_alarm'} and sig.timers[-1]==0
    assert ns['COMMAND_DEADLINE'] is None
    results.append({'case':name,'result':'passed','expectedRefusal':error,'events':events})

for name,fault in [('fresh_full_clone_accepts_new_raw_rehearsal_head',None),('snapshot_failure','snapshot_failed'),
    ('full_clone_failure','clone_failed'),('fresh_raw_change_after_clone','raw_drift'),('new_runtime_changed','changed_runtime'),
    ('originals_restarted_during_clone','original_restarted'),('controlled_sigterm','sigterm'),
    ('controlled_alarm','alarm'),('activation_120s_deadline','activation_deadline'),('new_health_failure','health_failed'),
    ('occupied_final_work','occupied_final_work'),('missing_parent_start_before_stop','missing_parent_start')]:
    run_case(name,fault)

# Inspect the ACTUAL launcher invocation through its remote() port; no transport executes.
launcher=HERE/'upload-launch.py';launch_tree=ast.parse(launcher.read_text())
function=next(n for n in launch_tree.body if isinstance(n,ast.FunctionDef) and n.name=='launch')
for phase in ['prepare','snapshot','validate-clone','cutover']:
    captured=[]
    namespace={'REMOTE':'/opt/reviewed/operator-attempt04','RUN':'staging-354fe7af62ea-launch04',
        'REV':'r','SHA':'s','ARCHIVE':RealPath('source.tar.gz'),'MANIFEST':RealPath('source.tar.gz.manifest.json'),
        'FROZEN':{},'expected_bundle':lambda *args:{},'remote':captured.append}
    exec(compile(ast.Module(body=[function],type_ignores=[]),str(launcher),'exec'),namespace)
    namespace['launch'](phase,{},{});assert len(captured)==1
    remote_tree=ast.parse(captured[0])
    send=next(node for node in ast.walk(remote_tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)
        and node.func.attr=='run' and isinstance(node.args[0],ast.List))
    argv=ast.literal_eval(send.args[0]);assert argv[0]=='systemd-run'
    guarded=[arg for arg in argv if 'ExecStopPost=' in arg]
    if phase=='cutover':
        assert len(guarded)==1 and guarded[0].endswith('recover-held --run staging-354fe7af62ea-launch04')
        assert '--property=RuntimeMaxSec=150' in argv and '--property=TimeoutStopSec=180' in argv
    else:
        assert not guarded and not any('RuntimeMaxSec=' in arg for arg in argv)
    results.append({'case':'actual_launcher_'+phase,'result':'passed'})

report={'schemaVersion':1,'result':'passed','cases':len(results),'runnerSha256':hashlib.sha256(RUNNER.read_bytes()).hexdigest(),
    'launcherSha256':hashlib.sha256(launcher.read_bytes()).hexdigest(),'systemdDockerSshCalls':0,
    'controllerOrServiceStarted':False,'actualFunctionsAstExtracted':True,'results':results}
(HERE/'held-cutover-offline-results.json').write_bytes((json.dumps(report,indent=2,sort_keys=True)+'\n').encode())
print(json.dumps({'result':'passed','cases':len(results),'systemdDockerSshCalls':0},sort_keys=True))
