"""Appraise a saved NEAR direct report without authorizing a live session.

This command makes no NEAR report or inference request. The vendored verifier
may obtain read-only Intel/NVIDIA collateral while checking raw hardware evidence.
The captured TLS connection cannot be re-established from a saved packet.
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


ORIGIN = "https://glm-5-3-flash.completions.near.ai"
MODEL = "z-ai/glm-5.3-flash"
REPORT_LIMIT = 8_388_608
INPUT_LIMIT = 16_779_264
HEX32 = re.compile(r"[0-9a-f]{64}\Z")
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


def certificate_spki(pem):
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    if not isinstance(pem, str) or not 1 <= len(pem) <= 32_768:
        raise AppraisalError()
    certificate = x509.load_pem_x509_certificate(pem.encode("ascii"))
    key = certificate.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(key).hexdigest()


def load_packet(directory, verifier):
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise AppraisalError()
    try:
        summary = verifier.parse_json(read_regular(directory / "summary.json", 65_536))
        raw = read_regular(directory / "report-response.bin", REPORT_LIMIT)
        saved = verifier.parse_json(read_regular(directory / "candidate-input.json", INPUT_LIMIT))
        connection = verifier.parse_json(read_regular(directory / "connection-request.json", 65_536))
        report = verifier.parse_json(raw)
        if not all(isinstance(item, dict) for item in (summary, saved, connection, report)):
            raise AppraisalError()
        response = summary.get("response")
        nonce, spki = saved.get("nonce"), saved.get("tlsSpkiSha256")
        report_spki = report.get("tls_cert_fingerprint")
        if (summary.get("schemaVersion") != 1 or summary.get("status") != "captured"
                or summary.get("reasonCode") != "CANDIDATE_CAPTURED"
                or summary.get("endpoint") != ORIGIN or summary.get("model") != MODEL
                or summary.get("approval") != "UNAPPROVED"
                or summary.get("hardwareVerified") is not False
                or type(summary.get("reportGets")) is not int or summary["reportGets"] != 1
                or type(summary.get("paidPosts")) is not int or summary["paidPosts"] != 0
                or type(summary.get("httpStatus")) is not int or summary["httpStatus"] != 200
                or not isinstance(response, dict)
                or type(response.get("bytes")) is not int or response["bytes"] != len(raw)
                or response.get("sha256") != "0x" + hashlib.sha256(raw).hexdigest()
                or saved.get("model") != MODEL or not isinstance(nonce, str)
                or not HEX32.fullmatch(nonce) or not isinstance(spki, str)
                or not HEX32.fullmatch(spki) or saved.get("attestation") != report
                or connection.get("approval") != "UNAPPROVED"
                or connection.get("hardwareVerified") is not False
                or connection.get("nonce") != nonce
                or connection.get("tlsSpkiSha256") != spki
                or connection.get("requestUrl") !=
                    f"{ORIGIN}/v1/attestation/report?nonce={nonce}&signing_algo=ecdsa&include_tls_fingerprint=true"
                or connection.get("requestHeaders") !=
                    {"accept": "application/json", "acceptEncoding": "identity"}
                or certificate_spki(connection.get("peerCertificatePem")) != spki
                or report.get("model_name") != MODEL or report.get("request_nonce") != nonce
                or not isinstance(report_spki, str)
                or report_spki.removeprefix("0x").lower() != spki
                or report.get("signing_algo") != "ecdsa"):
            raise AppraisalError()
    except Exception:
        raise AppraisalError() from None
    return {"nonce": nonce, "tlsSpkiSha256": spki, "attestation": report}


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
    document = load_packet(directory, verifier)
    nvidia = local_nvidia_config(verifier, binary_path, library_path)
    try:
        facts = await asyncio.wait_for(verifier.inspect_evidence(document, nvidia_local=nvidia), 250)
        count, actions = facts.get("gpuCount"), facts.get("composeManagerActionsSha256")
        if (facts.get("model") != MODEL or facts.get("cpuStatus") != "UpToDate"
                or facts.get("tlsSpkiSha256") != document["tlsSpkiSha256"]
                or type(count) is not int or not 1 <= count <= 32
                or not isinstance(actions, str) or not HEX32.fullmatch(actions)):
            raise AppraisalError()
        return {"status": "DIRECT_HARDWARE_VERIFIED", "model": MODEL, "gpuCount": count,
                "composeManagerActionsSha256": actions, "approval": "UNAPPROVED",
                "liveAdmission": False, "newNearReportGets": 0, "paidInferencePosts": 0}
    except Exception as error:
        code = getattr(error, "code", None)
        return {"status": "DIRECT_HARDWARE_REJECTED", "model": MODEL,
                "reasonCode": code if isinstance(code, str) and SAFE_CODE.fullmatch(code)
                else "APPRAISAL_FAILED", "approval": "UNAPPROVED", "liveAdmission": False,
                "newNearReportGets": 0, "paidInferencePosts": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", required=True, help="Absolute private direct candidate directory")
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
        return 0 if result["status"] == "DIRECT_HARDWARE_VERIFIED" else 1
    except Exception:
        print(json.dumps({"status": "APPRAISAL_FAILED", "approval": "UNAPPROVED",
                          "liveAdmission": False, "newNearReportGets": 0,
                          "paidInferencePosts": 0, "reasonCode": "PACKET_OR_RUNTIME_INVALID"},
                         separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
