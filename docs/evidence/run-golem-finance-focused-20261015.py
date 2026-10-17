"""Run only the local HTTP financial-lifecycle fixture; no provider or wallet.

Run from the Telomere repository after capturing the named 12-file manifest.
Refuses to replace prior complete acceptance evidence.
"""
import datetime
import hashlib
import json
import pathlib
import platform
import subprocess
import time

root = pathlib.Path.cwd()
base = root / 'docs/evidence'
prefix = 'golem-finance-complete'
before_path = base / f'{prefix}-source-before-20261015.json'
before = json.loads(before_path.read_text(encoding='utf-8'))
raw = base / f'{prefix}-20261015.json'
after_path = base / f'{prefix}-source-after-20261015.json'
receipt_path = base / f'{prefix}-receipt-20261015.json'
stdout_path = base / f'{prefix}-stdout-20261015.txt'
stderr_path = base / f'{prefix}-stderr-20261015.txt'
for path in (raw, after_path, receipt_path, stdout_path, stderr_path):
    if path.exists():
        raise RuntimeError('Refusing to replace prior evidence: ' + str(path))

def hashes():
    result = []
    for item in before['files']:
        data = (root / item['path']).read_bytes()
        result.append({'path': item['path'], 'bytes': len(data),
                       'sha256': hashlib.sha256(data).hexdigest()})
    return result

if hashes() != before['files']:
    raise RuntimeError('Focused source already differs from the captured cutoff')
command = ['node', 'node_modules/vitest/vitest.mjs', 'run',
           'tests/golem-finance.test.ts', '--reporter=json',
           '--outputFile=' + raw.relative_to(root).as_posix()]
start = time.monotonic()
result = subprocess.run(command, cwd=root, capture_output=True, timeout=60)
stdout_path.write_bytes(result.stdout)
stderr_path.write_bytes(result.stderr)
after = hashes()
after_path.write_text(json.dumps({**before,
    'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'files': after}, indent=2) + '\n', encoding='utf-8')
summary = json.loads(raw.read_text(encoding='utf-8'))
receipt = {
    'version': 1,
    'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Actual local HTTP protocol harness and durable local journal only. '
             'No production supplier execution, public chain settlement, wallet, '
             'treasury authority implementation, metering or 2% fault reserve.',
    'command': command, 'exitCode': result.returncode,
    'durationSeconds': round(time.monotonic() - start, 3),
    'node': before['node'], 'platform': platform.platform(),
    'passed': summary['numPassedTests'], 'failed': summary['numFailedTests'],
    'pending': summary['numPendingTests'], 'sourceFiles': len(after),
    'sourceUnchanged': before['files'] == after,
    'before': before_path.relative_to(root).as_posix(),
    'after': after_path.relative_to(root).as_posix(),
    'raw': raw.relative_to(root).as_posix(),
    'globalTypecheck': 'Parent owns the separate combined source cutoff and result.'}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))
if result.returncode or before['files'] != after:
    raise SystemExit(1)
