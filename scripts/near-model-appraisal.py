"""Appraise model hardware in a saved NEAR Cloud packet; never admit a session.

The packet is produced by near-cloud-evidence.ts. This command makes no NEAR
report or inference request. Intel collateral and NVIDIA RIM/OCSP verification
may make read-only vendor network requests. Only fixed, non-secret conclusions
are printed; the gateway, workload policy and image provenance remain unapproved.
"""

import argparse
import asyncio
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import stat
import sys


PACKET_LIMIT = 16_779_264
MODEL = re.compile(r"[A-Za-z0-9._/-]{1,512}\Z")
HEX32 = re.compile(r"[0-9a-fA-F]{64}\Z")
SAFE_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,63}\Z")


class AppraisalError(Exception):
    pass


def read_regular(path, maximum):
    if path.is_symlink():
        raise AppraisalError()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise AppraisalError()
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise AppraisalError()
    return data


def load_packet(directory, verifier):
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise AppraisalError()
    try:
        summary = verifier.parse_json(read_regular(directory / "summary.json", 65_536))
        raw = read_regular(directory / "report-response.bin", 16_777_216)
        saved = verifier.parse_json(read_regular(directory / "candidate-input.json", PACKET_LIMIT))
        connection = verifier.parse_json(read_regular(directory / "connection-request.json", 65_536))
        report = verifier.parse_json(raw)
    except Exception:
        raise AppraisalError() from None
    if not all(isinstance(value, dict) for value in (summary, saved, connection, report)):
        raise AppraisalError()
    expected = summary.get("response")
    model, nonce, spki = saved.get("model"), saved.get("nonce"), saved.get("tlsSpkiSha256")
    if (summary.get("schemaVersion") != 1 or summary.get("status") != "captured"
            or summary.get("reasonCode") != "CANDIDATE_CAPTURED"
            or summary.get("approval") != "UNAPPROVED" or summary.get("hardwareVerified") is not False
            or summary.get("paidPosts") != 0 or summary.get("endpoint") != "https://cloud-api.near.ai"
            or not isinstance(expected, dict) or expected.get("bytes") != len(raw)
            or expected.get("sha256") != "0x" + hashlib.sha256(raw).hexdigest()
            or not isinstance(model, str) or not MODEL.fullmatch(model)
            or summary.get("model") != model or not isinstance(nonce, str) or not HEX32.fullmatch(nonce)
            or not isinstance(spki, str) or not HEX32.fullmatch(spki)
            or saved.get("attestation") != report or connection.get("nonce") != nonce
            or connection.get("tlsSpkiSha256") != spki
            or connection.get("approval") != "UNAPPROVED"
            or connection.get("hardwareVerified") is not False):
        raise AppraisalError()
    gateway, candidates = report.get("gateway_attestation"), report.get("model_attestations")
    if (not isinstance(gateway, dict) or gateway.get("request_nonce") != nonce
            or gateway.get("tls_cert_fingerprint") != spki
            or not isinstance(candidates, list) or not 1 <= len(candidates) <= 32):
        raise AppraisalError()
    for candidate in candidates:
        if (not isinstance(candidate, dict) or candidate.get("model_name") != model
                or candidate.get("request_nonce") != nonce or "event_log" not in candidate
                or not isinstance(candidate.get("tls_cert_fingerprint"), str)
                or not HEX32.fullmatch(candidate["tls_cert_fingerprint"])):
            raise AppraisalError()
    return model, nonce, candidates


def local_nvidia_config(verifier, binary_path, library_path):
    if (not binary_path or not library_path or not Path(binary_path).is_absolute()
            or not Path(library_path).is_absolute()):
        raise AppraisalError()
    binary, library = Path(binary_path).resolve(strict=True), Path(library_path).resolve(strict=True)
    if os.name != "nt" and any(token in str(library.parent) for token in (":", "$")):
        raise AppraisalError()
    config = {"mode": "local", "sdkVersion": verifier.NVAT_VERSION,
              "binarySha256": verifier.NVAT_BINARY_SHA256,
              "librarySha256": verifier.NVAT_LIBRARY_SHA256,
              "binary": binary, "library": library}
    verifier.verify_nvat_files(config)
    return config


async def appraise_packet(directory, binary_path, library_path, verifier):
    model, nonce, candidates = load_packet(directory, verifier)
    nvidia = local_nvidia_config(verifier, binary_path, library_path)
    results = []
    for index, candidate in enumerate(candidates):
        document = {"nonce": nonce, "tlsSpkiSha256": candidate["tls_cert_fingerprint"],
                    "attestation": candidate}
        try:
            facts = await asyncio.wait_for(verifier.inspect_evidence(document, nvidia_local=nvidia), 250)
            count, action_hash = facts.get("gpuCount"), facts.get("composeManagerActionsSha256")
            if (facts.get("model") != model or facts.get("cpuStatus") != "UpToDate"
                    or type(count) is not int or not 1 <= count <= 32
                    or not isinstance(action_hash, str) or not HEX32.fullmatch(action_hash)):
                raise AppraisalError()
            results.append({"index": index, "status": "MODEL_HARDWARE_VERIFIED", "model": model,
                            "gpuCount": count, "composeManagerActionsSha256": action_hash.lower()})
        except Exception as error:
            code = getattr(error, "code", None)
            results.append({"index": index, "status": "MODEL_HARDWARE_REJECTED", "model": model,
                            "reasonCode": code if isinstance(code, str) and SAFE_CODE.fullmatch(code)
                            else "APPRAISAL_FAILED"})
    complete = all(item["status"] == "MODEL_HARDWARE_VERIFIED" for item in results)
    return {"status": "MODEL_HARDWARE_VERIFIED" if complete else "MODEL_HARDWARE_REJECTED",
            "approval": "UNAPPROVED", "liveAdmission": False, "gatewayAppraised": False,
            "newNearReportGets": 0, "paidInferencePosts": 0, "candidates": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", required=True, help="Absolute private Cloud candidate directory")
    parser.add_argument("--nvat-binary", help="Absolute pinned local NVIDIA NVAT binary")
    parser.add_argument("--nvat-library", help="Absolute pinned local NVIDIA NVAT library")
    arguments = parser.parse_args()
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra" / "near"))
        verifier = importlib.import_module("verifier")
        result = asyncio.run(appraise_packet(
            Path(arguments.packet), arguments.nvat_binary or os.environ.get("NEAR_NVAT_BINARY"),
            arguments.nvat_library or os.environ.get("NEAR_NVAT_LIBRARY"), verifier))
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["status"] == "MODEL_HARDWARE_VERIFIED" else 1
    except Exception:
        print(json.dumps({"status": "APPRAISAL_FAILED", "approval": "UNAPPROVED",
                          "liveAdmission": False, "newNearReportGets": 0,
                          "paidInferencePosts": 0, "reasonCode": "PACKET_OR_RUNTIME_INVALID"},
                         separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
