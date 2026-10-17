import asyncio, hashlib, json, os, pathlib, sys, time
root, destination = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / 'infra/near'))
import verifier as v
policy_path = pathlib.Path('/var/lib/enclave/releases/e1-20261001/acceptance-v6-20261004/accepted/provider-policy.json')
policy_raw = policy_path.read_bytes()
assert hashlib.sha256(policy_raw).hexdigest() == '75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa'
policy = v.parse_json(policy_raw)
config = {**policy['nvidiaVerifier'], 'binary': pathlib.Path('/opt/telomere-pilot/near-runtime/nvattest'),
    'library': pathlib.Path('/opt/telomere-pilot/near-runtime/libnvat.so.1.2.2')}
v.verify_nvat_files(config)
report = {'approval': 'UNAPPROVED', 'scope': 'captured_evidence_hardware_only', 'policyChanged': False,
    'paidInferencePosts': 0, 'newNearReportGets': 0, 'nativeArtifactHashesMatch': True, 'appraisals': {}, 'cpuResults': {}}
original_tdx = v.verify_tdx
async def record_tdx(value):
    result = await original_tdx(value)
    digest = hashlib.sha256(bytes.fromhex(value)).hexdigest()
    report['cpuResults'][digest] = {key: result[key] for key in ['status', 'advisory_ids', 'qe_status', 'platform_status'] if key in result}
    return result
v.verify_tdx = record_tdx
async def appraise():
    jobs = []
    cloud = destination / 'cloud/candidate-input.json'
    if cloud.is_file():
        packet = v.parse_json(cloud.read_bytes())
        attestation, nonce = packet['attestation'], packet['nonce']
        jobs.append(('gateway', v.inspect_gateway_report({'nonce': nonce, 'tlsSpkiSha256': packet['tlsSpkiSha256'],
            'gateway_attestation': attestation['gateway_attestation']})))
        for i, model in enumerate(attestation['model_attestations']):
            jobs.append(('cloud-model-' + str(i), v.inspect_evidence({'nonce': nonce,
                'tlsSpkiSha256': model['tls_cert_fingerprint'], 'attestation': model}, nvidia_local=config)))
    direct = destination / 'direct/candidate-input.json'
    if direct.is_file():
        jobs.append(('direct-model', v.inspect_evidence(v.parse_json(direct.read_bytes()), nvidia_local=config)))
    results = await asyncio.wait_for(asyncio.gather(*[job[1] for job in jobs], return_exceptions=True), 75)
    for (name, _), result in zip(jobs, results):
        if isinstance(result, Exception):
            report['appraisals'][name] = {'status': 'rejected', 'reasonCode': result.code if isinstance(result, v.VerificationError) else 'APPRAISAL_FAILED'}
        else:
            report['appraisals'][name] = {'status': 'hardware_checked', 'workloadApproved': False,
                **{key: result[key] for key in ['cpuStatus', 'gpuCount', 'gpuModels', 'appComposeSha256', 'composeManagerActionsSha256', 'quoteSha256'] if key in result}}
try: asyncio.run(appraise())
except asyncio.TimeoutError: report['failureCode'] = 'BOUNDED_APPRAISAL_TIMEOUT'
report['checkedAtEpoch'] = int(time.time())
with (destination / 'hardware-summary.json').open('x') as out: json.dump(report, out, indent=2); out.write('\n')
print(json.dumps(report))
