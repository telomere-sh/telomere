from __future__ import annotations

import copy
import unittest

from test_platform import CRYPTO, FIXTURE, SessionTransport, client
from telomere_sdk.client import _canonical, _typed
from telomere_sdk.platform import QUOTE_FIELDS, _cpu_lane_offer, _cpu_lane_offers, _host_price, _input, _workload

STANDARD = {"lane": "standard", "pricePerSecond": "200", "sessionPrices": {"full": "200", "lean": "120", "torpor": "60"}}
INTERRUPTIBLE = {"lane": "interruptible", "pricePerSecond": "100", "sessionPrices": {"full": "100", "lean": "80", "torpor": "40"},
                 "interruptible": {"protocol": "telomere-paid-preemption/v1", "minimumNoticeSeconds": 30, "hostOptInRequired": True}}


def host():
    return {"sessionEnabled": True, **copy.deepcopy(STANDARD),
            "laneOffers": {"protocol": "telomere-cpu-lane-offers-v1", "offers": copy.deepcopy([STANDARD, INTERRUPTIBLE])}}


class CpuOfferBoundaryTests(unittest.TestCase):
    def test_exact_legacy_and_lane_specific_profile_prices(self):
        physical = host()
        self.assertEqual(_host_price({"kind": "session", "resourceProfile": "lean"}, _cpu_lane_offer(physical, "interruptible")), "80")
        self.assertEqual(_host_price({"kind": "session", "resourceProfile": "lean"}, _cpu_lane_offer(physical, "standard")), "120")
        del physical["laneOffers"]
        self.assertEqual(_cpu_lane_offer(physical, "standard"), physical)
        self.assertIsNone(_cpu_lane_offer(physical, "interruptible"))

    def test_rejects_ambiguous_unreviewed_or_changed_base_catalogue(self):
        for change in (lambda h: h["laneOffers"].update(offers=[copy.deepcopy(INTERRUPTIBLE)]),
                       lambda h: h.update(pricePerSecond="201"),
                       lambda h: h["sessionPrices"].update(lean="121"),
                       lambda h: h.update(sessionEnabled=False),
                       lambda h: h["laneOffers"].update(offers=[copy.deepcopy(STANDARD), copy.deepcopy(STANDARD)]),
                       lambda h: h["laneOffers"]["offers"][1].update(pricePerSecond="0"),
                       lambda h: h["laneOffers"]["offers"][1].pop("interruptible"),
                       lambda h: h["laneOffers"]["offers"][1]["sessionPrices"].update(full="200"),
                       lambda h: h["laneOffers"]["offers"][1].update(hostId="another-physical-host")):
            physical = host(); change(physical)
            with self.subTest(change=change), self.assertRaises(ValueError):
                _cpu_lane_offers(physical)

    def test_missing_profile_does_not_inherit_other_lane_rate(self):
        physical = host(); del physical["laneOffers"]["offers"][1]["sessionPrices"]
        self.assertIsNone(_host_price({"kind": "session", "resourceProfile": "lean"}, _cpu_lane_offer(physical, "interruptible")))


@unittest.skipUnless(CRYPTO, "Requires eth-account reviewed crypto adapter")
class CpuOfferCryptoTests(unittest.TestCase):
    def fixture(self, vault):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        transport = SessionTransport(vault=vault); transport.principal = FIXTURE["owner"]
        physical = transport.config["capacity"][0]
        physical.update(host())
        if not vault:
            physical.update(copy.deepcopy(INTERRUPTIBLE))
        sdk = client(transport, vault=vault)
        prepared = copy.deepcopy(transport.vector["prepared"])
        prepared["input"] = _input({"leashId": prepared["quote"]["leashId"], "task": {"kind": "session", "maxCommands": 4,
            "imageDigest": physical["imageDigest"], "resourceProfile": "lean"}, "maxSeconds": 60,
            "deadline": FIXTURE["epoch"] + 600, "maxSpend": "20000", "regions": [physical["region"]],
            "cpuScheduling": {"version": 1, "lane": "interruptible" if vault else "standard",
                **({"interruptibleConsent": {"minimumNoticeSeconds": 30}} if vault else {})}})
        def signed(price):
            value = copy.deepcopy(prepared); quote = value["quote"]
            quote.update(maxSeconds=60, pricePerSecond=price, inferencePrice="0", quoteExpiry=FIXTURE["epoch"] + 120)
            quote["workloadHash"] = "0x" + CRYPTO.keccak256(_canonical(_workload(value["input"])).encode()).hex()
            base = 60 * int(price); value["ceiling"] = str(base + (base * 900 + 9999) // 10000)
            domain = {"name": "TelomerePlatformEscrow", "version": "1", "chainId": 31337,
                      "verifyingContract": FIXTURE["pins"]["escrowAddress"]}
            value["signature"] = "0x" + Account.sign_message(encode_typed_data(full_message=_typed(domain, "PlatformQuote", QUOTE_FIELDS, quote)),
                "0x" + "11" * 32).signature.hex()
            value["transaction"]["data"] = sdk._encode_open(quote, value["signature"], value["imageProof"], value["regionProof"])
            return value
        return sdk, transport, signed

    def test_real_signatures_use_exact_non_base_lane_profile_without_wallet_authority(self):
        for vault in (False, True):
            sdk, transport, signed = self.fixture(vault)
            prepared = signed("80" if vault else "120")
            with self.subTest(vault=vault):
                self.assertEqual(len(sdk.config()["capacity"]), 1)
                self.assertEqual(sdk.open_plan(prepared), prepared["transaction"])
                with self.assertRaisesRegex(ValueError, "quote changed"):
                    sdk.open_plan(signed("120" if vault else "80"))
                transport.config["capacity"][0]["laneOffers"]["offers"].reverse()
                self.assertEqual(sdk.open_plan(prepared), prepared["transaction"])

    def test_withdrawn_offer_does_not_fall_back_to_base_rate(self):
        sdk, transport, signed = self.fixture(True); prepared = signed("80")
        transport.config["capacity"][0]["laneOffers"]["offers"] = [copy.deepcopy(STANDARD)]
        with self.assertRaisesRegex(ValueError, "quote changed"):
            sdk.open_plan(prepared)


if __name__ == "__main__":
    unittest.main()
