import json,hashlib,os,shutil,subprocess,tarfile,time,datetime,pathlib,stat,sys
base=pathlib.Path(sys.argv[1]);parent=pathlib.Path('/opt/telomere-host-runtime');assert base.parent==parent and base.name.startswith('cyst-native-20261015-')
scope=json.loads((base/'scope.json').read_text());assert scope['base']==str(base)
source=base/'source';source.mkdir(mode=0o700)
archive=base/'source.tar.gz';assert hashlib.sha256(archive.read_bytes()).hexdigest()==scope['archiveSha256']
expected=json.loads((base/'source-manifest.json').read_text());assert len(expected)==scope['sourceFiles']
node='/opt/node-v22.23.3-linux-x64/bin/node';old=parent/'golem-protocol-20261015-dfad08e3322c';started=time.time()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def inventory(root,paths):return {p:{'bytes':(root/p).stat().st_size,'sha256':sha(root/p)} for p in paths}
def deps(root):
 result={}
 for p in sorted(root.rglob('*')):
  rel=p.relative_to(root).as_posix();s=p.lstat()
  if stat.S_ISLNK(s.st_mode):result[rel]={'symlink':os.readlink(p)}
  elif stat.S_ISREG(s.st_mode):result[rel]={'bytes':s.st_size,'sha256':sha(p)}
  elif not stat.S_ISDIR(s.st_mode):raise RuntimeError('Special dependency file')
 return result
def save(name,data):
 (base/name).write_text(json.dumps(data,indent=2)+'\n');os.chmod(base/name,0o600)
def progress(phase):save('progress.json',{'phase':phase,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':time.time()-started})
def run(name,args,timeout):
 progress(name)
 with (base/(name+'.stdout')).open('wb') as stdout,(base/(name+'.stderr')).open('wb') as stderr:
  result=subprocess.run(args,cwd=source,env={**os.environ,'PATH':str(pathlib.Path(node).parent)+':'+os.environ.get('PATH',''),'NODE_ENV':'test'},stdout=stdout,stderr=stderr,timeout=timeout)
 return {'exitCode':result.returncode,'stdoutSha256':sha(base/(name+'.stdout')),'stderrSha256':sha(base/(name+'.stderr'))}
try:
 progress('extract')
 with tarfile.open(archive,'r:gz') as tar:
  members=tar.getmembers();regular={}
  for m in members:
   p=pathlib.PurePosixPath(m.name)
   if p.is_absolute() or '..' in p.parts or m.issym() or m.islnk() or not(m.isfile() or m.isdir()):raise RuntimeError('Archive member')
   if m.isfile():
    if m.name not in expected or m.name in regular or m.size!=expected[m.name]['bytes']:raise RuntimeError('Archive boundary')
    regular[m.name]=True
  if set(regular)!=set(expected):raise RuntimeError('Archive inventory')
  for m in members:
   target=source/m.name
   if m.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o700)
   else:
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tar.extractfile(m) as src,target.open('xb') as dst:shutil.copyfileobj(src,dst)
    os.chmod(target,0o600)
 before=inventory(source,expected);assert before==expected
 progress('copy-private-dependencies')
 originalDeps=deps(old/'node_modules');shutil.copytree(old/'node_modules',source/'node_modules',symlinks=True)
 copiedDeps=deps(source/'node_modules');assert originalDeps==copiedDeps
 save('dependency-before.json',copiedDeps)
 if sha(old/'package-lock.json')!=expected['package-lock.json']['sha256']:raise RuntimeError('Dependency lock differs')
 build=run('compile',[node,'node_modules/typescript/bin/tsc'],240)
 if build['exitCode']!=0:raise RuntimeError('Compile failed')
 tests=['tests/chunk-aead.test.ts','tests/large-cyst-checkpoints.test.ts','tests/large-cyst-agent-manifest.test.ts','tests/large-cyst-current-resolver.test.ts','tests/large-cyst-publication.test.ts','tests/large-cyst-s3.test.ts','tests/large-cyst-replication.test.ts','tests/cyst-key-wrap.test.ts','tests/paid-cyst-file-restore.test.ts','tests/paid-cyst-file-cache-expiry.test.ts']
 cohort=run('focused',[node,'node_modules/vitest/vitest.mjs','run',*tests,'--no-cache','--reporter=json','--outputFile='+str(base/'focused.json')],300)
 raw=json.loads((base/'focused.json').read_text())
 if cohort['exitCode']!=0:raise RuntimeError('Focused cohort failed')
 # Each benchmark has a separate new private directory; never the accepted checkout.
 work=pathlib.Path(scope['work']);assert work.parent==parent and work.name.startswith('cyst-2g-stream-native-20261015-');work.mkdir(mode=0o700)
 bench=(base/'benchmark.mjs').read_text().replace(str(base)+'/dist/',str(source)+'/dist/').replace("const base = '"+str(base)+"';","const base = '"+str(source)+"';")
 (work/'benchmark.mjs').write_text(bench);os.chmod(work/'benchmark.mjs',0o600)
 progress('benchmark')
 with (work/'stdout').open('wb') as stdout,(work/'stderr').open('wb') as stderr:
  result=subprocess.run([node,str(work/'benchmark.mjs'),str(work)],cwd=source,stdout=stdout,stderr=stderr,timeout=900)
 benchReport=json.loads((work/'result.json').read_text())
 after=inventory(source,expected);save('source-after.json',after)
 afterDeps=deps(source/'node_modules');save('dependency-after.json',afterDeps)
 oldAfter=deps(old/'node_modules')
 changed=[p for p in expected if before[p]!=after[p]]
 depChanged=[p for p in set(copiedDeps)|set(afterDeps) if copiedDeps.get(p)!=afterDeps.get(p)]
 report={'status':'passed' if result.returncode==0 and benchReport['status']=='passed' and not changed and not depChanged and oldAfter==originalDeps else 'failed','revision':scope['revision'],'archiveSha256':scope['archiveSha256'],'sourceFiles':len(expected),'sourceChangedDuringRun':changed,'dependencyFiles':len(copiedDeps),'dependencyChangedDuringRun':depChanged,'originalDependencyCheckoutUnchanged':oldAfter==originalDeps,'compile':build,'focused':{**cohort,'total':raw.get('numTotalTests'),'passed':raw.get('numPassedTests'),'failed':raw.get('numFailedTests'),'skipped':raw.get('numPendingTests')},'benchmarkExitCode':result.returncode,'benchmarkReportSha256':sha(work/'result.json'),'runtimeExecutableSha256':sha(pathlib.Path(node)),'seconds':time.time()-started,'scope':scope,'ownedFilesPreserved':True}
 save('acceptance.json',report);progress('complete');print(json.dumps(report))
except BaseException as error:
 save('acceptance.json',{'status':'failed','phase':json.loads((base/'progress.json').read_text()).get('phase'),'errorType':type(error).__name__,'seconds':time.time()-started,'scope':scope,'ownedFilesPreserved':True});raise
