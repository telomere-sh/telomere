#!/usr/bin/env python3
"""Local-only operator helper; no transport occurs without an explicit phase invocation.

check is entirely local. upload and each launch are separate deliberate commands.
No protected profile or key contents are read, no phase chains into another phase.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
KEY = 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519'
HOST = 'root@2.27.12.39'
REMOTE = '/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt02'
RUN = 'staging-354fe7af62ea-launch02'
REV = '354fe7af62ea6701faafc3b04522abb1b4524d2d'
SHA = '86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce'
BASE_REV = 'b042c1bc3119754e06f6b662f2e46c108a63db36'
BASE_SHA = '3e901e235bb9e50ff4c8dea8312aa05da7364f4865aa3c46014cb5a806122a49'
PRIOR_REV = '8d848f20c8dc4a2b3d672013777e1c630ecd233e'
PRIOR_SHA = '45cdb729cb9ccf3aa5e9a063940c0d732ba2bcad59e612d5e1e3f3a9058164c4'
ARCHIVE = ROOT / '.local/telomere-selection-composed-20261015.tar.gz'
MANIFEST = Path(str(ARCHIVE) + '.manifest.json')
BASE_ARCHIVE = ROOT / '.local/telomere-backend-current-20261015.tar.gz'
BASE_MANIFEST = Path(str(BASE_ARCHIVE) + '.manifest.json')
PRIOR_ARCHIVE = ROOT / '.local/telomere-finance-keys-20261015.tar.gz'
PRIOR_MANIFEST = Path(str(PRIOR_ARCHIVE) + '.manifest.json')
INITIAL_REPORT_SHA = '8bdd2eaa68f5ce6a01cb67724060329e4209a24d14a5701d739631540030e52c'
INITIAL_RAW_SHA = '71d60bc6818432fb5cf041de6510f1227b67b803cb02e7326d68b0d0816a1f5e'
FAILURE_SHA = 'a4f45dcceb21171519ebd5baf65b7b1d77ccb47df06087a3b98ba7d0ba51526b'
FAILED_TITLE = 'Selection vaults and fixed-supply utility staking on an actual disposable EVM records inference-only burn and zero-charge settlement accurately without fabricating paid work'
PHASES = ['prepare', 'snapshot', 'validate-clone', 'cutover']
FROZEN = {'rollout.py': '6b1d4f4d1e427ed7e634569d54d6cfa8b3a9baaa5204149c44dd0825a5157135',
    'clone-smoke.mjs': '43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5',
    'README.md': '15bf729fe6c60e04adcbf126628602f1dcea986692dcb87c550047775de7580d'}
UNITS = {'telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service'}
ADDED = {'src/sealed-keys/handoff-v3.ts', 'src/sealed-keys/journal-v3.ts', 'src/sealed-keys/protocol-v3.ts',
    'src/suppliers/golem-finance-ledger.ts', 'src/suppliers/golem-finance-types.ts', 'src/suppliers/golem-finance.ts',
    'tests/golem-finance.test.ts', 'tests/sealed-handoff-v3.test.ts'}
SSH = ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
       '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']

class Refused(Exception):
    pass

def need(value, reason='gate_rejected'):
    if not value:
        raise Refused(reason)

def sha(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            result.update(block)
    return result.hexdigest()

def unique(pairs):
    out = {}
    for key, value in pairs:
        need(key not in out, 'duplicate_evidence_key')
        out[key] = value
    return out

def read(path):
    path = Path(path)
    need(path.is_file() and not path.is_symlink(), 'gate_evidence_missing')
    need(path.stat().st_size <= 67108864, 'gate_evidence_bound')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique)

def stable(report, known_initial_failure=False):
    need(report['servicesBefore'] == report['servicesAfter'] and set(report['servicesBefore']) == UNITS)
    for raw in report['servicesBefore'].values():
        need(dict(line.split('=', 1) for line in raw.splitlines()) == {'NRestarts': '0', 'ActiveState': 'active', 'SubState': 'running'})
    for key in ['healthBefore', 'healthAfter']:
        need(report[key]['live']['statusCode'] == report[key]['ready']['statusCode'] == 200)
        need(report[key]['live']['body']['status'] == 'ok' and report[key]['ready']['body']['status'] == 'ready')
    need(report['publicTransactions'] == report['paidProviderRequests'] == 0)
    need((known_initial_failure or not report.get('nodeFailures')) and 'failureType' not in report and 'postflightFailureType' not in report)
    need(not any(key.endswith('TimedOut') for key in report))

def tests(summary, raw, *, passed=None, allow_skips=False):
    need(summary['success'] is True and raw['success'] is True)
    for key, value in summary.items():
        need(raw[key] == value)
    need(raw['numFailedTests'] == 0 and (allow_skips or raw['numPendingTests'] == 0))
    need(raw['numPassedTests'] + raw['numPendingTests'] == raw['numTotalTests'])
    need(passed is None or raw['numPassedTests'] == raw['numTotalTests'] == passed)
    need(all(row['status'] != 'failed' for row in raw['testResults']))

def source(archive, manifest, revision, checksum, count):
    need(manifest['gitRevision'] == revision and manifest['archiveSha256'] == checksum and sha(archive) == checksum)
    need(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False)
    rows = {row['path']: row for row in manifest['files']}
    need(len(rows) == len(manifest['files']) == count)
    with tarfile.open(archive, 'r:gz') as packed:
        members = packed.getmembers()
        need(len(members) == count and {item.name for item in members} == set(rows))
        for item in members:
            path = PurePosixPath(item.name)
            need(item.isfile() and not path.is_absolute() and '..' not in path.parts and '\\' not in item.name)
            need(0 <= item.size == rows[item.name]['bytes'] <= 67108864)
            need(hashlib.sha256(packed.extractfile(item).read()).hexdigest() == rows[item.name]['sha256'])
    return rows

def initial_report(b, node, gpu):
    # This component remains a FAILED full run. Root/reviewer approved ONLY this exact classified gas-fixture failure.
    need(b['success'] is False and b['sourceFiles'] == 677 and b['gitRevision'] == BASE_REV and b['archiveSha256'] == BASE_SHA)
    need(b['sourceChangedAfter'] == [] and b['stagingServiceMutations'] is False)
    need(b['protectedContainerBefore'] == b['protectedContainerAfter'] and b['ownedSessionContainersAfter'] == '')
    need(all(b[key]['exitCode'] == 0 for key in ['npm-ci', 'build', 'paid-file-gvisor']) and b['node-full']['exitCode'] == 1)
    stable(b, known_initial_failure=True); tests(b['tests'], gpu, passed=16)
    need(node['success'] is False and node['numTotalTests'] == 2301 and node['numPassedTests'] == 2281
         and node['numFailedTests'] == 1 and node['numPendingTests'] == 19)
    need(all(node[key] == value for key, value in b['nodeTests'].items()))
    failed = [(Path(suite['name']).name, test) for suite in node['testResults'] for test in suite['assertionResults'] if test['status'] == 'failed']
    need(len(failed) == 1 and failed[0][0] == 'selection-contracts.test.ts' and failed[0][1]['fullName'] == FAILED_TITLE)
    message = '\n'.join(failed[0][1].get('failureMessages', []))
    need(hashlib.sha256(message.encode()).hexdigest() == FAILURE_SHA and 'gas' in message.lower() and 'reverted' in message.lower())
    need(len(b['nodeFailures']) == 1 and b['nodeFailures'][0]['file'] == 'selection-contracts.test.ts'
         and b['nodeFailures'][0]['tests'] == [FAILED_TITLE])
    need([Path(suite['name']).name for suite in node['testResults'] if suite['status'] == 'failed'] == ['selection-contracts.test.ts'])

def gates():
    # No true gate file is created until ALL actual retained evidence below is read and verified.
    base = ROOT / '.local/backend-current-linux-initial-20261015'
    current = ROOT / '.local/selection-composed-corrected-linux-20261015'
    evidence_paths = [base / 'acceptance.json', base / 'node-full.json', base / 'paid-file-gvisor.json',
        current / 'acceptance.json', current / 'selection-composed.json', BASE_MANIFEST, PRIOR_MANIFEST, MANIFEST,
        ROOT / 'docs/evidence/selection-composed-source-continuity-20261015.json']
    b, node, gpu, c, focused, bm, pm, cm, continuity = [read(path) for path in evidence_paths]
    need(sha(base/'acceptance.json') == INITIAL_REPORT_SHA and sha(base/'node-full.json') == INITIAL_RAW_SHA, 'initial_failure_identity_changed')
    initial_report(b, node, gpu)
    need(c['success'] is True and c['sourceFiles'] == 685 and c['gitRevision'] == REV and c['archiveSha256'] == SHA)
    need(c['directory'] == '/opt/telomere-host-runtime/selection-composed-corrected-20261015-' + SHA[:12])
    need(c['sourceAfter'] == {'unchanged': True, 'changed': []} and c['serviceMutations'] is False)
    need(c['dockerOptIn'] is c['capacityOptIn'] is c['langgraphOptIn'] is False)
    need(all(c[key]['exitCode'] == 0 for key in ['npm-ci', 'build', 'selection-composed']))
    stable(c); tests(c['nodeTests'], focused, passed=111)
    groups = {Path(suite['name']).name: suite['assertionResults'] for suite in focused['testResults']}
    need(all(suite['name'].startswith(c['directory'] + '/tests/') for suite in focused['testResults']))
    selected = {'selection-contracts.test.ts', 'sealed-handoff-v3.test.ts', 'sealed-keys-release.test.ts', 'sealed-keys-signed-appraiser.test.ts', 'golem-finance.test.ts'}
    need(set(groups) == selected and len(groups['selection-contracts.test.ts']) == 40
        and sum(len(rows) for name, rows in groups.items() if name != 'selection-contracts.test.ts') == 71
        and all(row['status'] == 'passed' for rows in groups.values() for row in rows), 'composed_cohort_scope')
    old = source(BASE_ARCHIVE, bm, BASE_REV, BASE_SHA, 677)
    prior = source(PRIOR_ARCHIVE, pm, PRIOR_REV, PRIOR_SHA, 685)
    new = source(ARCHIVE, cm, REV, SHA, 685)
    fixture = 'tests/selection-contracts.test.ts'
    need(all(row == prior.get(path) for path, row in old.items()) and set(prior)-set(old) == ADDED)
    need(set(new) == set(prior) and [path for path in prior if prior[path] != new[path]] == [fixture])
    with tarfile.open(BASE_ARCHIVE, 'r:gz') as packed: before = packed.extractfile(fixture).read()
    with tarfile.open(ARCHIVE, 'r:gz') as packed: after = packed.extractfile(fixture).read()
    previous = b'  async function settle(q: Quote, seconds = 3n, inferenceCharge = 0n, gas?: bigint) {'
    replacement = b'  // Anvil may estimate at zero elapsed seconds and mine after the next second.\n  // Keep a bounded fixture budget across both valid settlement branches.\n  async function settle(q: Quote, seconds = 3n, inferenceCharge = 0n, gas = 300_000n) {'
    need(before.count(previous) == 1 and before.replace(previous, replacement) == after, 'unexpected_fixture_delta')
    expected_continuity = {'initial677Revision': BASE_REV, 'initial677ArchiveSha256': BASE_SHA,
        'prior685Revision': PRIOR_REV, 'prior685ArchiveSha256': PRIOR_SHA, 'correctedRevision': REV, 'correctedArchiveSha256': SHA,
        'correctedSourceFiles': 685, 'priorCoreFilesByteIdentical': 676, 'allProductionDependencyAndConfigFilesByteIdentical': True,
        'allEightAdditiveFilesByteIdentical': True, 'onlyChangedPath': fixture, 'exactFixtureReplacementVerified': True}
    need(all(type(continuity[key]) is type(value) and continuity[key] == value for key, value in expected_continuity.items()), 'continuity_record_mismatch')
    for name, checksum in FROZEN.items():
        need(sha(HERE / name) == checksum, 'frozen_operator_changed')
    hashes = {str(path.relative_to(ROOT)).replace('\\', '/'): sha(path) for path in evidence_paths}
    hashes.update({str(path.relative_to(ROOT)).replace('\\', '/'): sha(path) for path in [BASE_ARCHIVE, PRIOR_ARCHIVE, ARCHIVE]})
    return {'schemaVersion': 2, 'revision': REV, 'archiveSha256': SHA,
        'initialFullFailureClassifiedGasOnly': True, 'exactSourceContinuity': True,
        'correctedSelectionCohortPassed': True, 'additive71Passed': True, 'paidFileGvisor16Passed': True}, hashes

def transport(args, *, input=None):
    # Never echo child stdout/stderr, argv, exception strings, profiles or key contents.
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=180, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 65536, 'transport_failed_review_private_state')
    return result.stdout

def remote(code):
    return transport(['ssh', *SSH, HOST, 'python3 -'], input=code.encode('utf-8'))

def expected_bundle(gate, hashes):
    gate_bytes = (json.dumps(gate, separators=(',', ':')) + '\n').encode()
    evidence_bytes = (json.dumps(hashes, sort_keys=True) + '\n').encode()
    return {**FROZEN, ARCHIVE.name: SHA, MANIFEST.name: sha(MANIFEST),
        'gates.json': hashlib.sha256(gate_bytes).hexdigest(), 'gate-evidence.json': hashlib.sha256(evidence_bytes).hexdigest()}

def upload(gate, hashes):
    remote('from pathlib import Path\nimport os\nos.umask(0o077)\np=Path(' + repr(REMOTE) + ')\nassert not p.exists() and not p.is_symlink()\nassert p.parent.resolve()==p.parent\np.mkdir(mode=0o700)\n')
    audit = Path(tempfile.mkdtemp(prefix='upload-gates-', dir=HERE))
    need(audit.resolve().parent == HERE.resolve() and not audit.is_symlink(), 'local_audit_path')
    gate_path = audit / 'gates.json'
    gate_path.write_bytes((json.dumps(gate, separators=(',', ':')) + '\n').encode('utf-8'))
    receipt_path = audit / 'gate-evidence.json'
    receipt_path.write_bytes((json.dumps(hashes, sort_keys=True) + '\n').encode('utf-8'))
    expected = expected_bundle(gate, hashes)
    paths = [*(HERE/name for name in FROZEN), ARCHIVE, MANIFEST, gate_path, receipt_path]
    transport(['scp', *SSH, *[path.as_posix() for path in paths], HOST + ':' + REMOTE + '/'])
    code = 'from pathlib import Path\nimport hashlib,json,os,stat\np=Path(' + repr(REMOTE) + ')\nexpected=' + repr(expected) + '\n'
    code += 'assert p.resolve()==p and stat.S_IMODE(p.stat().st_mode)==0o700\n'
    code += 'for name,checksum in expected.items():\n f=p/name\n m=f.lstat()\n assert stat.S_ISREG(m.st_mode) and m.st_nlink==1 and hashlib.sha256(f.read_bytes()).hexdigest()==checksum\n f.chmod(0o600)\n'
    code += "with (p/'upload-verified.json').open('x') as out: json.dump(expected,out,sort_keys=True)\n(p/'upload-verified.json').chmod(0o600)\n"
    remote(code)

def launch(phase, gate, hashes):
    args = ['python3', REMOTE + '/rollout.py', phase, '--run', RUN]
    if phase == 'prepare':
        args += ['--archive', REMOTE+'/'+ARCHIVE.name, '--manifest', REMOTE+'/'+MANIFEST.name,
            '--revision', REV, '--sha256', SHA, '--gates', REMOTE+'/gates.json']
    unit = 'telomere-private-staging-354fe7af62ea-launch02-' + phase + '.service'
    code = 'from pathlib import Path\nimport hashlib,json,stat,subprocess\np=Path(' + repr(REMOTE) + ')\n'
    code += 'assert p.resolve()==p and p.stat().st_uid==0 and stat.S_IMODE(p.stat().st_mode)==0o700\n'
    code += 'receipt=p/"upload-verified.json"\nm=receipt.lstat()\nassert stat.S_ISREG(m.st_mode) and m.st_nlink==1 and stat.S_IMODE(m.st_mode)==0o600 and m.st_size<=65536\n'
    code += "expected=json.loads((p/'upload-verified.json').read_text())\n"
    code += 'assert expected==' + repr(expected_bundle(gate, hashes)) + '\n'
    code += 'assert json.loads((p/"gate-evidence.json").read_text())==' + repr(hashes) + '\n'
    code += 'assert {k:expected[k] for k in ' + repr(list(FROZEN)) + '}==' + repr(FROZEN) + '\n'
    code += 'for name,checksum in expected.items():\n f=p/name\n m=f.lstat()\n assert stat.S_ISREG(m.st_mode) and m.st_nlink==1 and stat.S_IMODE(m.st_mode)==0o600 and hashlib.sha256(f.read_bytes()).hexdigest()==checksum\n'
    code += 'unit=' + repr(unit) + '\n'
    code += "assert subprocess.check_output(['systemctl','show',unit,'--property=LoadState','--value'],text=True).strip()=='not-found'\n"
    invocation = ['systemd-run', '--quiet', '--unit='+unit, '--property=User=root', '--property=UMask=0077',
        '--property=KillMode=control-group', '--property=TimeoutStopSec=30', '--property=Restart=no',
        '--property=StandardOutput=append:'+REMOTE+'/'+phase+'.private.log', '--property=StandardError=append:'+REMOTE+'/'+phase+'.private.log',
        '--working-directory='+REMOTE, *args]
    code += 'subprocess.run(' + repr(invocation) + ',stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)\n'
    # An independent unit survives SSH/client disconnection; this returns LAUNCHED, never completed.
    remote(code)

def status(phase):
    unit = 'telomere-private-staging-354fe7af62ea-launch02-' + phase + '.service'
    code = 'import json,subprocess\nunit=' + repr(unit) + '\n'
    code += "raw=subprocess.check_output(['systemctl','show',unit,'--property=ActiveState','--property=SubState','--property=Result','--property=ExecMainStatus','--property=MainPID'],text=True)\n"
    code += "out=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)\nprint(json.dumps(out,separators=(',',':')))\n"
    payload = json.loads(remote(code))
    need(set(payload) <= {'ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'MainPID'}, 'status_shape')
    return payload

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['check', 'upload', *PHASES, 'status'])
    parser.add_argument('--target', choices=PHASES)
    args = parser.parse_args()
    if args.phase == 'status':
        # Read-only recovery observation remains possible after local evidence moves or a launch acknowledgement is lost.
        need(args.target is not None, 'status_target_required')
        print(json.dumps({'status': 'read', 'phase': args.target, 'unit': status(args.target)})); return
    gate, hashes = gates()  # Before every mutating transport, directory creation or true gate-file write.
    if args.phase == 'upload': upload(gate, hashes)
    elif args.phase in PHASES: launch(args.phase, gate, hashes)
    print(json.dumps({'status': 'launched' if args.phase in PHASES else 'passed', 'phase': args.phase,
        'initialFullPassed': 2281, 'initialFullFailed': 1, 'initialFullSkipped': 19, 'composedSources': 685,
        'gvisorPassed': 16, 'selectionPassed': 40, 'additivePassed': 71, 'cleanFullPassClaimed': False,
        'automaticNextPhase': False, 'phaseCompletionClaimed': False}))

if __name__ == '__main__':
    phase = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ['check', 'upload', *PHASES, 'status'] else 'arguments'
    try:
        main()
    except Refused as error:
        print(json.dumps({'status': 'refused', 'phase': phase, 'reason': str(error)})); sys.exit(2)
    except BaseException:
        print(json.dumps({'status': 'refused', 'phase': phase, 'reason': 'evidence_or_transport_invalid'})); sys.exit(2)
