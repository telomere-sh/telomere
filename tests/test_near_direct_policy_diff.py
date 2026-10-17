"""Fail-closed comparison with an exact historical NEAR direct policy."""

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


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "near-direct-policy-diff.py"
SPEC = importlib.util.spec_from_file_location("near_direct_policy_diff", SOURCE)
DIFF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIFF)
APPRAISER = DIFF.direct_appraiser()
MODEL = "z-ai/glm-5.3-flash"
NONCE = "ab" * 32
CANARY = "private-quote-or-key-canary"
MEASUREMENTS = {
    "tee_tcb_svn": 16, "mr_seam": 48, "mr_signer_seam": 48,
    "seam_attributes": 8, "td_attributes": 8, "xfam": 8,
    "mr_td": 48, "mr_config_id": 48, "mr_owner": 48,
    "mr_owner_config": 48, "rt_mr0": 48, "rt_mr1": 48,
    "rt_mr2": 48, "rt_mr3": 48,
}


class FakeVerifier:
    NVAT_VERSION = "1.2.2"
    NVAT_BINARY_SHA256 = "a" * 64
    NVAT_LIBRARY_SHA256 = "b" * 64
    MEASUREMENTS = MEASUREMENTS

    def __init__(self, facts):
        self.facts = facts
        self.inspections = []
        self.nvat_checks = []

    @staticmethod
    def parse_json(raw):
        return json.loads(raw)

    @staticmethod
    def timestamp(value):
        if not isinstance(value, str) or not value.endswith("Z"):
            raise ValueError()
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()

    def verify_nvat_files(self, config):
        self.nvat_checks.append(config)

    async def inspect_evidence(self, document, *, nvidia_local):
        self.inspections.append((document, nvidia_local))
        return self.facts


def certificate():
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "glm-5-3-flash.completions.near.ai")])
    now = datetime.now(timezone.utc)
    item = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1)).sign(key, hashes.SHA256()))
    spki = hashlib.sha256(key.public_key().public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    return item.public_bytes(Encoding.PEM).decode("ascii"), spki


class DirectPolicyDiffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="near-direct-policy-diff-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.packet = self.root / "packet"
        self.packet.mkdir()
        self.policy_path = self.root / "provider-policy.json"
        self.binary, self.library = self.root / "nvattest", self.root / "libnvat.so.1.2.2"
        self.binary.write_bytes(b"test binary")
        self.library.write_bytes(b"test library")
        pem, self.spki = certificate()
        self.write_packet(pem)
        measurements = {key: "1a" * size for key, size in MEASUREMENTS.items()}
        self.facts = {"model": MODEL, "cpuStatus": "UpToDate", "tlsSpkiSha256": self.spki,
                      "gpuCount": 8, "gpuModels": ["GH100 A01 GSP BROM"],
                      "appComposeSha256": "aa" * 32,
                      "composeManagerActionsSha256": "bb" * 32,
                      "composeManagerImage": "nearaidev/compose-manager@sha256:" + "cc" * 32,
                      "measurements": measurements, "raw": CANARY}
        self.verifier = FakeVerifier(self.facts)
        self.policy = {"schemaVersion": 1, "version": DIFF.V6_POLICY_VERSION,
                       "validFrom": "2026-10-01T00:00:00Z", "validUntil": "2026-10-08T14:29:11Z",
                       "maxSessionSeconds": 300,
                       "nvidiaVerifier": {"mode": "local", "sdkVersion": self.verifier.NVAT_VERSION,
                                          "binarySha256": self.verifier.NVAT_BINARY_SHA256,
                                          "librarySha256": self.verifier.NVAT_LIBRARY_SHA256},
                       "profiles": [self.profile()]}
        self.save_policy()

    def write_packet(self, pem):
        report = {"model_name": MODEL, "request_nonce": NONCE,
                  "tls_cert_fingerprint": self.spki, "signing_algo": "ecdsa", "raw": CANARY}
        raw = json.dumps(report).encode()
        summary = {"schemaVersion": 1, "status": "captured", "reasonCode": "CANDIDATE_CAPTURED",
                   "endpoint": "https://glm-5-3-flash.completions.near.ai", "model": MODEL,
                   "approval": "UNAPPROVED", "hardwareVerified": False,
                   "reportGets": 1, "paidPosts": 0, "httpStatus": 200,
                   "response": {"sha256": "0x" + hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}}
        saved = {"attestation": report, "nonce": NONCE, "tlsSpkiSha256": self.spki, "model": MODEL}
        connection = {"approval": "UNAPPROVED", "hardwareVerified": False,
                      "nonce": NONCE, "tlsSpkiSha256": self.spki,
                      "requestUrl": "https://glm-5-3-flash.completions.near.ai/v1/attestation/report"
                                    f"?nonce={NONCE}&signing_algo=ecdsa&include_tls_fingerprint=true",
                      "requestHeaders": {"accept": "application/json", "acceptEncoding": "identity"},
                      "peerCertificatePem": pem}
        for name, value in (("summary.json", summary), ("candidate-input.json", saved),
                            ("connection-request.json", connection)):
            (self.packet / name).write_text(json.dumps(value), encoding="utf-8")
        (self.packet / "report-response.bin").write_bytes(raw)

    def profile(self):
        return {key: json.loads(json.dumps(self.facts[key])) for key in (
            "model", "gpuCount", "gpuModels", "appComposeSha256",
            "composeManagerActionsSha256", "composeManagerImage", "measurements")}

    def save_policy(self):
        raw = json.dumps(self.policy).encode()
        self.policy_path.write_bytes(raw)
        self.sha = hashlib.sha256(raw).hexdigest()

    def compare(self, *, now=None, claimed_sha=None):
        with patch.object(DIFF, "V6_POLICY_SHA256", self.sha):
            return asyncio.run(DIFF.compare_packet(
                self.packet, self.policy_path, claimed_sha or self.sha,
                str(self.binary), str(self.library), self.verifier, APPRAISER,
                now=now if now is not None else datetime(2026, 10, 13, tzinfo=timezone.utc).timestamp()))

    def test_expired_exact_profile_is_unapproved_with_separate_time_gate(self):
        packet_before = (self.packet / "report-response.bin").read_bytes()
        policy_before = self.policy_path.read_bytes()
        result = self.compare()
        self.assertEqual(result["status"], "POLICY_EXPIRED")
        self.assertEqual(result["policyTimeGate"], "EXPIRED")
        self.assertEqual(result["baselineProfileIndex"], 0)
        self.assertTrue(result["profileExactMatch"])
        self.assertEqual(result["deltas"], [])
        self.assertEqual(result["approval"], "UNAPPROVED")
        self.assertFalse(result["liveAdmission"])
        self.assertFalse(result["policyRenewed"])
        self.assertEqual(result["newNearReportGets"], 0)
        self.assertEqual(result["paidInferencePosts"], 0)
        self.assertEqual(len(self.verifier.inspections), 1)
        self.assertIs(self.verifier.inspections[0][1], self.verifier.nvat_checks[0])
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual((self.packet / "report-response.bin").read_bytes(), packet_before)
        self.assertEqual(self.policy_path.read_bytes(), policy_before)

    def test_changed_actions_and_measurement_are_bounded_safe_deltas(self):
        self.facts["composeManagerActionsSha256"] = "dd" * 32
        self.facts["measurements"]["rt_mr3"] = "ee" * 48
        result = self.compare()
        self.assertEqual(result["status"], "POLICY_EXPIRED")
        self.assertFalse(result["profileExactMatch"])
        self.assertEqual([delta["field"] for delta in result["deltas"]],
                         ["composeManagerActionsSha256", "measurements.rt_mr3"])
        self.assertEqual(result["deltas"][1]["candidate"], "ee" * 48)
        self.assertNotIn(CANARY, json.dumps(result))

    def test_missing_and_multiple_matching_profiles_fail_closed(self):
        self.policy["profiles"][0]["appComposeSha256"] = "ff" * 32
        self.save_policy()
        missing = self.compare()
        self.assertEqual(missing["status"], "PROFILE_NOT_FOUND")
        self.assertNotIn("baselineProfileIndex", missing)
        self.policy["profiles"] = [self.profile(), self.profile()]
        self.save_policy()
        multiple = self.compare()
        self.assertEqual(multiple["status"], "PROFILE_AMBIGUOUS")
        self.assertNotIn("deltas", multiple)
        self.assertEqual(multiple["approval"], "UNAPPROVED")

    def test_changed_packet_rejected_before_hardware_inspection(self):
        (self.packet / "report-response.bin").write_bytes(CANARY.encode())
        with self.assertRaises(APPRAISER.AppraisalError):
            self.compare()
        self.assertEqual(self.verifier.inspections, [])

    def test_wrong_policy_hash_rejected_before_hardware_inspection(self):
        with self.assertRaises(DIFF.DiffError):
            self.compare(claimed_sha="0" * 64)
        self.assertEqual(self.verifier.inspections, [])

    def test_tampered_policy_bytes_rejected_before_hardware_inspection(self):
        self.policy_path.write_bytes(self.policy_path.read_bytes() + b" ")
        with self.assertRaises(DIFF.DiffError):
            self.compare()
        self.assertEqual(self.verifier.inspections, [])

    def test_valid_window_still_cannot_admit_an_exact_match(self):
        inside = datetime(2026, 10, 4, tzinfo=timezone.utc).timestamp()
        result = self.compare(now=inside)
        self.assertEqual(result["status"], "PROFILE_MATCH_NO_ADMISSION")
        self.assertEqual(result["policyTimeGate"], "IN_WINDOW")
        self.assertEqual(result["approval"], "UNAPPROVED")
        self.assertFalse(result["liveAdmission"])

    def test_cli_prints_safe_one_line_and_nonzero_exit(self):
        stdout = io.StringIO()
        with patch.object(DIFF, "V6_POLICY_SHA256", self.sha), \
                patch.object(DIFF.importlib, "import_module", return_value=self.verifier), \
                patch.object(DIFF, "direct_appraiser", return_value=APPRAISER), \
                patch.object(sys, "argv", [str(SOURCE), "--packet", str(self.packet),
                                           "--policy", str(self.policy_path),
                                           "--policy-sha256", self.sha,
                                           "--nvat-binary", str(self.binary),
                                           "--nvat-library", str(self.library)]), \
                redirect_stdout(stdout):
            exit_code = DIFF.main()
        self.assertEqual(exit_code, 1)
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(stdout.getvalue())["approval"], "UNAPPROVED")
        self.assertNotIn(CANARY, stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
