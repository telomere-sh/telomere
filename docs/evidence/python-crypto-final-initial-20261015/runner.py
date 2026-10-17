import datetime,hashlib,json,os,pathlib,re,signal,subprocess,sys,time
source=pathlib.Path('/opt/telomere-host-runtime/backend-completion-final-20261015-090932a350a5')
revision='d4481aec92179df44a533699897db2f523fbd0a2';archive='090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
logs=source/'.local/python-crypto-final-20261015';venv=source/'.local/python-crypto-venv'
assert source.is_dir() and not source.is_symlink() and source.resolve()==source and logs.is_dir() and not logs.is_symlink() and not venv.exists()
os.umask(0o077);started=time.monotonic();deadline=started+300
manifest=json.loads((source/'.local/source-manifest.json').read_bytes());assert manifest['gitRevision']==revision and manifest['archiveSha256']==archive and manifest['source']=='committed_git_blobs_only' and manifest['workingTreeIncluded'] is False and len(manifest['files'])==708
report={'schema':1,'kind':'FRESH_ISOLATED_OPTIONAL_PYTHON_CRYPTO_VALIDATION','gitRevision':revision,'archiveSha256':archive,'sourceFiles':708,'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'venv':str(venv),'logs':str(logs),'status':'running','commands':[],'globalPackageInstalls':False,'providerCalls':0,'publicTransactions':0,'anvilOptInEnabled':False,'sourceChangedDuringRun':[],'ownedFilesPreserved':True}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(name,value):
 p=logs/name;p.write_text(json.dumps(value,indent=2)+'\n');os.chmod(p,0o600)
def inventory():
 result={}
 for item in manifest['files']:
  p=source/item['path'];assert p.is_file() and not p.is_symlink();b=p.read_bytes();result[item['path']]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlob':item['gitBlob']};assert len(b)==item['bytes'] and result[item['path']]['sha256']==item['sha256']
 return result
home=logs/'home';home.mkdir(mode=0o700);tmp=logs/'tmp';tmp.mkdir(mode=0o700)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(home),'LANG':'C.UTF-8','TMPDIR':str(tmp),'PIP_CONFIG_FILE':'/dev/null','PIP_DISABLE_PIP_VERSION_CHECK':'1','PIP_NO_INPUT':'1','PIP_NO_CACHE_DIR':'1','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':str(source/'python/src')}
def run(name,args,timeout):
 remaining=deadline-time.monotonic();assert remaining>1;save('progress.json',{'phase':name,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':time.monotonic()-started})
 begin=time.monotonic()
 with (logs/(name+'.stdout')).open('xb') as stdout,(logs/(name+'.stderr')).open('xb') as stderr:
  child=subprocess.Popen(args,cwd=source,env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True)
  timed=False
  try:child.wait(timeout=min(timeout,remaining))
  except subprocess.TimeoutExpired:
   timed=True
   try:os.killpg(child.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    child.wait(timeout=3)
 row={'name':name,'argv':args,'exitCode':child.returncode,'timedOut':timed,'seconds':time.monotonic()-begin,'stdoutSha256':sha(logs/(name+'.stdout')),'stderrSha256':sha(logs/(name+'.stderr'))}
 report['commands'].append(row);save('report.json',report)
 return row
before=None
try:
 before=inventory();save('source-before.json',before)
 req=source/'python/requirements-crypto.txt';pins={}
 for line in req.read_text().splitlines():
  if not line.strip() or line.startswith('#'):continue
  match=re.fullmatch(r'([A-Za-z0-9_-]+)==([A-Za-z0-9.]+)',line);assert match;pins[match.group(1).lower().replace('_','-')]=match.group(2)
 assert len(pins)==22
 report['requirementsSha256']=sha(req);report['exactRequestedPins']=pins
 created=run('venv-create',['/usr/bin/python3','-I','-B','-m','venv','--copies',str(venv)],30)
 if created['exitCode']!=0:report['status']='blocked_private_venv_unavailable';raise RuntimeError('venv unavailable; no apt/bootstrap fallback')
 python=str(venv/'bin/python')
 installed=run('pip-install',[python,'-B','-m','pip','--disable-pip-version-check','install','--no-input','--no-cache-dir','--no-deps','--only-binary=:all:','--index-url','https://pypi.org/simple','--retries','0','--timeout','20','--report',str(logs/'pip-install-report.json'),'--requirement',str(req)],180)
 if installed['exitCode']!=0:report['status']='blocked_exact_binary_wheel_install';raise RuntimeError('exact wheel install refused; pins unchanged')
 checked=run('pip-check',[python,'-B','-m','pip','--disable-pip-version-check','check'],20)
 assert checked['exitCode']==0
 frozen=run('pip-freeze',[python,'-B','-m','pip','--disable-pip-version-check','freeze','--all'],20);assert frozen['exitCode']==0
 probe="import sys,json,platform,ssl,importlib.metadata,pathlib,shutil;from telomere_sdk import EthAccountVerifier,PyCryptodomeCipher;v=EthAccountVerifier();c=PyCryptodomeCipher();print(json.dumps({'python':sys.version,'executable':sys.executable,'openssl':ssl.OPENSSL_VERSION,'userSiteEnabled':__import__('site').ENABLE_USER_SITE,'verifierType':type(v).__name__,'cipherType':type(c).__name__,'nodePath':shutil.which('node'),'keccakEmpty':v.keccak256(b'').hex(),'packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}))"
 probed=run('crypto-probe',[python,'-B','-c',probe],20);assert probed['exitCode']==0
 details=json.loads((logs/'crypto-probe.stdout').read_text());normalized={name.lower().replace('_','-'):version for name,version in details['packages'].items()};assert all(normalized.get(name)==version for name,version in pins.items()) and details['verifierType']=='EthAccountVerifier' and details['cipherType']=='PyCryptodomeCipher' and details['userSiteEnabled'] is False and details['keccakEmpty']=='c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
 report['runtimeAndPackages']=details
 tested=run('unittest',[python,'-B','-m','unittest','discover','-s','python/tests','-v'],120)
 text=(logs/'unittest.stdout').read_text()+(logs/'unittest.stderr').read_text();match=re.search(r'Ran ([0-9]+) tests in ([0-9.]+)s',text);assert match
 skips=re.findall(r'^(test[^\n]+) \.\.\. skipped ([^\n]+)$',text,re.M)
 report['unittest']={'exitCode':tested['exitCode'],'testsRun':int(match.group(1)),'seconds':float(match.group(2)),'skips':[{'case':case,'reason':reason} for case,reason in skips],'skippedCount':len(skips),'cryptoDependencySkips':[{'case':case,'reason':reason} for case,reason in skips if any(word in reason.lower() for word in ['optional','install','eth-account','cryptodome','crypto adapter']) and 'anvil' not in reason.lower()],'completedOk':bool(re.search(r'^OK(?: \(skipped=[0-9]+\))?$',text,re.M))}
 assert tested['exitCode']==0 and report['unittest']['completedOk'] and not report['unittest']['cryptoDependencySkips']
 installReport=json.loads((logs/'pip-install-report.json').read_text());wheels=[]
 for row in installReport['install']:
  url=row['download_info']['url'];assert url.startswith('https://files.pythonhosted.org/') and url.endswith('.whl')
  wheels.append({'name':row['metadata']['name'],'version':row['metadata']['version'],'url':url,'sha256':row['download_info']['archive_info']['hashes']['sha256']})
 assert len(wheels)==22;report['installedWheels']=wheels;report['status']='passed'
except BaseException as error:
 if report['status']=='running':report['status']='failed'
 report['failureType']=type(error).__name__
finally:
 try:
  after=inventory();save('source-after.json',after);report['sourceChangedDuringRun']=[p for p in before or {} if before[p]!=after[p]]
 except BaseException as error:report['sourceAuditFailureType']=type(error).__name__;report['status']='failed'
 report['seconds']=time.monotonic()-started;report['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if report['sourceChangedDuringRun']:report['status']='failed'
 save('report.json',report);print(json.dumps(report),flush=True)
sys.exit(0 if report['status']=='passed' else 1)
