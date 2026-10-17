import concurrent.futures, datetime, hashlib, json, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[1]
folder = root / '.local/private-staging-postactivation-20261015'
folder.mkdir(exist_ok=False)
ssh = ['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'root@2.27.12.39']
checks = [
    ('status', '.local/inspect-private-staging-attempt04-20261015.py', 'python3 -'),
    ('runtime', '.local/verify-private-staging-final-runtime-20261015.py', 'python3 -'),
    ('original-data', '.local/verify-postactivation-original-state-20261015.mjs',
        '/opt/node-v22.23.3-linux-x64/bin/node --input-type=module -'),
]
def run(row):
    name, path, command = row
    source = (root / path).read_bytes()
    output = subprocess.run([*ssh, command], input=source, capture_output=True, timeout=90, check=False)
    assert source == (root / path).read_bytes()
    (folder / (name + '.stdout')).write_bytes(output.stdout)
    (folder / (name + '.stderr')).write_bytes(output.stderr)
    result = {'name': name, 'script': path, 'scriptSha256': hashlib.sha256(source).hexdigest(),
        'exitCode': output.returncode, 'stderrEmpty': not output.stderr}
    if output.returncode == 0 and not output.stderr:
        data = json.loads(output.stdout)
        (folder / (name + '.json')).write_bytes(output.stdout)
        result['data'] = data
    return result
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(run, checks))
record = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'results': results}
(folder / 'collection.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
assert all(value['exitCode'] == 0 and value['stderrEmpty'] for value in results)
assert results[0]['data']['state']['stage'] == 'activated'
assert results[0]['data']['cutoverStatus'] == {'status': 'passed', 'phase': 'cutover'}
assert results[1]['data']['status'] == results[2]['data']['status'] == 'passed'
print(json.dumps(record, separators=(',', ':')))
