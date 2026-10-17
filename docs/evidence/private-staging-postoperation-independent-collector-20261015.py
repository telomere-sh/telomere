import ast
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
bundle = root / '.local/private-staging-rollout-attempt4-20261015'
review = json.loads((root / 'docs/private-staging-rollout-attempt4-review-2026-10-15.json').read_bytes())
sha = lambda value: hashlib.sha256(value).hexdigest()
for name, expected in review['files'].items(): assert sha((bundle / name).read_bytes()) == expected
namespace = {'__name__': 'independent_local_readonly', '__file__': str(bundle / 'upload-launch.py')}
exec(compile((bundle / 'upload-launch.py').read_bytes(), str(bundle / 'upload-launch.py'), 'exec'), namespace)
gate, hashes = namespace['gates']()
expected_upload = namespace['expected_bundle'](gate, hashes)
names = {'status': '.local/inspect-private-staging-attempt04-20261015.py',
         'runtime': '.local/verify-private-staging-final-runtime-20261015.py',
         'original-data': '.local/verify-postactivation-original-state-20261015.mjs'}
sources = {}
for name, path in names.items():
    data = (root / path).read_bytes()
    sources[name] = {'source': data.decode('utf-8'), 'sha256': sha(data)}
template = (root / '.local/private-staging-postoperation-independent-checker-20261015.template.py').read_text()
rendered = ('CHECKER_SOURCES = ' + repr(sources) + '\nEXPECTED_UPLOAD = ' + repr(expected_upload) + '\n' + template).encode()
ast.parse(rendered)
script = root / '.local/private-staging-postoperation-independent-checker-20261015.py'
with script.open('xb') as output: output.write(rendered)
folder = root / '.local/private-staging-postoperation-independent-20261015'
folder.mkdir(exist_ok=False)
ssh = ['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519',
       '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
       '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', 'root@2.27.12.39', 'python3 -B -']
result = subprocess.run(ssh, input=rendered, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=220, check=False)
(folder / 'stdout').write_bytes(result.stdout)
(folder / 'stderr').write_bytes(result.stderr)
record = {'schemaVersion': 1, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'script': script.relative_to(root).as_posix(), 'scriptSha256': sha(rendered),
          'exitCode': result.returncode, 'stderrEmpty': not result.stderr, 'sshSessions': 1,
          'checkedSourceScripts': {name: value['sha256'] for name, value in sources.items()}}
if result.returncode == 0 and not result.stderr:
    report = json.loads(result.stdout)
    assert report['status'] == 'passed'
    (folder / 'report.json').write_bytes(result.stdout)
    record['status'] = 'passed'
else:
    record['status'] = 'failed_safe_details_retained_locally'
assert rendered == script.read_bytes()
for name, expected in review['files'].items(): assert sha((bundle / name).read_bytes()) == expected
(folder / 'collection.json').write_bytes((json.dumps(record, indent=2) + '\n').encode())
print(json.dumps(record, separators=(',', ':')))
assert record['status'] == 'passed'
