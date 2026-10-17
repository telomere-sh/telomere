"""Forced SSH command: export encrypted backups and accept a bounded cloud receipt.

No shell commands, keys, environment, arbitrary paths, or plaintext DB exports.
"""
import datetime, hashlib, json, os, re, signal, stat, sys
from pathlib import Path

BASE = Path('/opt/telomere-mainnet-pilot')
PRIVATE, BACKUPS = BASE / 'private', BASE / 'backups'
BACKUP_ID = re.compile(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}')
RUNTIME_ID = re.compile(r'runtime-[0-9a-f]{40}-[0-9a-f]{16}')
CHECKSUM = re.compile(r'[0-9a-f]{64}')


def read_json(path):
    if path.is_symlink() or path.stat().st_size > 1024 * 1024:
        raise ValueError('Invalid metadata file')
    return json.loads(path.read_bytes())


def validate_request(request):
    if not isinstance(request, dict) or request.get('schemaVersion') != 1:
        raise ValueError('Protocol version required')
    operation = request.get('operation')
    expected = {'status': {'schemaVersion', 'operation'},
        'download': {'schemaVersion', 'operation', 'id'},
        'ack': {'schemaVersion', 'operation', 'id', 'sha256', 'runtimeId', 'runtimeSha256', 'repository', 'runId'}}
    if operation not in expected or set(request) != expected[operation]:
        raise ValueError('Unsupported request')
    if operation in ('download', 'ack'):
        identifier = request['id']
        if not isinstance(identifier, str) or not (BACKUP_ID.fullmatch(identifier) or (operation == 'download' and RUNTIME_ID.fullmatch(identifier))):
            raise ValueError('Invalid archive identity')
    if operation == 'ack':
        if not CHECKSUM.fullmatch(request['sha256']) or not CHECKSUM.fullmatch(request['runtimeSha256']) or not RUNTIME_ID.fullmatch(request['runtimeId']):
            raise ValueError('Invalid receipt')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', request['repository']) or not re.fullmatch(r'[0-9]{1,20}', request['runId']):
            raise ValueError('Invalid cloud provenance')
    return operation


def open_archive(identifier):
    if not (BACKUP_ID.fullmatch(identifier) or RUNTIME_ID.fullmatch(identifier)):
        raise ValueError('Invalid archive identity')
    if not BACKUPS.is_dir() or BACKUPS.is_symlink() or BACKUPS.resolve() != BACKUPS:
        raise ValueError('Untrusted backup directory')
    descriptor = os.open(BACKUPS / (identifier + '.tar.age'), os.O_RDONLY | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, 'rb')
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > 512 * 1024**2 or metadata.st_size < 100:
        stream.close()
        raise ValueError('Invalid archive file')
    return stream, metadata.st_size


def checksum(stream):
    digest = hashlib.sha256()
    for part in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(part)
    stream.seek(0)
    return digest.hexdigest()


def main():
    raw = sys.stdin.buffer.readline(4097)
    if len(raw) > 4096 or not raw.endswith(b'\n'):
        raise ValueError('Request size exceeded')
    request = json.loads(raw)
    operation = validate_request(request)
    latest = read_json(PRIVATE / 'cpu-backup-status.json')
    if operation == 'status':
        result = {'schemaVersion': 1, 'backup': latest, 'monitor': read_json(PRIVATE / 'cpu-monitor-status.json')}
        print(json.dumps(result))
    elif operation == 'download':
        with open_archive(request['id'])[0] as stream:
            metadata = os.fstat(stream.fileno())
            header = {'schemaVersion': 1, 'id': request['id'], 'bytes': metadata.st_size, 'sha256': checksum(stream)}
            sys.stdout.buffer.write((json.dumps(header) + '\n').encode())
            while part := stream.read(1024 * 1024):
                sys.stdout.buffer.write(part)
    else:
        cloud = read_json(PRIVATE / 'cpu-cloud-config.json')
        expected = latest['runtimeBundle']
        if request['repository'] != cloud['repository'] or request['id'] != latest['id'] or request['sha256'] != latest['sha256'] or request['runtimeId'] != expected['id'] or request['runtimeSha256'] != expected['sha256']:
            raise ValueError('Receipt differs from current approved backup')
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        proof = {'id': request['id'], 'sha256': request['sha256'], 'verifiedAt': now, 'source': 'github-actions',
            'runtimeBundleId': request['runtimeId'], 'runtimeBundleSha256': request['runtimeSha256'],
            'authenticatedDecryptionVerifiedByClient': True, 'repository': request['repository'], 'runId': request['runId']}
        temporary = PRIVATE / 'cpu-cloud-offhost-status.next'
        temporary.write_text(json.dumps(proof, indent=2) + '\n')
        temporary.chmod(0o600)
        os.replace(temporary, PRIVATE / 'cpu-cloud-offhost-status.json')
        print(json.dumps({'acknowledged': True}))


if __name__ == '__main__':
    os.umask(0o077)
    signal.alarm(180)
    try:
        main()
    except Exception as error:
        # No raw input, exception URL, private paths, or token values in logs.
        print(json.dumps({'errorType': type(error).__name__}))
        raise SystemExit(1)
