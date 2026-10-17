import datetime, hashlib, json, pathlib, urllib.request

url = 'https://raw.githubusercontent.com/nodejs/node/v22.23.3/deps/sqlite/sqlite3.c'
with urllib.request.urlopen(url, timeout=30) as response:
    assert response.status == 200
    raw = response.read(16 * 1024 * 1024 + 1)
assert len(raw) == 9_390_466
digest = hashlib.sha256(raw).hexdigest()
assert digest == '9512509b1bccb7461f79bea8aad6280ae4699e925fa4804381b71f59e7efb0c5'
lines = raw.decode('utf-8').splitlines()
function = '\n'.join(lines[39912:39923])
caller = '\n'.join(lines[45912:45927])
assert 'robustFchown' in function and 'return osGeteuid() ? 0 : osFchown(fd,uid,gid);' in function
assert 'robustFchown' in caller and 'SQLITE_OPEN_WAL' in caller
root = pathlib.Path(__file__).resolve().parent.parent
path = root / 'docs/evidence/golem-native-payment-doc-linux-20261015/sqlite-upstream-reference.json'
record = {'schemaVersion': 1, 'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'url': url, 'repositoryUrl': 'https://github.com/nodejs/node/blob/v22.23.3/deps/sqlite/sqlite3.c',
          'bytes': len(raw), 'sha256': digest, 'sourceTag': 'v22.23.3',
          'functionLines': [39913, 39923], 'walOpenCallerLines': [45913, 45927],
          'rootOnlyFchownConditionVerified': True, 'walOpenCallsFchownVerified': True,
          'scope': 'Source reference and static condition only. Actual filesystem effect is separately established by retained Linux probes.',
          'fullSourceSaved': False}
with path.open('x', encoding='utf-8', newline='\n') as output:
    json.dump(record, output, indent=2); output.write('\n')
print(json.dumps({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}))
