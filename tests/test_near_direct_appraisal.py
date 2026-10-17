"""Offline boundaries for saved NEAR direct-report hardware appraisal."""

import asyncio
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.x509.oid import NameOID


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "near-direct-appraisal.py"
SPEC = importlib.util.spec_from_file_location("near_direct_appraisal", SOURCE)
APPRAISAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPRAISAL)
MODEL = "z-ai/glm-5.3-flash"
NONCE = "ab" * 32
CANARY = "private-report-canary"


class FakeVerificationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class FakeVerifier:
    NVAT_VERSION = "1.2.2"
    NVAT_BINARY_SHA256 = "a" * 64
    NVAT_LIBRARY_SHA256 = "b" * 64

    def __init__(self):
        self.calls = []
        self.nvat_checks = []
        self.failure = None

    @staticmethod
    def parse_json(raw):
        return json.loads(raw)

    def verify_nvat_files(self, config):
        self.nvat_checks.append(config)

    async def inspect_evidence(self, document, *, nvidia_local):
        self.calls.append((document, nvidia_local))
        if self.failure:
            raise FakeVerificationError(self.failure)
        return {"model": MODEL, "cpuStatus": "UpToDate", "gpuCount": 8,
                "tlsSpkiSha256": document["tlsSpkiSha256"],
                "composeManagerActionsSha256": "ef" * 32,
                "nvidiaEvidence": {"raw": "never publish this"}}


def test_certificate():
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "glm-5-3-flash.completions.near.ai")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                   .public_key(key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=1))
                   .not_valid_after(now + timedelta(days=1))
                   .sign(key, hashes.SHA256()))
    pem = certificate.public_bytes(Encoding.PEM).decode("ascii")
    spki = hashlib.sha256(key.public_key().public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    return pem, spki


class DirectAppraisalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="near-direct-appraisal-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.packet = self.root / "packet"
        self.packet.mkdir()
        self.binary = self.root / "nvattest"
        self.library = self.root / "libnvat.so.1.2.2"
        self.binary.write_bytes(b"test binary")
        self.library.write_bytes(b"test library")
        self.verifier = FakeVerifier()
        self.pem, self.spki = test_certificate()
        self.write_packet()

    def write_packet(self):
        report = {"model_name": MODEL, "request_nonce": NONCE,
                  "tls_cert_fingerprint": self.spki, "signing_algo": "ecdsa",
                  "compose_manager_attestation": {"actions": [{"action": "fixture"}]},
                  "secret": CANARY}
        raw = json.dumps(report).encode()
        summary = {"schemaVersion": 1, "status": "captured", "reasonCode": "CANDIDATE_CAPTURED",
                   "endpoint": "https://glm-5-3-flash.completions.near.ai", "model": MODEL,
                   "approval": "UNAPPROVED", "hardwareVerified": False, "reportGets": 1,
                   "paidPosts": 0, "httpStatus": 200,
                   "response": {"sha256": "0x" + hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}}
        saved = {"attestation": report, "nonce": NONCE, "tlsSpkiSha256": self.spki, "model": MODEL}
        connection = {"approval": "UNAPPROVED", "hardwareVerified": False,
                      "nonce": NONCE, "tlsSpkiSha256": self.spki,
                      "requestUrl": "https://glm-5-3-flash.completions.near.ai/v1/attestation/report"
                                    f"?nonce={NONCE}&signing_algo=ecdsa&include_tls_fingerprint=true",
                      "requestHeaders": {"accept": "application/json", "acceptEncoding": "identity"},
                      "peerCertificatePem": self.pem}
        for name, value in (("summary.json", summary), ("candidate-input.json", saved),
                            ("connection-request.json", connection)):
            (self.packet / name).write_text(json.dumps(value), encoding="utf-8")
        (self.packet / "report-response.bin").write_bytes(raw)

    def change_json(self, filename, function):
        path = self.packet / filename
        value = json.loads(path.read_text(encoding="utf-8"))
        function(value)
        path.write_text(json.dumps(value), encoding="utf-8")

    def appraise(self):
        return asyncio.run(APPRAISAL.appraise_packet(
            self.packet, str(self.binary), str(self.library), self.verifier))

    def test_invokes_vendored_hardware_inspection_with_pinned_nvat_and_stays_unapproved(self):
        result = self.appraise()
        self.assertEqual(result, {
            "status": "DIRECT_HARDWARE_VERIFIED", "model": MODEL, "gpuCount": 8,
            "composeManagerActionsSha256": "ef" * 32, "approval": "UNAPPROVED",
            "liveAdmission": False, "newNearReportGets": 0, "paidInferencePosts": 0})
        self.assertEqual(len(self.verifier.nvat_checks), 1)
        self.assertEqual(len(self.verifier.calls), 1)
        document, config = self.verifier.calls[0]
        self.assertIs(config, self.verifier.nvat_checks[0])
        self.assertEqual(document["nonce"], NONCE)
        self.assertEqual(document["tlsSpkiSha256"], self.spki)
        self.assertEqual(document["attestation"]["secret"], CANARY)
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertNotIn("never publish this", json.dumps(result))

    def test_modified_response_rejected_before_verifier(self):
        (self.packet / "report-response.bin").write_bytes(CANARY.encode())
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_saved_input_report_mismatch_rejected_before_verifier(self):
        self.change_json("candidate-input.json", lambda value: value["attestation"].update(secret="altered"))
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_wrong_route_or_auth_header_rejected_before_verifier(self):
        self.change_json("connection-request.json", lambda value: value.update(requestUrl="https://evil.example"))
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.write_packet()
        self.change_json("connection-request.json", lambda value: value["requestHeaders"].update(authorization="Bearer secret"))
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_certificate_spki_mismatch_rejected_before_verifier(self):
        other_pem, _ = test_certificate()
        self.change_json("connection-request.json", lambda value: value.update(peerCertificatePem=other_pem))
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_rejected_hardware_uses_fixed_safe_code_without_evidence(self):
        self.verifier.failure = "CPU_TCB_REJECTED"
        result = self.appraise()
        self.assertEqual(result["status"], "DIRECT_HARDWARE_REJECTED")
        self.assertEqual(result["reasonCode"], "CPU_TCB_REJECTED")
        self.assertFalse(result["liveAdmission"])
        self.assertNotIn("gpuCount", result)
        self.assertNotIn(CANARY, json.dumps(result))

    def test_cli_prints_one_safe_line_and_never_admits(self):
        stdout = io.StringIO()
        with patch.object(APPRAISAL.importlib, "import_module", return_value=self.verifier), \
                patch.object(sys, "argv", [str(SOURCE), "--packet", str(self.packet),
                                           "--nvat-binary", str(self.binary),
                                           "--nvat-library", str(self.library)]), \
                redirect_stdout(stdout):
            exit_code = APPRAISAL.main()
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(stdout.getvalue())["approval"], "UNAPPROVED")
        self.assertNotIn(CANARY, stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
