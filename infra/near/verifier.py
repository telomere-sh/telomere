"""Enforcement for NEAR's ECDSA + SPKI report format; no inference or credentials.

Intel quote signatures/collateral use dcap-qvl's compiled Rust verifier and pinned
Intel root. NVIDIA uses signed NRAS results by default, or an explicitly reviewed
and pinned local NVAT implementation that re-verifies raw evidence/collateral.
Hardware validity and authorization of the measured workload are separate steps.
"""
import asyncio
import hashlib
import json
import os
import re
import struct
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import dcap_qvl
import jwt
import requests

MAX_DOCUMENT_BYTES = 2_000_000
NRAS_ORIGIN = "https://nras.attestation.nvidia.com"
NVAT_VERSION = "1.2.2"
NVAT_BINARY_SHA256 = "ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6"
NVAT_LIBRARY_SHA256 = "088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24"
NVAT_TIMEOUT_SECONDS = 180
NVAT_TRUE_CLAIMS = (
    "x-nvidia-gpu-arch-check", "x-nvidia-gpu-attestation-report-cert-chain-fwid-match",
    "x-nvidia-gpu-attestation-report-parsed", "x-nvidia-gpu-attestation-report-nonce-match",
    "x-nvidia-gpu-attestation-report-signature-verified", "x-nvidia-gpu-driver-rim-fetched",
    "x-nvidia-gpu-driver-rim-signature-verified", "x-nvidia-gpu-driver-rim-version-match",
    "x-nvidia-gpu-driver-rim-measurements-available", "x-nvidia-gpu-vbios-rim-fetched",
    "x-nvidia-gpu-vbios-rim-version-match", "x-nvidia-gpu-vbios-rim-signature-verified",
    "x-nvidia-gpu-vbios-rim-measurements-available", "x-nvidia-gpu-vbios-index-no-conflict",
)
NVAT_CERT_CLAIMS = (
    "x-nvidia-gpu-attestation-report-cert-chain", "x-nvidia-gpu-driver-rim-cert-chain",
    "x-nvidia-gpu-vbios-rim-cert-chain",
)
MEASUREMENTS = {
    "tee_tcb_svn": 16, "mr_seam": 48, "mr_signer_seam": 48,
    "seam_attributes": 8, "td_attributes": 8, "xfam": 8,
    "mr_td": 48, "mr_config_id": 48, "mr_owner": 48,
    "mr_owner_config": 48, "rt_mr0": 48, "rt_mr1": 48,
    "rt_mr2": 48, "rt_mr3": 48,
}
GPU_TRUE_CLAIMS = (
    "secboot", "x-nvidia-gpu-attestation-report-cert-chain-validated",
    "x-nvidia-gpu-attestation-report-signature-verified",
    "x-nvidia-gpu-attestation-report-nonce-match",
    "x-nvidia-gpu-attestation-report-parsed", "x-nvidia-gpu-arch-check",
    "x-nvidia-gpu-driver-rim-schema-validated",
    "x-nvidia-gpu-driver-rim-signature-verified", "x-nvidia-gpu-driver-rim-fetched",
    "x-nvidia-gpu-driver-rim-cert-validated",
    "x-nvidia-gpu-driver-rim-measurements-available",
    "x-nvidia-gpu-vbios-rim-schema-validated",
    "x-nvidia-gpu-vbios-rim-signature-verified", "x-nvidia-gpu-vbios-rim-fetched",
    "x-nvidia-gpu-vbios-rim-cert-validated",
    "x-nvidia-gpu-vbios-rim-measurements-available",
    "x-nvidia-gpu-vbios-index-no-conflict",
)


class VerificationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def parse_json(raw):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "INPUT_INVALID")
            result[key] = value
        return result

    def invalid_constant(_):
        raise VerificationError("INPUT_INVALID")

    try:
        return json.loads(raw, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError) as error:
        raise VerificationError("INPUT_INVALID") from error


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def hex_bytes(value, size, code="INPUT_INVALID"):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{%d}" % (size * 2), value), code)
    return bytes.fromhex(value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp(value):
    try:
        require(isinstance(value, str) and value.endswith("Z"), "POLICY_INVALID")
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError) as error:
        raise VerificationError("POLICY_INVALID") from error


def validate_policy(policy, now):
    require(isinstance(policy, dict) and policy.get("schemaVersion") == 1, "POLICY_INVALID")
    require(isinstance(policy.get("version"), str) and 1 <= len(policy["version"]) <= 128, "POLICY_INVALID")
    nvidia = policy.get("nvidiaVerifier")
    if nvidia is not None:
        require(isinstance(nvidia, dict), "POLICY_INVALID")
        if nvidia.get("mode") == "nras":
            require(set(nvidia) == {"mode"}, "POLICY_INVALID")
        else:
            require(nvidia == {"mode": "local", "sdkVersion": NVAT_VERSION,
                              "binarySha256": NVAT_BINARY_SHA256,
                              "librarySha256": NVAT_LIBRARY_SHA256}, "POLICY_INVALID")
    start, end = timestamp(policy.get("validFrom")), timestamp(policy.get("validUntil"))
    require(start <= now < end, "POLICY_EXPIRED")
    session = policy.get("maxSessionSeconds")
    require(type(session) is int and 1 <= session <= 300, "POLICY_INVALID")
    profiles = policy.get("profiles")
    require(isinstance(profiles, list) and 1 <= len(profiles) <= 32, "POLICY_INVALID")
    for profile in profiles:
        require(isinstance(profile, dict), "POLICY_INVALID")
        require(isinstance(profile.get("model"), str) and profile["model"], "POLICY_INVALID")
        hex_bytes(profile.get("appComposeSha256"), 32, "POLICY_INVALID")
        hex_bytes(profile.get("composeManagerActionsSha256"), 32, "POLICY_INVALID")
        require(isinstance(profile.get("composeManagerImage"), str)
                and re.fullmatch(r"nearaidev/compose-manager@sha256:[0-9a-f]{64}", profile["composeManagerImage"]), "POLICY_INVALID")
        measurements = profile.get("measurements")
        require(isinstance(measurements, dict) and set(measurements) == set(MEASUREMENTS), "POLICY_INVALID")
        for key, size in MEASUREMENTS.items():
            hex_bytes(measurements[key], size, "POLICY_INVALID")
        require(type(profile.get("gpuCount")) is int and 1 <= profile["gpuCount"] <= 32, "POLICY_INVALID")
        require(isinstance(profile.get("gpuModels"), list) and profile["gpuModels"]
                and all(isinstance(model, str) and model for model in profile["gpuModels"]), "POLICY_INVALID")
    return end, session


def nvidia_local_config(policy):
    """Only protected process configuration can select a reviewed implementation."""
    mode = os.environ.get("NVIDIA_VERIFIER_MODE", "nras")
    reviewed = policy.get("nvidiaVerifier", {"mode": "nras"})
    require(isinstance(reviewed, dict), "POLICY_INVALID")
    require(mode in ("nras", "local") and reviewed.get("mode") == mode,
            "NVIDIA_VERIFIER_MISMATCH")
    if mode == "nras":
        return None
    paths = []
    for name in ("NVIDIA_NVAT_BINARY", "NVIDIA_NVAT_LIBRARY"):
        value = os.environ.get(name)
        require(isinstance(value, str) and 1 <= len(value) <= 4096
                and "\x00" not in value and Path(value).is_absolute(),
                "NVIDIA_LOCAL_CONFIG_INVALID")
        paths.append(Path(value))
    # The loader parses ':' as a list separator and expands '$ORIGIN' tokens.
    # It must receive one canonical directory, never a loader expression.
    require(not any(token in str(paths[1].parent) for token in (":", "$")),
            "NVIDIA_LOCAL_CONFIG_INVALID")
    try:
        paths = [path.resolve(strict=True) for path in paths]
    except (OSError, RuntimeError) as error:
        raise VerificationError("NVIDIA_LOCAL_CONFIG_INVALID") from error
    require(not any(token in str(paths[1].parent) for token in (":", "$")),
            "NVIDIA_LOCAL_CONFIG_INVALID")
    return {**reviewed, "binary": paths[0], "library": paths[1]}


def verify_nvat_files(config):
    """Check both the reviewed library and the soname actually used by the loader."""
    try:
        binary, library = config["binary"], config["library"]
        candidates = ((binary, config["binarySha256"], 2_000_000),
                      (library, config["librarySha256"], 32_000_000),
                      (library.parent / "libnvat.so.1", config["librarySha256"], 32_000_000))
        for path, expected, limit in candidates:
            require(path.is_file() and path.stat().st_size <= limit,
                    "NVIDIA_IMPLEMENTATION_CHANGED")
            with path.open("rb") as source:
                value = source.read(limit + 1)
            require(len(value) <= limit and digest(value) == expected,
                    "NVIDIA_IMPLEMENTATION_CHANGED")
    except VerificationError:
        raise
    except (OSError, ValueError) as error:
        raise VerificationError("NVIDIA_IMPLEMENTATION_CHANGED") from error


def nvat_artifact(payload, config):
    # Local EATs/claims are not NVIDIA-issued signed evidence. Commit the raw
    # SPDM/certificate inputs and implementation, and verify them anew on replay.
    return {"format": "nvat-local-v1", "sdkVersion": config["sdkVersion"],
            "binarySha256": config["binarySha256"],
            "librarySha256": config["librarySha256"], "payload": payload}


def verify_nvat_claims(output, nonce, gpu_count, now):
    require(isinstance(output, dict) and type(output.get("result_code")) is int
            and output["result_code"] == 0, "NVIDIA_RESULT_REJECTED")
    claims = output.get("claims")
    require(isinstance(claims, list) and len(claims) == gpu_count,
            "NVIDIA_GPU_SET_INVALID")
    devices, ueids = [], set()
    for claim in claims:
        require(isinstance(claim, dict) and claim.get("x-nvidia-device-type") == "gpu"
                and claim.get("x-nvidia-gpu-claims-version") == "3.0"
                and claim.get("measres") == "success" and claim.get("secboot") is True
                and claim.get("dbgstat") == "disabled"
                and all(claim.get(key) is True for key in NVAT_TRUE_CLAIMS)
                and claim.get("x-nvidia-mismatch-measurement-records") is None
                and "x-nvidia-mismatch-measurement-records" in claim
                and claim.get("x-nvidia-attestation-warning") is None,
                "NVIDIA_GPU_REJECTED")
        require(hex_bytes(claim.get("eat_nonce"), 32, "NVIDIA_NONCE_INVALID") == nonce,
                "NVIDIA_NONCE_INVALID")
        for key in NVAT_CERT_CLAIMS:
            cert = claim.get(key)
            require(isinstance(cert, dict) and cert.get("x-nvidia-cert-status") == "valid"
                    and cert.get("x-nvidia-cert-ocsp-status") == "good"
                    and cert.get("x-nvidia-cert-ocsp-nonce-matches") is True
                    and cert.get("x-nvidia-cert-ocsp-response-valid") is True
                    and "x-nvidia-cert-revocation-reason" in cert
                    and cert["x-nvidia-cert-revocation-reason"] is None,
                    "NVIDIA_GPU_REJECTED")
            try:
                expiry = timestamp(cert.get("x-nvidia-cert-expiration-date"))
                require(expiry >= now + 300, "NVIDIA_TIME_INVALID")
            except VerificationError as error:
                raise VerificationError("NVIDIA_TIME_INVALID") from error
        ueid, model = claim.get("ueid"), claim.get("hwmodel")
        require(isinstance(ueid, str) and 1 <= len(ueid) <= 1024 and ueid not in ueids,
                "NVIDIA_GPU_SET_INVALID")
        require(isinstance(model, str) and 1 <= len(model) <= 256, "NVIDIA_GPU_REJECTED")
        ueids.add(ueid)
        devices.append(model)
    return devices


async def verify_nvidia_local(payload, nonce, config):
    entries = payload["evidence_list"]
    for item in entries:
        require(set(item) == {"arch", "nonce", "certificate", "evidence"}
                and item["arch"] == payload["arch"], "NVIDIA_INVALID")
        require(hex_bytes(item["nonce"], 32, "NVIDIA_NONCE_INVALID") == nonce,
                "NVIDIA_NONCE_INVALID")
    verify_nvat_files(config)
    process, tasks, aggregate = None, [], None
    try:
        with tempfile.TemporaryDirectory(prefix="enclave-nvat-") as folder:
            evidence_file = Path(folder) / "evidence.json"
            evidence_file.write_bytes(canonical(entries))
            # Ignore proxy, service URL, credential, preload and test overrides.
            # NVAT's default HTTP options verify the peer and CA chain. No custom
            # relying-party Rego is supplied: it could override overall failure.
            environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                           "LD_LIBRARY_PATH": str(config["library"].parent)}
            process = await asyncio.create_subprocess_exec(
                str(config["binary"]), "attest", "--device", "gpu", "--verifier", "local",
                "--gpu-evidence-source", "file", "--gpu-evidence-file", str(evidence_file),
                "--nonce", nonce.hex(), "--rim-store", "remote",
                "--rim-url", "https://rim.attestation.nvidia.com",
                "--ocsp-url", "https://ocsp.ndis.nvidia.com",
                "--verify-rim-signatures", "--verify-rim-cert-chain",
                "--format", "json", "--log-level", "off",
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=environment)
            consumed = [0]

            async def bounded_read(stream, retain):
                result = bytearray()
                while True:
                    chunk = await stream.read(16384)
                    if not chunk:
                        return bytes(result)
                    consumed[0] += len(chunk)
                    require(consumed[0] <= MAX_DOCUMENT_BYTES, "NVIDIA_LOCAL_OUTPUT_INVALID")
                    if retain:
                        result.extend(chunk)

            tasks = [asyncio.create_task(bounded_read(process.stdout, True)),
                     asyncio.create_task(bounded_read(process.stderr, False)),
                     asyncio.create_task(process.wait())]
            aggregate = asyncio.gather(*tasks)
            stdout, _, exit_code = await asyncio.wait_for(aggregate, NVAT_TIMEOUT_SECONDS)
            verify_nvat_files(config)
            require(exit_code == 0, "NVIDIA_RESULT_REJECTED")
            try:
                output = parse_json(stdout)
            except VerificationError as error:
                raise VerificationError("NVIDIA_LOCAL_OUTPUT_INVALID") from error
            return verify_nvat_claims(output, nonce, len(entries), int(time.time()))
    except asyncio.TimeoutError as error:
        raise VerificationError("NVIDIA_LOCAL_TIMEOUT") from error
    except VerificationError:
        raise
    except (OSError, ValueError) as error:
        raise VerificationError("NVIDIA_LOCAL_UNAVAILABLE") from error
    finally:
        if process is not None and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if aggregate is not None:
            # wait_for can finish cancellation before the original gathering
            # future receives its children's CancelledError. Consuming only the
            # individual tasks leaves that aggregate exception unobserved.
            await asyncio.gather(aggregate, return_exceptions=True)
        if process is not None and process.returncode is None:
            # Drain pipes after termination; waiting with unread PIPE buffers
            # alone can deadlock when the output bound triggered the failure.
            try:
                await asyncio.wait_for(process.communicate(), 5)
            except (asyncio.TimeoutError, OSError):
                pass


async def verify_tdx(quote_hex):
    require(isinstance(quote_hex, str) and 1000 <= len(quote_hex) <= 131072
            and len(quote_hex) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]+", quote_hex), "CPU_INVALID")
    try:
        result = await asyncio.wait_for(dcap_qvl.get_collateral_and_verify(bytes.fromhex(quote_hex)), 45)
        return parse_json(result.to_json())
    except Exception as error:
        raise VerificationError("CPU_VERIFICATION_FAILED") from error


def cpu_claims(result):
    require(isinstance(result, dict), "CPU_INVALID")
    for item in (result, result.get("qe_status"), result.get("platform_status")):
        require(isinstance(item, dict) and item.get("status") == "UpToDate"
                and item.get("advisory_ids") == [], "CPU_TCB_REJECTED")
    report = result.get("report")
    # Formats with a different measured-report schema need explicit implementation.
    require(isinstance(report, dict) and set(report) == {"TD10"}, "CPU_TYPE_REJECTED")
    td = report["TD10"]
    require(isinstance(td, dict), "CPU_INVALID")
    for key, size in MEASUREMENTS.items():
        hex_bytes(td.get(key), size, "CPU_INVALID")
    require(int.from_bytes(hex_bytes(td["td_attributes"], 8), "little") & 1 == 0, "CPU_DEBUG_REJECTED")
    hex_bytes(td.get("report_data"), 64, "CPU_INVALID")
    hex_bytes(result.get("ppid"), 16, "CPU_INVALID")
    return {key: td[key].lower() for key in (*MEASUREMENTS, "report_data")}


def replay_rtmr3(event_log):
    """Recompute the measured RTMR3 events; unmeasured HTTP text is not trusted."""
    events = parse_json(event_log) if isinstance(event_log, str) else event_log
    require(isinstance(events, list) and 1 <= len(events) <= 10000, "GATEWAY_EVENT_LOG_INVALID")
    state = bytes(48)
    measured = 0
    for entry in events:
        require(isinstance(entry, dict) and type(entry.get("imr")) is int,
                "GATEWAY_EVENT_LOG_INVALID")
        if entry["imr"] != 3:
            continue
        event_type = entry.get("event_type")
        event = entry.get("event")
        payload = entry.get("event_payload")
        require(type(event_type) is int and 0 <= event_type <= 0xffffffff
                and isinstance(event, str) and isinstance(payload, str), "GATEWAY_EVENT_LOG_INVALID")
        require(len(event.encode("utf-8")) <= 65536 and len(payload) <= 131072
                and len(payload) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]*", payload),
                "GATEWAY_EVENT_LOG_INVALID")
        event_digest = hashlib.sha384(struct.pack("<I", event_type) + b":"
                                      + event.encode("utf-8") + b":" + bytes.fromhex(payload)).digest()
        declared = entry.get("digest", "")
        require(declared == "" or hex_bytes(declared, 48, "GATEWAY_EVENT_LOG_INVALID") == event_digest,
                "GATEWAY_EVENT_LOG_INVALID")
        state = hashlib.sha384(state + event_digest).digest()
        measured += 1
    require(measured > 0, "GATEWAY_EVENT_LOG_INVALID")
    return state.hex()


async def inspect_gateway_report(document):
    """Verify gateway hardware and TLS facts; this does not approve its measurements."""
    require(isinstance(document, dict), "INPUT_INVALID")
    nonce = hex_bytes(document.get("nonce"), 32)
    spki = hex_bytes(document.get("tlsSpkiSha256"), 32)
    gateway = document.get("gateway_attestation")
    require(isinstance(gateway, dict), "GATEWAY_EVIDENCE_MISSING")
    require(gateway.get("signing_algo") == "ecdsa", "SIGNING_ALGORITHM_REJECTED")
    identity = gateway.get("signing_address")
    require(isinstance(identity, str) and identity.startswith("0x"), "GATEWAY_SIGNER_INVALID")
    signer = hex_bytes(identity[2:], 20, "GATEWAY_SIGNER_INVALID")
    require(hex_bytes(gateway.get("request_nonce"), 32, "NONCE_MISMATCH") == nonce,
            "NONCE_MISMATCH")
    require(hex_bytes(gateway.get("tls_cert_fingerprint"), 32, "TLS_BINDING_MISMATCH") == spki,
            "TLS_BINDING_MISMATCH")
    result = await verify_tdx(gateway.get("intel_quote"))
    claims = cpu_claims(result)
    expected_report_data = hashlib.sha256(signer + spki).hexdigest() + nonce.hex()
    require(claims["report_data"] == expected_report_data, "CPU_BINDING_MISMATCH")
    require(hex_bytes(gateway.get("report_data"), 64, "CPU_BINDING_MISMATCH").hex()
            == claims["report_data"], "CPU_BINDING_MISMATCH")
    require(replay_rtmr3(gateway.get("event_log")) == claims["rt_mr3"],
            "GATEWAY_EVENT_LOG_MISMATCH")
    info = gateway.get("info")
    require(isinstance(info, dict), "GATEWAY_EVIDENCE_MISSING")
    tcb = info.get("tcb_info")
    tcb = parse_json(tcb) if isinstance(tcb, str) else tcb
    require(isinstance(tcb, dict) and isinstance(tcb.get("app_compose"), str),
            "GATEWAY_EVIDENCE_MISSING")
    app_hash = hashlib.sha256(tcb["app_compose"].encode("utf-8")).hexdigest()
    require(claims["mr_config_id"] == "01" + app_hash + "00" * 15,
            "GATEWAY_COMPOSE_MISMATCH")
    return {"signingAddress": identity.lower(), "tlsSpkiSha256": spki.hex(),
            "measurements": {key: claims[key] for key in MEASUREMENTS},
            "appComposeSha256": app_hash, "quoteSha256": digest(bytes.fromhex(gateway["intel_quote"]))}


def validate_gateway_policy(policy, now):
    require(isinstance(policy, dict) and policy.get("schemaVersion") == 1, "POLICY_INVALID")
    require(isinstance(policy.get("version"), str) and 1 <= len(policy["version"]) <= 128,
            "POLICY_INVALID")
    start, end = timestamp(policy.get("validFrom")), timestamp(policy.get("validUntil"))
    require(start <= now < end, "POLICY_EXPIRED")
    session = policy.get("maxSessionSeconds")
    require(type(session) is int and 1 <= session <= 300, "POLICY_INVALID")
    profiles = policy.get("gatewayProfiles")
    require(isinstance(profiles, list) and 1 <= len(profiles) <= 32, "POLICY_INVALID")
    for profile in profiles:
        require(isinstance(profile, dict), "POLICY_INVALID")
        hex_bytes(profile.get("appComposeSha256"), 32, "POLICY_INVALID")
        measurements = profile.get("measurements")
        require(isinstance(measurements, dict) and set(measurements) == set(MEASUREMENTS),
                "POLICY_INVALID")
        for key, size in MEASUREMENTS.items():
            hex_bytes(measurements[key], size, "POLICY_INVALID")
    return end, session, profiles


def gateway_verdict(document, policy, facts, now):
    end, session, profiles = validate_gateway_policy(policy, now)
    require(any(facts["appComposeSha256"] == profile["appComposeSha256"].lower()
                and facts["measurements"] == {key: value.lower() for key, value in profile["measurements"].items()}
                for profile in profiles), "GATEWAY_POLICY_MISMATCH")
    reference = "0x" + digest(canonical({"quoteSha256": facts["quoteSha256"],
                                     "nonce": document["nonce"].lower(),
                                     "tlsSpkiSha256": facts["tlsSpkiSha256"],
                                     "policyVersion": policy["version"]}))
    return {"ok": True, "signingAddress": facts["signingAddress"],
            "tlsSpkiSha256": facts["tlsSpkiSha256"], "attestationRef": reference,
            "verifiedAt": iso(now), "expiresAt": iso(min(end, now + session)),
            "policyVersion": policy["version"]}


async def verify_gateway(document, policy):
    """Authorize an independently verified gateway against one reviewed measurement profile."""
    now = time.time()
    validate_gateway_policy(policy, now)
    facts = await inspect_gateway_report(document)
    return gateway_verdict(document, policy, facts, now)


def http_json(method, url, payload=None):
    # No caller-controlled URLs, proxy environment, netrc credentials, or redirects.
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.request(method, url, json=payload, timeout=(10, 40),
                                 allow_redirects=False, stream=True) as response:
                require(response.status_code == 200, "NVIDIA_UNAVAILABLE")
                data = bytearray()
                for chunk in response.iter_content(16384):
                    data.extend(chunk)
                    require(len(data) <= MAX_DOCUMENT_BYTES, "NVIDIA_INVALID")
                return parse_json(bytes(data))
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("NVIDIA_UNAVAILABLE") from error


def decode_nvidia(token, jwks, nonce, now):
    require(isinstance(token, str) and 1 <= len(token) <= 65536, "NVIDIA_INVALID")
    try:
        header = jwt.get_unverified_header(token)
        require(header.get("alg") == "ES384" and not any(k in header for k in ("jku", "x5u", "jwk", "crit")), "NVIDIA_SIGNATURE_INVALID")
        require(isinstance(header.get("kid"), str), "NVIDIA_SIGNATURE_INVALID")
        keys = [key for key in jwks["keys"] if key.get("kid") == header["kid"]]
        require(len(keys) == 1, "NVIDIA_SIGNATURE_INVALID")
        key = keys[0]
        require(key.get("kty") == "EC" and key.get("crv") == "P-384"
                and key.get("alg", "ES384") == "ES384" and key.get("use", "sig") == "sig", "NVIDIA_SIGNATURE_INVALID")
        # Validate time below against one trusted verification timestamp. Signature,
        # issuer, and lack of unsolicited audience are verified by PyJWT.
        claims = jwt.decode(token, jwt.PyJWK.from_dict(key).key, algorithms=["ES384"],
                            issuer=NRAS_ORIGIN, options={"verify_exp": False,
                            "verify_iat": False, "verify_nbf": False,
                            "require": ["iss", "exp", "iat", "nbf", "eat_nonce"]})
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("NVIDIA_SIGNATURE_INVALID") from error
    require(all(type(claims.get(k)) is int for k in ("iat", "nbf", "exp")), "NVIDIA_TIME_INVALID")
    require(claims["iat"] <= now + 5 and now - claims["iat"] <= 300
            and claims["nbf"] <= now + 5 and now < claims["exp"]
            and claims["iat"] <= claims["exp"], "NVIDIA_TIME_INVALID")
    require(hex_bytes(claims.get("eat_nonce"), 32, "NVIDIA_NONCE_INVALID") == nonce, "NVIDIA_NONCE_INVALID")
    return claims


def verify_nvidia_tokens(bundle, jwks, nonce, gpu_count, now):
    require(isinstance(bundle, list) and len(bundle) == 2 and isinstance(bundle[0], list)
            and len(bundle[0]) == 2 and bundle[0][0] == "JWT"
            and isinstance(bundle[1], dict), "NVIDIA_INVALID")
    require(isinstance(jwks, dict) and isinstance(jwks.get("keys"), list), "NVIDIA_INVALID")
    overall = decode_nvidia(bundle[0][1], jwks, nonce, now)
    require(overall.get("x-nvidia-ver") == "2.0"
            and overall.get("x-nvidia-overall-att-result") is True, "NVIDIA_RESULT_REJECTED")
    expected = {f"GPU-{n}" for n in range(gpu_count)}
    submods = overall.get("submods")
    require(isinstance(submods, dict) and set(submods) == expected
            and set(bundle[1]) == expected, "NVIDIA_GPU_SET_INVALID")
    devices, expirations, ueids = [], [overall["exp"]], set()
    for name in sorted(expected):
        token = bundle[1][name]
        require(isinstance(token, str), "NVIDIA_INVALID")
        require(submods[name] == ["DIGEST", ["SHA-256", digest(token.encode("ascii"))]], "NVIDIA_GPU_BINDING_INVALID")
        claims = decode_nvidia(token, jwks, nonce, now)
        require(claims.get("measres") == "success" and claims.get("dbgstat") == "disabled"
                and all(claims.get(key) is True for key in GPU_TRUE_CLAIMS)
                and claims.get("x-nvidia-attestation-warning") is None, "NVIDIA_GPU_REJECTED")
        ueid = claims.get("ueid")
        require(isinstance(ueid, str) and ueid and ueid not in ueids, "NVIDIA_GPU_SET_INVALID")
        ueids.add(ueid)
        require(isinstance(claims.get("hwmodel"), str) and claims["hwmodel"], "NVIDIA_GPU_REJECTED")
        devices.append(claims["hwmodel"])
        expirations.append(claims["exp"])
    return devices, min(expirations)


def action_value(value):
    # serde_json's canonical maps used by compose-manager; reject numeric values
    # rather than introducing Python/Rust floating-point serialization ambiguity.
    if isinstance(value, str) or value is None or type(value) is bool:
        return True
    if isinstance(value, list):
        return all(action_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and action_value(item) for key, item in value.items())
    return False


async def inspect_evidence(document, *, archived_bundle=None, verification_time=None,
                           trusted_jwks=None, nvidia_local=None):
    """Real crypto verification only; does NOT authorize a workload or return ok."""
    require(isinstance(document, dict), "INPUT_INVALID")
    nonce = hex_bytes(document.get("nonce"), 32)
    spki = hex_bytes(document.get("tlsSpkiSha256"), 32)
    a = document.get("attestation")
    require(isinstance(a, dict), "INPUT_INVALID")
    require(hex_bytes(a.get("request_nonce"), 32) == nonce, "NONCE_MISMATCH")
    require(a.get("signing_algo") == "ecdsa", "SIGNING_ALGORITHM_REJECTED")
    address = a.get("signing_address")
    require(isinstance(address, str) and address.startswith("0x"), "INPUT_INVALID")
    signer = hex_bytes(address[2:], 20)
    require(hex_bytes(a.get("tls_cert_fingerprint"), 32) == spki, "TLS_BINDING_MISMATCH")
    require(isinstance(a.get("model_name"), str) and a["model_name"], "INPUT_INVALID")
    cm = a.get("compose_manager_attestation")
    require(isinstance(cm, dict), "WORKLOAD_EVIDENCE_MISSING")
    main_result, cm_result = await asyncio.gather(verify_tdx(a.get("intel_quote")), verify_tdx(cm.get("quote")))
    main, manager = cpu_claims(main_result), cpu_claims(cm_result)
    require(main["report_data"] == digest(signer + spki) + nonce.hex(), "CPU_BINDING_MISMATCH")
    if "event_log" in a:
        require(replay_rtmr3(a["event_log"]) == main["rt_mr3"],
                "MODEL_EVENT_LOG_MISMATCH")
    require(main_result["ppid"] == cm_result["ppid"]
            and all(main[k] == manager[k] for k in MEASUREMENTS), "WORKLOAD_VM_MISMATCH")
    actions = cm.get("actions")
    require(isinstance(actions, list) and 1 <= len(actions) <= 10000
            and all(isinstance(action, dict) for action in actions) and action_value(actions), "WORKLOAD_ACTIONS_INVALID")
    actions_hash = digest(canonical(actions))
    starts = [action for action in actions if action.get("action") == "compose_manager_started"]
    require(starts and isinstance(starts[-1].get("image"), str)
            and re.fullmatch(r"nearaidev/compose-manager@sha256:[0-9a-f]{64}", starts[-1]["image"]), "WORKLOAD_MANAGER_UNKNOWN")
    require(cm.get("nonce_source") == "client" and hex_bytes(cm.get("nonce"), 32) == nonce, "WORKLOAD_NONCE_MISMATCH")
    require(cm.get("actions_hash") == actions_hash
            and cm.get("report_data") == actions_hash + nonce.hex()
            and manager["report_data"] == actions_hash + nonce.hex(), "WORKLOAD_BINDING_MISMATCH")
    info = a.get("info")
    require(isinstance(info, dict), "WORKLOAD_EVIDENCE_MISSING")
    tcb = info.get("tcb_info")
    tcb = parse_json(tcb) if isinstance(tcb, str) else tcb
    require(isinstance(tcb, dict) and isinstance(tcb.get("app_compose"), str), "WORKLOAD_EVIDENCE_MISSING")
    app_hash = digest(tcb["app_compose"].encode("utf-8"))
    require(main["mr_config_id"] == "01" + app_hash + "00" * 15, "WORKLOAD_COMPOSE_MISMATCH")
    payload = parse_json(a.get("nvidia_payload")) if isinstance(a.get("nvidia_payload"), str) else a.get("nvidia_payload")
    require(isinstance(payload, dict) and payload.get("arch") in ("HOPPER", "BLACKWELL")
            and isinstance(payload.get("evidence_list"), list)
            and 1 <= len(payload["evidence_list"]) <= 32, "NVIDIA_INVALID")
    require(hex_bytes(payload.get("nonce"), 32) == nonce, "NVIDIA_NONCE_INVALID")
    for evidence in payload["evidence_list"]:
        require(isinstance(evidence, dict) and isinstance(evidence.get("evidence"), str)
                and isinstance(evidence.get("certificate"), str), "NVIDIA_INVALID")
    if nvidia_local is not None:
        bundle = nvat_artifact(payload, nvidia_local)
        if archived_bundle is None:
            require(verification_time is None and trusted_jwks is None, "ARCHIVE_INVALID")
        else:
            require(type(verification_time) is int and trusted_jwks is None
                    and archived_bundle == bundle, "ARCHIVE_INVALID")
        gpu_models = await verify_nvidia_local(payload, nonce, nvidia_local)
        # A new raw-evidence appraisal uses current signed RIM/OCSP collateral.
        # Nothing here authenticates a historical local JSON/EAT or reestablishes
        # an old TLS session. Certificate claims must cover the bounded lifetime.
        now = int(time.time()) if verification_time is None else verification_time
        nvidia_exp = now + 300
    elif archived_bundle is None:
        require(verification_time is None and trusted_jwks is None, "ARCHIVE_INVALID")
        bundle, jwks = await asyncio.gather(
            asyncio.to_thread(http_json, "POST", NRAS_ORIGIN + "/v3/attest/gpu", payload),
            asyncio.to_thread(http_json, "GET", NRAS_ORIGIN + "/.well-known/jwks.json"))
        now = int(time.time())
    else:
        # Only the explicit archive entry point supplies these values. Never use
        # caller-supplied JWKs or token URLs as a verification trust anchor.
        require(type(verification_time) is int and isinstance(trusted_jwks, dict), "ARCHIVE_INVALID")
        bundle, jwks, now = archived_bundle, trusted_jwks, verification_time
    if nvidia_local is None:
        gpu_models, nvidia_exp = verify_nvidia_tokens(bundle, jwks, nonce, len(payload["evidence_list"]), now)
    measurements = {key: main[key] for key in MEASUREMENTS}
    return {"signingAddress": address.lower(), "tlsSpkiSha256": spki.hex(),
            "cpuStatus": "UpToDate", "gpuCount": len(gpu_models), "gpuModels": sorted(set(gpu_models)),
            "model": a["model_name"], "measurements": measurements,
            "appComposeSha256": app_hash, "composeManagerActionsSha256": actions_hash,
            "composeManagerImage": starts[-1]["image"],
            "nvidiaExpiresAt": nvidia_exp,
            "nvidiaEvidenceSha256": digest(canonical(bundle)), "nvidiaEvidence": bundle}


def model_verdict(document, policy, facts, now):
    end, session = validate_policy(policy, now)
    keys = ("model", "measurements", "appComposeSha256", "composeManagerActionsSha256", "composeManagerImage", "gpuCount", "gpuModels")
    require(any(all(facts[key] == profile[key] for key in keys) for profile in policy["profiles"]), "WORKLOAD_NOT_APPROVED")
    expiry = min(now + session, int(end), facts["nvidiaExpiresAt"])
    require(expiry > now, "VERIFICATION_EXPIRED")
    reference = digest(canonical({"input": document, "policy": policy,
                                  "nvidiaEvidenceSha256": facts["nvidiaEvidenceSha256"]}))
    return {"ok": True, "signingAddress": facts["signingAddress"],
            "tlsSpkiSha256": facts["tlsSpkiSha256"], "attestationRef": "0x" + reference,
            "verifiedAt": iso(now), "expiresAt": iso(expiry),
            "cpuStatus": facts["cpuStatus"], "gpuCount": facts["gpuCount"],
            "measurements": facts["measurements"], "policyVersion": policy["version"],
            "policySha256": digest(canonical(policy)),
            "composeManagerActionsSha256": facts["composeManagerActionsSha256"],
            "composeManagerImage": facts["composeManagerImage"],
            "nvidiaEvidenceSha256": facts["nvidiaEvidenceSha256"],
            "nvidiaEvidence": facts["nvidiaEvidence"]}


async def verify(document, policy):
    require(isinstance(document, dict) and "archivedVerdict" not in document, "INPUT_INVALID")
    validate_policy(policy, time.time())
    local = nvidia_local_config(policy)
    started = time.time()
    facts = await inspect_evidence(document, nvidia_local=local) if local else await inspect_evidence(document)
    now = int(time.time())
    require(now - started <= (180 if local else 120), "VERIFICATION_TIMEOUT")
    return model_verdict(document, policy, facts, now)


async def verify_cloud(document, policy):
    """Verify the gateway and every advertised model candidate before inference."""
    require(isinstance(document, dict), "INPUT_INVALID")
    require("archivedVerdict" not in document, "INPUT_INVALID")
    nvidia_local_config(policy)
    nonce = hex_bytes(document.get("nonce"), 32).hex()
    gateway_spki = hex_bytes(document.get("tlsSpkiSha256"), 32).hex()
    model = document.get("model")
    require(isinstance(model, str) and model, "MODEL_INVALID")
    report = document.get("attestation")
    require(isinstance(report, dict), "INPUT_INVALID")
    candidates = report.get("model_attestations")
    require(isinstance(candidates, list) and 1 <= len(candidates) <= 32,
            "MODEL_EVIDENCE_MISSING")
    gateway = await verify_gateway({"nonce": nonce, "tlsSpkiSha256": gateway_spki,
                                    "gateway_attestation": report.get("gateway_attestation")}, policy)
    verified = []
    for candidate in candidates:
        require(isinstance(candidate, dict) and candidate.get("model_name") == model
                and "event_log" in candidate, "MODEL_EVIDENCE_INVALID")
        provider_spki = hex_bytes(candidate.get("tls_cert_fingerprint"), 32,
                                  "MODEL_EVIDENCE_INVALID").hex()
        verdict = await verify({"nonce": nonce, "tlsSpkiSha256": provider_spki,
                                "attestation": candidate}, policy)
        verified.append(verdict)
    signers = [item["signingAddress"] for item in verified]
    require(len(set(signers)) == len(signers), "MODEL_EVIDENCE_DUPLICATE")
    expiry = min(timestamp(gateway["expiresAt"]),
                 *(timestamp(item["expiresAt"]) for item in verified))
    now = time.time()
    require(expiry > now, "VERIFICATION_EXPIRED")
    reference = "0x" + digest(canonical({"gatewayRef": gateway["attestationRef"],
                                     "modelRefs": [item["attestationRef"] for item in verified],
                                     "model": model}))
    return {"ok": True, "signingAddress": signers[0], "allowedSigners": signers,
            "gatewaySigningAddress": gateway["signingAddress"],
            "tlsSpkiSha256": gateway_spki, "attestationRef": reference,
            "verifiedAt": iso(now), "expiresAt": iso(expiry),
            "policyVersion": policy["version"], "model": model,
            "gatewayVerdict": gateway, "modelVerdicts": verified}


def archive_time(verdict, now):
    require(isinstance(verdict, dict) and verdict.get("ok") is True, "ARCHIVE_INVALID")
    try:
        recorded = timestamp(verdict.get("verifiedAt"))
        expiry = timestamp(verdict.get("expiresAt"))
    except VerificationError as error:
        raise VerificationError("ARCHIVE_TIME_INVALID") from error
    require(recorded == int(recorded) and verdict["verifiedAt"] == iso(recorded)
            and now - 30 * 86400 <= recorded <= now
            and recorded < expiry <= recorded + 300, "ARCHIVE_TIME_INVALID")
    return int(recorded)


def compare_archived_verdict(archived, reconstructed):
    require(isinstance(archived, dict)
            and all(archived.get(key) == value for key, value in reconstructed.items()),
            "ARCHIVE_VERDICT_MISMATCH")


async def verify_direct_archive(document, policy):
    """Replay signed NRAS evidence or re-appraise original local GPU raw evidence."""
    now = time.time()
    validate_policy(policy, now)
    local = nvidia_local_config(policy)
    require(isinstance(document, dict), "INPUT_INVALID")
    nonce = hex_bytes(document.get("nonce"), 32).hex()
    spki = hex_bytes(document.get("tlsSpkiSha256"), 32).hex()
    report, archived = document.get("attestation"), document.get("archivedVerdict")
    require(isinstance(report, dict) and isinstance(archived, dict)
            and "gateway_attestation" not in report and "model_attestations" not in report,
            "ARCHIVE_INVALID")
    recorded = archive_time(archived, now)
    require(isinstance(archived.get("nvidiaEvidence"), dict if local else list), "ARCHIVE_INVALID")
    # Keep exactly the normalized input used by the original direct live path.
    # Including the archived verdict would change its policy/evidence reference.
    original = {"nonce": nonce, "tlsSpkiSha256": spki, "attestation": report}
    jwks = None if local else await asyncio.to_thread(http_json, "GET", NRAS_ORIGIN + "/.well-known/jwks.json")
    facts = await inspect_evidence(original, archived_bundle=archived["nvidiaEvidence"],
                                   verification_time=recorded, trusted_jwks=jwks, nvidia_local=local)
    reconstructed = model_verdict(original, policy, facts, recorded)
    compare_archived_verdict(archived, reconstructed)
    validate_policy(policy, time.time())
    return {**reconstructed, "archivedHardwareVerified": True, "replayedAt": iso(time.time())}


async def verify_cloud_archive(document, policy):
    """Replay saved Cloud evidence with current Intel collateral and trusted NVIDIA keys.

    NVIDIA JWT signatures/nonce/claims are checked at the bounded historical
    verification instant. This mode does not establish a new TLS session or
    authorize live inference; live verification never consumes archived verdicts.
    """
    now = time.time()
    validate_policy(policy, now)
    local = nvidia_local_config(policy)
    validate_gateway_policy(policy, now)
    require(isinstance(document, dict), "INPUT_INVALID")
    nonce = hex_bytes(document.get("nonce"), 32).hex()
    gateway_spki = hex_bytes(document.get("tlsSpkiSha256"), 32).hex()
    model = document.get("model")
    require(isinstance(model, str) and model, "MODEL_INVALID")
    report, archived = document.get("attestation"), document.get("archivedVerdict")
    require(isinstance(report, dict) and isinstance(archived, dict), "ARCHIVE_INVALID")
    recorded = archive_time(archived, now)
    candidates, model_archives = report.get("model_attestations"), archived.get("modelVerdicts")
    require(isinstance(candidates, list) and 1 <= len(candidates) <= 32,
            "MODEL_EVIDENCE_MISSING")
    require(isinstance(model_archives, list) and len(model_archives) == len(candidates), "ARCHIVE_INVALID")
    gateway_archive = archived.get("gatewayVerdict")
    gateway_time = archive_time(gateway_archive, now)
    require(gateway_time <= recorded < timestamp(gateway_archive["expiresAt"]), "ARCHIVE_TIME_INVALID")
    gateway_input = {"nonce": nonce, "tlsSpkiSha256": gateway_spki,
                     "gateway_attestation": report.get("gateway_attestation")}
    gateway_facts = await inspect_gateway_report(gateway_input)
    gateway = gateway_verdict(gateway_input, policy, gateway_facts, gateway_time)
    compare_archived_verdict(gateway_archive, gateway)
    # This key source is fixed, CA-verified, has no redirects/proxy/netrc, and
    # rejects unknown key IDs. An archived/included JWK is never consulted.
    jwks = None if local else await asyncio.to_thread(http_json, "GET", NRAS_ORIGIN + "/.well-known/jwks.json")
    verified = []
    for candidate, model_archive in zip(candidates, model_archives, strict=True):
        require(isinstance(candidate, dict) and candidate.get("model_name") == model
                and "event_log" in candidate, "MODEL_EVIDENCE_INVALID")
        model_time = archive_time(model_archive, now)
        require(gateway_time <= model_time <= recorded < timestamp(model_archive["expiresAt"]),
                "ARCHIVE_TIME_INVALID")
        provider_spki = hex_bytes(candidate.get("tls_cert_fingerprint"), 32,
                                  "MODEL_EVIDENCE_INVALID").hex()
        model_input = {"nonce": nonce, "tlsSpkiSha256": provider_spki, "attestation": candidate}
        require(isinstance(model_archive.get("nvidiaEvidence"), dict if local else list), "ARCHIVE_INVALID")
        facts = await inspect_evidence(model_input, archived_bundle=model_archive["nvidiaEvidence"],
                                       verification_time=model_time, trusted_jwks=jwks, nvidia_local=local)
        verdict = model_verdict(model_input, policy, facts, model_time)
        compare_archived_verdict(model_archive, verdict)
        verified.append(verdict)
    signers = [item["signingAddress"] for item in verified]
    require(len(set(signers)) == len(signers), "MODEL_EVIDENCE_DUPLICATE")
    expiry = min(timestamp(gateway["expiresAt"]),
                 *(timestamp(item["expiresAt"]) for item in verified))
    require(recorded < expiry, "ARCHIVE_TIME_INVALID")
    reference = "0x" + digest(canonical({"gatewayRef": gateway["attestationRef"],
                                     "modelRefs": [item["attestationRef"] for item in verified],
                                     "model": model}))
    reconstructed = {"ok": True, "signingAddress": signers[0], "allowedSigners": signers,
                     "gatewaySigningAddress": gateway["signingAddress"],
                     "tlsSpkiSha256": gateway_spki, "attestationRef": reference,
                     "verifiedAt": iso(recorded), "expiresAt": iso(expiry),
                     "policyVersion": policy["version"], "model": model,
                     "gatewayVerdict": gateway, "modelVerdicts": verified}
    compare_archived_verdict(archived, reconstructed)
    # Reject policy expiry during long collateral checks as well as at admission.
    validate_policy(policy, time.time())
    validate_gateway_policy(policy, time.time())
    return {**reconstructed, "archivedHardwareVerified": True, "replayedAt": iso(time.time())}
