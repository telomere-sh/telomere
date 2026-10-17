import datetime, hashlib, json, os, pathlib, re, signal, subprocess, sys, tarfile, time

archive_arg, manifest_arg, expected, revision = sys.argv[1:]
assert re.fullmatch('[a-f0-9]{64}', expected) and re.fullmatch('[a-f0-9]{40}', revision)
archive, manifest_path = pathlib.Path(archive_arg), pathlib.Path(manifest_arg)
assert archive.parent == manifest_path.parent == pathlib.Path('/tmp')
assert archive.name == 'telomere-backend-completion-final-20261015.tar.gz'
assert manifest_path.name == archive.name + '.manifest.json'
assert archive.is_file() and not archive.is_symlink() and not manifest_path.is_symlink()
manifest = json.loads(manifest_path.read_bytes())
assert manifest['gitRevision'] == revision and manifest['source'] == 'committed_git_blobs_only'
assert manifest['workingTreeIncluded'] is False
assert expected == manifest['archiveSha256'] == hashlib.sha256(archive.read_bytes()).hexdigest()
inventory = {item['path']: item for item in manifest['files']}
assert 689 <= len(inventory) == len(manifest['files']) <= 1000
target = pathlib.Path('/opt/telomere-host-runtime') / ('backend-completion-final-20261015-' + expected[:12])
assert target.parent.resolve() == target.parent and not target.exists()
os.umask(0o077)
target.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers()
    assert len(members) == len(inventory)
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        assert item.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        assert item.name in inventory
        raw = packed.extractfile(item).read()
        assert len(raw) == inventory[item.name]['bytes'] and hashlib.sha256(raw).hexdigest() == inventory[item.name]['sha256']
        destination = target / item.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(raw)
logs = target / '.local'
logs.mkdir(mode=0o700)
(logs / 'source-manifest.json').write_bytes(manifest_path.read_bytes())
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
report = {'schemaVersion': 1, 'gitRevision': revision, 'archiveSha256': expected, 'sourceFiles': len(inventory),
    'directory': str(target), 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0}
def run(name, command, timeout):
    started = time.monotonic()
    with (logs / (name + '.log')).open('xb') as output:
        child = subprocess.Popen(command, cwd=target, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
    report[name] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3)}
    print(json.dumps({'completed': name, **report[name]}), flush=True)
    assert child.returncode == 0
try:
    report['nodeVersion'] = subprocess.check_output(['node', '--version'], env=environment, text=True).strip()
    assert report['nodeVersion'] == 'v22.23.3'
    run('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600)
    run('build', ['npm', 'run', 'build'], 600)
    context = target / '.local/declared-state-image-context'
    context.mkdir(mode=0o700)
    run('cell-bundle', ['node_modules/.bin/esbuild', 'scripts/declared-state-cell.ts', '--bundle',
        '--platform=node', '--format=cjs', '--outfile=' + str(context / 'declared-state-cell.cjs')], 60)
    run('cell-capture-bundle', ['node_modules/.bin/esbuild', 'scripts/declared-state-cell-capture.ts', '--bundle',
        '--platform=node', '--format=cjs', '--outfile=' + str(context / 'declared-state-cell-capture.cjs')], 60)
    with (context / 'Dockerfile').open('xb') as output:
        output.write((target / 'infra/host-kit/Dockerfile.declared-state').read_bytes())
    report['cellCjsSha256'] = hashlib.sha256((context / 'declared-state-cell.cjs').read_bytes()).hexdigest()
    report['cellCaptureCjsSha256'] = hashlib.sha256((context / 'declared-state-cell-capture.cjs').read_bytes()).hexdigest()
    report['imageBuildContext'] = str(context)
    report['success'] = True
except Exception as error:
    report['success'] = False
    report['failureType'] = type(error).__name__
finally:
    report['changedSource'] = [name for name, item in inventory.items() if not (target / name).is_file()
        or (target / name).is_symlink() or hashlib.sha256((target / name).read_bytes()).hexdigest() != item['sha256']]
    report['success'] = report['success'] and not report['changedSource']
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'install.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')), flush=True)
sys.exit(0 if report['success'] else 1)
