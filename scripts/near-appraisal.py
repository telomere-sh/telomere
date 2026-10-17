"""Gateway evidence capture/replay only. Never authorizes a workload or calls inference.

capture: one official Intel PCS collateral-fetch invocation for a saved Cloud quote.
replay: no network; verify the archived quote/collateral at its recorded historical time.
All quote, report, collateral and native-verdict files are private; stdout is metadata only.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone

import dcap_qvl
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

STATUSES = {'UpToDate', 'OutOfDate', 'ConfigurationNeeded', 'OutOfDateConfigurationNeeded',
            'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded', 'Revoked'}
FILES = ('quote.bin', 'intel-collateral.json', 'native-verdict.json', 'gateway-evidence.json')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read(path, maximum=16777216):
    with Path(path).open('rb') as source:
        value = source.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError('File limit')
    return value

def parse(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)

def encode(value):
    return (json.dumps(value, indent=2) + '\n').encode()

def save(directory, name, value):
    data = value if isinstance(value, bytes) else encode(value)
    with os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())

def serialize_collateral(collateral):
    result = {}
    for name in dir(collateral):
        if name.startswith('_'):
            continue
        value = getattr(collateral, name)
        if callable(value):
            continue
        if isinstance(value, bytes):
            result[name] = {'hex': value.hex()}
        elif isinstance(value, str) or value is None:
            result[name] = value
        else:
            raise ValueError('Unsupported collateral')
    return result

def load_collateral(values):
    return dcap_qvl.QuoteCollateralV3(**{
        key: bytes.fromhex(value['hex']) if isinstance(value, dict) else value
        for key, value in values.items()
    })

def tcb_diagnostic(result):
    output = {}
    for scope, value in [('overall', result), ('qe', result.get('qe_status')), ('platform', result.get('platform_status'))]:
        valid = isinstance(value, dict) and value.get('status') in STATUSES
        advisories = value.get('advisory_ids') if isinstance(value, dict) else None
        valid = valid and isinstance(advisories, list) and len(advisories) <= 64 and all(
            isinstance(item, str) and re.fullmatch(r'INTEL-SA-[0-9]{5}', item) for item in advisories)
        if not valid:
            raise ValueError('Native verdict shape invalid')
        output[scope] = {'status': value['status'], 'advisory_ids': advisories}
    accepted = all(value['status'] == 'UpToDate' and value['advisory_ids'] == [] for value in output.values())
    classification = 'STRICT_TCB_ACCEPTED' if accepted else 'PLATFORM_TCB_OUT_OF_DATE' if output['platform']['status'] in (
        'OutOfDate', 'OutOfDateConfigurationNeeded') else 'TCB_STATUS_REJECTED' if any(
            value['status'] != 'UpToDate' for value in output.values()) else 'ADVISORIES_PRESENT'
    return output, accepted, classification

def binding_checks(evidence, result):
    # Cryptographic verdict fields are used for diagnostics even if strict TCB rejects them; no session is returned.
    report = result['report']['TD10']
    gateway = evidence['gateway_attestation']
    signer = bytes.fromhex(gateway['signing_address'].removeprefix('0x'))
    spki = evidence['tlsSpkiSha256']
    cert = x509.load_pem_x509_certificate(evidence['peerCertificatePem'].encode())
    observed = digest(cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo))
    tcb = gateway['info']['tcb_info']
    tcb = parse(tcb) if isinstance(tcb, str) else tcb
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'infra' / 'near'))
    from verifier import replay_rtmr3
    return {
        'nonceSignerSpkiBinding': report['report_data'] == digest(signer + bytes.fromhex(spki)) + evidence['nonce'],
        'echoedNonce': gateway['request_nonce'] == evidence['nonce'],
        'echoedSpki': gateway['tls_cert_fingerprint'] == spki,
        'recordedCertificateSpki': observed == spki,
        'appComposeMrconfig': report['mr_config_id'] == '01' + digest(tcb['app_compose'].encode()) + '00' * 15,
        'eventLogRtmr3': replay_rtmr3(gateway['event_log']) == report['rt_mr3'],
        'debugBitClear': int.from_bytes(bytes.fromhex(report['td_attributes']), 'little') & 1 == 0,
    }

def replay(quote, collateral_values, at):
    collateral = load_collateral(collateral_values)
    result = parse(dcap_qvl.verify(quote, collateral, at).to_json())
    tampered = bytearray(quote)
    tampered[120] ^= 1
    quote_rejected = False
    try:
        dcap_qvl.verify(bytes(tampered), collateral, at)
    except Exception:
        quote_rejected = True
    bad = dict(collateral_values)
    signature = bytearray.fromhex(bad['tcb_info_signature']['hex'])
    signature[0] ^= 1
    bad['tcb_info_signature'] = {'hex': signature.hex()}
    collateral_rejected = False
    try:
        dcap_qvl.verify(quote, load_collateral(bad), at)
    except Exception:
        collateral_rejected = True
    return result, quote_rejected, collateral_rejected

async def capture(packet, destination):
    data = parse(read(packet / 'candidate-input.json'))
    metadata = parse(read(packet / 'connection-request.json', 1048576))
    gateway = data['attestation']['gateway_attestation']
    quote = bytes.fromhex(gateway['intel_quote'])
    if not 1000 <= len(quote) <= 65536:
        raise ValueError('Quote limit')
    collateral = await asyncio.wait_for(dcap_qvl.get_collateral_from_pcs(quote), 40)
    at = int(time.time())
    native = parse(dcap_qvl.verify(quote, collateral, at).to_json())
    values = serialize_collateral(collateral)
    offline, quote_rejected, collateral_rejected = replay(quote, values, at)
    evidence = {'nonce': data['nonce'], 'tlsSpkiSha256': data['tlsSpkiSha256'], 'gateway_attestation': gateway,
                'peerCertificatePem': metadata['peerCertificatePem']}
    statuses, accepted, classification = tcb_diagnostic(native)
    destination.mkdir(mode=0o700)
    for name, value in zip(FILES, (quote, values, native, evidence)):
        save(destination, name, value)
    files = [{'name': name, 'sha256': digest(read(destination / name)), 'bytes': (destination / name).stat().st_size} for name in FILES]
    summary = {'schemaVersion': 1, 'mode': 'capture', 'scope': 'captured_gateway_evidence', 'approval': 'UNAPPROVED',
               'liveAdmission': False, 'verifiedAt': at, 'checkedAt': datetime.now(timezone.utc).isoformat(),
               'nativeTcb': statuses, 'strictTcbAccepted': accepted, 'classification': classification,
               'bindingChecks': binding_checks(evidence, native), 'offlineReplayMatches': offline == native,
               'tamperedQuoteRejectedOffline': quote_rejected, 'tamperedCollateralRejectedOffline': collateral_rejected,
               'intelCollateralFetchInvocations': 1, 'newNearReportGets': 0, 'inferencePosts': 0, 'files': files}
    save(destination, 'summary.json', summary)
    return summary

def replay_archive(directory):
    manifest = parse(read(directory / 'summary.json', 1048576))
    if manifest['schemaVersion'] != 1 or manifest['approval'] != 'UNAPPROVED' or manifest['liveAdmission'] is not False:
        raise ValueError('Archive schema')
    at = manifest['verifiedAt']
    if type(at) is not int or not 0 < at <= int(time.time()) + 30:
        raise ValueError('Archive time')
    if set(item['name'] for item in manifest['files']) != set(FILES) or len(manifest['files']) != len(FILES):
        raise ValueError('Archive files')
    for item in manifest['files']:
        value = read(directory / item['name'])
        if len(value) != item['bytes'] or digest(value) != item['sha256']:
            raise ValueError('Archive hash')
    quote = read(directory / 'quote.bin', 65536)
    values = parse(read(directory / 'intel-collateral.json', 1048576))
    original = parse(read(directory / 'native-verdict.json', 1048576))
    evidence = parse(read(directory / 'gateway-evidence.json'))
    result, quote_rejected, collateral_rejected = replay(quote, values, at)
    statuses, accepted, classification = tcb_diagnostic(result)
    return {**manifest, 'mode': 'replay', 'scope': 'historical_gateway_evidence', 'checkedAt': datetime.now(timezone.utc).isoformat(),
            'nativeTcb': statuses, 'strictTcbAccepted': accepted, 'classification': classification,
            'bindingChecks': binding_checks(evidence, result), 'offlineReplayMatches': result == original,
            'tamperedQuoteRejectedOffline': quote_rejected, 'tamperedCollateralRejectedOffline': collateral_rejected,
            'intelCollateralFetchInvocations': 0, 'newNearReportGets': 0, 'inferencePosts': 0}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['capture', 'replay'])
    parser.add_argument('--packet')
    parser.add_argument('--output')
    parser.add_argument('--archive')
    args = parser.parse_args()
    try:
        if args.mode == 'capture':
            packet, destination = Path(args.packet), Path(args.output)
            if not packet.is_absolute() or not destination.is_absolute() or destination.exists():
                raise ValueError('New absolute private archive required')
            summary = asyncio.run(asyncio.wait_for(capture(packet, destination), 50))
        else:
            archive = Path(args.archive)
            if not archive.is_absolute():
                raise ValueError('Absolute archive required')
            summary = replay_archive(archive)
        print(json.dumps(summary))
    except Exception:
        print(json.dumps({'status': 'appraisal_failed', 'reasonCode': 'PRIVATE_ARCHIVE_OR_APPRAISAL_FAILED',
                          'approval': 'UNAPPROVED', 'liveAdmission': False, 'inferencePosts': 0, 'newNearReportGets': 0}))
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
