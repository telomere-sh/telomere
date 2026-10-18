"""Restore encrypted production data, then boot the archived runtime with disposable keys.

The production controller is never restarted or cloned. Data/config decryption is
root-only; the application receives an empty scratch database and local chain.
Pass an age identity on stdin. It is not written to disk or passed as an argument.
"""
import hashlib, http.client, importlib.util, json, os, re, shutil, socket, ssl, subprocess, sys, tarfile, tempfile, time, uuid
from pathlib import Path, PurePosixPath
_spec=importlib.util.spec_from_file_location('restore_capacity_policy',Path(__file__).parent.parent/'cpu-cloud/archive_policy.py')
policy=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(policy)

BASE = Path('/opt/telomere-mainnet-pilot')
PRIVATE = BASE / 'private'
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
SOCKET = 'unix:///run/telomere-mainnet-docker/docker.sock'

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **{'timeout':120,**kwargs})

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for part in iter(lambda: source.read(1024 * 1024), b''):
            value.update(part)
    return value.hexdigest()

def unpack(cipher, expected_hash, identity, target):
    if digest(cipher) != expected_hash:
        raise ValueError('Ciphertext hash differs')
    plain = target.parent / (target.name + '.plain')
    try:
        run(['/usr/bin/age', '--decrypt', '-i', '/dev/stdin', '-o', str(plain), str(cipher)], input=identity,timeout=policy.CRYPTO_SECONDS)
        with tarfile.open(plain) as source:
            members = source.getmembers()
            if not 1 <= len(members) <= 50000:
                raise ValueError('Archive member limit')
            indexed = {}
            for member in members:
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts or '\\' in member.name or member.name in indexed:
                    raise ValueError('Unsafe archive member')
                indexed[member.name] = member
            if 'manifest.json' not in indexed or indexed['manifest.json'].size > 16 * 1024**2:
                raise ValueError('Missing archive manifest')
            manifest = json.load(source.extractfile('manifest.json'))
            policy.validate_files(manifest['files'],runtime=bool(policy.RUNTIME_ID.fullmatch(manifest['id'])))
            if cipher.stat().st_size>policy.archive_limit(manifest['id']):
                raise ValueError('Encrypted archive capacity exceeded')
            if set(indexed) != {'manifest.json'} | {item['path'] for item in manifest['files']}:
                raise ValueError('Manifest member set differs')
            if sum(item['bytes'] for item in manifest['files']) > 2 * 1024**3:
                raise ValueError('Archive expanded-size limit')
            target.mkdir(mode=0o700)
            for item in manifest['files']:
                member = indexed[item['path']]
                if member.size != item['bytes']:
                    raise ValueError('Archive member size differs')
                output = target.joinpath(*PurePosixPath(item['path']).parts)
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as stream, output.open('xb') as destination:
                    shutil.copyfileobj(stream, destination)
                output.chmod(0o600)
                if digest(output) != item['sha256']:
                    raise ValueError('Archive member hash differs')
            (target / 'manifest.json').write_text(json.dumps(manifest))
            return manifest
    finally:
        plain.unlink(missing_ok=True)

def proxy_rehearsal(stage, runtime, http_origin):
    """Start a separate TLS nginx from the retained site and CSP configuration."""
    # Progress is written by the unprivileged test process. It must never become
    # arbitrary nginx configuration interpreted by the privileged master.
    match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})', http_origin) if isinstance(http_origin, str) else None
    if not match or int(match[1]) > 65535:
        raise ValueError('Scratch proxy requires one exact loopback origin')
    selected = socket.socket(); selected.bind(('127.0.0.1', 0)); port = selected.getsockname()[1]; selected.close()
    cert, key = stage / 'test-cert.pem', stage / 'test-key.pem'
    run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
         '-subj', '/CN=telomere.sh', '-addext', 'subjectAltName=DNS:telomere.sh', '-keyout', str(key), '-out', str(cert)])
    key.chmod(0o600)
    config = (stage / 'data/configuration/nginx.conf').read_text()
    assert (stage / 'data/configuration/nginx-csp.conf').is_file(), 'Retained CSP include missing'
    config, count = re.subn(r'listen 443 ssl http2;', 'listen 127.0.0.1:' + str(port) + ' ssl;', config)
    assert count == 1
    config = re.sub(r'\s*listen \[::\]:443 ssl http2;', '', config)
    config = re.sub(r'ssl_certificate\s+[^;]+;', 'ssl_certificate ' + str(cert) + ';', config)
    config = re.sub(r'ssl_certificate_key\s+[^;]+;', 'ssl_certificate_key ' + str(key) + ';', config)
    config, count = re.subn(r'root /var/www/telomere-public/[A-Za-z0-9_-]+;', 'root ' + str(runtime / 'website') + ';', config)
    assert count == 1
    config = config.replace('/etc/nginx/snippets/telomere-website-csp.conf', str(stage / 'data/configuration/nginx-csp.conf'))
    config = config.replace('http://127.0.0.1:3282', http_origin)
    nginx = stage / 'nginx.conf'
    nginx.write_text('user telomere-mainnet; worker_processes 1; pid ' + str(stage / 'nginx.pid') + ';\n'
        'error_log ' + str(stage / 'nginx-error.log') + '; events { worker_connections 64; }\n'
        'http { include /etc/nginx/mime.types; access_log off; ' + config + '\n}\n')
    run(['/usr/sbin/nginx', '-t', '-c', str(nginx)])
    child = subprocess.Popen(['/usr/sbin/nginx', '-c', str(nginx), '-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        context = ssl.create_default_context(cafile=str(cert)); context.check_hostname = False
        checks = []
        for path, expected in (('/', 200), ('/page.html', 200), ('/api/me', 401), ('/.env', 404), ('/src/main.ts', 404)):
            for attempt in range(30):
                try:
                    connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=5)
                    connection.request('GET', path, headers={'Host': 'telomere.sh'})
                    response = connection.getresponse(); body = response.read(4 * 1024**2)
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(.1)
            else:
                raise RuntimeError('Private restored TLS proxy did not start')
            assert response.status == expected, 'Restored nginx route differs: ' + path + ':' + str(response.status)
            if path in ('/', '/page.html'):
                name = 'index.html' if path == '/' else 'page.html'
                assert hashlib.sha256(body).hexdigest() == digest(runtime / 'website' / name), 'Restored website bytes differ'
                assert response.getheader('Content-Security-Policy'), 'Restored CSP missing'
            checks.append({'path': path, 'status': response.status})
            connection.close()
        return {'passed': True, 'checks': checks, 'privateLoopbackOnly': True, 'ephemeralTestCertificate': True, 'productionTlsOrDnsChanged': False}
    finally:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)

def restored_data_api(stage, runtime, snapshot):
    """Read real restored records through archived routes with all IP networking absent."""
    name = 'telomere-dr-data-' + uuid.uuid4().hex[:16]
    docker = ['/usr/bin/docker', '--host', SOCKET]
    socket_folder = runtime / 'pg-socket'; socket_folder.mkdir(mode=0o777); socket_folder.chmod(0o777)
    image = snapshot.get('databaseImage')
    if not image:
        image = json.loads((stage / 'data/manifest.json').read_text())['restoreRehearsal']['databaseImage']
    assert re.fullmatch(r'postgres@sha256:[0-9a-f]{64}', image)
    volume=name+'-data';volume_created=False
    try:
        assert shutil.disk_usage(stage).free>policy.MIN_FREE_BYTES
        run(docker+['volume','create','--label','telomere.dr.data='+name,volume]);volume_created=True
        run(docker + ['run', '-d', '--name', name, '--label', 'telomere.dr.data=' + name, '--runtime', 'runc', '--network', 'none',
            '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128', '--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',
            '--mount', 'type=bind,source=' + str(socket_folder) + ',target=/var/run/postgresql',
            '-e', 'POSTGRES_USER=restore', '-e', 'POSTGRES_DB=restore', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image])
        for attempt in range(60):
            # The image briefly starts an init-time server before creating its
            # configured database. Wait for the final PostgreSQL PID 1 as well.
            ready = subprocess.run(docker + ['exec', name, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U restore -d restore'], capture_output=True, timeout=5)
            if ready.returncode == 0: break
            time.sleep(.5)
        else: raise RuntimeError('Restored API database did not start')
        with (stage / 'data/database.dump').open('rb') as dump:
            run(docker + ['exec', '-i', name, 'pg_restore', '-U', 'restore', '-d', 'restore', '--exit-on-error', '--no-owner', '--no-acl'], stdin=dump,timeout=policy.RESTORE_SECONDS)
        reader = runtime / 'data-reader.mjs'
        shutil.copyfile(BASE / 'operator/cpu-launch/restored-data-reader.mjs', reader)
        reader.chmod(0o640); os.chown(reader, 0, 993)
        observed = json.loads(run(['/usr/bin/unshare', '--net', '/usr/sbin/runuser', '-u', 'telomere-mainnet', '--',
            str(runtime / 'binaries/node'), str(reader), str(runtime), str(socket_folder)], cwd=runtime / 'release').stdout)
        assert observed['passed']
        for entry in snapshot['fingerprints']:
            table = entry['table']; assert re.fullmatch('[a-z][a-z0-9_]*', table)
            query = 'SELECT to_jsonb(t)::text FROM public."' + table + '" t ORDER BY to_jsonb(t)::text;'
            with tempfile.TemporaryFile() as output:
                subprocess.run(docker+['exec',name,'psql','-X','-q','-A','-t','-U','restore','-d','restore','-v','ON_ERROR_STOP=1','-v','FETCH_COUNT=256','-c',query],check=True,stdout=output,stderr=subprocess.PIPE,timeout=policy.RESTORE_SECONDS)
                output.seek(0);checksum=hashlib.sha256()
                for part in iter(lambda:output.read(1024**2),b''):checksum.update(part)
            assert checksum.hexdigest()==entry['sha256'],'Archived API changed a restored table'
        observed['allOriginalTableFingerprintsPreserved'] = True
        return observed
    finally:
        inspected = subprocess.run(docker + ['inspect', '--format', '{{index .Config.Labels "telomere.dr.data"}}', name], capture_output=True, timeout=10)
        if inspected.returncode == 0:
            assert inspected.stdout.decode().strip() == name
            run(docker + ['rm', '-f', name])
        if volume_created:
            label=run(docker+['volume','inspect','--format','{{index .Labels "telomere.dr.data"}}',volume]).stdout.decode().strip()
            assert label==name
            run(docker+['volume','rm',volume])
        # PostgreSQL owns its socket directory; its contents are disposable.
        shutil.rmtree(socket_folder)

def main():
    assert os.geteuid() == 0
    identity = sys.stdin.buffer.read(4097)
    assert len(identity) <= 4096 and b'AGE-SECRET-KEY-' in identity
    started = time.monotonic()
    guard = json.loads(run([NODE, str(BASE / 'operator/preflight-public.mjs'), '--configuration-only']).stdout)
    assert guard['configurationValid']
    status = json.loads((PRIVATE / 'cpu-backup-status.json').read_text())
    cloud = json.loads((PRIVATE / 'cpu-cloud-offhost-status.json').read_text())
    assert cloud['id'] == status['id'] and cloud['sha256'] == status['sha256']
    runtime = status['runtimeBundle']
    assert cloud['runtimeBundleId'] == runtime['id'] and cloud['runtimeBundleSha256'] == runtime['sha256']
    assert re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}', status['id'])
    assert re.fullmatch(r'runtime-[0-9a-f]{40}-[0-9a-f]{16}', runtime['id'])
    namespace = uuid.uuid4().hex[:16]
    # The live application can write data/. Keep executable recovery material in
    # a separate root-owned parent so that it cannot replace a privileged helper.
    parent = BASE / 'rehearsals'
    parent.mkdir(exist_ok=True, mode=0o750)
    assert not parent.is_symlink() and parent.resolve() == parent and parent.stat().st_uid == 0
    os.chown(parent, 0, 993); parent.chmod(0o750)
    root = parent / ('cpu-dr-' + namespace)
    root.mkdir(mode=0o750)
    os.chown(root, 0, 993)
    result = {'schemaVersion': 1, 'passed': False, 'backupId': status['id'], 'runtimeId': runtime['id'],
              'mainnetTransactions': 0, 'productionControllerRestarted': False,
              'mainnetSignerPassedToApplication': False, 'completeVpsRebuild': False}
    # Root must not follow a report symlink in the application's writable data/.
    report = PRIVATE / ('cpu-dr-report-' + namespace + '.json')
    unit = None
    try:
        with tempfile.TemporaryDirectory(prefix='cpu-dr-', dir=PRIVATE) as temporary:
            stage = Path(temporary)
            data = unpack(BASE / 'backups' / (status['id'] + '.tar.age'), status['sha256'], identity, stage / 'data')
            archived = unpack(BASE / 'backups' / (runtime['id'] + '.tar.age'), runtime['sha256'], identity, stage / 'runtime')
            identity = b''
            assert data['runtimeBundle']['id'] == archived['id'] == runtime['id']
            expected = json.loads((stage / 'data/configuration/expected.json').read_text())
            for pin in expected['runtimePins']:
                assert digest(stage / 'runtime/release' / pin['path']) == pin['sha256']
            result.update(authenticatedDecryption=True, dataMembers=len(data['files']), runtimeMembers=len(archived['files']), runtimePins=len(expected['runtimePins']))
            spec = importlib.util.spec_from_file_location('cpu_ops', BASE / 'operator/cpu-launch/mainnet-ops.py')
            ops = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(ops)
            snapshot = json.loads((stage / 'data/snapshot.json').read_text())
            result['productionDataRestore'] = ops.restore(stage / 'data', snapshot)
            # Only public runtime files leave the root-only data/config stage.
            for part in ('release', 'website', 'operator', 'binaries'):
                shutil.copytree(stage / 'runtime' / part, root / part)
            for path in [root, *root.rglob('*')]:
                assert not path.is_symlink()
                os.chown(path, 0, 993)
                path.chmod(0o750 if path.is_dir() else 0o640)
            for binary in ('node', 'runsc'):
                (root / 'binaries' / binary).chmod(0o750)
            result['archivedNodeVersion'] = run(['/usr/sbin/runuser', '-u', 'telomere-mainnet', '--', str(root / 'binaries/node'), '--version'], cwd=root / 'release').stdout.decode().strip()
            result['archivedRunscExecutable'] = run(['/usr/sbin/runuser', '-u', 'telomere-mainnet', '--', str(root / 'binaries/runsc'), '--version'], cwd=root / 'release').returncode == 0
            result['runtimeTreeRootOwned'] = True
            for protected in (parent, root, root / 'binaries/node', root / 'binaries/runsc'):
                run(['/usr/sbin/runuser', '-u', 'telomere-mainnet', '--', '/usr/bin/test', '!', '-w', str(protected)], cwd=root / 'release')
            result['liveApplicationCannotModifyRehearsalExecutables'] = True
            result['restoredProductionDataApi'] = restored_data_api(stage, root, snapshot)
            # Rewrite only acceptance harness import locations, never restored application bytes.
            template = (BASE / 'operator/cpu-launch/soak.mjs').read_text()
            template = template.replace('/opt/telomere-mainnet-pilot/app/', str(root / 'release') + '/')
            template = template.replace("BASE+'/app/", "'" + str(root / 'release') + '/')
            template = template.replace("BASE+'/operator/cpu-launch/load-worker.mjs'", repr(str(root / 'worker.mjs')))
            template = template.replace("BASE+'/operator/acceptance-tools/anvil'", repr(str(root / 'operator/acceptance-tools/anvil')))
            # Report the dynamically assigned scratch HTTP origin for a private proxy rehearsal.
            template = template.replace("scope:'exact deployed runtime,", "httpOrigin:origin,scope:'archived runtime,")
            (root / 'soak.mjs').write_text(template)
            worker = (BASE / 'operator/cpu-launch/load-worker.mjs').read_text().replace('/opt/telomere-mainnet-pilot/app/', str(root / 'release') + '/')
            (root / 'worker.mjs').write_text(worker)
            for path in (root / 'soak.mjs', root / 'worker.mjs'):
                os.chown(path, 0, 993); path.chmod(0o640)
                run(['/usr/sbin/runuser', '-u', 'telomere-mainnet', '--', str(root / 'binaries/node'), '--check', str(path)], cwd=root / 'release')
            (root / 'operator/acceptance-tools/anvil').chmod(0o750)
            for pin in expected['runtimePins']:
                assert digest(root / 'release' / pin['path']) == pin['sha256']
            # Only the reviewed image/socket are selected from live config; no key or DB URL.
            source = "import {parseProfile} from './dist/src/operator/profile.js';import {readFile} from 'node:fs/promises';const e=parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'));process.stdout.write(JSON.stringify({image:e.CPU_IMAGE,host:e.DOCKER_HOST}));"
            selected = json.loads(run([NODE, '--input-type=module', '-e', source], cwd=BASE / 'app').stdout)
            assert selected['host'] == SOCKET
            image = run(['/usr/bin/docker', '--host', SOCKET, 'inspect', '--format', '{{.Image}}', 'telomere-mainnet-postgres']).stdout.decode().strip()
            env = {'PATH': str(BASE / 'operator/cpu-launch/bin') + ':/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',
                   'DOCKER_HOST': SOCKET, 'CPU_IMAGE': selected['image'], 'ACCEPTANCE_POSTGRES_IMAGE': image,
                   'TELOMERE_ACCEPTANCE_NAMESPACE': namespace, 'ACCEPTANCE_NAMESPACE': namespace, 'ACCEPTANCE_DURATION_SECONDS': '60'}
            unit = 'telomere-cpu-dr-' + namespace
            command = ['systemd-run', '--unit=' + unit, '--uid=telomere-mainnet', '--gid=telomere-mainnet',
                       '--property=MemoryMax=2G', '--property=CPUQuota=100%', '--property=CPUWeight=10', '--property=RuntimeMaxSec=300',
                       '--working-directory=' + str(root / 'release')]
            command += ['--setenv=' + key + '=' + value for key, value in env.items()]
            run(command + [str(root / 'binaries/node'), str(root / 'soak.mjs')])
            progress_path = BASE / 'data/cpu-launch-acceptance-20261017' / ('soak-' + namespace + '.json')
            proxy_checked = False
            for attempt in range(150):
                if progress_path.exists():
                    progress = json.loads(progress_path.read_text())
                    if not proxy_checked and progress['state'] == 'running':
                        result['restoredTlsProxy'] = proxy_rehearsal(stage, root, progress['httpOrigin'])
                        proxy_checked = True
                    if progress['state'] in ('completed', 'failed'):
                        break
                state = run(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']).stdout.decode().strip()
                if state == 'failed':
                    raise RuntimeError('Archived runtime acceptance unit failed')
                time.sleep(1)
            else:
                raise RuntimeError('Archived runtime acceptance deadline')
            assert progress['state'] == 'completed', 'Archived application acceptance failed'
            assert proxy_checked, 'Restored proxy was not exercised'
            result['archivedApplication'] = progress
            result['applicationRuntimePinsUnchanged'] = all(digest(root / 'release' / pin['path']) == pin['sha256'] for pin in expected['runtimePins'])
            result['nginxConfigurationRetained'] = (stage / 'data/configuration/nginx.conf').is_file()
            result['passed'] = True
    except Exception as error:
        result.update(errorType=type(error).__name__, errorCode=str(error)[:160])
    finally:
        if unit:
            subprocess.run(['systemctl', 'stop', unit], capture_output=True, timeout=40)
        assert root.resolve().parent == parent and re.fullmatch(r'cpu-dr-[0-9a-f]{16}', root.name)
        shutil.rmtree(root)
        result['scratchRuntimeRemoved'] = not root.exists()
        result['elapsedSeconds'] = round(time.monotonic() - started, 3)
        with report.open('x') as output: output.write(json.dumps(result, indent=2) + '\n')
        report.chmod(0o600)
        print(json.dumps({**result, 'report': str(report)}))
    if not result['passed']:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
