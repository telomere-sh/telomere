import ast,hashlib,json,pathlib,re,types
SOURCE=pathlib.Path(__file__).with_name('verify-declared-state-image-20261015.py');before=SOURCE.read_bytes();tree=ast.parse(before)
names={'Refusal','require','sha','strict_json','blob','source_manifest'}
selected=[n for n in tree.body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name in names]
root=pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015');source=root.parent/'fixture-source'
ns={'hashlib':hashlib,'json':json,'pathlib':pathlib,'re':re,'WORK':root,'BLOBS':root/'fixture-blobs','REVISION':'a'*40,'ARCHIVE_SHA':'b'*64}
exec(compile(ast.Module(body=selected,type_ignores=[]),str(SOURCE),'exec'),ns)
results=[]
def case(name,call,reject=False):
 try:call()
 except BaseException as error:
  if not reject:raise AssertionError(name)from error
  results.append({'name':name,'result':'refused'})
 else:
  assert not reject,name
  results.append({'name':name,'result':'accepted'})
case('valid-json',lambda:ns['strict_json'](b'{"schemaVersion":2}'))
for name,value in [('duplicate-json',b'{"a":1,"a":2}'),('NaN',b'{"a":NaN}'),('Infinity',b'{"a":Infinity}'),('invalid-utf8',bytes([255]))]:case(name,lambda value=value:ns['strict_json'](value),True)
content=b'blob';digest=hashlib.sha256(content).hexdigest();actual={'sha256':digest,'bytes':4};descriptor={'digest':'sha256:'+digest,'size':4}
ns['stable_file']=lambda *args,**kwargs:(dict(actual),content)
case('exact-blob-descriptor',lambda:ns['blob'](descriptor,64))
for name,change in [('wrong-size',{'size':5}),('url',{'urls':['https://external.invalid']}),('inline-data',{'data':'YQ=='}),('zero-size',{'size':0}),('bool-size',{'size':True}),('oversize',{'size':65}),('wrong-algorithm',{'digest':'sha512:'+digest}),('non-digest',{'digest':'x'}),('wrong-hash',{'digest':'sha256:'+'0'*64})]:
 value={**descriptor,**change};case(name,lambda value=value:ns['blob'](value,64),True)
files=[{'path':'scripts/f'+str(i)+'.ts','bytes':0 if i==0 else 1,'sha256':hashlib.sha256(b'' if i==0 else b'x').hexdigest()}for i in range(708)]
manifest={'source':'committed_git_blobs_only','workingTreeIncluded':False,'gitRevision':ns['REVISION'],'archiveSha256':ns['ARCHIVE_SHA'],'files':files}
state={'manifest':manifest}
def encoded():return json.dumps(state['manifest'],separators=(',',':')).encode()
ns['stable_file']=lambda path,*args,**kwargs:({'bytes':0 if path.name=='f0.ts' else 1,'sha256':hashlib.sha256(b'' if path.name=='f0.ts' else b'x').hexdigest()},None)
builder=types.SimpleNamespace(private_directory=lambda path:None,private_file=lambda *args:encoded())
def verify(expected=None):return ns['source_manifest'](builder,source,expected or hashlib.sha256(encoded()).hexdigest())
case('all-708-source-including-empty',verify)
original=json.loads(json.dumps(manifest))
for name,change in [('wrong-revision',lambda m:m.update(gitRevision='c'*40)),('working-tree',lambda m:m.update(workingTreeIncluded=True)),('wrong-source-kind',lambda m:m.update(source='working_tree')),('wrong-count',lambda m:m['files'].pop()),('duplicate-path',lambda m:m['files'][1].update(path=m['files'][0]['path'])),('traversal',lambda m:m['files'][1].update(path='../outside')),('backslash',lambda m:m['files'][1].update(path='scripts'+chr(92)+'outside')),('excluded-dependencies',lambda m:m['files'][1].update(path='node_modules/outside')),('changed-source-sha',lambda m:m['files'][1].update(sha256='0'*64)),('oversize-source',lambda m:m['files'][1].update(bytes=64*1024*1024+1))]:
 state['manifest']=json.loads(json.dumps(original));change(state['manifest']);case(name,verify,True)
state['manifest']=original;case('changed-manifest-anchor',lambda:verify('0'*64),True)
assert SOURCE.read_bytes()==before;compile(before,str(SOURCE),'exec')
report={'schemaVersion':1,'helperSha256':hashlib.sha256(before).hexdigest(),'sourceStable':True,'passed':len(results),'failed':0,'actualDockerCalls':0,'actualSSHCalls':0,'actualServiceCalls':0,'actualBlobReads':0,'posixFilesystemClaim':False,'cases':results}
output=pathlib.Path(__file__).with_suffix('.json');output.write_bytes((json.dumps(report,indent=2)+'\n').encode());print(json.dumps({k:v for k,v in report.items()if k!='cases'},separators=(',',':')))
