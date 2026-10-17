"""Offline boundaries for the saved NEAR model-only hardware appraiser."""

import asyncio
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "near-model-appraisal.py"
SPEC = importlib.util.spec_from_file_location("near_model_appraisal", SOURCE)
APPRAISAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPRAISAL)
MODEL = "z-ai/glm-5.3-flash"
NONCE = "ab" * 32
SPKI = "cd" * 32


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
        self.fail_marker = None

    @staticmethod
    def parse_json(raw):
        return json.loads(raw)

    def verify_nvat_files(self, config):
        self.nvat_checks.append(config)

    async def inspect_evidence(self, document, *, nvidia_local):
        self.calls.append((document, nvidia_local))
        if document["attestation"].get("marker") == self.fail_marker:
            raise FakeVerificationError("CPU_TCB_REJECTED")
        return {"model": MODEL, "cpuStatus": "UpToDate", "gpuCount": 8,
                "composeManagerActionsSha256": "ef" * 32,
                "nvidiaEvidence": {"raw": "never publish this"}}


class ModelAppraisalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="near-model-appraisal-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.packet = self.root / "packet"
        self.packet.mkdir()
        self.binary = self.root / "nvattest"
        self.library = self.root / "libnvat.so.1.2.2"
        self.binary.write_bytes(b"test binary")
        self.library.write_bytes(b"test library")
        self.verifier = FakeVerifier()
        self.write_packet(2)

    def write_packet(self, count):
        report = {"gateway_attestation": {"request_nonce": NONCE,
                                          "tls_cert_fingerprint": SPKI},
                  "model_attestations": [
                      {"model_name": MODEL, "request_nonce": NONCE,
                       "tls_cert_fingerprint": "12" * 32,
                       "event_log": [{"fixture": True}], "marker": index,
                       "raw": "private-secret-canary"}
                      for index in range(count)]}
        raw = json.dumps(report).encode()
        summary = {"schemaVersion": 1, "status": "captured",
                   "reasonCode": "CANDIDATE_CAPTURED", "approval": "UNAPPROVED",
                   "hardwareVerified": False, "paidPosts": 0,
                   "endpoint": "https://cloud-api.near.ai", "model": MODEL,
                   "response": {"sha256": "0x" + hashlib.sha256(raw).hexdigest(),
                                "bytes": len(raw)}}
        saved = {"attestation": report, "model": MODEL, "nonce": NONCE,
                 "tlsSpkiSha256": SPKI}
        connection = {"approval": "UNAPPROVED", "hardwareVerified": False,
                      "nonce": NONCE, "tlsSpkiSha256": SPKI}
        for name, value in (("summary.json", summary),
                            ("candidate-input.json", saved),
                            ("connection-request.json", connection)):
            (self.packet / name).write_text(json.dumps(value), encoding="utf-8")
        (self.packet / "report-response.bin").write_bytes(raw)

    def appraise(self):
        return asyncio.run(APPRAISAL.appraise_packet(
            self.packet, str(self.binary), str(self.library), self.verifier))

    def test_every_candidate_uses_vendored_verifier_with_explicit_pinned_nvat(self):
        result = self.appraise()
        self.assertEqual(result["status"], "MODEL_HARDWARE_VERIFIED")
        self.assertEqual(result["approval"], "UNAPPROVED")
        self.assertFalse(result["liveAdmission"])
        self.assertFalse(result["gatewayAppraised"])
        self.assertEqual(result["paidInferencePosts"], 0)
        self.assertEqual(len(self.verifier.calls), 2)
        self.assertEqual(len(self.verifier.nvat_checks), 1)
        self.assertEqual(self.verifier.calls[0][0]["nonce"], NONCE)
        self.assertEqual(self.verifier.calls[0][0]["tlsSpkiSha256"], "12" * 32)
        self.assertIs(self.verifier.calls[0][1], self.verifier.nvat_checks[0])
        self.assertEqual([item["gpuCount"] for item in result["candidates"]], [8, 8])
        self.assertEqual([item["composeManagerActionsSha256"] for item in result["candidates"]], ["ef" * 32] * 2)
        self.assertNotIn("private-secret-canary", json.dumps(result))
        self.assertNotIn("never publish this", json.dumps(result))

    def test_one_rejection_does_not_skip_other_candidate_or_print_private_error(self):
        self.verifier.fail_marker = 0
        result = self.appraise()
        self.assertEqual(result["status"], "MODEL_HARDWARE_REJECTED")
        self.assertEqual(len(self.verifier.calls), 2)
        self.assertEqual(result["candidates"][0]["reasonCode"], "CPU_TCB_REJECTED")
        self.assertEqual(result["candidates"][1]["status"], "MODEL_HARDWARE_VERIFIED")
        self.assertNotIn("gpuCount", result["candidates"][0])

    def test_changed_raw_packet_is_rejected_before_any_hardware_call(self):
        (self.packet / "report-response.bin").write_bytes(b"private-secret-canary")
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_missing_event_log_is_rejected_before_any_hardware_call(self):
        self.write_packet(1)
        saved = json.loads((self.packet / "candidate-input.json").read_text())
        saved["attestation"]["model_attestations"][0].pop("event_log")
        (self.packet / "candidate-input.json").write_text(json.dumps(saved))
        with self.assertRaises(APPRAISAL.AppraisalError):
            self.appraise()
        self.assertEqual(self.verifier.calls, [])

    def test_cli_redacts_runtime_failure(self):
        stdout = io.StringIO()
        with patch.object(APPRAISAL.importlib, "import_module", return_value=self.verifier), \
                patch.object(sys, "argv", [str(SOURCE), "--packet", str(self.packet),
                                           "--nvat-binary", str(self.binary),
                                           "--nvat-library", str(self.library)]), \
                redirect_stdout(stdout):
            exit_code = APPRAISAL.main()
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertNotIn("private-secret-canary", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
