import datetime, hashlib, json, os, pathlib, subprocess
os.umask(0o077)
root = pathlib.Path('/opt/telomere-host-runtime/backend-current-20261015-3e901e235bb9')
destination = pathlib.Path('/opt/telomere-host-runtime/near-readonly-20261015-0300')
assert not destination.exists()
destination.mkdir(mode=0o700)
protected = pathlib.Path('/opt/enclave/_backend/.env.demo')
values = {}
for line in protected.read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1); values[key.strip()] = value.strip().strip('"').strip("'")
model, endpoint, api_key = values['INFERENCE_MODEL'], values['INFERENCE_BASE_URL'], values['INFERENCE_API_KEY']
assert model and endpoint.startswith('https://') and api_key and '\n' not in api_key and '\r' not in api_key
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
    'NEAR_MODEL': model, 'NEAR_ALLOWED_MODELS': model}
report = {'schemaVersion': 1, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceGitRevision': 'b042c1bc3119754e06f6b662f2e46c108a63db36', 'sourceDirectory': str(root),
    'privatePacketDirectory': str(destination), 'readOnly': True, 'paidInferencePosts': 0,
    'walletTransactions': 0, 'policyChanges': 0, 'serviceChanges': 0, 'approval': 'UNAPPROVED', 'captures': {}}
policy = pathlib.Path('/var/lib/enclave/releases/e1-20261001/acceptance-v6-20261004/accepted/provider-policy.json')
policy_before = hashlib.sha256(policy.read_bytes()).hexdigest()
assert policy_before == '75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa'
for kind in ['cloud', 'direct']:
    extra = {'NEAR_API_KEY': api_key} if kind == 'cloud' else {'NEAR_ENDPOINT': endpoint}
    child = subprocess.run(['node', 'dist/scripts/near-' + kind + '-evidence.js', '--output', str(destination / kind)],
        cwd=root, env={**environment, **extra}, capture_output=True, timeout=70)
    assert api_key.encode() not in child.stdout and api_key.encode() not in child.stderr
    parsed = json.loads(child.stdout)
    report['captures'][kind] = {'exitCode': child.returncode, 'summary': parsed}
    print(json.dumps({'completed': kind, 'exitCode': child.returncode, 'status': parsed['status']}), flush=True)
api_key = ''; values.clear()
child = subprocess.run(['/opt/telomere-pilot/near-runtime/venv/bin/python', '/tmp/near-fresh-hardware-20261015.py',
    str(root), str(destination)], env={'PATH': environment['PATH'], 'HOME': '/root', 'LANG': 'C.UTF-8'}, capture_output=True, timeout=90)
report['hardwareProcessExitCode'] = child.returncode
if child.returncode == 0: report['hardware'] = json.loads(child.stdout)
else: report['hardwareFailureCode'] = 'BOUNDED_HARDWARE_APPRAISAL_FAILED'
report['policySha256'] = policy_before
report['policyUnchanged'] = policy_before == hashlib.sha256(policy.read_bytes()).hexdigest()
assert report['policyUnchanged']
report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
with (destination / 'acceptance.json').open('x') as out: json.dump(report, out, indent=2); out.write('\n')
print(json.dumps(report), flush=True)
