import datetime, json, pathlib, subprocess, urllib.request
work = pathlib.Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch04')
operator = pathlib.Path('/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04')
result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
result['snapshotCaptureDirectoryPresent'] = (work / '.local/snapshot').exists()
def command(args): return subprocess.check_output(args, text=True, timeout=15).strip()
if (work / 'state.json').exists():
    state = json.loads((work / 'state.json').read_bytes())
    result['state'] = {key: state[key] for key in ['stage', 'revision', 'archiveSha256', 'release',
        'preparedAt', 'snapshotMaintenanceSeconds', 'cloneAcceptedAt', 'activatedAt', 'maintenanceSeconds',
        'latestReportSha256', 'oldReportSha256', 'cleanupSha256', 'controllerDropinSha256'] if key in state}
else: result['state'] = None
for name in ['clone-cleanup.json', 'global-docker-inventory.json']:
    path = work / name
    if path.exists():
        value = json.loads(path.read_bytes())
        result[name] = value if name == 'clone-cleanup.json' else {'unchanged': value.get('unchanged')}
for phase in ['prepare', 'snapshot', 'validate-clone', 'cutover']:
    unit = 'telomere-private-staging-354fe7af62ea-launch04-' + phase + '.service'
    result[phase] = command(['systemctl', 'show', unit, '--property=ActiveState', '--property=SubState', '--property=Result', '--property=LoadState', '--property=ExecMainStatus', '--property=MainPID'])
    path = operator / (phase + '.private.log')
    if path.exists():
        lines = path.read_bytes()[-65536:].decode(errors='replace').splitlines()
        records = []
        for line in lines:
            try:
                value = json.loads(line)
                if isinstance(value, dict) and value.get('status') in ['passed', 'failed'] and isinstance(value.get('phase'), str):
                    records.append({key: value[key] for key in ['status', 'phase', 'detail', 'reason'] if key in value})
            except (ValueError, TypeError): pass
        if records:
            result[phase + 'Records'] = records[-8:]
            primary = [value for value in records if value['phase'] not in ['recover-held', 'recover_held']]
            if primary: result[phase + 'Status'] = primary[-1]
result['services'] = {unit: command(['systemctl', 'show', unit, '--property=ActiveState', '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory'])
    for unit in ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']}
result['health'] = {}
for kind in ['live', 'ready']:
    try:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + kind, timeout=5) as response:
            result['health'][kind] = {'code': response.status, 'body': json.load(response)}
    except Exception as error: result['health'][kind] = {'errorType': type(error).__name__}
print(json.dumps(result, separators=(',', ':')))
