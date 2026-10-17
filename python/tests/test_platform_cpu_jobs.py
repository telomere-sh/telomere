from __future__ import annotations

import copy
import unittest

from test_platform import CRYPTO, FIXTURE, SessionTransport, client
from telomere_sdk.client import _canonical, _typed
from telomere_sdk.platform import QUOTE_FIELDS, _cpu_job_input, _cpu_job_replan, _cpu_scheduling, _input, _normalize_job_addresses, _workload


class CpuJobInputTests(unittest.TestCase):
    def test_lane_consent_is_explicit_and_old_workload_remains_exact(self):
        task = {"kind": "session", "imageDigest": "sha256:" + "a" * 64, "maxCommands": 4}
        base = {"leashId": "0x" + "1" * 64, "task": task, "maxSeconds": 60, "deadline": 1000, "maxSpend": "10000"}
        self.assertEqual(_workload(_input(base)), {"task": task})
        for scheduling in ({"version": 1, "lane": "interruptible"},
                           {"version": 1, "lane": "interruptible", "interruptibleConsent": {"minimumNoticeSeconds": 29}},
                           {"version": 1, "lane": "standard", "interruptibleConsent": {"minimumNoticeSeconds": 30}},
                           {"version": True, "lane": "standard"}):
            with self.subTest(scheduling=scheduling), self.assertRaises(ValueError):
                _cpu_scheduling(scheduling)
        scheduling = {"version": 1, "lane": "interruptible", "interruptibleConsent": {"minimumNoticeSeconds": 30}}
        self.assertEqual(_workload(_input({**base, "cpuScheduling": scheduling})),
                         {"protocol": "telomere-platform-cpu-scheduling-v1", "task": task, "cpuScheduling": scheduling})
        with self.assertRaises(ValueError):
            _input({**base, "maxSeconds": 30, "cpuScheduling": scheduling})
        with self.assertRaises(ValueError):
            _cpu_scheduling({**scheduling, "job": {"jobId": "0x" + "1" * 64, "intentHash": "0x" + "2" * 64,
                "decisionHash": "0x" + "3" * 64}})

    def test_owner_job_never_accepts_unbounded_or_unconsented_work(self):
        base = {"protocol": "telomere-paid-cpu-job-v1", "leashId": "0x" + "1" * 64,
                "task": {"kind": "session", "imageDigest": "sha256:" + "a" * 64, "maxCommands": 4},
                "workSeconds": 60, "deadline": 1000, "maxSpend": "10000"}
        self.assertEqual(_cpu_job_input(base)["lanes"], ["standard"])
        for change in ({"workSeconds": 121}, {"lanes": ["standard", "interruptible"]}, {"lanes": ["standard", "standard"]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                _cpu_job_input({**base, **change})
        with self.assertRaises(ValueError):
            _cpu_job_replan({"checkpointHash": "0x" + "1" * 64, "remainingSeconds": 110, "restoreSeconds": 20})

    def test_replan_keeps_legacy_shape_and_requires_a_valid_optional_source_fence(self):
        original = {"checkpointHash": "0x" + "1" * 64, "remainingSeconds": 40, "restoreSeconds": 20}
        self.assertEqual(_cpu_job_replan(original), original)
        fenced = {**original, "expectedSourceRunId": "0x" + "2" * 64}
        self.assertEqual(_cpu_job_replan(fenced), fenced)
        for change in ({"expectedSourceRunId": None}, {"expectedSourceRunId": "wrong-source"}, {"sourceRunId": "0x" + "2" * 64}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                _cpu_job_replan({**original, **change})


@unittest.skipUnless(CRYPTO, "Requires eth-account reviewed crypto adapter")
class CpuJobCryptoTests(unittest.TestCase):
    def fixture(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        transport = SessionTransport(vault=True); transport.principal = FIXTURE["owner"]
        sdk = client(transport, vault=True)
        input = _cpu_job_input({"protocol": "telomere-paid-cpu-job-v1", "leashId": FIXTURE["binding"]["leashId"],
            "task": {"kind": "session", "imageDigest": transport.config["capacity"][0]["imageDigest"], "maxCommands": 4},
            "workSeconds": 60, "deadline": FIXTURE["epoch"] + 600, "maxSpend": "1000000"})
        job_id = "0x" + "ab" * 32
        intent = {"domain": "telomere-paid-cpu-job-intent/v1", "jobId": job_id, "binding": FIXTURE["binding"],
                  "input": input, "createdAt": FIXTURE["epoch"], "pins": FIXTURE["pins"]}
        intent_hash = "0x" + CRYPTO.keccak256(_canonical(_normalize_job_addresses(intent)).encode()).hex()
        prepared = copy.deepcopy(transport.vector["prepared"])
        prepared["input"] = {"leashId": input["leashId"], "task": input["task"], "maxSeconds": 60,
            "deadline": input["deadline"], "maxSpend": input["maxSpend"], "regions": [],
            "cpuScheduling": {"version": 1, "lane": "standard", "job": {"jobId": job_id, "intentHash": intent_hash,
                "targetHostId": transport.config["capacity"][0]["hostId"]}}}
        quote = prepared["quote"]; quote.update(leashId=input["leashId"], maxSeconds=60)
        quote["workloadHash"] = "0x" + CRYPTO.keccak256(_canonical(_workload(prepared["input"])).encode()).hex()
        quote["inferencePrice"] = "0"; quote["pricePerSecond"] = transport.config["capacity"][0]["pricePerSecond"]
        base = 60 * int(quote["pricePerSecond"]); prepared["ceiling"] = str(base + (base * 900 + 9999) // 10000)
        domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337,
                  "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
        prepared["signature"] = "0x" + Account.sign_message(encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, quote)),
            "0x" + "11" * 32).signature.hex()
        prepared["transaction"]["data"] = sdk._encode_open(quote, prepared["signature"], prepared["imageProof"], prepared["regionProof"])
        job = {"protocol": "telomere-paid-cpu-job-v1", "id": job_id, "owner": FIXTURE["binding"]["owner"],
            "vault": FIXTURE["binding"]["vault"], "binding": copy.deepcopy(FIXTURE["binding"]), "intentHash": intent_hash,
            "input": input, "createdAt": FIXTURE["epoch"], "phase": "active", "runIds": [quote["runId"]], "currentRunId": quote["runId"],
            "proposal": None, "approvalHash": None, "charged": "0", "outstandingLiability": prepared["ceiling"],
            "cancellationReason": None, "prepared": prepared, "fundsReserved": False, "funding": "external-wallet-required",
            "stopAndRefundRequired": False}
        original_request = transport.request
        def request(path, *, method="GET", body=None, idempotency_key=None):
            if "/cpu-jobs" in path:
                transport.calls.append((path, method, copy.deepcopy(body), idempotency_key))
                return copy.deepcopy(job)
            return original_request(path, method=method, body=body, idempotency_key=idempotency_key)
        transport.request = request
        return sdk, transport, job

    def test_checks_owner_job_binding_and_real_signature_without_wallet_authority(self):
        sdk, transport, job = self.fixture()
        value = sdk.create_cpu_job(job["input"], idempotency_key="owner-job-create")
        self.assertEqual(value["id"], job["id"])
        self.assertEqual(sdk.cpu_job(job["id"])["prepared"]["signature"], job["prepared"]["signature"])
        value["prepared"]["input"]["maxSpend"] = "1"
        self.assertEqual(sdk.cpu_job(job["id"])["input"]["maxSpend"], "1000000")
        transport.principal = FIXTURE["agent"]
        with self.assertRaisesRegex(ValueError, "not authorized"):
            sdk.create_cpu_job(job["input"], idempotency_key="agent-job-create")

    def test_rejects_response_scope_budget_and_signed_consent_tampering(self):
        for change in (lambda job: job["input"].update(deadline=job["input"]["deadline"] + 1),
                       lambda job: job.update(outstandingLiability="1000001"),
                       lambda job: job["prepared"]["input"]["cpuScheduling"].update(job={"jobId": "0x" + "cd" * 32,
                           "intentHash": job["intentHash"]}),
                       lambda job: job["prepared"]["input"]["cpuScheduling"].update(lane="interruptible",
                           interruptibleConsent={"minimumNoticeSeconds": 30})):
            sdk, transport, job = self.fixture(); change(job)
            with self.subTest(change=change), self.assertRaises(ValueError):
                sdk.cpu_job(job["id"])

    def test_replan_transmits_exact_source_fence_and_original_operation_key(self):
        sdk, transport, job = self.fixture()
        request = {"checkpointHash": "0x" + "1" * 64, "expectedSourceRunId": job["currentRunId"],
                   "remainingSeconds": 40, "restoreSeconds": 20}
        sdk.replan_cpu_job(job["id"], request, idempotency_key="fenced-owner-replan")
        submissions = [call for call in transport.calls if call[0].endswith("/cpu-jobs/" + job["id"] + "/replan")]
        self.assertEqual(len(submissions), 1)
        _, method, body, key = submissions[0]
        self.assertEqual((method, body, key), ("POST", request, "fenced-owner-replan"))
        self.assertEqual(request["expectedSourceRunId"], job["currentRunId"])

    def test_finish_transmits_original_source_and_preserves_legacy_omission(self):
        sdk, transport, job = self.fixture()
        sdk.finish_cpu_job(job["id"], expected_source_run_id=job["currentRunId"])
        sdk.finish_cpu_job(job["id"])
        submissions = [call for call in transport.calls if call[0].endswith("/cpu-jobs/" + job["id"] + "/finish")]
        self.assertEqual([(call[1], call[2], call[3]) for call in submissions], [
            ("POST", {"expectedSourceRunId": job["currentRunId"]}, None), ("POST", {}, None)])
        with self.assertRaises(ValueError):
            sdk.finish_cpu_job(job["id"], expected_source_run_id="wrong-source")
        self.assertEqual(len([call for call in transport.calls if call[0].endswith("/finish")]), 2)


if __name__ == "__main__":
    unittest.main()
