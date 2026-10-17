"""Opt-in direct Python RPC/private journal acceptance on disposable Anvil.

Node deploys the existing fixture and supplies disposable signing/reorg controls.
All independent evidence is read and verified by the actual Python RPC reader.
"""
from __future__ import annotations

import json
import os
import pathlib
import queue
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.request import ProxyHandler, Request, build_opener

from test_vault_income import CRYPTO
from telomere_sdk import FileVaultIncomeJournal, RpcVaultIncomeReader, VaultIncomeClient, VaultIncomeError, VaultIncomePublicHttp

ROOT = pathlib.Path(__file__).resolve().parents[2]


class FixtureControl:
    def __init__(self, config):
        self.url = config["readerUrl"]
        self.opener = build_opener(ProxyHandler({}))

    def call(self, action, **fields):
        request = Request(self.url, method="POST", headers={"Content-Type": "application/json"},
                          data=json.dumps({"action": action, **fields}, separators=(",", ":")).encode())
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)


class DropAfterResponse:
    def __init__(self, profile):
        self.resource_url, self.headers, self.drop = profile["resourceUrl"], [], False
        self.http = VaultIncomePublicHttp(self.resource_url, chain_id=31337)

    def send(self, signed_header=None):
        result = self.http.send(signed_header)
        if signed_header:
            self.headers.append(signed_header)
            if self.drop:
                self.drop = False
                raise ConnectionError("Disposable loss after complete paid HTTP response")
        return result


@unittest.skipUnless(os.environ.get("TELOMERE_PYTHON_NATIVE_ACCEPTANCE") == "1" and CRYPTO is not None,
                     "Explicitly enable disposable Anvil acceptance with the pinned crypto environment")
class NativeVaultFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Existing Node runtime required for disposable acceptance")
        cls.process = subprocess.Popen([node, str(ROOT / "node_modules/tsx/dist/cli.mjs"),
                                        str(ROOT / "python/tests/native-vault-harness.ts")],
                                       cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        cls.addClassCleanup(cls.close_fixture)
        lines = queue.Queue()
        def ready():
            lines.put(cls.process.stdout.readline())
        worker = threading.Thread(target=ready, daemon=True); worker.start()
        try:
            line = lines.get(timeout=120)
            if not line:
                raise RuntimeError("Disposable native Vault bridge did not start")
            cls.config = json.loads(line)
        except Exception:
            cls.close_fixture()
            raise

    @classmethod
    def close_fixture(cls):
        process = getattr(cls, "process", None)
        if process is None:
            return
        try:
            if process.poll() is None:
                process.stdin.write("close\n"); process.stdin.flush()
                process.wait(timeout=30)
        finally:
            if process.poll() is None:
                process.kill(); process.wait(timeout=10)
            process.stdin.close(); process.stdout.close(); process.stderr.close()

    @classmethod
    def tearDownClass(cls):
        cls.close_fixture()


class NativeVaultAcceptance(NativeVaultFixture):
    def test_real_native_income_subsidy_lost_ack_restart_and_reorg(self):
        control = FixtureControl(self.config)
        profile = self.config["profile"]
        reader = RpcVaultIncomeReader(self.config["rpcUrl"], profile=profile)
        transport = DropAfterResponse(profile)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "payer"
            journal = FileVaultIncomeJournal(path)
            def journal_state():
                return journal.exclusive(self.config["profileHash"], lambda tx: tx.load())
            def client():
                return VaultIncomeClient(profile=profile, verifier=CRYPTO, reader=reader, journal=journal, transport=transport)
            def authorized(name, payer):
                instance = client()
                prepared = instance.prepare(name, payer=self.config["payer" if payer == "external" else "owner"])
                signature = control.call("sign", typedData=prepared["typedData"], payer=payer)["signature"]
                instance.authorize(name, signature)
                return prepared
            try:
                authorized("external-income", "external")
                self.assertEqual(journal_state()["profileHash"], self.config["profileHash"])
                before = control.call("stats")
                transport.drop = True
                with self.assertRaises((ConnectionError, VaultIncomeError)):
                    client().submit("external-income")
                after = control.call("stats")
                self.assertEqual(int(before["external"]) - int(after["external"]), 101)
                self.assertEqual(after["facilitatorTransactions"] - before["facilitatorTransactions"], 1)
                with self.assertRaisesRegex(VaultIncomeError, "reconciliation_required"):
                    client().prepare("unsafe-replacement", payer=self.config["payer"])
                journal.close(); journal = FileVaultIncomeJournal(path)
                control.call("restart")
                recovered = client().retry("external-income")
                self.assertEqual(recovered["status"], "settled")
                self.assertEqual(recovered["evidence"]["classification"], "income")
                self.assertEqual(recovered["evidence"]["incomeFee"], "2")
                self.assertEqual(transport.headers[0], transport.headers[1])
                self.assertEqual(control.call("stats"), after)

                # The actual contract classifies original owner funds as subsidy.
                authorized("owner-subsidy", "owner")
                owner_before = control.call("stats")
                subsidy = client().submit("owner-subsidy")
                owner_after = control.call("stats")
                self.assertEqual(subsidy["status"], "settled")
                self.assertEqual(subsidy["evidence"]["classification"], "subsidy")
                self.assertEqual(subsidy["evidence"]["incomeFee"], "0")
                self.assertEqual(int(owner_before["owner"]) - int(owner_after["owner"]), 101)

                authorized("reorg-income", "external")
                control.call("branch")
                original = client().submit("reorg-income")
                self.assertEqual(original["status"], "settled")
                control.call("reorg")
                journal.close(); journal = FileVaultIncomeJournal(path)
                self.assertEqual(client().check("reorg-income")["status"], "pending")
                self.assertEqual(client().retry("reorg-income")["status"], "pending")
                restored = client().retry("reorg-income")
                self.assertEqual(restored["status"], "settled")
                self.assertEqual(restored["transactionHash"], original["transactionHash"])
                self.assertEqual(control.call("stats")["facilitatorTransactions"], owner_after["facilitatorTransactions"] + 1)
            finally:
                journal.close()


if __name__ == "__main__":
    unittest.main()
