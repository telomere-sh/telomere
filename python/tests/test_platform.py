from __future__ import annotations

import copy
import hashlib
import json
import pathlib
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import ApiTransport, EthAccountVerifier, PlatformRuntimeClient, PlatformVaultRuntimeClient, TelomereClient
from telomere_sdk.client import _canonical, _typed
from telomere_sdk.chains import PUBLIC_BASE_TOKENS
from telomere_sdk.platform import QUOTE_FIELDS, _input, _pins
from test_sdk import FixtureServer, FIXTURE as PILOT_FIXTURE

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "platform-typescript.json").read_text(encoding="utf-8"))
try:
    CRYPTO = EthAccountVerifier()
except RuntimeError:
    CRYPTO = None


class ScriptedTransport:
    origin = "http://127.0.0.1:3280"

    def __init__(self, vault=False, *, command=False):
        self.vault = vault
        self.principal = FIXTURE["agent" if vault else "owner"]
        self.vector = copy.deepcopy(FIXTURE[("execVault" if vault else "execEoa") if command else ("vault" if vault else "eoa")])
        self.run_id = self.vector["run"]["id"]
        self.config = copy.deepcopy(FIXTURE[("execVaultConfig" if vault else "execConfig") if command else ("vaultConfig" if vault else "config")])
        self.path = "/api/platform" + ("/vaults/" + FIXTURE["binding"]["vault"] if vault else "")
        self.calls = []
        self.mutate = lambda path, value: value
        self.fail_once = False

    def request(self, path, *, method="GET", body=None, idempotency_key=None):
        self.calls.append((path, method, copy.deepcopy(body), idempotency_key))
        if path == "/api/me":
            result = {"address": self.principal, "demo": False}
        elif path == self.path + "/config":
            result = self.config
        elif path == self.path + "/balance":
            result = {"available": "1000000"}
        elif path == self.path + "/quotes":
            if self.fail_once:
                self.fail_once = False
                raise ConnectionError("Lost acknowledged platform quote")
            result = self.vector["prepared"]
        elif path == self.path + "/runs":
            result = self.vector["run"] if method == "POST" else {"runs": [self.vector["run"]]}
        elif path == self.path + "/runs/" + self.run_id:
            result = self.vector["run"]
        elif path.endswith("/stop"):
            result = self.vector["actions"]["stop"]
        elif path.endswith("/refund"):
            result = self.vector["actions"]["refund"]
        else:
            raise AssertionError("Unexpected platform endpoint " + path)
        return self.mutate(path, copy.deepcopy(result))

    def clear_session(self):
        pass


class SessionTransport(ScriptedTransport):
    def __init__(self, vault=False):
        super().__init__(vault, command=True)
        self.config["capacity"][0]["sessionEnabled"] = True
        self.vector["run"]["status"] = "running"
        self.session_command = {"commandId": "write", "argv": ["/usr/local/bin/node", "-e", "process.stdout.write('ok')"]}
        self.command_result = {"command": copy.deepcopy(self.session_command),
                               "inputHash": hashlib.sha256(_canonical(self.session_command).encode("utf-8")).hexdigest(),
                               "state": "completed", "stdout": "ok", "stderr": "", "exitCode": 0, "reason": "exited", "outputBytes": 2}
        self.events = [{"sequence": 0, "kind": "ready"}, {"sequence": 1, "kind": "started", "commandId": "write"},
                       {"sequence": 2, "kind": "output", "commandId": "write", "stream": "stdout", "text": "ok"},
                       {"sequence": 3, "kind": "command_exit", "commandId": "write", "exitCode": 0},
                       {"sequence": 4, "kind": "session_exit", "reason": "requested"}]

    def request(self, path, *, method="GET", body=None, idempotency_key=None):
        if path == self.path + "/runs/" + self.run_id + "/commands":
            self.calls.append((path, method, copy.deepcopy(body), idempotency_key))
            return self.mutate(path, copy.deepcopy(self.command_result))
        prefix = self.path + "/runs/" + self.run_id + "/events?after="
        if path.startswith(prefix):
            self.calls.append((path, method, copy.deepcopy(body), idempotency_key))
            cursor = path.removeprefix(prefix).split("&limit=")
            after, limit = map(int, cursor)
            events = self.events[after + 1:after + 1 + limit]
            result = {"events": events, "nextSequence": events[-1]["sequence"] if events else after,
                      "eventCount": len(self.events), "state": "stopped"}
            return self.mutate(path, copy.deepcopy(result))
        return super().request(path, method=method, body=body, idempotency_key=idempotency_key)


def client(transport=None, *, vault=False, verifier=CRYPTO, clock=None, binding=True):
    transport = transport or ScriptedTransport(vault)
    options = {"pins": FIXTURE["pins"], "verifier": verifier, "transport": transport, "clock": clock or (lambda: FIXTURE["epoch"])}
    if vault:
        options.update({"vault_pins": FIXTURE["vaultPins"], "vault": FIXTURE["binding"]["vault"]})
        if binding:
            options["binding"] = FIXTURE["binding"]
        return PlatformVaultRuntimeClient(transport.origin, **options)
    return PlatformRuntimeClient(transport.origin, **options)


class PlatformReadTests(unittest.TestCase):
    def test_base_usdc_circle_proxy_pins_are_exact_and_old_rails_rejected(self):
        for chain_id in (8453, 84532):
            pins = copy.deepcopy(FIXTURE["pins"])
            pins.update(chainId=chain_id, tokenAddress=PUBLIC_BASE_TOKENS[chain_id], reviewedTokenKind="circle_proxy",
                        assetImplementation={"address": "0x" + "a" * 40, "codeHash": "0x" + "b" * 64})
            with self.subTest(chain_id=chain_id):
                self.assertEqual(_pins(pins)["tokenAddress"], PUBLIC_BASE_TOKENS[chain_id])
                transport = ScriptedTransport(); transport.origin = "https://controller.example"
                transport.config["pins"] = copy.deepcopy(pins)
                self.assertEqual(PlatformRuntimeClient(transport.origin, pins=pins, transport=transport).config()["pins"], _pins(pins))
                for change in (lambda p: p.update(tokenAddress="0x7e955252e15c84f5768b83c41a71f9eba181802f"),
                               lambda p: p.update(reviewedTokenKind="eip1967"),
                               lambda p: p.update(assetFacet={"address": "0x" + "c" * 40, "codeHash": "0x" + "d" * 64}),
                               lambda p: p.pop("assetImplementation")):
                    changed = copy.deepcopy(pins); change(changed)
                    with self.assertRaises(ValueError):
                        _pins(changed)
        for old_chain in (4663, 46630):
            pins = copy.deepcopy(FIXTURE["pins"]); pins["chainId"] = old_chain
            with self.assertRaises(ValueError):
                _pins(pins)

    def test_inference_only_input_and_provider_config_are_strictly_bounded(self):
        transport = ScriptedTransport()
        near = {"model": "z-ai/glm-5.3-flash", "maxTokens": 32, "policySha256": "0x" + "a1" * 32,
                "inferencePrice": "1000"}
        transport.config.update(near=near, nearInferenceTask="near_inference")
        self.assertEqual(client(transport, verifier=None).config()["near"], near)
        request = {**copy.deepcopy(FIXTURE["input"]), "task": {"kind": "near_inference"},
                   "near": {"model": near["model"], "maxTokens": near["maxTokens"],
                            "policySha256": near["policySha256"], "prompt": "Bounded inference"}}
        self.assertEqual(_input(request)["task"], {"kind": "near_inference"})
        for change in (lambda r: r.pop("near"), lambda r: r["near"].update(prompt="x" * 8193),
                       lambda r: r["task"].update(argv=["/bin/sh"])):
            malformed = copy.deepcopy(request); change(malformed)
            with self.subTest(change=change), self.assertRaises(ValueError):
                _input(malformed)
        transport.config.pop("nearInferenceTask")
        with self.assertRaisesRegex(ValueError, "explicitly enabled"):
            client(transport, verifier=None).config()

    def test_dependency_free_reads_checked_pins_balances_and_scoped_runs(self):
        for vault in (False, True):
            with self.subTest(vault=vault):
                transport = ScriptedTransport(vault); sdk = client(transport, vault=vault, verifier=None)
                self.assertEqual(sdk.config()["pins"]["chainId"], 31337)
                self.assertEqual(sdk.balance(), {"available": "1000000"})
                self.assertEqual(sdk.list()["runs"][0]["id"], transport.vector["run"]["id"])
                self.assertEqual(sdk.get(transport.vector["run"]["id"])["quote"]["payer"], transport.vector["run"]["quote"]["payer"].lower())

    def test_all_financial_methods_fail_closed_without_verifier(self):
        for vault in (False, True):
            sdk = client(vault=vault, verifier=None); vector = FIXTURE["vault" if vault else "eoa"]
            for operation in (lambda: sdk.quote(FIXTURE["input"], idempotency_key="crypto-required"), lambda: sdk.open_plan(vector["prepared"]),
                              lambda: sdk.admit({"runId": vector["run"]["id"], "transactionHash": vector["admissionHash"]}, idempotency_key="crypto-admission"),
                              lambda: sdk.stop_plan(vector["run"]["id"], idempotency_key="crypto-stop"), lambda: sdk.refund_plan(vector["run"]["id"], idempotency_key="crypto-refund")):
                with self.assertRaisesRegex(ValueError, "CryptoVerifier"):
                    operation()

    def test_mainnet_bad_origin_and_transport_origin_mismatch_fail_closed(self):
        pins = copy.deepcopy(FIXTURE["pins"]); pins["chainId"] = 1
        with self.assertRaises(ValueError):
            PlatformRuntimeClient("http://127.0.0.1:3280", pins=pins)
        with self.assertRaises(ValueError):
            PlatformRuntimeClient("http://public.example", pins=FIXTURE["pins"])
        with self.assertRaises(ValueError):
            PlatformRuntimeClient("http://127.0.0.1:3281", pins=FIXTURE["pins"], transport=ScriptedTransport())

    def test_every_reviewed_platform_pin_is_mandatory_and_checked(self):
        for key in FIXTURE["pins"]:
            transport = ScriptedTransport(); transport.config["pins"][key] = 46630 if key == "chainId" else "0x" + ("ab" * (32 if key.endswith("CodeHash") else 20))
            with self.subTest(pin=key), self.assertRaises(ValueError):
                client(transport, verifier=None).config()
        transport = ScriptedTransport(); del transport.config["pins"]["escrowCodeHash"]
        with self.assertRaises(ValueError):
            client(transport).config()

    def test_vault_pins_binding_and_roles_are_checked_without_cached_authorization(self):
        for key in FIXTURE["vaultPins"]:
            transport = ScriptedTransport(True); transport.config["vaultPins"][key] = "0x" + "ab" * (32 if key.endswith("CodeHash") else 20)
            with self.subTest(vault_pin=key), self.assertRaises(ValueError):
                client(transport, vault=True, verifier=None).config()
        for key in FIXTURE["binding"]:
            transport = ScriptedTransport(True); transport.config["binding"][key] = "0x" + "ab" * (32 if key.endswith("Id") else 20)
            with self.subTest(binding=key), self.assertRaises(ValueError):
                client(transport, vault=True, verifier=None).config()
        transport = ScriptedTransport(True); sdk = client(transport, vault=True, verifier=None)
        sdk.balance(); transport.principal = FIXTURE["owner"]; sdk.balance()
        transport.principal = "0x" + "ab" * 20
        with self.assertRaisesRegex(ValueError, "not authorized"):
            sdk.balance()

    def test_config_requires_exact_protocol_types_and_bounded_distinct_hosts(self):
        changes = [lambda c: c.update(extra=True), lambda c: c.update(feeBps=True), lambda c: c.update(maxSeconds=120.0),
                   lambda c: c["pins"].update(chainId=True), lambda c: c["pins"].update(chainId=31337.0),
                   lambda c: c.update(protocol="legacy"), lambda c: c.update(capacity=[]), lambda c: c.update(capacity=c["capacity"] * 17),
                   lambda c: c.update(capacity=c["capacity"] * 2), lambda c: c["capacity"][0].update(lane="interruptible"),
                   lambda c: c["capacity"][0].update(hardwareClass="gpu"), lambda c: c["capacity"][0].update(imageDigest="latest"),
                   lambda c: c["capacity"][0].update(pricePerSecond="01")]
        for mutate in changes:
            transport = ScriptedTransport(); mutate(transport.config)
            with self.subTest(change=changes.index(mutate)), self.assertRaises(ValueError):
                client(transport, verifier=None).config()

    def test_balance_uint256_and_run_lists_are_bounded(self):
        transport = ScriptedTransport()
        for bad in (True, "-1", "01", str(2 ** 256)):
            transport.mutate = lambda path, value, bad=bad: {"available": bad} if path.endswith("/balance") else value
            with self.subTest(balance=bad), self.assertRaises(ValueError):
                client(transport, verifier=None).balance()
        transport.mutate = lambda path, value: {"runs": [transport.vector["run"]] * 129} if path.endswith("/runs") else value
        with self.assertRaises(ValueError):
            client(transport, verifier=None).list()

    def test_run_binding_amount_settlement_and_structure_tampering_is_rejected(self):
        mutations = [lambda r: r["quote"].update(payer="0x" + "ab" * 20), lambda r: r.update(id="0x" + "ab" * 32),
                     lambda r: r.update(status="paid"), lambda r: r.update(ceiling="330"), lambda r: r.update(charged="332"),
                     lambda r: r.update(charged="100", refund="200"), lambda r: r.update(errorCode="x" * 129),
                     lambda r: r.update(result=[0] * 16385), lambda r: r.update(result="x" * 131073),
                     lambda r: r.update(settlement={"runId": r["id"], "billableSeconds": 4, "endedAt": FIXTURE["epoch"], "inferenceCharge": "0", "receiptHash": "0x" + "ab" * 32})]
        for mutate in mutations:
            transport = ScriptedTransport(); mutate(transport.vector["run"])
            with self.subTest(change=mutations.index(mutate)), self.assertRaises(ValueError):
                client(transport, verifier=None).get(FIXTURE["eoa"]["run"]["id"])
        transport = ScriptedTransport(True); transport.vector["run"]["quote"]["leashId"] = "0x" + "ab" * 32
        with self.assertRaises(ValueError):
            client(transport, vault=True, verifier=None).get(transport.vector["run"]["id"])

    def test_inference_settlement_charged_and_terminal_status_match_signed_quote(self):
        transport = ScriptedTransport()
        run = transport.vector["run"]
        run["quote"]["inferencePrice"] = "1000"
        base = run["quote"]["maxSeconds"] * int(run["quote"]["pricePerSecond"]) + 1000
        run["ceiling"] = str(base + (base * 900 + 9999) // 10000)
        run.update(status="completed", executionKind="near_inference", nearResult={"output": "verified"},
                   settlement={"runId": run["id"], "billableSeconds": 0, "endedAt": FIXTURE["epoch"],
                               "inferenceCharge": "1000", "receiptHash": "0x" + "a2" * 32},
                   charged="1090", refund=str(int(run["ceiling"]) - 1090))
        sdk = client(transport, verifier=None)
        self.assertEqual(sdk.get(run["id"])["charged"], "1090")
        run.update(charged="0", refund=run["ceiling"])
        with self.assertRaisesRegex(ValueError, "charged amount differs"):
            sdk.get(run["id"])
        run.update(charged="1090", refund=str(int(run["ceiling"]) - 1090), settlement=None)
        with self.assertRaisesRegex(ValueError, "lacks exact settlement"):
            sdk.get(run["id"])
        run.update(status="refunded", charged="1", refund=str(int(run["ceiling"]) - 1))
        with self.assertRaisesRegex(ValueError, "refunded run differs"):
            sdk.get(run["id"])

    def test_defensive_copies_prevent_config_and_run_mutation(self):
        sdk = client(verifier=None); config = sdk.config(); config["pins"]["chainId"] = 46630
        self.assertEqual(sdk.config()["pins"]["chainId"], 31337)
        run = sdk.get(FIXTURE["eoa"]["run"]["id"]); run["quote"]["payer"] = "0x" + "ab" * 20
        self.assertEqual(sdk.get(run["id"])["quote"]["payer"], FIXTURE["owner"].lower())


class PlatformCommandValidationTests(unittest.TestCase):
    def test_financial_exec_validation_preserves_legacy_task_boundary(self):
        self.assertEqual(_input(FIXTURE["execInput"]), FIXTURE["execInput"])
        self.assertEqual(_input(FIXTURE["input"]), FIXTURE["input"])
        with self.assertRaises(ValueError):
            TelomereClient._quote_input({key: FIXTURE["execInput"][key] for key in ("leashId", "task", "maxSeconds")})
        body = copy.deepcopy(FIXTURE["execInput"]); del body["task"]["stdin"]
        self.assertNotIn("stdin", _input(body)["task"])
        body["task"]["stdin"] = ""
        self.assertEqual(_input(body)["task"]["stdin"], "")

    def test_exec_image_arguments_stdin_and_runtime_bounds_fail_closed(self):
        mutations = [lambda b: b["task"].update(extra="private"), lambda b: b["task"].update(imageDigest="latest"),
                     lambda b: b["task"].update(imageDigest="sha256:" + "A" * 64), lambda b: b["task"].update(argv=[]),
                     lambda b: b["task"].update(argv=["node"] * 33), lambda b: b["task"].update(argv="node"),
                     lambda b: b["task"].update(argv=["node", None]), lambda b: b["task"].update(argv=["node", True]),
                     lambda b: b["task"].update(argv=[""]), lambda b: b["task"].update(argv=["node", "\0"]),
                     lambda b: b["task"].update(argv=["node", "x" * 4097]),
                     lambda b: b["task"].update(argv=["node", "x" * 4096, "x" * 4093]),
                     lambda b: b["task"].update(argv=["node", "🧬" * 2048]),
                     lambda b: b["task"].update(argv=["node", "\ud800"]),
                     lambda b: b["task"].update(stdin=True), lambda b: b["task"].update(stdin="x" * 8193),
                     lambda b: b["task"].update(stdin="🧬" * 2049), lambda b: b["task"].update(stdin="\0"),
                     lambda b: b["task"].update(stdin="\ud800"), lambda b: b.update(maxSeconds=0),
                     lambda b: b.update(maxSeconds=121), lambda b: b.update(maxSeconds=True), lambda b: b.update(maxSeconds=3.0)]
        for index, mutate in enumerate(mutations):
            body = copy.deepcopy(FIXTURE["execInput"]); mutate(body)
            with self.subTest(change=index), self.assertRaises(ValueError):
                _input(body)

    def test_exec_exact_boundaries_and_no_implicit_shell(self):
        for argv in (["node"] * 32, ["node", "x" * 4096, "x" * 4092], ["node", "🧬" * 2047]):
            body = copy.deepcopy(FIXTURE["execInput"]); body["task"].update(argv=argv, stdin="🧬" * 2048)
            self.assertEqual(_input(body)["task"], body["task"])
        body["task"].update(argv=["node"], stdin="x" * 8192)
        self.assertEqual(_input(body)["task"]["stdin"], "x" * 8192)
        for shell in ("sh", "bash", "dash", "zsh", "ksh", "fish", "busybox"):
            for executable in (shell, "/bin/" + shell, "/a/b/" + shell):
                body["task"].update(argv=[executable, "-c", "echo blocked"])
                with self.subTest(executable=executable), self.assertRaisesRegex(ValueError, "shell"):
                    _input(body)
        # The financial boundary mirrors HostKit's exact case-sensitive POSIX basename policy.
        for executable in ("/bin/bashful", "BASH", "program", "/usr/local/bin/node"):
            body["task"]["argv"] = [executable]
            self.assertEqual(_input(body)["task"]["argv"], [executable])

    def test_exec_capability_accepts_only_explicit_true_for_both_clients(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault, command=True)
            self.assertIs(client(transport, vault=vault, verifier=None).config()["capacity"][0]["execEnabled"], True)
            for bad in (False, None, 0, 1, "true", [], {}):
                transport.config["capacity"][0]["execEnabled"] = bad
                with self.subTest(vault=vault, capability=repr(bad)), self.assertRaises(ValueError):
                    client(transport, vault=vault, verifier=None).config()
            del transport.config["capacity"][0]["execEnabled"]
            self.assertNotIn("execEnabled", client(transport, vault=vault, verifier=None).config()["capacity"][0])


class PlatformSessionTests(unittest.TestCase):
    def test_explicit_session_task_and_revocable_host_capability(self):
        body = copy.deepcopy(FIXTURE["execInput"])
        body["task"] = {"kind": "session", "imageDigest": body["task"]["imageDigest"], "maxCommands": 4}
        self.assertEqual(_input(body), body)
        for mutation in (lambda t: t.update(maxCommands=0), lambda t: t.update(maxCommands=33),
                         lambda t: t.update(maxCommands=True), lambda t: t.update(maxCommands=4.0),
                         lambda t: t.update(imageDigest="latest"), lambda t: t.update(argv=["unexpected"]),
                         lambda t: t.update(kind="exec")):
            changed = copy.deepcopy(body); mutation(changed["task"])
            with self.assertRaises(ValueError):
                _input(changed)
        for vault in (False, True):
            transport = SessionTransport(vault)
            for invalid in (False, None, 1, "true"):
                transport.config["capacity"][0]["sessionEnabled"] = invalid
                with self.subTest(vault=vault, invalid=invalid), self.assertRaises(ValueError):
                    client(transport, vault=vault, verifier=None).config()
            del transport.config["capacity"][0]["sessionEnabled"]
            if CRYPTO is not None:
                with self.assertRaisesRegex(ValueError, "No reviewed host"):
                    client(transport, vault=vault).quote(body, idempotency_key="session-without-optin")
            self.assertFalse(any(path.endswith("/quotes") for path, *_ in transport.calls))

    def test_eoa_and_vault_commands_bind_idempotency_and_exact_response(self):
        for vault in (False, True):
            transport = SessionTransport(vault); sdk = client(transport, vault=vault, verifier=None)
            result = sdk.command(transport.run_id, transport.session_command)
            self.assertEqual(result["stdout"], "ok")
            posted = [call for call in transport.calls if call[0].endswith("/commands")]
            self.assertEqual(posted, [(transport.path + "/runs/" + transport.run_id + "/commands", "POST",
                                       transport.session_command, "write")])
            result["stdout"] = "mutated"
            self.assertEqual(sdk.command(transport.run_id, transport.session_command)["stdout"], "ok")
            changed = copy.deepcopy(transport.session_command); changed["argv"] = ["/usr/local/bin/node", "-e", "process.exit(1)"]
            sent_count = sum(path.endswith("/commands") for path, *_ in transport.calls)
            with self.assertRaisesRegex(ValueError, "different work"):
                sdk.command(transport.run_id, changed)
            self.assertEqual(sum(path.endswith("/commands") for path, *_ in transport.calls), sent_count)
            for mutate in (lambda r: r["command"].update(argv=["changed"]), lambda r: r.update(inputHash="a" * 64),
                           lambda r: r.update(state="settled"), lambda r: r.update(outputBytes=True),
                           lambda r: r.update(stdout="\ud800"), lambda r: r.update(extra=True)):
                transport.mutate = lambda path, value, change=mutate: (change(value) or value) if path.endswith("/commands") else value
                with self.subTest(vault=vault, change=mutate), self.assertRaises(ValueError):
                    sdk.command(transport.run_id, transport.session_command)
            transport.mutate = lambda path, value: value
            transport.vector["run"]["status"] = "queued"
            with self.assertRaisesRegex(ValueError, "active admitted"):
                sdk.command(transport.run_id, transport.session_command)
            transport.vector["run"]["status"] = "running"
            transport.vector["run"]["admissionTx"] = None
            with self.assertRaisesRegex(ValueError, "active admitted"):
                sdk.command(transport.run_id, transport.session_command)
            if vault:
                transport.vector["run"]["admissionTx"] = FIXTURE["execVault"]["admissionHash"]
                transport.principal = FIXTURE["owner"]
                with self.assertRaisesRegex(ValueError, "not authorized"):
                    sdk.command(transport.run_id, transport.session_command)

    def test_lost_command_response_keeps_original_idempotency_scope(self):
        transport = SessionTransport(); sdk = client(transport, verifier=None)
        failed = [False]

        def lose_once(path, value):
            if path.endswith("/commands") and not failed[0]:
                failed[0] = True
                raise ConnectionError("Lost command response")
            return value

        transport.mutate = lose_once
        with self.assertRaises(ConnectionError):
            sdk.command(transport.run_id, transport.session_command)
        changed = copy.deepcopy(transport.session_command); changed["argv"] = ["other"]
        with self.assertRaisesRegex(ValueError, "different work"):
            sdk.command(transport.run_id, changed)
        self.assertEqual(sdk.command(transport.run_id, transport.session_command)["stdout"], "ok")
        self.assertEqual([key for path, _, _, key in transport.calls if path.endswith("/commands")], ["write", "write"])

    def test_command_and_event_boundaries_fail_before_network(self):
        transport = SessionTransport(); sdk = client(transport, verifier=None)
        for mutation in (lambda c: c.update(commandId="bad/id"), lambda c: c.update(commandId="x" * 65),
                         lambda c: c.update(argv=[]), lambda c: c.update(argv=[""]),
                         lambda c: c.update(argv=["x" * 4097]), lambda c: c.update(stdin="\0"),
                         lambda c: c.update(stdin="🧬" * 2049), lambda c: c.update(extra=True)):
            command = copy.deepcopy(transport.session_command); mutation(command)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                sdk.command(transport.run_id, command)
        self.assertEqual(transport.calls, [])
        for cursor in ((True, 8), (-2, 8), (4096, 8), (-1, 0), (-1, 9), (-1, 1.0)):
            with self.subTest(cursor=cursor), self.assertRaises(ValueError):
                sdk.session_events(transport.run_id, after_sequence=cursor[0], limit=cursor[1])
        self.assertEqual(transport.calls, [])

    def test_bounded_event_pages_roles_and_sequence_tampering(self):
        for vault in (False, True):
            transport = SessionTransport(vault); sdk = client(transport, vault=vault, verifier=None)
            page = sdk.session_events(transport.run_id, after_sequence=1, limit=2)
            self.assertEqual([event["sequence"] for event in page["events"]], [2, 3])
            self.assertEqual(page["nextSequence"], 3)
            page["events"][0]["text"] = "mutated"
            self.assertEqual(sdk.session_events(transport.run_id, after_sequence=1, limit=2)["events"][0]["text"], "ok")
            mutations = (lambda r: r["events"][0].update(sequence=3), lambda r: r.update(nextSequence=2),
                         lambda r: r.update(eventCount=1), lambda r: r.update(state="paid"),
                         lambda r: r["events"][0].update(text="\ud800"), lambda r: r.update(extra=True))
            for mutate in mutations:
                transport.mutate = lambda path, value, change=mutate: (change(value) or value) if "/events?" in path else value
                with self.subTest(vault=vault, change=mutate), self.assertRaises(ValueError):
                    sdk.session_events(transport.run_id, after_sequence=1, limit=2)
            transport.mutate = lambda path, value: value
            transport.vector["run"]["admissionTx"] = None
            with self.assertRaisesRegex(ValueError, "not been admitted"):
                sdk.session_events(transport.run_id)
            if vault:
                transport.vector["run"]["admissionTx"] = FIXTURE["execVault"]["admissionHash"]
                transport.principal = FIXTURE["owner"]
                self.assertEqual(sdk.session_events(transport.run_id)["events"][0]["kind"], "ready")
                transport.principal = "0x" + "ab" * 20
                with self.assertRaisesRegex(ValueError, "not authorized"):
                    sdk.session_events(transport.run_id)


@unittest.skipUnless(CRYPTO, "Optional Ethereum crypto adapter is not installed")
class PlatformCryptoTests(unittest.TestCase):
    def test_signed_inference_only_quote_and_run_bind_policy_prompt_and_fixed_price(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        transport = ScriptedTransport(); sdk = client(transport)
        near = {"model": "z-ai/glm-5.3-flash", "maxTokens": 32,
                "policySha256": "0x" + "a1" * 32, "inferencePrice": "1000"}
        transport.config.update(near=near, nearInferenceTask="near_inference")
        request = {**copy.deepcopy(FIXTURE["input"]), "task": {"kind": "near_inference"}, "maxSpend": "2000",
                   "near": {"model": near["model"], "maxTokens": near["maxTokens"],
                            "policySha256": near["policySha256"], "prompt": "A bounded model request"}}
        prepared = transport.vector["prepared"]
        prepared["input"] = copy.deepcopy(request)
        quote = prepared["quote"]
        quote["inferencePrice"] = near["inferencePrice"]
        quote["workloadHash"] = "0x" + CRYPTO.keccak256(_canonical({
            "protocol": "telomere-platform-near-v1", "task": request["task"], "near": request["near"]}).encode("utf-8")).hex()
        base = quote["maxSeconds"] * int(quote["pricePerSecond"]) + int(quote["inferencePrice"])
        prepared["ceiling"] = str(base + (base * 900 + 9999) // 10000)
        domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337,
                  "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
        prepared["signature"] = "0x" + Account.sign_message(
            encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, quote)),
            "0x" + "11" * 32).signature.hex()
        prepared["transaction"]["data"] = sdk._encode_open(quote, prepared["signature"],
                                                                prepared["imageProof"], prepared["regionProof"])
        accepted = sdk.quote(request, idempotency_key="verified-near-only")
        self.assertEqual(accepted["ceiling"], prepared["ceiling"])
        self.assertEqual(sdk.open_plan(accepted), prepared["transaction"])
        run = transport.vector["run"]
        run["quote"] = copy.deepcopy(quote); run["ceiling"] = prepared["ceiling"]
        run["nearResult"] = None; run["executionKind"] = "near_inference"
        run["status"] = "near_dispatching"
        self.assertEqual(sdk.list()["runs"][0]["status"], "near_dispatching")
        self.assertEqual(sdk.get(run["id"])["executionKind"], "near_inference")
        run["settlement"] = {"runId": run["id"], "billableSeconds": 0, "endedAt": FIXTURE["epoch"],
                             "inferenceCharge": near["inferencePrice"], "receiptHash": "0x" + "a2" * 32}
        self.assertEqual(sdk.get(run["id"])["settlement"]["inferenceCharge"], near["inferencePrice"])
        run["settlement"]["billableSeconds"] = 1
        with self.assertRaisesRegex(ValueError, "cannot bill CPU"):
            sdk.get(run["id"])
        run["settlement"] = None
        prepared["input"]["near"]["prompt"] = "changed prompt"
        with self.assertRaises(ValueError):
            client(transport).quote(request, idempotency_key="near-tampered-prompt")
        prepared["input"] = copy.deepcopy(request)
        quote["inferencePrice"] = "999"
        with self.assertRaises(ValueError):
            client(transport).quote(request, idempotency_key="near-tampered-price")

    def test_paid_session_quote_is_opted_in_signed_and_rechecked_before_wallet_plan(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        for vault in (False, True):
            transport = SessionTransport(vault); sdk = client(transport, vault=vault)
            request = copy.deepcopy(FIXTURE["execInput"])
            request["task"] = {"kind": "session", "imageDigest": request["task"]["imageDigest"], "maxCommands": 4}
            prepared = transport.vector["prepared"]
            prepared["input"] = copy.deepcopy(request)
            quote = prepared["quote"]
            quote["workloadHash"] = "0x" + CRYPTO.keccak256(_canonical({"task": request["task"]}).encode("utf-8")).hex()
            domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337,
                      "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
            prepared["signature"] = "0x" + Account.sign_message(
                encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, quote)), "0x" + "11" * 32).signature.hex()
            prepared["transaction"]["data"] = sdk._encode_open(quote, prepared["signature"], prepared["imageProof"], prepared["regionProof"])
            actual = sdk.quote(request, idempotency_key="paid-session-quote")
            self.assertEqual(actual["transaction"], prepared["transaction"])
            self.assertEqual(sdk.open_plan(actual), prepared["transaction"])
            prepared["input"]["task"]["maxCommands"] = 5
            with self.assertRaises(ValueError):
                client(transport, vault=vault).quote(request, idempotency_key="altered-session-response")
            prepared["input"] = copy.deepcopy(request)
            del transport.config["capacity"][0]["sessionEnabled"]
            with self.assertRaises(ValueError):
                sdk.open_plan(actual)
            with self.assertRaises(ValueError):
                sdk.quote(request, idempotency_key="paid-session-quote")

    def test_python_eip712_hash_and_abi_independently_match_actual_viem_vectors(self):
        from eth_abi import encode
        from eth_account.messages import encode_typed_data
        from eth_utils import keccak
        tuple_type = "(bytes32,bytes32,bytes32,address,uint16,bytes32,bytes32,bytes32,uint64,uint96,uint96,uint64)"
        for name in ("eoa", "vault", "emptyProofs", "execEoa", "execVault"):
            vector = FIXTURE[name]; q = vector["prepared"]["quote"]
            message = _typed({"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337, "verifyingContract": FIXTURE["pins"]["escrowAddress"]}, "PlatformQuote", QUOTE_FIELDS, q)
            encoded = encode_typed_data(full_message=message)
            self.assertEqual("0x" + keccak(b"\x19" + encoded.version + encoded.header + encoded.body).hex(), vector["quoteDigest"])
            self.assertTrue(CRYPTO.verify_typed_data(FIXTURE["pins"]["quoteSigner"], message, vector["prepared"]["signature"]))
            values = tuple(bytes.fromhex(q[key][2:]) if kind == "bytes32" else int(q[key]) if kind.startswith("uint") else q[key] for key, kind in QUOTE_FIELDS)
            args = encode([tuple_type, "bytes", "bytes32[]", "bytes32[]"], [values, bytes.fromhex(vector["prepared"]["signature"][2:]),
                [bytes.fromhex(item[2:]) for item in vector["prepared"]["imageProof"]], [bytes.fromhex(item[2:]) for item in vector["prepared"]["regionProof"]]])
            vault = name in ("vault", "execVault"); command = name.startswith("exec")
            function = "payRun" if vault else "openRun"
            expected = "0x" + (keccak(text=function + "(" + tuple_type + ",bytes,bytes32[],bytes32[])")[:4] + args).hex()
            self.assertEqual(expected, vector["prepared"]["transaction"]["data"])
            transport = ScriptedTransport(vault, command=command); transport.vector = copy.deepcopy(vector)
            self.assertEqual(client(transport, vault=vault).quote(FIXTURE["execInput" if command else "input"], idempotency_key="independent-vector")["transaction"]["data"], expected)

    def test_exec_eoa_and_vault_preserve_unsigned_financial_flow(self):
        for vault in (False, True):
            with self.subTest(vault=vault):
                transport = ScriptedTransport(vault, command=True); sdk = client(transport, vault=vault)
                prepared = sdk.quote(FIXTURE["execInput"], idempotency_key="original-exec-work")
                self.assertEqual(prepared["input"]["task"]["stdin"], "Telomere проверка 🧬\n")
                self.assertEqual(sdk.open_plan(prepared), transport.vector["prepared"]["transaction"])
                run = sdk.admit({"runId": transport.run_id, "transactionHash": transport.vector["admissionHash"]}, idempotency_key="original-exec-admit")
                self.assertEqual(run["ceiling"], "331")
                if vault:
                    transport.principal = FIXTURE["owner"]
                self.assertEqual(sdk.stop_plan(run["id"], idempotency_key="original-exec-stop"), transport.vector["actions"]["stop"])
                self.assertEqual(sdk.refund_plan(run["id"], idempotency_key="original-exec-refund"), transport.vector["actions"]["refund"])
                self.assertTrue(all(path.startswith("/api/platform") or path == "/api/me" for path, *_ in transport.calls))

    def test_exec_requires_matching_opted_in_host_before_request_and_on_cached_plan(self):
        for vault in (False, True):
            for change in ("capability", "image"):
                transport = ScriptedTransport(vault, command=True)
                if change == "capability":
                    del transport.config["capacity"][0]["execEnabled"]
                else:
                    transport.config["capacity"][0]["imageDigest"] = "sha256:" + "b" * 64
                with self.subTest(vault=vault, change=change), self.assertRaisesRegex(ValueError, "No reviewed host"):
                    client(transport, vault=vault).quote(FIXTURE["execInput"], idempotency_key="no-exec-capacity")
                self.assertFalse(any(path.endswith("/quotes") for path, *_ in transport.calls))
            transport = ScriptedTransport(vault, command=True); sdk = client(transport, vault=vault)
            prepared = sdk.quote(FIXTURE["execInput"], idempotency_key="revocable-exec-work")
            del transport.config["capacity"][0]["execEnabled"]
            for operation in (lambda: sdk.open_plan(prepared), lambda: sdk.quote(FIXTURE["execInput"], idempotency_key="revocable-exec-work")):
                with self.subTest(vault=vault), self.assertRaises(ValueError):
                    operation()

    def test_exec_selected_host_must_enable_exec_even_if_another_host_does(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault, command=True)
            other = copy.deepcopy(transport.config["capacity"][0]); other["hostId"] = "0x" + "ab" * 32
            transport.config["capacity"].append(other); del transport.config["capacity"][0]["execEnabled"]
            with self.subTest(vault=vault), self.assertRaises(ValueError):
                client(transport, vault=vault).quote(FIXTURE["execInput"], idempotency_key="wrong-selected-exec")
            self.assertTrue(any(path.endswith("/quotes") for path, *_ in transport.calls))

    def test_exec_selected_image_cannot_change_even_with_valid_operator_signature(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        for vault in (False, True):
            transport = ScriptedTransport(vault, command=True); sdk = client(transport, vault=vault)
            other = copy.deepcopy(transport.config["capacity"][0]); other["hostId"] = "0x" + "ab" * 32
            transport.config["capacity"].append(other)
            host = transport.config["capacity"][0]; host["imageDigest"] = "sha256:" + "b" * 64
            prepared = transport.vector["prepared"]; prepared["quote"]["imageHash"] = "0x" + CRYPTO.keccak256(host["imageDigest"].encode()).hex()
            domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337, "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
            prepared["signature"] = "0x" + Account.sign_message(encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, prepared["quote"])), "0x" + "11" * 32).signature.hex()
            prepared["transaction"]["data"] = sdk._encode_open(prepared["quote"], prepared["signature"], prepared["imageProof"], prepared["regionProof"])
            with self.subTest(vault=vault), self.assertRaises(ValueError):
                sdk.quote(FIXTURE["execInput"], idempotency_key="signed-wrong-exec-image")

    def test_exec_argv_stdin_scope_signature_and_calldata_tampering_are_rejected(self):
        mutations = [lambda p: p["input"]["task"].update(argv=["node", "another-workload"]),
                     lambda p: p["input"]["task"].update(stdin="different input"),
                     lambda p: p["input"]["task"].update(imageDigest="sha256:" + "b" * 64),
                     lambda p: p["quote"].update(workloadHash="0x" + "ab" * 32),
                     lambda p: p["quote"].update(payer=FIXTURE["agent"]), lambda p: p.update(ceiling="303"),
                     lambda p: p.update(signature="0x" + "00" * 65),
                     lambda p: p["transaction"].update(data=p["transaction"]["data"] + "00")]
        for vault in (False, True):
            for index, mutate in enumerate(mutations):
                transport = ScriptedTransport(vault, command=True); mutate(transport.vector["prepared"])
                with self.subTest(vault=vault, change=index), self.assertRaises(ValueError):
                    client(transport, vault=vault).quote(FIXTURE["execInput"], idempotency_key="tampered-exec-work")

    def test_eoa_and_vault_quote_open_admit_and_unsigned_actions(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = client(transport, vault=vault); vector = transport.vector
            prepared = sdk.quote(FIXTURE["input"], idempotency_key="original-platform-work")
            self.assertEqual(sdk.open_plan(prepared), prepared["transaction"])
            run = sdk.admit({"runId": vector["run"]["id"], "transactionHash": vector["admissionHash"]}, idempotency_key="original-platform-admission")
            self.assertEqual(run["admissionTx"], vector["admissionHash"])
            if vault:
                transport.principal = FIXTURE["owner"]
            self.assertEqual(sdk.stop_plan(run["id"], idempotency_key="original-stop-plan")["data"], vector["actions"]["stop"]["data"])
            self.assertEqual(sdk.refund_plan(run["id"], idempotency_key="original-refund-plan")["data"], vector["actions"]["refund"]["data"])
            self.assertTrue(all(path.startswith("/api/platform") or path == "/api/me" for path, *_ in transport.calls))

    def test_excluded_host_is_preserved_and_cannot_be_silently_selected(self):
        excluded = FIXTURE["config"]["capacity"][0]["hostId"]
        for vault in (False, True):
            transport = ScriptedTransport(vault)
            second = copy.deepcopy(transport.config["capacity"][0]); second["hostId"] = "0x" + "ab" * 32
            transport.config["capacity"].append(second)
            request = copy.deepcopy(FIXTURE["input"]); request["excludedHostIds"] = [excluded]
            transport.vector["prepared"]["input"] = copy.deepcopy(request)
            with self.subTest(vault=vault), self.assertRaisesRegex(ValueError, "quote changed"):
                client(transport, vault=vault).quote(request, idempotency_key="exclude-source-host")
            for invalid in ([excluded, excluded], ["0x" + "ab" * 32] * 17, ["not-a-host"]):
                request["excludedHostIds"] = invalid
                with self.subTest(vault=vault, invalid=invalid), self.assertRaises(ValueError):
                    client(transport, vault=vault).quote(request, idempotency_key="invalid-exclusion")

    def test_quote_singleflight_retry_and_defensive_copy_preserve_original_work(self):
        transport = ScriptedTransport(); sdk = client(transport)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: sdk.quote(FIXTURE["input"], idempotency_key="same-threaded-work"), range(4)))
        self.assertEqual(sum(path.endswith("/quotes") for path, *_ in transport.calls), 1)
        results[0]["quote"]["payer"] = "0x" + "ab" * 20
        self.assertEqual(sdk.quote(FIXTURE["input"], idempotency_key="same-threaded-work")["quote"]["payer"], FIXTURE["owner"].lower())
        changed = copy.deepcopy(FIXTURE["input"]); changed["maxSpend"] = "332"
        with self.assertRaisesRegex(ValueError, "different work"):
            sdk.quote(changed, idempotency_key="same-threaded-work")
        transport = ScriptedTransport(); transport.fail_once = True; sdk = client(transport)
        with self.assertRaises(ConnectionError):
            sdk.quote(FIXTURE["input"], idempotency_key="lost-platform-response")
        self.assertEqual(sdk.quote(FIXTURE["input"], idempotency_key="lost-platform-response")["quote"]["runId"], FIXTURE["eoa"]["run"]["id"])

    def test_both_proof_arrays_accept_64_siblings_and_reject_65(self):
        from eth_abi import encode
        from eth_utils import keccak
        tuple_type = "(bytes32,bytes32,bytes32,address,uint16,bytes32,bytes32,bytes32,uint64,uint96,uint96,uint64)"
        for vault in (False, True):
            for count in (0, 1, 64):
                transport = ScriptedTransport(vault); p = transport.vector["prepared"]; q = p["quote"]
                p["imageProof"] = ["0x" + "ab" * 32] * count; p["regionProof"] = ["0x" + "cd" * 32] * count
                values = tuple(bytes.fromhex(q[key][2:]) if kind == "bytes32" else int(q[key]) if kind.startswith("uint") else q[key] for key, kind in QUOTE_FIELDS)
                args = encode([tuple_type, "bytes", "bytes32[]", "bytes32[]"], [values, bytes.fromhex(p["signature"][2:]),
                    [bytes.fromhex(item[2:]) for item in p["imageProof"]], [bytes.fromhex(item[2:]) for item in p["regionProof"]]])
                function = "payRun" if vault else "openRun"
                p["transaction"]["data"] = "0x" + (keccak(text=function + "(" + tuple_type + ",bytes,bytes32[],bytes32[])")[:4] + args).hex()
                with self.subTest(vault=vault, siblings=count):
                    self.assertEqual(client(transport, vault=vault).quote(FIXTURE["input"], idempotency_key="maximum-proof-case")["transaction"]["data"], p["transaction"]["data"])
            for key in ("imageProof", "regionProof"):
                transport = ScriptedTransport(vault); transport.vector["prepared"][key] = ["0x" + "ab" * 32] * 65
                with self.subTest(vault=vault, array=key), self.assertRaisesRegex(ValueError, "64 siblings"):
                    client(transport, vault=vault).quote(FIXTURE["input"], idempotency_key="oversized-proof-case")

    def test_nonboolean_signature_verdict_and_invalid_clock_are_rejected(self):
        class TruthyVerifier:
            def keccak256(self, value): return CRYPTO.keccak256(value)
            def verify_typed_data(self, *args): return 1
        with self.assertRaisesRegex(ValueError, "signature"):
            client(verifier=TruthyVerifier()).quote(FIXTURE["input"], idempotency_key="truthy-verdict-case")
        for now in (True, float("nan"), float("inf"), -1, 2 ** 53):
            with self.subTest(clock=now), self.assertRaises(ValueError):
                client(clock=lambda: now).quote(FIXTURE["input"], idempotency_key="invalid-clock-case")

    def test_expiry_and_changed_session_are_rechecked_for_cached_quotes(self):
        transport = ScriptedTransport(); now = [FIXTURE["epoch"]]; sdk = client(transport, clock=lambda: now[0])
        sdk.quote(FIXTURE["input"], idempotency_key="cached-platform-work"); now[0] += 61
        with self.assertRaises(ValueError):
            sdk.quote(FIXTURE["input"], idempotency_key="cached-platform-work")
        now[0] = FIXTURE["epoch"]; transport.principal = "0x" + "ab" * 20
        with self.assertRaises(ValueError):
            sdk.quote(FIXTURE["input"], idempotency_key="cached-platform-work")

    def test_vault_quote_admit_stop_roles_and_leash_cannot_be_widened(self):
        transport = ScriptedTransport(True); sdk = client(transport, vault=True)
        with self.assertRaisesRegex(ValueError, "not authorized"):
            sdk.stop_plan(transport.vector["run"]["id"], idempotency_key="agent-cannot-stop")
        transport.principal = FIXTURE["owner"]
        with self.assertRaisesRegex(ValueError, "not authorized"):
            sdk.quote(FIXTURE["input"], idempotency_key="owner-cannot-run")
        with self.assertRaisesRegex(ValueError, "not authorized"):
            sdk.admit({"runId": transport.vector["run"]["id"], "transactionHash": transport.vector["admissionHash"]}, idempotency_key="owner-cannot-admit")
        transport.principal = FIXTURE["agent"]; changed = copy.deepcopy(FIXTURE["input"]); changed["leashId"] = "0x" + "ab" * 32
        with self.assertRaisesRegex(ValueError, "Leash"):
            sdk.quote(changed, idempotency_key="agent-other-leash")

    def test_full_quote_scope_signature_fee_and_both_dynamic_proofs_are_checked(self):
        mutations = [lambda p: p.update(signature="0x" + "11" * 65), lambda p: p["quote"].update(payer="0x" + "ab" * 20),
                     lambda p: p["quote"].update(hwClass=True), lambda p: p["quote"].update(maxSeconds=3.0), lambda p: p["quote"].update(pricePerSecond=str(2 ** 96)),
                     lambda p: p["quote"].update(pricePerSecond="0101"), lambda p: p["quote"].update(inferencePrice="1"),
                     lambda p: p["input"]["task"].update(text="substituted work"), lambda p: p["input"].update(maxSpend="9999"),
                     lambda p: p["quote"].update(hostId="0x" + "ab" * 32), lambda p: p["quote"].update(imageHash="0x" + "ab" * 32),
                     lambda p: p["quote"].update(regionHash="0x" + "ab" * 32), lambda p: p["quote"].update(workloadHash="0x" + "ab" * 32),
                     lambda p: p.update(ceiling="330"), lambda p: p["quote"].update(quoteExpiry=FIXTURE["epoch"] - 1),
                     lambda p: p["quote"].update(quoteExpiry=FIXTURE["epoch"] + 121), lambda p: p.update(imageProof=[]),
                     lambda p: p.update(regionProof=[]), lambda p: p.update(regionProof=p["regionProof"] * 65),
                     lambda p: p["transaction"].update(to=FIXTURE["owner"]), lambda p: p["transaction"].update(chainId=46630),
                     lambda p: p["transaction"].update(value="1"), lambda p: p["transaction"].update(data=p["transaction"]["data"] + "00")]
        for vault in (False, True):
            for mutate in mutations:
                transport = ScriptedTransport(vault); mutate(transport.vector["prepared"])
                with self.subTest(vault=vault, change=mutations.index(mutate)), self.assertRaises(ValueError):
                    client(transport, vault=vault).quote(FIXTURE["input"], idempotency_key="bad-platform-quote")

    def test_wrong_eip712_signer_or_domain_fails_even_when_calldata_is_reencoded(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        for change in ("signer", "domain", "chain"):
            transport = ScriptedTransport(); prepared = transport.vector["prepared"]
            domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337, "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
            if change == "domain": domain["name"] = "TelomereRunEscrow"
            if change == "chain": domain["chainId"] = 46630
            key = "0x" + ("22" if change == "signer" else "11") * 32
            signature = "0x" + Account.sign_message(encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, prepared["quote"])), key).signature.hex()
            prepared["signature"] = signature
            sdk = client(transport)
            prepared["transaction"]["data"] = sdk._encode_open(prepared["quote"], signature, prepared["imageProof"], prepared["regionProof"])
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "signature"):
                sdk.quote(FIXTURE["input"], idempotency_key="wrong-domain-quote")

    def test_action_calldata_and_admission_hash_cannot_be_substituted(self):
        for vault in (False, True):
            for action in ("stop", "refund"):
                for field, changed in (("to", FIXTURE["owner"]), ("chainId", 46630), ("chainId", True), ("chainId", 31337.0), ("data", "0x1234"), ("value", "1")):
                    transport = ScriptedTransport(vault); transport.principal = FIXTURE["owner"]
                    transport.vector["actions"][action][field] = changed
                    with self.subTest(vault=vault, action=action, field=field), self.assertRaises(ValueError):
                        getattr(client(transport, vault=vault), action + "_plan")(transport.vector["run"]["id"], idempotency_key="bad-action-plan")
            transport = ScriptedTransport(vault); transport.vector["run"]["admissionTx"] = "0x" + "ab" * 32
            with self.assertRaisesRegex(ValueError, "original reservation"):
                client(transport, vault=vault).admit({"runId": transport.vector["run"]["id"], "transactionHash": transport.vector["admissionHash"]}, idempotency_key="bad-admission-hash")

    def test_input_bounds_body_limit_and_non_ethereum_hash_fail_closed(self):
        mutations = [lambda b: b.update(maxSeconds=True), lambda b: b.update(deadline=2 ** 53), lambda b: b.update(maxSpend=str(2 ** 96)),
                     lambda b: b.update(nearPrompt="unpriced"), lambda b: b.update(regions=["x"] * 33), lambda b: b.update(regions=["../other"]),
                     lambda b: b["task"].update(iterations=2_000_001), lambda b: b["task"].update(text="x" * 8193),
                     lambda b: b.update(task={"kind": "sort", "numbers": [1_000_000_000] * 10000})]
        for mutate in mutations:
            body = copy.deepcopy(FIXTURE["input"]); mutate(body)
            with self.subTest(change=mutations.index(mutate)), self.assertRaises(ValueError):
                client().quote(body, idempotency_key="bad-input-platform")
        class Sha3:
            def keccak256(self, value): return hashlib.sha3_256(value).digest()
        with self.assertRaisesRegex(ValueError, "Ethereum Keccak"):
            client(verifier=Sha3()).quote(FIXTURE["input"], idempotency_key="sha3-is-not-keccak")


class PlatformHttpTests(unittest.TestCase):
    def setUp(self):
        self.server = FixtureServer(); self.transport = ApiTransport(self.server.origin, timeout=2)
        self.responses = {"/api/config": PILOT_FIXTURE["config"], "/api/auth/demo": {"address": FIXTURE["owner"], "demo": True},
                          "/api/platform/config": FIXTURE["config"], "/api/me": {"address": FIXTURE["owner"], "demo": False},
                          "/api/platform/balance": {"available": "1000000"}, "/api/platform/quotes": FIXTURE["eoa"]["prepared"]}
        self.server.response = lambda path: (200, {}, json.dumps(self.responses[path]).encode("utf-8"))

    def tearDown(self):
        self.server.close()

    def test_actual_http_read_uses_existing_bounded_transport(self):
        sdk = PlatformRuntimeClient(self.server.origin, pins=FIXTURE["pins"], transport=self.transport)
        self.assertEqual(sdk.balance(), {"available": "1000000"})
        self.assertEqual([entry[0] for entry in self.server.requests], ["/api/platform/config", "/api/me", "/api/platform/balance"])

    def test_actual_http_paid_session_command_and_events_use_exact_scoped_idempotency(self):
        token = "ab" * 32
        self.server.response = lambda path: (200, {"Set-Cookie": f"telomere_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"},
                                             json.dumps(self.responses[path]).encode("utf-8"))
        for vault in (False, True):
            with self.subTest(vault=vault):
                scripted = SessionTransport(vault); prefix = scripted.path; run_id = scripted.run_id
                command_path = prefix + "/runs/" + run_id + "/commands"
                event_path = prefix + "/runs/" + run_id + "/events?after=-1&limit=8"
                self.responses.update({prefix + "/config": scripted.config,
                                       "/api/me": {"address": scripted.principal, "demo": False},
                                       prefix + "/runs/" + run_id: scripted.vector["run"],
                                       command_path: scripted.command_result,
                                       event_path: {"events": scripted.events, "nextSequence": 4,
                                                    "eventCount": 5, "state": "stopped"}})
                options = {"pins": FIXTURE["pins"], "transport": self.transport}
                sdk = (PlatformVaultRuntimeClient(self.server.origin, vault=FIXTURE["binding"]["vault"],
                                                  vault_pins=FIXTURE["vaultPins"], binding=FIXTURE["binding"], **options)
                       if vault else PlatformRuntimeClient(self.server.origin, **options))
                with patch.object(self.transport._opener, "open", wraps=self.transport._opener.open) as http_open:
                    self.assertEqual(sdk.command(run_id, scripted.session_command)["stdout"], "ok")
                    self.assertEqual(sdk.session_events(run_id)["eventCount"], 5)
                timed = [(call.args[0].full_url, call.kwargs["timeout"]) for call in http_open.call_args_list]
                self.assertEqual([timeout for url, timeout in timed if url.endswith(command_path)], [130])
                self.assertTrue(all(timeout == self.transport.timeout for url, timeout in timed if not url.endswith(command_path)))
                sent = next(entry for entry in self.server.requests if entry[0] == command_path)
                self.assertEqual(sent[1], "POST")
                self.assertEqual(sent[2]["Idempotency-Key"], "write")
                self.assertEqual(sent[2]["Origin"], self.server.origin)
                self.assertEqual(sent[2]["Cookie"], "telomere_session=" + token)
                self.assertEqual(json.loads(sent[3]), scripted.session_command)
                self.assertTrue(any(entry[0] == event_path for entry in self.server.requests))
                with self.assertRaisesRegex(ValueError, "must match"):
                    self.transport.request(command_path, method="POST", body=scripted.session_command,
                                           idempotency_key="different")
                for path, timeout in ((command_path, 131), (command_path, True), (prefix + "/config", 130)):
                    with self.assertRaisesRegex(ValueError, "130-second"):
                        self.transport.request(path, method="POST", body=scripted.session_command,
                                               idempotency_key="write", command_timeout=timeout)

    @unittest.skipUnless(CRYPTO, "Optional Ethereum crypto adapter is not installed")
    def test_actual_http_quote_preserves_scoped_cookie_origin_and_idempotency_without_wallet_calls(self):
        token = "ab" * 32
        self.server.response = lambda path: (200, {"Set-Cookie": f"telomere_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"},
                                             json.dumps(self.responses.get(path, {"ok": True})).encode("utf-8"))
        TelomereClient(self.server.origin, verifier=CRYPTO, transport=self.transport).authenticate_demo(explicitly_enabled=True)
        sdk = PlatformRuntimeClient(self.server.origin, pins=FIXTURE["pins"], transport=self.transport, verifier=CRYPTO, clock=lambda: FIXTURE["epoch"])
        result = sdk.quote(FIXTURE["input"], idempotency_key="actual-http-platform")
        self.assertEqual(result["transaction"]["data"], FIXTURE["eoa"]["prepared"]["transaction"]["data"])
        quoted = next(entry for entry in self.server.requests if entry[0] == "/api/platform/quotes")
        self.assertEqual(quoted[2]["Origin"], self.server.origin)
        self.assertEqual(quoted[2]["Cookie"], "telomere_session=" + token)
        self.assertEqual(quoted[2]["Idempotency-Key"], "actual-http-platform")
        self.assertEqual(json.loads(quoted[3]), FIXTURE["input"])

    @unittest.skipUnless(CRYPTO, "Optional Ethereum crypto adapter is not installed")
    def test_actual_http_exec_eoa_and_vault_keep_exact_unicode_input_and_unsigned_plans(self):
        token = "ab" * 32
        self.server.response = lambda path: (200, {"Set-Cookie": f"telomere_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"},
                                             json.dumps(self.responses.get(path, {"ok": True})).encode("utf-8"))
        TelomereClient(self.server.origin, verifier=CRYPTO, transport=self.transport).authenticate_demo(explicitly_enabled=True)
        for vault in (False, True):
            with self.subTest(vault=vault):
                prefix = "/api/platform" + ("/vaults/" + FIXTURE["binding"]["vault"] if vault else "")
                vector = FIXTURE["execVault" if vault else "execEoa"]
                self.responses.update({prefix + "/config": FIXTURE["execVaultConfig" if vault else "execConfig"],
                                       "/api/me": {"address": FIXTURE["agent" if vault else "owner"], "demo": False},
                                       prefix + "/quotes": vector["prepared"]})
                options = {"pins": FIXTURE["pins"], "transport": self.transport, "verifier": CRYPTO, "clock": lambda: FIXTURE["epoch"]}
                sdk = (PlatformVaultRuntimeClient(self.server.origin, vault=FIXTURE["binding"]["vault"], vault_pins=FIXTURE["vaultPins"], binding=FIXTURE["binding"], **options)
                       if vault else PlatformRuntimeClient(self.server.origin, **options))
                prepared = sdk.quote(FIXTURE["execInput"], idempotency_key="actual-http-exec-work")
                self.assertEqual(sdk.open_plan(prepared), vector["prepared"]["transaction"])
                quoted = next(entry for entry in self.server.requests if entry[0] == prefix + "/quotes")
                self.assertEqual(quoted[2]["Origin"], self.server.origin)
                self.assertEqual(quoted[2]["Cookie"], "telomere_session=" + token)
                self.assertEqual(quoted[2]["Idempotency-Key"], "actual-http-exec-work")
                self.assertEqual(json.loads(quoted[3]), FIXTURE["execInput"])
        self.assertFalse(any("/demo/" in entry[0] or "broadcast" in entry[0] for entry in self.server.requests))


if __name__ == "__main__":
    unittest.main()
