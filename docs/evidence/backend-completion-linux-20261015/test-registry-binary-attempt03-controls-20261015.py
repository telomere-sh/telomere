import ast, hashlib, json, pathlib, re, struct, types
SOURCE=pathlib.Path(__file__).with_name('build-declared-state-cell-image-attempt03-20261015.py')
before=SOURCE.read_bytes(); tree=ast.parse(before)
names={'Refusal','require','digest','image_context','validate_static_registry','registry_account_identity','registry_uid_idle','registry_unit_properties','registry_service_identity','stop_registry_service'}
selected=[n for n in tree.body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name in names]
root=pathlib.Path('/opt/telomere-host-runtime/declared-state-registry-attempt03-20261015')
unit='telomere-declared-registry-attempt02-20261015.service'; namespace='tlmr-declared-accept-20261015'
ns={'hashlib':hashlib,'struct':struct,'re':re,'REGISTRY_ROOT':root,'REGISTRY_UNIT':unit,'NAMESPACE':namespace}
exec(compile(ast.Module(body=selected,type_ignores=[]),str(SOURCE),'exec'),ns)
results=[]
def case(name,fn,reject=False):
 try: fn()
 except BaseException as error:
  if not reject: raise AssertionError(name) from error
  results.append({'name':name,'passed':True,'result':'refused'})
 else:
  assert not reject,name
  results.append({'name':name,'passed':True,'result':'accepted'})
def elf(program=1,machine=62):
 b=bytearray(128);b[:7]=bytes([127,69,76,70,2,1,1])
 struct.pack_into('<HHI',b,16,2,machine,1);struct.pack_into('<Q',b,32,64);struct.pack_into('<HHH',b,52,64,56,1)
 struct.pack_into('<I',b,64,program);struct.pack_into('<Q',b,72,0);struct.pack_into('<Q',b,96,128)
 return bytes(b)
case('static-ELF64-amd64',lambda:ns['validate_static_registry'](elf()))
for name,value in [('dynamic',elf(2)),('interpreter',elf(3)),('other-machine',elf(machine=183)),('short',b'ELF'),('wrong-magic',b'x'+elf()[1:])]:
 case(name,lambda value=value:ns['validate_static_registry'](value),True)
b=bytearray(elf());struct.pack_into('<Q',b,32,999);case('ELF-table-bounds',lambda:ns['validate_static_registry'](bytes(b)),True)
work=pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015');ns['WORK']=work
class Context:
 parent=work;name='image-context-final'
 def iterdir(self):return [types.SimpleNamespace(name=n) for n in files]
 def __truediv__(self,name):return work/self.name/name
context=Context();files={'Dockerfile':b'FROM pinned','declared-state-cell.cjs':b'restore','declared-state-cell-capture.cjs':b'capture'}
modes={'Dockerfile':0o600,'declared-state-cell.cjs':0o444,'declared-state-cell-capture.cjs':0o444}
def private(path,maximum,allowed=(0o400,0o600)):
 ns['require'](modes[path.name] in allowed and len(files[path.name])<=maximum)
 return files[path.name]
ns['private_file']=private
rsha=hashlib.sha256(files['declared-state-cell.cjs']).hexdigest();cptsha=hashlib.sha256(files['declared-state-cell-capture.cjs']).hexdigest()
def image_context():return ns['image_context'](context,rsha,cptsha,b'FROM pinned')
case('two-cli-context-exact',image_context)
context.name='image-context';case('old-context-name',image_context,True);context.name='image-context-final'
context.parent=pathlib.Path('/foreign');case('foreign-context-parent',image_context,True);context.parent=work
files['extra']=b'x';case('extra-context-file',image_context,True);del files['extra']
original=files.pop('declared-state-cell-capture.cjs');case('missing-capture-cli',image_context,True);files['declared-state-cell-capture.cjs']=original
modes['declared-state-cell-capture.cjs']=0o600;case('capture-not-sealed',image_context,True);modes['declared-state-cell-capture.cjs']=0o444
files['declared-state-cell-capture.cjs']=b'tamper';case('capture-hash-tamper',image_context,True);files['declared-state-cell-capture.cjs']=original
original_restore=files['declared-state-cell.cjs'];files['declared-state-cell.cjs']=b'tamper';case('restore-hash-tamper',image_context,True);files['declared-state-cell.cjs']=original_restore
files['Dockerfile']=b'changed';case('Dockerfile-tamper',image_context,True);files['Dockerfile']=b'FROM pinned'
binary=b'binary';config=b'config';description='Telomere declared registry attempt03 closed-token'
bsha=hashlib.sha256(binary).hexdigest();csha=hashlib.sha256(config).hexdigest()
expected='/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 '+str(root/'registry')+' serve '+str(root/'config.yml')
base={'LoadState':'loaded','ActiveState':'active','SubState':'running','MainPID':'123','Description':description,'User':'nobody','Group':'nogroup','NetworkNamespacePath':'/run/netns/'+namespace,'FragmentPath':'/run/systemd/transient/'+unit,'ExecStart':'{ path=/usr/bin/env ; argv[]='+expected+' ; ignore_errors=no ; }','ControlGroup':'/system.slice/'+unit,'NoNewPrivileges':'yes','KillMode':'control-group'}
state={'properties':dict(base),'namespace':1,'binary':binary,'config':config,'status':'Uid:\t65534\t65534\t65534\t65534\nGid:\t65534\t65534\t65534\t65534\n','returncode':0,'argv':[str(root/'registry').encode(),b'serve',str(root/'config.yml').encode(),b'']}
ns['subprocess']=types.SimpleNamespace(DEVNULL=-3,PIPE=-1,run=lambda *args,**kwargs:types.SimpleNamespace(returncode=state['returncode'],stdout=('\n'.join(k+'='+v for k,v in state['properties'].items())).encode()))
ns['private_file']=lambda path,*args:state['binary'] if path.name=='registry' else state['config']
ns['os']=types.SimpleNamespace(stat=lambda path:types.SimpleNamespace(st_dev=1,st_ino=state['namespace'] if str(path).startswith('/proc/') else 1))
ns['pathlib']=types.SimpleNamespace(Path=lambda *args:types.SimpleNamespace(read_bytes=lambda:b'\0'.join(state['argv']),read_text=lambda:state['status']))
def identity(**kwargs):return ns['registry_service_identity']({},description,bsha,csha,**kwargs)
case('exact-service-identity',identity)
state['namespace']=2;case('wrong-live-namespace',identity,True);case('exact-own-cleanup-despite-wrong-namespace',lambda:identity(verify_live_namespace=False));state['namespace']=1
for key,value in [('Description','foreign'),('User','0'),('Group','0'),('NetworkNamespacePath','/run/netns/foreign'),('FragmentPath','/etc/systemd/system/foreign'),('ExecStart','{ path=/bin/false ; argv[]=/bin/false ; }'),('ControlGroup','/system.slice/foreign.service'),('NoNewPrivileges','no'),('KillMode','process'),('MainPID','invalid')]:
 state['properties']=dict(base);state['properties'][key]=value;case('reject-'+key,identity,True)
state['properties']=dict(base);state['properties'].update(ActiveState='inactive',MainPID='0',ControlGroup='');case('stopped-unit-identity',lambda:identity(verify_live_namespace=False));case('stopped-not-live-proof',identity,True)
state['properties']=dict(base);state['properties'].update(LoadState='not-found',ActiveState='inactive',SubState='dead',MainPID='0',ControlGroup='',User='',Group='',NetworkNamespacePath='',FragmentPath='',ExecStart='',Description=unit);state['returncode']=1;case('absent-cleanup',lambda:identity(allow_absent=True));case('absent-start-refused',identity,True)
state['properties'].pop('ExecStart');state['returncode']=0;case('actual-never-loaded-12-field-exit-zero',lambda:identity(allow_absent=True));state['returncode']=1;case('garbage-collected-12-field-exit-one',lambda:identity(allow_absent=True))
state['properties']['User']='nobody';case('missing-exec-with-foreign-identity-refused',lambda:identity(allow_absent=True),True)
state['properties']=dict(base);state['properties'].pop('ExecStart');state['returncode']=0;case('loaded-missing-exec-refused',identity,True)
state['properties']=dict(base);state['returncode']=1;case('loaded-exit-one-refused',identity,True);state['returncode']=0;state['binary']=b'tamper';case('binary-hash-drift',identity,True);state['binary']=binary;state['config']=b'tamper';case('config-hash-drift',identity,True);state['config']=config
state['argv']=[b'/bin/false',b''];case('foreign-live-argv',identity,True)
state['argv']=[str(root/'registry').encode(),b'serve',str(root/'config.yml').encode(),b''];state['status']='Uid: 0 0 0 0\nGid: 65534 65534 65534 65534\n';case('live-user-numeric-pin',identity,True);state['status']='Uid: 65534 65534 65534 65534\nGid: 0 0 0 0\n';case('live-group-numeric-pin',identity,True)
real_identity=ns['registry_service_identity']
def stop_scenario(mode):
 calls=[];step={'value':0};clock={'value':0.0}
 def inspect(*args,**kwargs):
  calls.append(('inspect',kwargs));step['value']+=1
  if mode=='absent':return None
  if mode=='changed' and step['value']>=2:raise ns['Refusal']()
  if mode in ('normal','stop-timeout') and step['value']>= (2 if mode=='normal' else 3):return {'ActiveState':'inactive','MainPID':'0'}
  return {'ActiveState':'active','MainPID':'123'}
 def command(args,*unused,**kwargs):
  calls.append(tuple(args))
  if args[1]=='stop' and mode in ('stop-timeout','changed'):raise TimeoutError()
 def mono():clock['value']+=1;return clock['value']
 ns['registry_service_identity']=inspect;ns['command']=command;ns['time']=types.SimpleNamespace(monotonic=mono,sleep=lambda value:None)
 try:ns['stop_registry_service']({},description,bsha,csha)
 finally:
  assert all(c[1].get('verify_live_namespace') is False for c in calls if c[0]=='inspect')
  assert all(c[2]==unit for c in calls if c[0]=='systemctl' and c[1]=='stop')
  if mode in ('absent','changed'):assert not any(c[0]=='systemctl' and c[1]=='kill' for c in calls)
  if mode=='stop-timeout':assert any(c[0]=='systemctl' and c[1]=='kill' and c[-1]==unit for c in calls)
for mode in ('absent','normal','stop-timeout','changed','never-stops'):
 case('cleanup-'+mode,lambda mode=mode:stop_scenario(mode),mode in ('changed','never-stops'))
account={'passwd':'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin','group':'nogroup:x:65534:'}
ns['command']=lambda args,*unused,**kwargs:account['passwd'] if args[1]=='passwd' else account['group']
case('existing-nobody-nogroup-exact',lambda:ns['registry_account_identity']({}))
for field,value,name in [('passwd','nobody:x:10001:65534:nobody:/none:/nologin','changed-uid'),('passwd','nobody:x:65534:10001:nobody:/none:/nologin','changed-primary-gid'),('group','nogroup:x:10001:','changed-group-gid'),('passwd',account['passwd']+'\nroot:x:0:0:r:/root:/bin/sh','multiple-NSS-rows')]:
 old=account[field];account[field]=value;case(name,lambda:ns['registry_account_identity']({}),True);account[field]=old
class Proc:
 def __init__(self,name,status='Uid: 0 0 0 0\n',error=None):self.name=name;self.status=status;self.error=error
 def joinpath(self,value):assert value=='status';return self
 def read_text(self):
  if self.error:raise self.error
  return self.status
proc={'rows':[Proc('1'),Proc('2'),Proc('self')]}
ns['pathlib']=types.SimpleNamespace(Path=lambda value:types.SimpleNamespace(iterdir=lambda:iter(proc['rows'])))
case('idle-registry-uid',ns['registry_uid_idle'])
for row,name in [(Proc('3','Uid: 0 65534 0 0\n'),'active-effective-uid'),(Proc('3','Uid: 0 0 65534 0\n'),'active-saved-uid'),(Proc('3','Pid: 3\n'),'missing-uid-proof'),(Proc('3',error=PermissionError()),'unreadable-process-status')]:
 proc['rows']=[row];case(name,ns['registry_uid_idle'],True)
proc['rows']=[Proc('3',error=FileNotFoundError())];case('vanished-process-skipped',ns['registry_uid_idle'])
proc['rows']=[Proc(str(x+1))for x in range(4097)];case('process-scan-bounded',ns['registry_uid_idle'],True)
assert SOURCE.read_bytes()==before
report={'schemaVersion':1,'helperSha256':hashlib.sha256(before).hexdigest(),'sourceStable':True,'passed':len(results),'failed':0,'actualDockerCalls':0,'actualSSHCalls':0,'actualServiceCalls':0,'cases':results}
output=pathlib.Path(__file__).with_suffix('.json');output.write_bytes((json.dumps(report,indent=2)+'\n').encode())
print(json.dumps({k:v for k,v in report.items() if k!='cases'},separators=(',',':')))
