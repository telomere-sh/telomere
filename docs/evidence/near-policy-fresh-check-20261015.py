import hashlib, json, pathlib, sys, time
root = pathlib.Path('/opt/telomere-host-runtime/backend-current-20261015-3e901e235bb9')
destination = pathlib.Path('/opt/telomere-host-runtime/near-readonly-20261015-0300')
sys.path.insert(0, str(root / 'infra/near'))
import verifier as v
import dcap_qvl
policy_file = pathlib.Path('/var/lib/enclave/releases/e1-20261001/acceptance-v6-20261004/accepted/provider-policy.json')
policy_bytes = policy_file.read_bytes()
assert hashlib.sha256(policy_bytes).hexdigest() == '75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa'
policy = v.parse_json(policy_bytes)
report = {'approval': 'UNAPPROVED', 'paidInferencePosts': 0, 'newReportGets': 0,
    'policySha256': hashlib.sha256(policy_bytes).hexdigest(), 'validUntil': policy['validUntil'],
    'policyChanged': False, 'readOnlyOfflineComparison': True}
try:
    v.validate_policy(policy, int(time.time()))
    report['policyValidation'] = 'within_time_window'
except v.VerificationError as error: report['policyValidation'] = error.code
hardware = json.loads((destination / 'hardware-summary.json').read_bytes())
packet = v.parse_json((destination / 'direct/candidate-input.json').read_bytes())
a = packet['attestation']
digest = hashlib.sha256(bytes.fromhex(a['intel_quote'])).hexdigest()
assert hardware['cpuResults'][digest]['status'] == 'UpToDate'
assert hardware['appraisals']['direct-model']['status'] == 'hardware_checked'
assert hardware['appraisals']['direct-model']['composeManagerActionsSha256'] == v.digest(v.canonical(a['compose_manager_attestation']['actions']))
quote = dcap_qvl.parse_quote(bytes.fromhex(a['intel_quote']))
measurements = {name: bytes(getattr(quote.report, name)).hex() for name in v.MEASUREMENTS}
actions = hardware['appraisals']['direct-model']['composeManagerActionsSha256']
report['directProfiles'] = [{'profileIndex': i,
    'measurementDifferences': [name for name in measurements if measurements[name] != profile['measurements'][name]],
    'actionsHashMatches': profile['composeManagerActionsSha256'] == actions}
    for i, profile in enumerate(policy['profiles']) if profile['model'] == a['model_name']]
report['capturedQuoteSha256'] = digest
with (destination / 'policy-comparison.json').open('x') as out: json.dump(report, out, indent=2); out.write('\n')
print(json.dumps(report))
