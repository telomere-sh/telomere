"""Bounded disposable Linux filesystem regression; never starts daemon/controller/service."""
from pathlib import Path
import grp,json,os,pwd,shutil,socket,stat,subprocess,tempfile
class Refusal(Exception): pass
def require(condition,code):
    if not condition: raise Refusal(code)
def command(args,timeout=10):
    assert args[0]=='setpriv'
    p=subprocess.run(args,capture_output=True,text=True,check=True,timeout=timeout)
    return p.stdout.strip()
def exact_runtime_access_preflight(work, label, options):
    config = work / (label + '-options.json')
    account = pwd.getpwnam('telomere')
    os.chown(config, account.pw_uid, account.pw_gid)
    socket_path = work / 'clone/run/docker.sock'
    target_release = OLD if options['source'] == 'old' else Path(options['release'])
    access_paths = {'workTraverse': [str(work), os.X_OK], 'helperRead': [str(work / 'clone-smoke.mjs'), os.R_OK], 'optionsRead': [str(config), os.R_OK], 'profileRead': [options['profile'], os.R_OK], 'baselineRead': [options['baseline'], os.R_OK], 'cloneWrite': [str(work / 'clone'), os.W_OK | os.X_OK], 'dockerRunTraverse': [str(socket_path.parent), os.X_OK], 'dockerSocketWrite': [str(socket_path), os.W_OK], 'releaseTraverse': [str(target_release), os.X_OK], 'mainRead': [str(target_release / 'dist/src/main.js'), os.R_OK], 'nodeExecute': [NODE, os.X_OK]}
    access_probe = 'import json,os,stat,sys\nchecks={key:os.access(path,mode) for key,(path,mode) in json.loads(sys.argv[1]).items()}\ntry: checks["socketType"]=stat.S_ISSOCK(os.stat(sys.argv[2]).st_mode)\nexcept OSError: checks["socketType"]=False\nprint(json.dumps(checks))\n'
    access_groups = sorted(set(os.getgrouplist(account.pw_name, account.pw_gid)) | {grp.getgrnam('docker').gr_gid})
    access = json.loads(command(['setpriv', '--reuid=' + str(account.pw_uid), '--regid=' + str(account.pw_gid), '--groups=' + ','.join(map(str, access_groups)), '/usr/bin/python3', '-c', access_probe, json.dumps(access_paths), str(socket_path)], timeout=10))
    require(set(access) == {*access_paths, 'socketType'} and all((value is True for value in access.values())), 'service_user_path_access')
    return access

account=pwd.getpwnam('telomere'); docker_gid=grp.getgrnam('docker').gr_gid
old_umask=os.umask(0o077)
root=Path(tempfile.mkdtemp(prefix='telomere-operator-permissions04-',dir='/tmp'))
assert root.resolve().parent==Path('/tmp').resolve() and root.name.startswith('telomere-operator-permissions04-')
created_files=[]; created_dirs=[root]; unix=None; report=None; cleanup=True
try:
    os.chown(root,0,account.pw_gid);os.chmod(root,0o750)
    work=root/'work'; work.mkdir(mode=0o750); created_dirs.append(work);os.chown(work,0,account.pw_gid)
    clone=work/'clone'; clone.mkdir(mode=0o700);created_dirs.append(clone);os.chown(clone,account.pw_uid,account.pw_gid)
    run=clone/'run';run.mkdir(mode=0o750);created_dirs.append(run);os.chown(run,0,docker_gid)
    release=root/'release';release.mkdir(mode=0o750);created_dirs.append(release);os.chown(release,0,account.pw_gid);os.chmod(release,0o750)
    for directory in [release/'dist',release/'dist/src']:
        directory.mkdir(mode=0o750);created_dirs.append(directory);os.chown(directory,0,account.pw_gid);os.chmod(directory,0o750)
    def synthetic(path,uid,gid,mode):
        path.write_bytes(b'synthetic disposable access-test data\n');created_files.append(path);os.chown(path,uid,gid);os.chmod(path,mode)
    synthetic(work/'clone-smoke.mjs',0,account.pw_gid,0o640)
    for path in [work/'latest-options.json',clone/'profile.env',clone/'baseline.json']:
        synthetic(path,account.pw_uid,account.pw_gid,0o600)
    synthetic(release/'dist/src/main.js',0,account.pw_gid,0o640)
    NODE=str(root/'synthetic-node-not-executed');synthetic(Path(NODE),0,account.pw_gid,0o750)
    OLD=release
    unix=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);unix.bind(str(run/'docker.sock'));created_files.append(run/'docker.sock')
    os.chown(run/'docker.sock',0,docker_gid);os.chmod(run/'docker.sock',0o660)
    options={'source':'latest','release':str(release),'profile':str(clone/'profile.env'),'baseline':str(clone/'baseline.json')}
    modes_before={'work':oct(work.stat().st_mode&0o777),'run':oct(run.stat().st_mode&0o777)}
    def refused():
        try: exact_runtime_access_preflight(work,'latest',options)
        except Refusal as error: return str(error)=='service_user_path_access'
        return False
    before_refused=refused();assert before_refused
    os.chmod(work,0o750)
    work_only_refused=refused();assert work_only_refused
    os.chmod(run,0o750)
    checks=exact_runtime_access_preflight(work,'latest',options)
    assert all(value is True for value in checks.values())
    report={'schemaVersion':1,'kind':'actual_linux_umask077_disposable_filesystem_access_regression',
        'result':'passed','umask':'0077','beforeModes':modes_before,'beforeRefused':before_refused,
        'workOnlyStillRefused':work_only_refused,'bothFixedAccepted':True,
        'afterModes':{'work':oct(work.stat().st_mode&0o777),'run':oct(run.stat().st_mode&0o777)},
        'exactRuntimePreflightChecks':checks,'actualServiceUid':True,'accountGroupsUnionDocker':True,
        'socketBoundButNeverListenedOrConnected':True,'syntheticNodeNeverExecuted':True,
        'profilesOrCredentialsRead':False,'stagingPathsTouched':False,'servicesOrPhasesStarted':False}
finally:
    if unix: unix.close()
    for path in reversed(created_files):
        try:
            assert root.resolve() in path.parent.resolve().parents or path.parent.resolve()==root.resolve()
            assert not path.is_symlink()
            path.unlink()
        except BaseException:cleanup=False
    for path in reversed(created_dirs):
        try:
            assert path==root or root.resolve() in path.resolve().parents
            assert not path.is_symlink()
            path.rmdir()
        except BaseException:cleanup=False
    os.umask(old_umask)
assert report and cleanup and not root.exists()
report['exactDisposableFilesAndDirectoriesRemoved']=cleanup
print(json.dumps(report,sort_keys=True))
