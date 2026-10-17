"""Checked public CPU-profile and opt-in financial-domain parity; no transaction submission."""
from __future__ import annotations

import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import PlatformRuntimeClient, PlatformVaultRuntimeClient
from telomere_sdk.client import _canonical, _typed
from telomere_sdk.platform import QUOTE_FIELDS, CPU_PROFILE_QUOTAS, _input, _pins, _session_policy
from test_platform import CRYPTO, FIXTURE, ScriptedTransport

FINANCIAL_PROFILE = {"kind": "tlmr_economics_v2", "stakingAddress": "0x" + "ab" * 20,
                     "stakingCodeHash": "0x" + "ac" * 32, "utilityTokenAddress": "0x" + "ad" * 20,
                     "utilityTokenCodeHash": "0x" + "ae" * 32}


def configured_client(transport, *, economics=False):
    pins = copy.deepcopy(FIXTURE["pins"])
    if economics:
        pins["financialProfile"] = copy.deepcopy(FINANCIAL_PROFILE)
    transport.config["pins"] = copy.deepcopy(pins)
    options = {"pins": pins, "verifier": CRYPTO, "transport": transport, "clock": lambda: FIXTURE["epoch"]}
    if transport.vault:
        return PlatformVaultRuntimeClient(transport.origin, vault=FIXTURE["binding"]["vault"],
                                          vault_pins=FIXTURE["vaultPins"], binding=FIXTURE["binding"], **options)
    return PlatformRuntimeClient(transport.origin, **options)


def resign(sdk, prepared, version):
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    domain = {"name": "TelomerePlatformEscrow", "version": version, "chainId": 31337,
              "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
    prepared["signature"] = "0x" + Account.sign_message(
        encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, prepared["quote"])),
        "0x" + "11" * 32).signature.hex()
    prepared["transaction"]["data"] = sdk._encode_open(prepared["quote"], prepared["signature"],
                                                       prepared["imageProof"], prepared["regionProof"])


class CpuProfileValidationTests(unittest.TestCase):
    def test_independent_cpu_receipt_version_constructor_prevents_initial_downgrade(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault)
            options = {"pins": FIXTURE["pins"], "transport": transport, "cpu_receipt_version": 2}
            sdk = (PlatformVaultRuntimeClient(transport.origin, vault=FIXTURE["binding"]["vault"], vault_pins=FIXTURE["vaultPins"],
                                               binding=FIXTURE["binding"], **options) if vault else PlatformRuntimeClient(transport.origin, **options))
            with self.assertRaisesRegex(ValueError, "downgraded"):
                sdk.config()
            transport.config["cpuReceiptVersion"] = 2
            self.assertEqual(sdk.config()["cpuReceiptVersion"], 2)
            for invalid in (True, False, 0, 3, "2", 2.0):
                options["cpu_receipt_version"] = invalid
                with self.assertRaises(ValueError):
                    if vault:
                        PlatformVaultRuntimeClient(transport.origin, vault=FIXTURE["binding"]["vault"], vault_pins=FIXTURE["vaultPins"], **options)
                    else:
                        PlatformRuntimeClient(transport.origin, **options)

    def test_observed_cpu_v2_cannot_drop_its_config_marker_later_in_the_same_client(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport)
            transport.config["cpuReceiptVersion"] = 2; sdk.config()
            transport.config.pop("cpuReceiptVersion")
            with self.assertRaisesRegex(ValueError, "downgraded"):
                sdk.config()
            self.assertFalse(any(method == "POST" for _, method, *_ in transport.calls))

    def test_invalid_config_cannot_promote_the_observed_cpu_protocol_floor(self):
        mutations = (lambda c: c["pins"].update(quoteSigner="0x" + "af" * 20),
                     lambda c: c.update(protocol="unreviewed"),
                     lambda c: c["capacity"][0].update(hardwareClass="gpu"))
        for vault in (False, True):
            checks = mutations + ((lambda c: c["binding"].update(owner="0x" + "af" * 20),) if vault else ())
            for mutate in checks:
                transport = ScriptedTransport(vault); sdk = configured_client(transport)
                valid_config = copy.deepcopy(transport.config)
                transport.config["cpuReceiptVersion"] = 2; mutate(transport.config)
                with self.assertRaises(ValueError):
                    sdk.config()
                transport.config = copy.deepcopy(valid_config)
                self.assertNotIn("cpuReceiptVersion", sdk.config())
                self.assertFalse(any(method == "POST" for _, method, *_ in transport.calls))

    def test_never_dispatched_controller_observation_is_exact_terminal_and_zero_charge(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport)
            run = transport.vector["run"]
            run.update(status="refunded", charged="0", refund=run["ceiling"],
                       cpuDispatch={"state": "never_dispatched", "confirmed": True, "admissionTx": run["admissionTx"]})
            self.assertEqual(sdk.get(run["id"])["cpuDispatch"], run["cpuDispatch"])
            original = copy.deepcopy(run)
            for change in (lambda r: r["cpuDispatch"].update(state="dispatched"), lambda r: r["cpuDispatch"].update(confirmed=1),
                           lambda r: r["cpuDispatch"].update(admissionTx="0x" + "ab" * 32), lambda r: r["cpuDispatch"].update(extra=True),
                           lambda r: r.update(status="running"), lambda r: r.update(admissionTx=None),
                           lambda r: r.update(charged="1", refund=str(int(r["ceiling"]) - 1))):
                transport.vector["run"] = copy.deepcopy(original); change(transport.vector["run"])
                with self.assertRaises(ValueError):
                    sdk.get(run["id"])
            transport.vector["run"] = copy.deepcopy(original)
            transport.vector["run"].update(status="completed", settlement={"runId": run["id"], "billableSeconds": 0,
                                           "endedAt": FIXTURE["epoch"], "inferenceCharge": "0", "receiptHash": "0x" + "ab" * 32})
            self.assertEqual(sdk.get(run["id"])["charged"], "0")

    def test_optional_profiles_preserve_absent_workload_and_exact_cpu_policy(self):
        body = copy.deepcopy(FIXTURE["execInput"])
        body["task"] = {"kind": "session", "imageDigest": body["task"]["imageDigest"], "maxCommands": 4}
        body["maxSeconds"] = 15
        self.assertEqual(_input(body), body)
        self.assertNotIn("resourceProfile", _input(body)["task"])
        for profile, quota in CPU_PROFILE_QUOTAS.items():
            selected = copy.deepcopy(body); selected["task"]["resourceProfile"] = profile
            self.assertEqual(_input(selected), selected)
            policy = _session_policy(4, profile)
            self.assertEqual(policy["cpu"], quota)
            self.assertEqual(policy["memoryBytes"], 268_435_456)
            self.assertEqual(policy["network"], "none")
        for bad in (None, False, 1, "", "FULL", "sleep", {}, []):
            selected = copy.deepcopy(body); selected["task"]["resourceProfile"] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                _input(selected)
        selected = copy.deepcopy(FIXTURE["execInput"]); selected["task"]["resourceProfile"] = "lean"
        with self.assertRaises(ValueError):
            _input(selected)

    def test_reviewed_capacity_prices_are_strict_positive_and_ordered_for_both_clients(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault)
            host = transport.config["capacity"][0]
            host["sessionPrices"] = {"full": "200", "lean": "100", "torpor": "25"}
            sdk = configured_client(transport)
            self.assertEqual(sdk.config()["capacity"][0]["sessionPrices"], host["sessionPrices"])
            for bad in ({"full": "100", "lean": "200", "torpor": "25"}, {"full": "200", "lean": "25", "torpor": "100"},
                        {"full": "200", "lean": "100", "torpor": "0"}, {"full": "0200", "lean": "100", "torpor": "25"},
                        {"full": 200, "lean": "100", "torpor": "25"}, {"full": "200", "lean": "100"},
                        {"full": "200", "lean": "100", "torpor": "25", "extra": "1"}):
                host["sessionPrices"] = bad
                with self.subTest(vault=vault, prices=bad), self.assertRaises(ValueError):
                    sdk.config()

    def test_financial_profile_is_strict_and_cannot_alias_payment_asset(self):
        pins = copy.deepcopy(FIXTURE["pins"]); pins["financialProfile"] = copy.deepcopy(FINANCIAL_PROFILE)
        self.assertEqual(_pins(pins)["financialProfile"], FINANCIAL_PROFILE)
        for change in (lambda p: p.update(kind="v1"), lambda p: p.pop("stakingCodeHash"), lambda p: p.update(extra=True),
                       lambda p: p.update(utilityTokenAddress=p["stakingAddress"]),
                       lambda p: p.update(utilityTokenAddress=pins["tokenAddress"]), lambda p: p.update(stakingCodeHash="bad")):
            modified = copy.deepcopy(pins); change(modified["financialProfile"])
            with self.assertRaises(ValueError):
                _pins(modified)

    def test_public_cpu_receipt_marker_is_an_explicit_integer_two(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport)
            transport.config["cpuReceiptVersion"] = 2
            self.assertEqual(sdk.config()["cpuReceiptVersion"], 2)
            for bad in (True, False, None, 1, "2", 2.0):
                transport.config["cpuReceiptVersion"] = bad
                with self.assertRaises(ValueError):
                    sdk.config()

    def test_pinned_financial_profile_downgrade_or_any_identity_change_fails_before_mutation(self):
        for vault in (False, True):
            for field in (None, "stakingAddress", "stakingCodeHash", "utilityTokenAddress", "utilityTokenCodeHash"):
                transport = ScriptedTransport(vault); sdk = configured_client(transport, economics=True)
                if field is None:
                    del transport.config["pins"]["financialProfile"]
                else:
                    transport.config["pins"]["financialProfile"][field] = "0x" + ("af" * (32 if field.endswith("Hash") else 20))
                with self.subTest(vault=vault, field=field), self.assertRaisesRegex(ValueError, "reviewed pins"):
                    sdk.config()
                self.assertFalse(any(method == "POST" for _, method, *_ in transport.calls))

    def test_trusted_vault_discount_registry_is_exact_optional_independent_profile_pin(self):
        registry = {"address": FIXTURE["vaultPins"]["registryAddress"], "codeHash": FIXTURE["vaultPins"]["registryCodeHash"],
                    "implementationAddress": FIXTURE["vaultPins"]["implementationAddress"],
                    "implementationCodeHash": FIXTURE["vaultPins"]["implementationCodeHash"]}
        for vault in (False, True):
            transport = ScriptedTransport(vault)
            pins = copy.deepcopy(FIXTURE["pins"]); pins["financialProfile"] = {**FINANCIAL_PROFILE, "discountVaultRegistry": registry}
            transport.config["pins"] = copy.deepcopy(pins)
            options = {"pins": pins, "transport": transport}
            sdk = (PlatformVaultRuntimeClient(transport.origin, vault=FIXTURE["binding"]["vault"], vault_pins=FIXTURE["vaultPins"],
                                               binding=FIXTURE["binding"], **options) if vault else PlatformRuntimeClient(transport.origin, **options))
            self.assertEqual(sdk.config()["pins"]["financialProfile"]["discountVaultRegistry"], registry)
            for bad in (None, {}, {"address": registry["address"]}, {**registry, "extra": True}, {**registry, "codeHash": "bad"}):
                changed = copy.deepcopy(pins); changed["financialProfile"]["discountVaultRegistry"] = bad
                with self.assertRaises(ValueError):
                    _pins(changed)
            transport.config["pins"]["financialProfile"].pop("discountVaultRegistry")
            with self.assertRaisesRegex(ValueError, "reviewed pins"):
                sdk.config()

    def test_vault_financial_factory_and_implementation_pins_must_match_before_any_http(self):
        registry = {"address": FIXTURE["vaultPins"]["registryAddress"], "codeHash": FIXTURE["vaultPins"]["registryCodeHash"],
                    "implementationAddress": FIXTURE["vaultPins"]["implementationAddress"],
                    "implementationCodeHash": FIXTURE["vaultPins"]["implementationCodeHash"]}
        for field in registry:
            transport = ScriptedTransport(True)
            changed = copy.deepcopy(registry); changed[field] = "0x" + "af" * (32 if field.endswith("Hash") else 20)
            pins = {**FIXTURE["pins"], "financialProfile": {**FINANCIAL_PROFILE, "discountVaultRegistry": changed}}
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "reviewed economics factory"):
                PlatformVaultRuntimeClient(transport.origin, pins=pins, vault=FIXTURE["binding"]["vault"],
                                           vault_pins=FIXTURE["vaultPins"], transport=transport)
            self.assertEqual(transport.calls, [])

    def test_admission_discount_is_required_bounded_and_impossible_on_legacy_profile(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport, economics=True)
            run = transport.vector["run"]
            with self.assertRaisesRegex(ValueError, "admission fee discount"):
                sdk.get(run["id"])
            for valid in (0, 100, 200, 300):
                run["feeDiscountBps"] = valid
                self.assertEqual(sdk.get(run["id"])["feeDiscountBps"], valid)
            for bad in (None, True, False, "100", 100.0, -1, 1, 900, 400):
                run["feeDiscountBps"] = bad
                with self.subTest(vault=vault, bad=bad), self.assertRaises(ValueError):
                    sdk.get(run["id"])
            run.pop("feeDiscountBps"); run["admissionTx"] = None; run["status"] = "prepared"
            self.assertNotIn("feeDiscountBps", sdk.get(run["id"]))
            transport = ScriptedTransport(vault); sdk = configured_client(transport)
            transport.vector["run"]["feeDiscountBps"] = 100
            with self.assertRaisesRegex(ValueError, "admission fee discount"):
                sdk.get(transport.run_id)

    def test_discount_applies_only_to_fee_and_conservative_ceiling_does_not_shrink(self):
        for vault in (False, True):
            for discount in (0, 100, 200, 300):
                transport = ScriptedTransport(vault); sdk = configured_client(transport, economics=True)
                run = transport.vector["run"]; base = 303
                charged = base + (base * (900 - discount) + 9999) // 10000
                run.update(status="completed", feeDiscountBps=discount, charged=str(charged), refund=str(331 - charged),
                           settlement={"runId": run["id"], "billableSeconds": 3, "endedAt": FIXTURE["epoch"],
                                       "inferenceCharge": "0", "receiptHash": "0x" + "aa" * 32})
                self.assertEqual(sdk.get(run["id"])["charged"], str(charged))
                run["ceiling"] = str(charged)
                if discount:
                    with self.assertRaisesRegex(ValueError, "fee ceiling"):
                        sdk.get(run["id"])
                run["ceiling"] = "331"; run.update(charged=str(charged - 1), refund=str(332 - charged))
                with self.assertRaisesRegex(ValueError, "charged amount differs"):
                    sdk.get(run["id"])


@unittest.skipUnless(CRYPTO, "Optional actual Ethereum crypto adapter required")
class CpuProfileFinancialTests(unittest.TestCase):
    def test_actual_signed_session_quotes_bind_selected_price_profile_and_cpu_workload_for_both_clients(self):
        for vault in (False, True):
            for profile in (None, "full", "lean", "torpor"):
                transport = ScriptedTransport(vault, command=True); sdk = configured_client(transport)
                host = transport.config["capacity"][0]
                host.update(sessionEnabled=True, pricePerSecond="200", sessionPrices={"full": "200", "lean": "100", "torpor": "25"})
                request = copy.deepcopy(FIXTURE["execInput"])
                request.update(maxSeconds=15, maxSpend="5000")
                request["task"] = {"kind": "session", "imageDigest": host["imageDigest"], "maxCommands": 4}
                if profile is not None:
                    request["task"]["resourceProfile"] = profile
                prepared = transport.vector["prepared"]; prepared["input"] = copy.deepcopy(request)
                quote = prepared["quote"]
                quote.update(maxSeconds=15, pricePerSecond=host["sessionPrices"][profile or "full"],
                             workloadHash="0x" + CRYPTO.keccak256(_canonical({"task": request["task"]}).encode()).hex())
                base = 15 * int(quote["pricePerSecond"]); prepared["ceiling"] = str(base + (base * 900 + 9999) // 10000)
                resign(sdk, prepared, "1")
                with self.subTest(vault=vault, profile=profile):
                    accepted = sdk.quote(request, idempotency_key="cpu-profile-work")
                    self.assertEqual(accepted["quote"]["pricePerSecond"], quote["pricePerSecond"])
                    self.assertEqual(sdk.open_plan(accepted), prepared["transaction"])
                    if profile is None:
                        self.assertNotIn("resourceProfile", accepted["input"]["task"])
                    host["sessionPrices"][profile or "full"] = str(int(quote["pricePerSecond"]) + 1)
                    # Keep ordered prices while changing the reviewed selected price.
                    host["pricePerSecond"] = "201"
                    host["sessionPrices"]["full"] = "201"; host["sessionPrices"]["lean"] = "101"; host["sessionPrices"]["torpor"] = "26"
                    with self.assertRaisesRegex(ValueError, "quote changed"):
                        sdk.open_plan(accepted)

    def test_actual_domain_two_signatures_and_receipt_version_acceptance_never_downgrade(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport, economics=True)
            prepared = transport.vector["prepared"]; prepared["receiptVersion"] = 2
            transport.config["cpuReceiptVersion"] = 2
            resign(sdk, prepared, "2")
            self.assertEqual(sdk.quote(FIXTURE["input"], idempotency_key="economics-v2-work")["receiptVersion"], 2)
            self.assertEqual(sdk.open_plan(prepared), prepared["transaction"])
            resign(sdk, prepared, "1")
            with self.assertRaisesRegex(ValueError, "signature"):
                sdk.open_plan(prepared)
            transport = ScriptedTransport(vault); legacy = configured_client(transport)
            resign(legacy, transport.vector["prepared"], "2")
            with self.assertRaisesRegex(ValueError, "signature"):
                legacy.open_plan(transport.vector["prepared"])
            for invalid in (True, None, 0, 3, "2", 2.0):
                transport = ScriptedTransport(vault); sdk = configured_client(transport)
                transport.vector["prepared"]["receiptVersion"] = invalid
                with self.assertRaises(ValueError):
                    sdk.open_plan(transport.vector["prepared"])

    def test_actual_signed_cpu_receipt_version_matches_public_marker_in_both_directions(self):
        for vault in (False, True):
            transport = ScriptedTransport(vault); sdk = configured_client(transport)
            transport.config["cpuReceiptVersion"] = 2; prepared = transport.vector["prepared"]
            with self.assertRaisesRegex(ValueError, "receipt version"):
                sdk.open_plan(prepared)
            prepared["receiptVersion"] = 2
            self.assertEqual(sdk.open_plan(prepared), prepared["transaction"])
            prepared["receiptVersion"] = 1
            with self.assertRaisesRegex(ValueError, "receipt version"):
                sdk.open_plan(prepared)
            transport.config.pop("cpuReceiptVersion"); prepared["receiptVersion"] = 2
            with self.assertRaisesRegex(ValueError, "downgraded"):
                sdk.open_plan(prepared)
            fresh_legacy = configured_client(transport)
            with self.assertRaisesRegex(ValueError, "receipt version"):
                fresh_legacy.open_plan(prepared)


if __name__ == "__main__":
    unittest.main()
