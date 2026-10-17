"""Independent hosted backup verifier and outage pager. No application execution."""
import argparse, datetime, hashlib, json, os, re, select, subprocess, tarfile, tempfile, time, traceback, urllib.request
from pathlib import Path, PurePosixPath
from github_store import GitHubStore, digest
from pager import delivery_plan, send

MAX_ARCHIVE = 512 * 1024**2
DELIVERY_ATTEMPTED = False
BACKUP_ID = re.compile(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}')
RUNTIME_ID = re.compile(r'runtime-[0-9a-f]{40}-[0-9a-f]{16}')


def validate_archive_metadata(value, runtime=False):
    if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not (RUNTIME_ID if runtime else BACKUP_ID).fullmatch(value['id']):
        raise ValueError('Invalid backup identity')
    if not re.fullmatch(r'[0-9a-f]{64}', value.get('sha256', '')) or type(value.get('bytes')) is not int or not 100 <= value['bytes'] <= MAX_ARCHIVE:
        raise ValueError('Invalid backup checksum or size')


def verify_archive(archive, identity, directory):
    plain = directory / (archive.name + '.plain')
    try:
        subprocess.run(['age', '--decrypt', '-i', str(identity), '-o', str(plain), str(archive)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)
        with tarfile.open(plain) as source:
            members = source.getmembers()
            if not 1 <= len(members) <= 50000:
                raise ValueError('Archive file count exceeded')
            if any(not member.isfile() or PurePosixPath(member.name).is_absolute() or '..' in PurePosixPath(member.name).parts or '\\' in member.name for member in members):
                raise ValueError('Unsafe archive member')
            indexed = {member.name: member for member in members}
            if len(indexed) != len(members) or 'manifest.json' not in indexed or indexed['manifest.json'].size > 16 * 1024**2:
                raise ValueError('Invalid archive manifest')
            manifest = json.load(source.extractfile('manifest.json'))
            if set(indexed) != {'manifest.json'} | {entry['path'] for entry in manifest['files']}:
                raise ValueError('Manifest file set differs')
            for entry in manifest['files']:
                member = indexed[entry['path']]
                if member.size != entry['bytes']:
                    raise ValueError('Manifest size differs')
                checksum = hashlib.sha256()
                stream = source.extractfile(member)
                for part in iter(lambda: stream.read(1024 * 1024), b''):
                    checksum.update(part)
                if checksum.hexdigest() != entry['sha256']:
                    raise ValueError('Manifest checksum differs')
        proof = {'id': manifest['id'], 'verifiedFiles': len(manifest['files']),
            'authenticatedAgeDecryption': True, 'manifestChecksumsValid': True, 'verifiedAt': time.time()}
        if 'runtimeBundle' in manifest:
            proof['runtimeBundle'] = manifest['runtimeBundle']
        return proof
    finally:
        plain.unlink(missing_ok=True)


class ExportClient:
    def __init__(self, folder):
        key, hosts = folder / 'ssh-key', folder / 'known-hosts'
        key.write_text(os.environ['TELOMERE_SSH_KEY'].strip() + '\n')
        hosts.write_text(os.environ['TELOMERE_KNOWN_HOSTS'].strip() + '\n')
        key.chmod(0o600)
        self.arguments = ['ssh', '-F', '/dev/null', '-T', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(hosts), '-o', 'ConnectTimeout=12',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ClearAllForwardings=yes', 'root@2.27.12.39']
        if os.environ.get('TELOMERE_SIMULATE_SSH_OUTAGE') == 'true':
            self.arguments[-1:] = ['-p', '9', 'root@127.0.0.1']

    def request(self, value, target=None):
        request = json.dumps({'schemaVersion': 1, **value}).encode() + b'\n'
        child = subprocess.Popen(self.arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ})
        try:
            if target is None:
                output, _ = child.communicate(request, timeout=30)
                if child.returncode or len(output) > 1024 * 1024:
                    raise RuntimeError('Restricted backup SSH failed')
                parsed = json.loads(output)
                if parsed.get('errorType'):
                    raise RuntimeError('Restricted backup operation rejected')
                return parsed
            child.stdin.write(request)
            child.stdin.close()
            # One byte at a time only for the bounded JSON header; archive data streams.
            header, deadline = bytearray(), time.monotonic() + 180
            while not header.endswith(b'\n'):
                if len(header) >= 4096 or time.monotonic() > deadline:
                    raise RuntimeError('Restricted backup header deadline')
                if not select.select([child.stdout], [], [], 5)[0]:
                    continue
                part = os.read(child.stdout.fileno(), 1)
                if not part:
                    raise RuntimeError('Restricted backup header missing')
                header.extend(part)
            metadata = json.loads(header)
            validate_archive_metadata(metadata, RUNTIME_ID.fullmatch(value['id']) is not None)
            if metadata['id'] != value['id']:
                raise RuntimeError('Export returned another archive')
            remaining = metadata['bytes']
            with target.open('xb') as output:
                while remaining:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Restricted backup transfer deadline')
                    if not select.select([child.stdout], [], [], 5)[0]:
                        continue
                    part = os.read(child.stdout.fileno(), min(1024 * 1024, remaining))
                    if not part:
                        raise RuntimeError('Restricted backup stream truncated')
                    output.write(part)
                    remaining -= len(part)
            child.wait(timeout=10)
            if child.returncode or digest(target) != metadata['sha256']:
                raise RuntimeError('Export checksum differs')
            return metadata
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream and not stream.closed:
                    stream.close()


def copy_archive(store, exporter, metadata, identity, folder, runtime=False):
    validate_archive_metadata(metadata, runtime)
    kind = 'telomere-cpu-runtime' if runtime else 'telomere-cpu-data-backup'
    release = store.api(store.prefix + '/releases/tags/' + metadata['id'], missing=True)
    if release:
        body = json.loads(release['body'])
        if body.get('kind') != kind or body.get('sha256') != metadata['sha256']:
            raise RuntimeError('Stored release binding differs')
        asset = next((item for item in store.assets(release) if item['name'] == metadata['id'] + '.tar.age'), None)
        if asset and asset.get('digest') == 'sha256:' + metadata['sha256'] and asset['size'] == metadata['bytes']:
            proof = body.get('verification', {})
            if proof.get('authenticatedAgeDecryption') and proof.get('manifestChecksumsValid') and proof.get('id') == metadata['id'] and time.time() - proof.get('verifiedAt', 0) < (86400 if runtime else 1800):
                return proof
            path = folder / (metadata['id'] + '.stored.tar.age')
            store.download(asset, path, metadata['sha256'])
            proof = verify_archive(path, identity, folder)
            if proof['id'] != metadata['id']:
                raise RuntimeError('Stored manifest identity differs')
            store.api(store.prefix + '/releases/' + str(release['id']), 'PATCH', {'body': json.dumps({**body, 'verification': proof})})
            return proof
    source = folder / (metadata['id'] + '.tar.age')
    exported = exporter.request({'operation': 'download', 'id': metadata['id']}, source)
    if exported['sha256'] != metadata['sha256'] or exported['bytes'] != metadata['bytes']:
        raise RuntimeError('Export differs from published backup metadata')
    proof = verify_archive(source, identity, folder)
    if proof['id'] != metadata['id']:
        raise RuntimeError('Manifest identity differs')
    release = store.release(metadata['id'], {'kind': kind, **metadata, 'verification': proof})
    asset = store.upload(release, source)
    readback = folder / (metadata['id'] + '.readback.tar.age')
    store.download(asset, readback, metadata['sha256'])
    # Independent storage readback is verified before acknowledging the copy.
    if digest(readback) != metadata['sha256']:
        raise RuntimeError('Independent readback failed')
    return proof


def public_alerts():
    try:
        with urllib.request.urlopen('https://telomere.sh/api/config', timeout=15) as response:
            config = json.loads(response.read(128 * 1024))
        if config['chain']['id'] != 8453 or config['escrowAddress'].lower() != '0x27c1e35f563aa4f57a68b192d88a76c25e68e0db':
            return ['PUBLIC_DEPLOYMENT_BINDING_CHANGED']
        with urllib.request.urlopen('https://telomere.sh/', timeout=15) as response:
            if response.status != 200:
                return ['PUBLIC_SITE_UNAVAILABLE']
    except Exception:
        return ['PUBLIC_SITE_UNAVAILABLE']
    return []


def rehearse_restore(store, backup, identity, folder):
    with tempfile.TemporaryDirectory(prefix='restore-', dir=folder) as temporary:
        return _rehearse_restore(store, backup, identity, Path(temporary))


def _rehearse_restore(store, backup, identity, folder):
    image = backup['restore']['databaseImage']
    if not re.fullmatch(r'postgres@sha256:[0-9a-f]{64}', image):
        raise ValueError('Reviewed PostgreSQL digest required')
    release = store.release(backup['id'], {'kind': 'telomere-cpu-data-backup'})
    asset = next(item for item in store.assets(release) if item['name'] == backup['id'] + '.tar.age')
    archive, plain = folder / 'restore-source.tar.age', folder / 'restore-source.tar'
    store.download(asset, archive, backup['sha256'])
    subprocess.run(['age', '-d', '-i', str(identity), '-o', str(plain), str(archive)], check=True, capture_output=True, timeout=60)
    dump = folder / 'database.dump'
    with tarfile.open(plain) as tar:
        member = tar.getmember('database.dump')
        if not member.isfile() or member.size > 256 * 1024**2 or tar.getmember('snapshot.json').size > 16 * 1024**2:
            raise ValueError('Restore member bounds exceeded')
        with dump.open('xb') as output:
            stream = tar.extractfile(member)
            for part in iter(lambda: stream.read(1024 * 1024), b''):
                output.write(part)
        snapshot = json.load(tar.extractfile('snapshot.json'))
    plain.unlink()
    run_id = os.environ['GITHUB_RUN_ID']
    if not re.fullmatch(r'[0-9]{1,20}', run_id):
        raise ValueError('Invalid isolated restore identity')
    name = 'telomere-cloud-restore-' + run_id
    docker = ['docker', '--host', 'unix:///var/run/docker.sock']
    def command(arguments, **kwargs):
        return subprocess.run(docker + arguments, check=True, capture_output=True, timeout=120, **kwargs)
    created = False
    started = time.monotonic()
    try:
        command(['run', '-d', '--name', name, '--label', 'telomere.cloud.restore=' + name,
            '--network', 'none', '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128',
            '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-e', 'POSTGRES_USER=restore',
            '-e', 'POSTGRES_DB=restore', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image])
        created = True
        for attempt in range(60):
            try:
                command(['exec', name, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U restore -d restore'])
                break
            except subprocess.CalledProcessError:
                time.sleep(.5)
        else:
            raise RuntimeError('Cloud restore database readiness deadline')
        with dump.open('rb') as source:
            command(['exec', '-i', name, 'pg_restore', '-U', 'restore', '-d', 'restore', '--exit-on-error', '--no-owner', '--no-acl'], stdin=source)
        rows = 0
        for entry in snapshot['fingerprints']:
            table = entry['table']
            if not re.fullmatch(r'[a-z][a-z0-9_]*', table):
                raise ValueError('Invalid restored table')
            query = 'SELECT to_jsonb(t)::text FROM public."' + table + '" t ORDER BY to_jsonb(t)::text;'
            restored = command(['exec', name, 'psql', '-X', '-q', '-A', '-t', '-U', 'restore', '-d', 'restore', '-v', 'ON_ERROR_STOP=1', '-c', query]).stdout
            if hashlib.sha256(restored).hexdigest() != entry['sha256'] or len(restored.splitlines()) != entry['rows']:
                raise RuntimeError('Cloud-restored table differs')
            rows += entry['rows']
        return {'passed': True, 'tables': len(snapshot['fingerprints']), 'rows': rows,
            'elapsedSeconds': round(time.monotonic() - started, 3), 'network': 'none', 'controllerStarted': False}
    finally:
        if created:
            label = command(['inspect', '--format', '{{index .Config.Labels "telomere.cloud.restore"}}', name]).stdout.decode().strip()
            if label != name:
                raise RuntimeError('Isolated restore label differs')
            command(['rm', '-f', name])


def copy_current_backup(store, exporter, identity, folder, restore=False):
    for attempt in range(3):
        status = exporter.request({'operation':'status'})
        backup = status['backup']
        runtime_proof = copy_archive(store, exporter, backup['runtimeBundle'], identity, folder, True)
        data_proof = copy_archive(store, exporter, backup, identity, folder)
        binding = data_proof.get('runtimeBundle', {})
        if binding.get('id') != backup['runtimeBundle']['id'] or binding.get('sha256') != backup['runtimeBundle']['sha256']:
            raise RuntimeError('Snapshot/runtime manifest binding differs')
        if exporter.request({'operation':'status'})['backup']['id'] != backup['id']:
            continue  # An hourly snapshot advanced while bytes were transferred.
        restored = rehearse_restore(store, backup, identity, folder) if restore else None
        try:
            exporter.request({'operation':'ack','id':backup['id'],'sha256':backup['sha256'],
                'runtimeId':backup['runtimeBundle']['id'],'runtimeSha256':backup['runtimeBundle']['sha256'],
                'repository':store.repository,'runId':os.environ['GITHUB_RUN_ID']})
        except RuntimeError:
            if exporter.request({'operation':'status'})['backup']['id'] != backup['id']:
                continue
            raise
        return status, runtime_proof, data_proof, restored, attempt+1
    raise RuntimeError('Backup changed repeatedly during transfer; retry next scheduled run')


def run():
    global DELIVERY_ATTEMPTED
    store = GitHubStore(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_TOKEN'])
    state_release, previous = store.state()
    alerts, report = public_alerts(), {'scope': 'independent cloud CPU operations', 'mainnetTransactions': 0}
    with tempfile.TemporaryDirectory(prefix='telomere-cloud-') as temporary:
        folder = Path(temporary)
        folder.chmod(0o700)
        identity = folder / 'age-identity'
        identity.write_text(os.environ['TELOMERE_AGE_IDENTITY'].strip() + '\n')
        identity.chmod(0o600)
        try:
            exporter = ExportClient(folder)
            status, runtime_proof, data_proof, restored, attempts = copy_current_backup(store, exporter, identity, folder,
                os.environ.get('TELOMERE_RESTORE_REHEARSAL') == 'true')
            monitor, backup = status['monitor'], status['backup']
            observed = datetime.datetime.fromisoformat(monitor['observedAt']).timestamp()
            if time.time() - observed > 300:
                alerts.append('LOCAL_MONITOR_STALE')
            alerts += monitor['alerts']
            if restored:
                report['cloudRestore'] = restored
            # The private monitor preceded this successful upload/receipt. These
            # two stale off-host observations are superseded by this run's proof.
            alerts = [code for code in alerts if code not in ('OFFHOST_BACKUP_STALE', 'OFFHOST_RUNTIME_NOT_VERIFIED')]
            report.update(backupId=backup['id'], backupVerified=data_proof, runtimeVerified=runtime_proof,
                independentStorageReadback=True, snapshotCopyAttempts=attempts, retention=store.prune_snapshots())
        except Exception as error:
            alerts.append('CLOUD_BACKUP_OR_EXPORT_FAILED')
            report['backupFailureType'] = type(error).__name__
            report['failureFrames'] = [{'file':Path(frame.filename).name,'line':frame.lineno,'function':frame.name} for frame in traceback.extract_tb(error.__traceback__)]
            if type(error) is RuntimeError:
                report['backupFailureReason'] = str(error)
    plan = delivery_plan(previous, alerts, time.time())
    if os.environ.get('TELOMERE_TEST_DELIVERY') == 'true' and not alerts:
        plan = {'kind': 'test', 'alerts': []}
    if plan:
        DELIVERY_ATTEMPTED = True
        Path('cloud-pager-attempted').touch(mode=0o600)
        proof = send(os.environ['TELOMERE_TELEGRAM_TOKEN'], os.environ['TELOMERE_TELEGRAM_CHAT_ID'],
            'external', plan['kind'], plan['alerts'])
        store.save_state(state_release, {**plan, **proof})
        report['notification'] = {'delivered': True, 'kind': plan['kind'], **proof}
    report.update(passed=not alerts, alerts=sorted(set(alerts)), syntheticSshOutage=os.environ.get('TELOMERE_SIMULATE_SSH_OUTAGE')=='true', observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    Path('cloud-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    if alerts:
        raise SystemExit(1)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        run()
    except Exception as error:
        if not DELIVERY_ATTEMPTED and os.environ.get('TELOMERE_TELEGRAM_TOKEN') and os.environ.get('TELOMERE_TELEGRAM_CHAT_ID'):
            try:
                Path('cloud-pager-attempted').touch(mode=0o600)
                send(os.environ['TELOMERE_TELEGRAM_TOKEN'], os.environ['TELOMERE_TELEGRAM_CHAT_ID'], 'external', 'incident', ['CLOUD_OPERATIONS_FAILED'])
            except Exception:
                pass
        print(json.dumps({'passed': False, 'errorType': type(error).__name__, 'mainnetTransactions': 0}))
        raise SystemExit(1)
