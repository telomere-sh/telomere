"""Full-proof platform and Vault clients. Every wallet plan remains unsigned."""

from __future__ import annotations

import copy
import hashlib
import math
import re
import threading
import time
from typing import Any, Callable

from .chains import LOCAL_CHAIN_ID, PUBLIC_BASE_TOKENS, SUPPORTED_CHAIN_IDS
from .client import TelomereClient, _address, _bytes32, _canonical, _integer, _money, _object, _signature, _typed
from .crypto import CryptoVerifier
from .transport import ApiTransport, Transport, normalize_origin

MAX_SAFE = 2 ** 53 - 1
QUOTE_FIELDS = (("runId", "bytes32"), ("leashId", "bytes32"), ("hostId", "bytes32"), ("payer", "address"),
                ("hwClass", "uint16"), ("regionHash", "bytes32"), ("imageHash", "bytes32"), ("workloadHash", "bytes32"),
                ("maxSeconds", "uint64"), ("pricePerSecond", "uint96"), ("inferencePrice", "uint96"), ("quoteExpiry", "uint64"))
PIN_ADDRESSES = {"escrowAddress", "tokenAddress", "quoteSigner", "receiptRootAddress", "hostRegistryAddress", "feeRouterAddress"}
PIN_HASHES = {"tokenCodeHash", "escrowCodeHash", "receiptRootCodeHash", "hostRegistryCodeHash", "feeRouterCodeHash"}
VAULT_ADDRESSES = {"registryAddress", "implementationAddress"}
VAULT_HASHES = {"registryCodeHash", "implementationCodeHash"}
BINDING_ADDRESSES = {"vault", "owner", "agentWallet"}
RUN_FIELDS = {"id", "status", "quote", "ceiling", "admissionTx", "settlementTx", "result", "settlement", "charged", "refund", "errorCode"}
OPEN_TUPLE = "(bytes32,bytes32,bytes32,address,uint16,bytes32,bytes32,bytes32,uint64,uint96,uint96,uint64)"
CPU_PROFILE_QUOTAS = {"full": 1, "lean": 0.5, "torpor": 0.25}


def _pins(raw: Any, *, vault: bool = False) -> dict[str, Any]:
    addresses, hashes = (VAULT_ADDRESSES, VAULT_HASHES) if vault else (PIN_ADDRESSES, PIN_HASHES)
    value = copy.deepcopy(_object(raw))
    required = addresses | hashes | (set() if vault else {"chainId", "reviewedTokenKind"})
    optional = set() if vault else {"assetImplementation", "assetFacet", "financialProfile"}
    if not required <= set(value) or set(value) - required - optional:
        raise ValueError("Unexpected platform deployment pins")
    for key in addresses:
        value[key] = _address(value[key])
    for key in hashes:
        value[key] = _bytes32(value[key])
    if not vault and (type(value["chainId"]) is not int or value["chainId"] not in SUPPORTED_CHAIN_IDS):
        raise ValueError("Only reviewed platform chains are supported")
    if not vault:
        if value["reviewedTokenKind"] not in ("immutable", "eip1967", "circle_proxy"):
            raise ValueError("Unsupported platform payment asset kind")
        for key in ("assetImplementation", "assetFacet"):
            if key in value:
                nested = _object(value[key], {"address", "codeHash"})
                value[key] = {"address": _address(nested["address"]), "codeHash": _bytes32(nested["codeHash"])}
        if ((value["reviewedTokenKind"] in ("eip1967", "circle_proxy") and "assetImplementation" not in value)
                or (value["reviewedTokenKind"] == "immutable" and ("assetImplementation" in value or "assetFacet" in value))
                or (value["reviewedTokenKind"] == "circle_proxy" and "assetFacet" in value)
                or (value["chainId"] != LOCAL_CHAIN_ID and (value["tokenAddress"] != PUBLIC_BASE_TOKENS[value["chainId"]]
                    or value["reviewedTokenKind"] != "circle_proxy"))):
            raise ValueError("Platform payment asset lacks reviewed deployment pins")
        if "financialProfile" in value:
            profile = copy.deepcopy(_object(value["financialProfile"]))
            fields = {"kind", "stakingAddress", "stakingCodeHash", "utilityTokenAddress", "utilityTokenCodeHash"}
            if not fields <= set(profile) or set(profile) - fields - {"discountVaultRegistry"}:
                raise ValueError("Unexpected platform financial profile fields")
            if profile["kind"] != "tlmr_economics_v2":
                raise ValueError("Unsupported platform financial profile")
            for key in ("stakingAddress", "utilityTokenAddress"):
                profile[key] = _address(profile[key])
            for key in ("stakingCodeHash", "utilityTokenCodeHash"):
                profile[key] = _bytes32(profile[key])
            if (profile["stakingAddress"] == profile["utilityTokenAddress"]
                    or profile["utilityTokenAddress"] == value["tokenAddress"]):
                raise ValueError("Economics requires a separate reviewed utility token and staking contract")
            if "discountVaultRegistry" in profile:
                registry = _object(profile["discountVaultRegistry"], {"address", "codeHash", "implementationAddress", "implementationCodeHash"})
                profile["discountVaultRegistry"] = {"address": _address(registry["address"]), "codeHash": _bytes32(registry["codeHash"]),
                                                    "implementationAddress": _address(registry["implementationAddress"]),
                                                    "implementationCodeHash": _bytes32(registry["implementationCodeHash"])}
            value["financialProfile"] = profile
    return value


def _binding(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, BINDING_ADDRESSES | {"agentId", "leashId"}))
    for key in BINDING_ADDRESSES:
        value[key] = _address(value[key])
    for key in ("agentId", "leashId"):
        value[key] = _bytes32(value[key])
        if int(value[key][2:], 16) == 0:
            raise ValueError("Vault identifiers must be nonzero")
    return value


def _key(value: Any) -> str:
    # Preserve the existing transport's reviewed key subset.
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", value):
        raise ValueError("Use an 8..128 character alphanumeric, underscore or hyphen idempotency key")
    return value


def _region(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value):
        raise ValueError("Invalid platform region")
    return value


def _exec_task(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    if set(value) not in ({"kind", "imageDigest", "argv"}, {"kind", "imageDigest", "argv", "stdin"}):
        raise ValueError("Unexpected platform command fields")
    if value["kind"] != "exec" or not isinstance(value["imageDigest"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value["imageDigest"]):
        raise ValueError("Platform commands require a pinned image digest")
    argv = value["argv"]
    if not isinstance(argv, list) or not 1 <= len(argv) <= 32:
        raise ValueError("Platform command requires 1..32 arguments")
    try:
        for argument in argv:
            if (not isinstance(argument, str) or not argument or "\0" in argument
                    or len(argument.encode("utf-16-le", "strict")) // 2 > 4096):
                raise ValueError("Invalid platform command argument")
        if sum(len(argument.encode("utf-8", "strict")) for argument in argv) > 8192:
            raise ValueError("Platform command arguments exceed 8192 UTF-8 bytes")
        if "stdin" in value and (not isinstance(value["stdin"], str) or "\0" in value["stdin"]
                or len(value["stdin"].encode("utf-16-le", "strict")) // 2 > 8192
                or len(value["stdin"].encode("utf-8", "strict")) > 8192):
            raise ValueError("Platform command stdin exceeds 8192 characters or UTF-8 bytes")
    except UnicodeError:
        raise ValueError("Invalid UTF-8 platform command text") from None
    if re.fullmatch(r"(?:.*/)?(?:sh|bash|dash|zsh|ksh|fish|busybox)", argv[0]):
        raise ValueError("A default shell is not permitted for platform commands")
    return value


def _session_task(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    required = {"kind", "imageDigest", "maxCommands"}
    if not required <= set(value) or set(value) - required - {"resourceProfile"}:
        raise ValueError("Unexpected paid session task fields")
    if (value["kind"] != "session" or not isinstance(value["imageDigest"], str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", value["imageDigest"])):
        raise ValueError("Paid sessions require a pinned image digest")
    _integer(value["maxCommands"], 1, 32)
    if "resourceProfile" in value:
        _resource_profile(value["resourceProfile"])
    return value


def _resource_profile(raw: Any) -> str:
    if not isinstance(raw, str) or raw not in CPU_PROFILE_QUOTAS:
        raise ValueError("Unknown CPU resource profile")
    return raw


def _session_prices(raw: Any) -> dict[str, str]:
    value = copy.deepcopy(_object(raw, {"full", "lean", "torpor"}))
    for name in CPU_PROFILE_QUOTAS:
        value[name] = _money(value[name])
    if not int(value["full"]) >= int(value["lean"]) >= int(value["torpor"]) > 0:
        raise ValueError("CPU profile prices must be positive and decrease with resource quota")
    return value


def _host_price(task: dict[str, Any], host: dict[str, Any]) -> str | None:
    if task["kind"] == "session" and task.get("resourceProfile", "full") != "full":
        return host.get("sessionPrices", {}).get(task["resourceProfile"])
    return host["pricePerSecond"]


def _cpu_lane_offers(host: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(_object(host["laneOffers"], {"protocol", "offers"}))
    offers = value["offers"]
    if (value["protocol"] != "telomere-cpu-lane-offers-v1" or not isinstance(offers, list)
            or not 1 <= len(offers) <= 2 or host.get("sessionEnabled") is not True):
        raise ValueError("CPU lane offers require one reviewed physical session host")
    lanes = set()
    for offer in offers:
        _object(offer)
        if (not {"lane", "pricePerSecond"} <= set(offer)
                or set(offer) - {"lane", "pricePerSecond", "sessionPrices", "interruptible"}
                or offer["lane"] not in ("standard", "interruptible") or offer["lane"] in lanes
                or int(_money(offer["pricePerSecond"])) == 0):
            raise ValueError("CPU lane offers must contain one positive exact rate per lane")
        lanes.add(offer["lane"])
        if "sessionPrices" in offer:
            offer["sessionPrices"] = _session_prices(offer["sessionPrices"])
            if offer["sessionPrices"]["full"] != offer["pricePerSecond"]:
                raise ValueError("The full CPU profile must retain its posted lane price")
        if "interruptible" in offer:
            capability = _object(offer["interruptible"], {"protocol", "minimumNoticeSeconds", "hostOptInRequired"})
            if (capability["protocol"] != "telomere-paid-preemption/v1"
                    or type(capability["minimumNoticeSeconds"]) is not int or capability["minimumNoticeSeconds"] != 30
                    or capability["hostOptInRequired"] is not True):
                raise ValueError("CPU lane preemption capability differs from the reviewed host protocol")
        if offer["lane"] == "interruptible" and "interruptible" not in offer:
            raise ValueError("Interruptible lane offers require explicit reviewed preemption capability")
    original = {key: copy.deepcopy(host[key]) for key in ("lane", "pricePerSecond", "sessionPrices", "interruptible") if key in host}
    if next((offer for offer in offers if offer["lane"] == host["lane"]), None) != original:
        raise ValueError("CPU lane offers changed the original exact base offer")
    return value


def _cpu_lane_offer(host: dict[str, Any], lane: str) -> dict[str, Any] | None:
    if "laneOffers" not in host:
        return host if host["lane"] == lane else None
    offer = next((offer for offer in _cpu_lane_offers(host)["offers"] if offer["lane"] == lane), None)
    if offer is None:
        return None
    physical = {key: value for key, value in host.items() if key not in ("sessionPrices", "interruptible")}
    return {**physical, **offer}


def _session_policy(max_commands: Any, resource_profile: str = "full") -> dict[str, Any]:
    """Exact fixed CPU policy parity; a policy dictionary is not a signed host attestation."""
    return {"version": 1, "cpu": CPU_PROFILE_QUOTAS[_resource_profile(resource_profile)], "memoryBytes": 268_435_456,
            "pids": 64, "temporaryBytes": 16_777_216, "network": "none", "readOnlyRoot": True,
            "maxCommands": _integer(max_commands, 1, 32), "maxOutputBytesPerCommand": 16_384,
            "maxSessionOutputBytes": 65_536, "maxOutputFrames": 1024}


def _near_config(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"model", "maxTokens", "policySha256", "inferencePrice"}))
    if (not isinstance(value["model"], str) or not 1 <= len(value["model"]) <= 512
            or not re.fullmatch(r"[a-zA-Z0-9._/-]+", value["model"])):
        raise ValueError("NEAR model must match the reviewed identifier")
    _integer(value["maxTokens"], 1, 512)
    value["policySha256"] = _bytes32(value["policySha256"])
    if int(_money(value["inferencePrice"])) == 0:
        raise ValueError("NEAR inference price must be positive")
    return value


def _near_request(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"model", "maxTokens", "policySha256", "prompt"}))
    checked = _near_config({"model": value["model"], "maxTokens": value["maxTokens"],
                            "policySha256": value["policySha256"], "inferencePrice": "1"})
    value["policySha256"] = checked["policySha256"]
    prompt = value["prompt"]
    if not isinstance(prompt, str) or not prompt:
        raise ValueError("NEAR prompt must be nonempty")
    try:
        if len(prompt.encode("utf-16-le", "strict")) // 2 > 8192 or len(prompt.encode("utf-8", "strict")) > 8192:
            raise ValueError("NEAR prompt exceeds 8192 characters or UTF-8 bytes")
    except UnicodeError:
        raise ValueError("Invalid NEAR prompt Unicode") from None
    return value


def _host_supports(task: dict[str, Any], host: dict[str, Any]) -> bool:
    if task["kind"] == "exec":
        return host.get("execEnabled") is True and host["imageDigest"] == task["imageDigest"]
    if task["kind"] == "session":
        return (host.get("sessionEnabled") is True and host["imageDigest"] == task["imageDigest"]
                and _host_price(task, host) is not None)
    return True


def _cpu_scheduling(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    if not {"version", "lane"} <= set(value) or set(value) - {"version", "lane", "interruptibleConsent", "job"}:
        raise ValueError("Unexpected CPU scheduling fields")
    if type(value["version"]) is not int or value["version"] != 1 or value["lane"] not in ("standard", "interruptible"):
        raise ValueError("Unsupported CPU scheduling commitment")
    if (value["lane"] == "interruptible") != ("interruptibleConsent" in value):
        raise ValueError("Interruptible CPU requires explicit thirty-second notice consent")
    if "interruptibleConsent" in value:
        consent = _object(value["interruptibleConsent"], {"minimumNoticeSeconds"})
        if type(consent["minimumNoticeSeconds"]) is not int or consent["minimumNoticeSeconds"] != 30:
            raise ValueError("Interruptible CPU requires thirty-second notice consent")
    if "job" in value:
        job = _object(value["job"])
        required, optional = {"jobId", "intentHash"}, {"sourceRunId", "sourceQuoteHash", "decisionHash", "targetHostId"}
        if not required <= set(job) or set(job) - required - optional:
            raise ValueError("Unexpected CPU job commitment")
        for key in job:
            job[key] = _bytes32(job[key])
        source = {"sourceRunId", "sourceQuoteHash", "decisionHash"} & set(job)
        if source and (source != {"sourceRunId", "sourceQuoteHash", "decisionHash"} or "targetHostId" not in job):
            raise ValueError("CPU replacement must bind its exact source, decision and target")
    return value


def _workload(input: dict[str, Any]) -> dict[str, Any]:
    if "cpuScheduling" in input:
        return {"protocol": "telomere-platform-cpu-scheduling-v1", "task": input["task"], "cpuScheduling": input["cpuScheduling"]}
    if "near" in input:
        return {"protocol": "telomere-platform-near-v1", "task": input["task"], "near": input["near"]}
    return {"task": input["task"]}


def _cpu_job_input(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    required = {"protocol", "leashId", "task", "workSeconds", "deadline", "maxSpend"}
    if not required <= set(value) or set(value) - required - {"regions", "lanes", "interruptibleConsent"}:
        raise ValueError("Unexpected owner CPU job fields")
    if value["protocol"] != "telomere-paid-cpu-job-v1":
        raise ValueError("Unsupported owner CPU job")
    value["leashId"] = _bytes32(value["leashId"]); value["task"] = _session_task(value["task"])
    _integer(value["workSeconds"], 10, 120); _integer(value["deadline"], 1, MAX_SAFE); _money(value["maxSpend"])
    lanes, regions = value.setdefault("lanes", ["standard"]), value.setdefault("regions", [])
    if not isinstance(lanes, list) or not 1 <= len(lanes) <= 2 or len(set(lanes)) != len(lanes) or any(lane not in ("standard", "interruptible") for lane in lanes):
        raise ValueError("CPU job lanes must be explicit and unique")
    if not isinstance(regions, list) or len(regions) > 32:
        raise ValueError("CPU job region selection exceeds its bound")
    for region in regions:
        _region(region)
    if ("interruptible" in lanes) != ("interruptibleConsent" in value):
        raise ValueError("Owner CPU job requires explicit interruptible consent")
    if "interruptibleConsent" in value:
        _cpu_scheduling({"version": 1, "lane": "interruptible", "interruptibleConsent": value["interruptibleConsent"]})
        if value["workSeconds"] <= 30:
            raise ValueError("Interruptible CPU must leave thirty seconds for notice")
    return value


def _cpu_job_replan(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    required = {"checkpointHash", "remainingSeconds", "restoreSeconds"}
    if not required <= set(value) or set(value) - required - {"expectedSourceRunId"}:
        raise ValueError("Unexpected CPU job replan fields")
    value["checkpointHash"] = _bytes32(value["checkpointHash"])
    if "expectedSourceRunId" in value:
        value["expectedSourceRunId"] = _bytes32(value["expectedSourceRunId"])
    _integer(value["remainingSeconds"], 1, 120); _integer(value["restoreSeconds"], 0, 120)
    _integer(value["remainingSeconds"] + value["restoreSeconds"], 10, 120)
    return value


def _normalize_job_addresses(value: Any) -> Any:
    if isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
        return value.lower()
    if isinstance(value, list):
        return [_normalize_job_addresses(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_job_addresses(item) for key, item in value.items()}
    return value


def _input(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    required = {"leashId", "task", "maxSeconds", "deadline", "maxSpend"}
    if not required <= set(value) or set(value) - required - {"regions", "excludedHostIds", "near", "cpuScheduling"}:
        raise ValueError("Unexpected platform quote input fields")
    if isinstance(value["task"], dict) and value["task"].get("kind") == "exec":
        pilot = {"leashId": _bytes32(value["leashId"]), "task": _exec_task(value["task"]),
                 "maxSeconds": _integer(value["maxSeconds"], 1, 120)}
    elif isinstance(value["task"], dict) and value["task"].get("kind") == "session":
        pilot = {"leashId": _bytes32(value["leashId"]), "task": _session_task(value["task"]),
                 "maxSeconds": _integer(value["maxSeconds"], 1, 120)}
    elif isinstance(value["task"], dict) and value["task"].get("kind") == "near_inference":
        pilot = {"leashId": _bytes32(value["leashId"]),
                 "task": copy.deepcopy(_object(value["task"], {"kind"})),
                 "maxSeconds": _integer(value["maxSeconds"], 1, 120)}
    else:
        pilot = TelomereClient._quote_input({key: value[key] for key in ("leashId", "task", "maxSeconds")})
    value.update(pilot); _integer(value["deadline"], 1, MAX_SAFE); _money(value["maxSpend"])
    regions = value.setdefault("regions", [])
    if not isinstance(regions, list) or len(regions) > 32:
        raise ValueError("Platform region selection exceeds its bound")
    for region in regions:
        _region(region)
    if "excludedHostIds" in value:
        excluded = value["excludedHostIds"]
        if not isinstance(excluded, list) or len(excluded) > 16:
            raise ValueError("Platform excluded host selection exceeds its bound")
        value["excludedHostIds"] = [_bytes32(host_id) for host_id in excluded]
        if len(set(value["excludedHostIds"])) != len(excluded):
            raise ValueError("Platform excluded host IDs must be unique")
    if "near" in value:
        value["near"] = _near_request(value["near"])
        if value["task"]["kind"] in ("exec", "session"):
            raise ValueError("NEAR inference cannot follow a paid command or session")
    elif value["task"]["kind"] == "near_inference":
        raise ValueError("An inference-only task requires a bounded NEAR request")
    if "cpuScheduling" in value:
        value["cpuScheduling"] = _cpu_scheduling(value["cpuScheduling"])
        if (value["task"]["kind"] != "session" or "near" in value
                or value["cpuScheduling"]["lane"] == "interruptible" and value["maxSeconds"] <= 30):
            raise ValueError("CPU lanes require paid sessions and thirty seconds for interruptible notice")
    return value


def _session_text(value: Any, maximum: int) -> str:
    if not isinstance(value, str) or "\0" in value:
        raise ValueError("Invalid paid session text")
    try:
        if len(value.encode("utf-16-le", "strict")) // 2 > maximum:
            raise ValueError("Paid session text exceeds its bound")
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise ValueError("Invalid paid session Unicode text") from None
    return value


def _session_command(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    if set(value) not in ({"commandId", "argv"}, {"commandId", "argv", "stdin"}):
        raise ValueError("Unexpected paid session command fields")
    if not isinstance(value["commandId"], str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", value["commandId"]):
        raise ValueError("Invalid paid session command ID")
    argv = value["argv"]
    if not isinstance(argv, list) or not 1 <= len(argv) <= 32:
        raise ValueError("Paid session command requires 1..32 arguments")
    for argument in argv:
        if not _session_text(argument, 4096):
            raise ValueError("Paid session command arguments cannot be empty")
    if "stdin" in value:
        _session_text(value["stdin"], 8192)
        if len(value["stdin"].encode("utf-8")) > 8192:
            raise ValueError("Paid session stdin exceeds 8192 UTF-8 bytes")
    return value


def _session_event(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw))
    required = {"sequence", "kind"}
    optional = {"commandId", "stream", "text", "exitCode", "reason"}
    if not required <= set(value) or not set(value) <= required | optional:
        raise ValueError("Unexpected paid session event fields")
    _integer(value["sequence"], 0, 4095)
    if value["kind"] not in ("ready", "started", "output", "command_exit", "session_exit"):
        raise ValueError("Unknown paid session event")
    if "commandId" in value and (not isinstance(value["commandId"], str)
                                 or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", value["commandId"])):
        raise ValueError("Invalid paid session event command ID")
    if "stream" in value and value["stream"] not in ("stdout", "stderr"):
        raise ValueError("Invalid paid session event stream")
    if "text" in value:
        _session_text(value["text"], 8192)
    if "exitCode" in value:
        _integer(value["exitCode"], -1, 255)
    if "reason" in value:
        _session_text(value["reason"], 32)
    return value


def _session_command_result(raw: Any, requested: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"command", "inputHash", "state", "stdout", "stderr", "exitCode", "reason", "outputBytes"}))
    value["command"] = _session_command(value["command"])
    if value["command"] != requested:
        raise ValueError("Paid session command response changed")
    digest = hashlib.sha256(_canonical(requested).encode("utf-8")).hexdigest()
    if value["inputHash"] != digest:
        raise ValueError("Paid session command input hash changed")
    if value["state"] not in ("queued", "starting", "running", "completed", "failed", "cancelled", "uncertain"):
        raise ValueError("Unknown paid session command state")
    _session_text(value["stdout"], 16_384); _session_text(value["stderr"], 16_384)
    _integer(value["exitCode"], -1, 255); _session_text(value["reason"], 32)
    _integer(value["outputBytes"], 0, 65_536)
    return value


def _session_cursor(after_sequence: Any, limit: Any) -> tuple[int, int]:
    return _integer(after_sequence, -1, 4095), _integer(limit, 1, 8)


def _session_event_page(raw: Any, after_sequence: int, limit: int) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"events", "nextSequence", "eventCount", "state"}))
    if not isinstance(value["events"], list) or len(value["events"]) > limit:
        raise ValueError("Paid session event page exceeds its bound")
    value["events"] = [_session_event(item) for item in value["events"]]
    _integer(value["nextSequence"], -1, 4095); _integer(value["eventCount"], 0, 4096)
    if value["state"] not in ("starting", "running", "completed", "stopped", "expired", "fault",
                              "cancelled", "timed_out", "failed", "reconciliation"):
        raise ValueError("Unknown paid session state")
    if (value["eventCount"] < len(value["events"]) or value["eventCount"] < after_sequence + 1
            or any(event["sequence"] != after_sequence + index + 1 for index, event in enumerate(value["events"]))
            or value["nextSequence"] != (value["events"][-1]["sequence"] if value["events"] else after_sequence)):
        raise ValueError("Paid session event page changed sequence")
    return value


def _quote(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {name for name, _ in QUOTE_FIELDS}))
    for name, kind in QUOTE_FIELDS:
        if kind == "bytes32":
            value[name] = _bytes32(value[name])
        elif kind == "address":
            value[name] = _address(value[name])
    _integer(value["hwClass"], 0, 0); _integer(value["maxSeconds"], 1, 120)
    _integer(value["quoteExpiry"], 1, MAX_SAFE); _money(value["pricePerSecond"]); _money(value["inferencePrice"])
    return value


def _proof(raw: Any) -> list[str]:
    if not isinstance(raw, list) or len(raw) > 64:
        raise ValueError("Platform scope proof exceeds 64 siblings")
    return [_bytes32(item) for item in raw]


def _bounded_result(raw: Any) -> None:
    count = 0

    def visit(value: Any, depth: int) -> None:
        nonlocal count
        count += 1
        if count > 16_384 or depth > 16:
            raise ValueError("Platform result exceeds its structural bound")
        if value is None or type(value) is bool:
            return
        if isinstance(value, str):
            if len(value.encode("utf-16-le", "strict")) // 2 > 131_072:
                raise ValueError("Platform result text exceeds its bound")
            return
        if type(value) in (int, float):
            try:
                finite = math.isfinite(value)
            except OverflowError:
                finite = False
            if not finite:
                raise ValueError("Platform result contains a non-finite number")
            return
        if isinstance(value, list):
            for child in value:
                visit(child, depth + 1)
            return
        if isinstance(value, dict) and all(isinstance(key, str) for key in value):
            for child in value.values():
                visit(child, depth + 1)
            return
        raise ValueError("Invalid platform result")

    visit(raw, 0)


class PlatformRuntimeClient:
    """Reviewed EOA paid API; signatures are verified, never created or submitted."""

    def __init__(self, base_url: str, *, pins: dict[str, Any], verifier: CryptoVerifier | None = None,
                 transport: Transport | None = None, clock: Callable[[], float] = time.time,
                 cpu_receipt_version: int | None = None):
        self.origin = normalize_origin(base_url)
        self._transport = transport or ApiTransport(self.origin)
        if normalize_origin(self._transport.origin) != self.origin:
            raise ValueError("Injected transport must use the exact client origin")
        self._pins, self._verifier, self._clock = _pins(pins), verifier, clock
        self._minimum_cpu_receipt_version = _integer(1 if cpu_receipt_version is None else cpu_receipt_version, 1, 2)
        self._crypto_checked = False
        self._quotes: dict[str, tuple[str, dict[str, Any]]] = {}
        self._quote_inputs: dict[str, str] = {}
        self._command_inputs: dict[tuple[str, str], str] = {}
        self._lock = threading.RLock()

    def _path(self, suffix: str) -> str:
        return "/api/platform" + suffix

    def _request(self, path: str, *, method: str = "GET", body: Any = None, idempotency_key: str | None = None,
                 paid_command: bool = False) -> Any:
        try:
            if body is not None and len(_canonical(body).encode("utf-8")) > 32_768:
                raise ValueError("Platform request exceeds 32 KiB")
            options = {"method": method, "body": body, "idempotency_key": idempotency_key}
            if paid_command and isinstance(self._transport, ApiTransport):
                result = self._transport.request(path, **options, command_timeout=130)
            else:
                result = self._transport.request(path, **options)
            if len(_canonical(result).encode("utf-8")) > 1_048_576:
                raise ValueError("Platform response exceeds 1 MiB")
            return copy.deepcopy(result)
        except (TypeError, UnicodeError, RecursionError, OverflowError):
            raise ValueError("Invalid platform JSON data") from None

    def config(self) -> dict[str, Any]:
        keys = {"protocol", "pins", "maxSeconds", "feeBps", "capacity"}
        if isinstance(self, PlatformVaultRuntimeClient):
            keys |= {"binding", "vaultPins"}
        value = _object(self._request(self._path("/config")))
        if not keys <= set(value) or set(value) - keys - {"near", "nearInferenceTask", "cpuReceiptVersion"}:
            raise ValueError("Unexpected platform configuration fields")
        if "cpuReceiptVersion" in value:
            _integer(value["cpuReceiptVersion"], 2, 2)
        if value.get("cpuReceiptVersion", 1) < self._minimum_cpu_receipt_version:
            raise ValueError("Reviewed CPU receipt protocol was downgraded")
        if "near" in value:
            value["near"] = _near_config(value["near"])
            if value.get("nearInferenceTask") != "near_inference":
                raise ValueError("NEAR inference task must be explicitly enabled")
        elif "nearInferenceTask" in value:
            raise ValueError("NEAR inference task has no reviewed provider configuration")
        value["pins"] = _pins(value["pins"])
        if value["pins"] != self._pins:
            raise ValueError("Platform deployment differs from reviewed pins")
        if (value["protocol"] != "telomere-platform-v1" or type(value["maxSeconds"]) is not int or value["maxSeconds"] != 120
                or type(value["feeBps"]) is not int or value["feeBps"] != 900):
            raise ValueError("Unsupported full-proof platform protocol")
        capacity = value["capacity"]
        if not isinstance(capacity, list) or not 1 <= len(capacity) <= 16:
            raise ValueError("Platform capacity must contain 1..16 reviewed CPU hosts")
        ids = set()
        for host in capacity:
            _object(host)
            fields = {"hostId", "hardwareClass", "region", "imageDigest", "lane", "pricePerSecond"}
            if (not fields <= set(host) or not set(host) <= fields | {"execEnabled", "sessionEnabled", "sessionPrices", "interruptible", "laneOffers"}
                    or ("execEnabled" in host and host["execEnabled"] is not True)
                    or ("sessionEnabled" in host and host["sessionEnabled"] is not True)):
                raise ValueError("Platform command and session capabilities must be explicitly enabled")
            host["hostId"] = _bytes32(host["hostId"]); _region(host["region"]); _money(host["pricePerSecond"])
            if (host["hostId"] in ids or host["hardwareClass"] != "cpu" or host["lane"] not in ("standard", "interruptible")
                    or not isinstance(host["imageDigest"], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", host["imageDigest"])):
                raise ValueError("Platform capacity contains an ambiguous or unsupported host")
            if "sessionPrices" in host:
                host["sessionPrices"] = _session_prices(host["sessionPrices"])
            if "interruptible" in host:
                capability = _object(host["interruptible"], {"protocol", "minimumNoticeSeconds", "hostOptInRequired"})
                if (capability["protocol"] != "telomere-paid-preemption/v1" or type(capability["minimumNoticeSeconds"]) is not int
                        or capability["minimumNoticeSeconds"] != 30 or capability["hostOptInRequired"] is not True):
                    raise ValueError("Interruptible capability differs from the reviewed host protocol")
            if host["lane"] == "interruptible" and ("interruptible" not in host or host.get("sessionEnabled") is not True):
                raise ValueError("Interruptible CPU requires an explicit reviewed paid-session capability")
            if "laneOffers" in host:
                host["laneOffers"] = _cpu_lane_offers(host)
            ids.add(host["hostId"])
        self._check_config(value)
        if value.get("cpuReceiptVersion") == 2:
            self._minimum_cpu_receipt_version = 2
        return copy.deepcopy(value)

    def _check_config(self, config: dict[str, Any]) -> None:
        pass

    def _principal(self, config: dict[str, Any], role: str = "read") -> str:
        value = _object(self._request("/api/me"), {"address", "demo"})
        address = _address(value["address"])
        if type(value["demo"]) is not bool:
            raise ValueError("Invalid platform session")
        return address

    def _payer(self, config: dict[str, Any], principal: str) -> str:
        return principal

    def _financial(self) -> CryptoVerifier:
        if self._verifier is None:
            raise ValueError("A reviewed CryptoVerifier is required for platform wallet plans")
        if not self._crypto_checked:
            if self._verifier.keccak256(b"") != bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"):
                raise ValueError("CryptoVerifier must implement Ethereum Keccak-256")
            self._crypto_checked = True
        return self._verifier

    def _digest(self, raw: bytes) -> bytes:
        digest = self._financial().keccak256(raw)
        if not isinstance(digest, bytes) or len(digest) != 32:
            raise ValueError("CryptoVerifier returned an invalid Keccak digest")
        return digest

    def _encode_open(self, quote: dict[str, Any], signature: str, image_proof: list[str], region_proof: list[str]) -> str:
        words = []
        for name, kind in QUOTE_FIELDS:
            value = quote[name]
            if kind == "bytes32":
                words.append(bytes.fromhex(_bytes32(value)[2:]))
            elif kind == "address":
                words.append(bytes.fromhex(_address(value)[2:]).rjust(32, b"\0"))
            else:
                number = int(value) if isinstance(value, str) else value
                words.append(_integer(number, 0, 2 ** int(kind[4:]) - 1).to_bytes(32, "big"))
        raw_signature = bytes.fromhex(_signature(signature)[2:])
        signature_tail = len(raw_signature).to_bytes(32, "big") + raw_signature + b"\0" * (-len(raw_signature) % 32)
        tails = [signature_tail]
        for proof in (image_proof, region_proof):
            tails.append(len(proof).to_bytes(32, "big") + b"".join(bytes.fromhex(item[2:]) for item in _proof(proof)))
        offset = (len(words) + len(tails)) * 32
        for tail in tails:
            words.append(offset.to_bytes(32, "big")); offset += len(tail)
        function = "payRun" if isinstance(self, PlatformVaultRuntimeClient) else "openRun"
        selector = self._digest((function + "(" + OPEN_TUPLE + ",bytes,bytes32[],bytes32[])").encode("ascii"))[:4]
        return "0x" + (selector + b"".join(words) + b"".join(tails)).hex()

    def _transaction(self, raw: Any, destination: str, data: str) -> dict[str, Any]:
        value = _object(raw, {"chainId", "to", "data", "value"})
        value["to"] = _address(value["to"])
        if (type(value["chainId"]) is not int or value["chainId"] != self._pins["chainId"] or value["to"] != destination
                or value["data"] != data or value["value"] != "0"):
            raise ValueError("Platform transaction differs from its reviewed destination, chain or exact calldata")
        return value

    def balance(self) -> dict[str, str]:
        config = self.config(); self._principal(config)
        value = _object(self._request(self._path("/balance")), {"available"})
        units = value["available"]
        if not isinstance(units, str) or not re.fullmatch(r"0|[1-9][0-9]{0,77}", units) or int(units) >= 2 ** 256:
            raise ValueError("Platform balance must be canonical uint256 decimal units")
        return value

    def _checked_prepared(self, raw: Any, requested: dict[str, Any], *, role: str | None = None, historical: bool = False) -> dict[str, Any]:
        verifier = self._financial(); config = self.config()
        principal = self._principal(config, role or ("owner" if requested.get("cpuScheduling", {}).get("lane") == "interruptible" else "agent"))
        value = _object(copy.deepcopy(raw))
        fields = {"input", "quote", "signature", "ceiling", "imageProof", "regionProof", "transaction"}
        if not fields <= set(value) or set(value) - fields - {"receiptVersion"}:
            raise ValueError("Unexpected platform prepared fields")
        if "receiptVersion" in value:
            _integer(value["receiptVersion"], 1, 2)
        value["input"] = _input(value["input"]); value["quote"] = q = _quote(value["quote"])
        value["signature"] = signature = _signature(value["signature"]); _money(value["ceiling"])
        value["imageProof"] = _proof(value["imageProof"]); value["regionProof"] = _proof(value["regionProof"])
        host = next((host for host in config["capacity"] if host["hostId"] == q["hostId"]), None)
        if host is not None:
            host = _cpu_lane_offer(host, requested.get("cpuScheduling", {}).get("lane", "standard"))
        clock = self._clock()
        if type(clock) not in (int, float) or not math.isfinite(clock):
            raise ValueError("Invalid platform clock")
        now = _integer(math.floor(clock), 0, MAX_SAFE)
        near = requested.get("near"); configured_near = config.get("near")
        expected_receipt = (2 if config.get("cpuReceiptVersion") == 2 and near is None
                            and requested["task"]["kind"] not in ("session", "near_inference") else 1)
        if value.get("receiptVersion", 1) != expected_receipt:
            raise ValueError("Platform quote changed its reviewed CPU receipt version")
        if near is not None and (configured_near is None or any(near[key] != configured_near[key]
                                                               for key in ("model", "maxTokens", "policySha256"))):
            raise ValueError("Platform NEAR request differs from the reviewed model or policy")
        inference_price = configured_near["inferencePrice"] if near is not None else "0"
        base = q["maxSeconds"] * int(q["pricePerSecond"]) + int(q["inferencePrice"])
        ceiling = base + (base * 900 + 9999) // 10000
        def text_hash(text: str) -> str:
            return "0x" + self._digest(text.encode("utf-8")).hex()
        if (host is None or q["payer"] != self._payer(config, principal) or value["input"] != requested
                or host["lane"] != requested.get("cpuScheduling", {}).get("lane", "standard")
                or requested.get("cpuScheduling", {}).get("job", {}).get("targetHostId", q["hostId"]) != q["hostId"]
                or q["hostId"] in requested.get("excludedHostIds", [])
                or q["leashId"] != requested["leashId"] or q["maxSeconds"] != requested["maxSeconds"]
                or q["pricePerSecond"] != _host_price(requested["task"], host)
                or not historical and (q["quoteExpiry"] < now or q["quoteExpiry"] > now + 120 or now + q["maxSeconds"] > requested["deadline"])
                or q["quoteExpiry"] + q["maxSeconds"] > requested["deadline"]
                or (requested["regions"] and host["region"] not in requested["regions"])
                or not _host_supports(requested["task"], host)
                or q["regionHash"] != text_hash(host["region"]) or q["imageHash"] != text_hash(host["imageDigest"])
                or q["inferencePrice"] != inference_price
                or q["workloadHash"] != text_hash(_canonical(_workload(requested))) or base == 0
                or value["ceiling"] != str(ceiling) or ceiling > int(requested["maxSpend"])):
            raise ValueError("Platform quote changed its payer, task, scope, deadline or fee ceiling")
        self._check_leash(config, q["leashId"])
        domain = {"name": "TelomerePlatformEscrow", "version": "2" if "financialProfile" in self._pins else "1",
                  "chainId": self._pins["chainId"], "verifyingContract": self._pins["escrowAddress"]}
        if verifier.verify_typed_data(self._pins["quoteSigner"], _typed(domain, "PlatformQuote", QUOTE_FIELDS, q), signature) is not True:
            raise ValueError("Platform quote signature did not verify locally")
        destination = self.vault if isinstance(self, PlatformVaultRuntimeClient) else self._pins["escrowAddress"]
        value["transaction"] = self._transaction(value["transaction"], destination, self._encode_open(q, signature, value["imageProof"], value["regionProof"]))
        return value

    def _check_leash(self, config: dict[str, Any], leash: str) -> None:
        pass

    def quote(self, raw: dict[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        self._financial(); body = _input(raw); key = _key(idempotency_key); fingerprint = _canonical(body)
        with self._lock:
            prior = self._quote_inputs.get(key)
            if prior is not None and prior != fingerprint:
                raise ValueError("Platform idempotency key belongs to different work")
            if prior is None and len(self._quote_inputs) >= 128:
                raise ValueError("Platform quote history is full; retain reservations and use a new client")
            self._quote_inputs[key] = fingerprint
            known = self._quotes.get(key)
            if known is not None:
                return copy.deepcopy(self._checked_prepared(known[1], body))
            config = self.config(); self._principal(config, "owner" if body.get("cpuScheduling", {}).get("lane") == "interruptible" else "agent"); self._check_leash(config, body["leashId"])
            if "near" in body:
                reviewed = config.get("near")
                if reviewed is None or any(body["near"][field] != reviewed[field]
                                        for field in ("model", "maxTokens", "policySha256")):
                    raise ValueError("No reviewed NEAR model and policy enables this task")
            if not any(_host_supports(body["task"], host) and host["hostId"] not in body.get("excludedHostIds", [])
                       and (not body["regions"] or host["region"] in body["regions"])
                       for host in config["capacity"]):
                raise ValueError("No reviewed host enables this pinned platform task in the requested regions")
            response = self._request(self._path("/quotes"), method="POST", body=body, idempotency_key=key)
            result = self._checked_prepared(response, body)
            self._quotes[key] = (fingerprint, copy.deepcopy(result))
            return copy.deepcopy(result)

    def open_plan(self, prepared: dict[str, Any]) -> dict[str, Any]:
        value = _object(prepared)
        return copy.deepcopy(self._checked_prepared(value, _input(value.get("input")))["transaction"])

    def _checked_run(self, raw: Any, config: dict[str, Any], principal: str, run_id: str | None = None) -> dict[str, Any]:
        value = copy.deepcopy(_object(raw))
        if not RUN_FIELDS <= set(value) or set(value) - RUN_FIELDS - {"nearResult", "executionKind", "feeDiscountBps", "cpuDispatch"}:
            raise ValueError("Unexpected platform run fields")
        value["id"] = _bytes32(value["id"]); value["quote"] = q = _quote(value["quote"])
        if value["status"] not in ("prepared", "queued", "running", "near_dispatching", "receipt_pending", "settling",
                                   "completed", "refunded", "reconciliation"):
            raise ValueError("Unknown platform run status")
        _money(value["ceiling"]); self._check_leash(config, q["leashId"])
        maximum = q["maxSeconds"] * int(q["pricePerSecond"]) + int(q["inferencePrice"])
        if (value["id"] != q["runId"] or (run_id is not None and value["id"] != run_id) or q["payer"] != self._payer(config, principal)
                or int(value["ceiling"]) != maximum + (maximum * 900 + 9999) // 10000):
            raise ValueError("Platform run changed its payer, request or fee ceiling")
        for key in ("admissionTx", "settlementTx"):
            if value[key] is not None:
                value[key] = _bytes32(value[key])
        discount = value.get("feeDiscountBps", 0)
        if (type(discount) is not int or discount not in (0, 100, 200, 300)
                or "financialProfile" not in self._pins and discount != 0
                or "financialProfile" in self._pins and value["admissionTx"] is not None and "feeDiscountBps" not in value):
            raise ValueError("Platform run lacks its reviewed admission fee discount")
        for key in ("charged", "refund"):
            if value[key] is not None and int(_money(value[key])) > int(value["ceiling"]):
                raise ValueError("Platform reported amount exceeds the reservation")
        if value["charged"] is not None and value["refund"] is not None and int(value["charged"]) + int(value["refund"]) != int(value["ceiling"]):
            raise ValueError("Platform reported funds do not conserve the reservation")
        if value["settlement"] is not None:
            settlement = _object(value["settlement"], {"runId", "billableSeconds", "endedAt", "inferenceCharge", "receiptHash"})
            settlement["runId"] = _bytes32(settlement["runId"]); settlement["receiptHash"] = _bytes32(settlement["receiptHash"])
            _integer(settlement["billableSeconds"], 0, q["maxSeconds"]); _integer(settlement["endedAt"], 1, MAX_SAFE)
            charge = _money(settlement["inferenceCharge"])
            if settlement["runId"] != value["id"] or charge not in ("0", q["inferencePrice"]):
                raise ValueError("Platform settlement changed its run or fixed inference charge")
            if value.get("executionKind") == "near_inference" and settlement["billableSeconds"] != 0:
                raise ValueError("Inference-only result cannot bill CPU seconds")
            base = settlement["billableSeconds"] * int(q["pricePerSecond"]) + int(charge)
            charged = base + (base * (900 - discount) + 9999) // 10000
            if charged > int(value["ceiling"]) or (value["charged"] is not None and int(value["charged"]) != charged):
                raise ValueError("Platform charged amount differs from the signed quote and settlement")
        if value["status"] == "completed" and (value["settlement"] is None or value["charged"] is None or value["refund"] is None):
            raise ValueError("Platform completed run lacks exact settlement accounting")
        if value["status"] == "refunded" and (value["charged"] != "0" or value["refund"] != value["ceiling"]):
            raise ValueError("Platform refunded run differs from the original reservation")
        if "cpuDispatch" in value:
            dispatch = _object(value["cpuDispatch"], {"state", "confirmed", "admissionTx"})
            dispatch["admissionTx"] = _bytes32(dispatch["admissionTx"])
            if (dispatch["state"] != "never_dispatched" or dispatch["confirmed"] is not True
                    or dispatch["admissionTx"] != value["admissionTx"] or value["admissionTx"] is None
                    or value["status"] not in ("completed", "refunded") or value["charged"] != "0"
                    or value["refund"] != value["ceiling"]
                    or value["settlement"] is not None and value["settlement"]["billableSeconds"] != 0):
                raise ValueError("Platform never-dispatched controller observation changed its original refunded run")
        if "executionKind" in value and (value["executionKind"] != "near_inference" or q["inferencePrice"] == "0"):
            raise ValueError("Unsupported platform execution kind")
        if (q["inferencePrice"] != "0") != ("nearResult" in value):
            raise ValueError("Platform run changed its provider-result scope")
        if "nearResult" in value:
            _bounded_result(value["nearResult"])
        if value["errorCode"] is not None and (not isinstance(value["errorCode"], str) or len(value["errorCode"]) > 128):
            raise ValueError("Invalid platform error code")
        _bounded_result(value["result"])
        return value

    def admit(self, raw: dict[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        self._financial(); body = copy.deepcopy(_object(raw, {"runId", "transactionHash"}))
        body["runId"] = _bytes32(body["runId"]); body["transactionHash"] = _bytes32(body["transactionHash"])
        config = self.config(); principal = self._principal(config, "agent")
        result = self._checked_run(self._request(self._path("/runs"), method="POST", body=body, idempotency_key=_key(idempotency_key)), config, principal, body["runId"])
        if result["admissionTx"] != body["transactionHash"]:
            raise ValueError("Platform admission changed its original reservation transaction")
        return result

    def list(self) -> dict[str, Any]:
        config = self.config(); principal = self._principal(config)
        value = _object(self._request(self._path("/runs")), {"runs"})
        if not isinstance(value["runs"], list) or len(value["runs"]) > 128:
            raise ValueError("Platform run list exceeds its bound")
        return {"runs": [self._checked_run(run, config, principal) for run in value["runs"]]}

    def get(self, run_id: str) -> dict[str, Any]:
        run_id = _bytes32(run_id); config = self.config(); principal = self._principal(config)
        return self._checked_run(self._request(self._path("/runs/" + run_id)), config, principal, run_id)

    def command(self, run_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        run_id = _bytes32(run_id); command = _session_command(raw)
        config = self.config(); self._principal(config, "agent")
        run = self.get(run_id)
        if run["status"] != "running" or run["admissionTx"] is None:
            raise ValueError("Paid session is not an active admitted run")
        key = (run_id, command["commandId"]); fingerprint = _canonical(command)
        with self._lock:
            prior = self._command_inputs.get(key)
            if prior is not None and prior != fingerprint:
                raise ValueError("Paid session command ID belongs to different work")
            if prior is None and len(self._command_inputs) >= 4096:
                raise ValueError("Paid session command history is full; use a new client")
            self._command_inputs[key] = fingerprint
        return _session_command_result(self._request(self._path("/runs/" + run_id + "/commands"),
                                                     method="POST", body=command, idempotency_key=command["commandId"],
                                                     paid_command=True), command)

    def session_events(self, run_id: str, *, after_sequence: int = -1, limit: int = 8) -> dict[str, Any]:
        run_id = _bytes32(run_id); after_sequence, limit = _session_cursor(after_sequence, limit)
        run = self.get(run_id)
        if run["admissionTx"] is None:
            raise ValueError("Paid session has not been admitted")
        path = self._path("/runs/" + run_id + "/events") + f"?after={after_sequence}&limit={limit}"
        return _session_event_page(self._request(path), after_sequence, limit)

    def _action_plan(self, action: str, run_id: str, key: str) -> dict[str, Any]:
        self._financial(); run_id = _bytes32(run_id); config = self.config()
        principal = self._principal(config, "owner" if action == "stop" else "read")
        self._checked_run(self._request(self._path("/runs/" + run_id)), config, principal, run_id)
        function = "requestStop(bytes32)" if action == "stop" else "refundRun(bytes32)"
        data = "0x" + (self._digest(function.encode("ascii"))[:4] + bytes.fromhex(run_id[2:])).hex()
        destination = self.vault if action == "stop" and isinstance(self, PlatformVaultRuntimeClient) else self._pins["escrowAddress"]
        return self._transaction(self._request(self._path("/runs/" + run_id + "/" + action), method="POST", body={}, idempotency_key=_key(key)), destination, data)

    def stop_plan(self, run_id: str, *, idempotency_key: str) -> dict[str, Any]:
        return self._action_plan("stop", run_id, idempotency_key)

    def refund_plan(self, run_id: str, *, idempotency_key: str) -> dict[str, Any]:
        return self._action_plan("refund", run_id, idempotency_key)


class PlatformVaultRuntimeClient(PlatformRuntimeClient):
    """Agent pays through its reviewed Vault; the human owner retains stop authority."""

    def __init__(self, base_url: str, *, pins: dict[str, Any], vault_pins: dict[str, Any], vault: str,
                 binding: dict[str, Any] | None = None, verifier: CryptoVerifier | None = None,
                 transport: Transport | None = None, clock: Callable[[], float] = time.time,
                 cpu_receipt_version: int | None = None):
        super().__init__(base_url, pins=pins, verifier=verifier, transport=transport, clock=clock,
                         cpu_receipt_version=cpu_receipt_version)
        self.vault = _address(vault); self._vault_pins = _pins(vault_pins, vault=True)
        discount_registry = self._pins.get("financialProfile", {}).get("discountVaultRegistry")
        if discount_registry is not None and discount_registry != {
                "address": self._vault_pins["registryAddress"], "codeHash": self._vault_pins["registryCodeHash"],
                "implementationAddress": self._vault_pins["implementationAddress"],
                "implementationCodeHash": self._vault_pins["implementationCodeHash"]}:
            raise ValueError("Vault pins differ from the reviewed economics factory")
        self._binding = None if binding is None else _binding(binding)
        if self._binding is not None and self._binding["vault"] != self.vault:
            raise ValueError("Reviewed Vault binding differs from expected Vault")

    def _path(self, suffix: str) -> str:
        return "/api/platform/vaults/" + self.vault + suffix

    def _check_config(self, config: dict[str, Any]) -> None:
        config["vaultPins"] = _pins(config["vaultPins"], vault=True); config["binding"] = _binding(config["binding"])
        if config["vaultPins"] != self._vault_pins:
            raise ValueError("Vault deployment differs from reviewed pins")
        if config["binding"]["vault"] != self.vault or (self._binding is not None and config["binding"] != self._binding):
            raise ValueError("Vault configuration changed its reviewed binding")

    def _principal(self, config: dict[str, Any], role: str = "read") -> str:
        principal = super()._principal(config, role)
        agent = principal == config["binding"]["agentWallet"]; owner = principal == config["binding"]["owner"]
        if (role == "agent" and not agent) or (role == "owner" and not owner) or (role == "read" and not agent and not owner):
            raise ValueError("Authenticated wallet is not authorized for this Vault action")
        return principal

    def _payer(self, config: dict[str, Any], principal: str) -> str:
        return self.vault

    def _check_leash(self, config: dict[str, Any], leash: str) -> None:
        if leash != config["binding"]["leashId"]:
            raise ValueError("Requested Leash differs from Vault binding")

    def _checked_cpu_job(self, raw: Any, *, historical: bool = False) -> dict[str, Any]:
        value = copy.deepcopy(_object(raw, {"protocol", "id", "owner", "vault", "binding", "intentHash", "input", "createdAt", "phase",
            "runIds", "currentRunId", "proposal", "approvalHash", "charged", "outstandingLiability", "cancellationReason",
            "prepared", "fundsReserved", "funding", "stopAndRefundRequired"}))
        config = self.config(); self._principal(config, "owner"); value["input"] = _cpu_job_input(value["input"])
        value["binding"] = _binding(value["binding"]); value["id"] = _bytes32(value["id"])
        value["owner"], value["vault"] = _address(value["owner"]), _address(value["vault"])
        _integer(value["createdAt"], 0, MAX_SAFE); _money(value["charged"]); _money(value["outstandingLiability"])
        intent = {"domain": "telomere-paid-cpu-job-intent/v1", "jobId": value["id"], "binding": value["binding"],
                  "input": value["input"], "createdAt": value["createdAt"], "pins": self._pins}
        expected_intent = "0x" + self._digest(_canonical(_normalize_job_addresses(intent)).encode()).hex()
        if (value["protocol"] != "telomere-paid-cpu-job-v1" or value["binding"] != config["binding"]
                or value["owner"] != config["binding"]["owner"] or value["vault"] != self.vault
                or value["input"]["leashId"] != config["binding"]["leashId"] or _bytes32(value["intentHash"]) != expected_intent
                or value["phase"] not in ("preparing", "active", "awaiting_owner", "approved", "cancelled", "finished")
                or value["fundsReserved"] is not False or value["funding"] != "external-wallet-required"
                or type(value["stopAndRefundRequired"]) is not bool
                or int(value["charged"]) + int(value["outstandingLiability"]) > int(value["input"]["maxSpend"])):
            raise ValueError("Owner CPU job changed its original scope, deadline or total budget")
        if not isinstance(value["runIds"], list) or len(value["runIds"]) > 64:
            raise ValueError("CPU job reservation history exceeds its bound")
        value["runIds"] = [_bytes32(item) for item in value["runIds"]]
        for key in ("currentRunId", "approvalHash"):
            if value[key] is not None:
                value[key] = _bytes32(value[key])
        if value["cancellationReason"] not in (None, "deadline_infeasible", "budget_exhausted", "capacity_infeasible", "owner_cancelled"):
            raise ValueError("Unsupported CPU job cancellation reason")
        proposal = value["proposal"]
        if proposal is not None:
            _object(proposal)
            if (proposal.get("domain") != "telomere.cpu-replacement.v1" or proposal.get("jobId") != value["id"]
                    or proposal.get("originalDeadline") != value["input"]["deadline"]
                    or proposal.get("originalMaxSpend") != value["input"]["maxSpend"]
                    or proposal.get("requiresSeparateOwnerApproval") is not True or proposal.get("fundsReserved") is not False
                    or _object(proposal.get("target")).get("lane") not in value["input"]["lanes"]):
                raise ValueError("CPU proposal changed its original owner intent")
            body = {key: item for key, item in proposal.items() if key not in ("decisionHash", "requiresSeparateOwnerApproval", "fundsReserved")}
            if _bytes32(proposal.get("decisionHash")) != "0x" + self._digest(_canonical(body).encode()).hex():
                raise ValueError("CPU replacement decision hash changed")
            for key in ("charged", "outstandingLiability", "remainingBudget", "liabilityCeiling", "ceiling"):
                _money(proposal[key])
            if (int(proposal["charged"]) + int(proposal["outstandingLiability"]) + int(proposal["remainingBudget"]) != int(value["input"]["maxSpend"])
                    or int(proposal["liabilityCeiling"]) > int(proposal["remainingBudget"])):
                raise ValueError("CPU replacement exceeds the original complete budget")
        if value["prepared"] is not None:
            prepared = self._checked_prepared(value["prepared"], _input(value["prepared"]["input"]), role="owner", historical=historical)
            job = prepared["input"].get("cpuScheduling", {}).get("job", {})
            if (prepared["quote"]["runId"] != value["currentRunId"] or value["currentRunId"] not in value["runIds"]
                    or job.get("jobId") != value["id"] or job.get("intentHash") != value["intentHash"]
                    or job.get("decisionHash") != value["approvalHash"] or prepared["input"]["task"] != value["input"]["task"]
                    or prepared["input"]["deadline"] != value["input"]["deadline"]):
                raise ValueError("CPU job quote changed its exact original owner approval")
            value["prepared"] = prepared
        return value

    def create_cpu_job(self, raw: Any, *, idempotency_key: str) -> dict[str, Any]:
        body = _cpu_job_input(raw); config = self.config(); self._principal(config, "owner")
        value = self._checked_cpu_job(self._request(self._path("/cpu-jobs"), method="POST", body=body, idempotency_key=_key(idempotency_key)))
        if value["input"] != body:
            raise ValueError("Owner CPU job changed its original request")
        return value

    def cpu_job(self, job_id: str) -> dict[str, Any]:
        config = self.config(); self._principal(config, "owner")
        return self._checked_cpu_job(self._request(self._path("/cpu-jobs/" + _bytes32(job_id))), historical=True)

    def replan_cpu_job(self, job_id: str, raw: Any, *, idempotency_key: str) -> dict[str, Any]:
        config = self.config(); self._principal(config, "owner")
        return self._checked_cpu_job(self._request(self._path("/cpu-jobs/" + _bytes32(job_id) + "/replan"), method="POST",
            body=_cpu_job_replan(raw), idempotency_key=_key(idempotency_key)), historical=True)

    def approve_cpu_job(self, job_id: str, decision_hash: str) -> dict[str, Any]:
        config = self.config(); self._principal(config, "owner")
        return self._checked_cpu_job(self._request(self._path("/cpu-jobs/" + _bytes32(job_id) + "/approve"), method="POST",
            body={"decisionHash": _bytes32(decision_hash)}))

    def cancel_cpu_job(self, job_id: str) -> dict[str, Any]:
        config = self.config(); self._principal(config, "owner")
        return self._checked_cpu_job(self._request(self._path("/cpu-jobs/" + _bytes32(job_id) + "/cancel"), method="POST", body={}), historical=True)

    def finish_cpu_job(self, job_id: str, *, expected_source_run_id: str | None = None) -> dict[str, Any]:
        body = {} if expected_source_run_id is None else {"expectedSourceRunId": _bytes32(expected_source_run_id)}
        config = self.config(); self._principal(config, "owner")
        return self._checked_cpu_job(self._request(self._path("/cpu-jobs/" + _bytes32(job_id) + "/finish"), method="POST", body=body), historical=True)

    def cpu_reliability(self, host_id: str, lane: str) -> dict[str, Any]:
        config = self.config(); self._principal(config, "owner"); host_id = _bytes32(host_id)
        if lane not in ("standard", "interruptible"):
            raise ValueError("Unknown CPU lane")
        value = _object(self._request(self._path("/cpu-jobs/reliability/" + host_id + "/" + lane)),
            {"protocol", "scope", "marketWide", "hardwareClass", "hostId", "lane", "from", "until", "eligible", "completed",
             "reliabilityBps", "noHistoryPrior", "excludedUnverified", "attribution"})
        if (value["protocol"] != "telomere-paid-cpu-reliability-v1" or value["scope"] != "verified-local-controller-history"
                or value["marketWide"] is not False or value["hardwareClass"] != "cpu" or value["hostId"] != host_id
                or value["lane"] != lane or value["noHistoryPrior"] != 10000
                or value["attribution"] != "canonical-financial-settlement-and-retained-hostkit-cleanup"):
            raise ValueError("CPU reliability scope changed")
        for key in ("from", "until", "eligible", "completed", "excludedUnverified"):
            _integer(value[key], 0, MAX_SAFE)
        _integer(value["reliabilityBps"], 1, 10000)
        if value["completed"] > value["eligible"] or value["from"] > value["until"]:
            raise ValueError("CPU reliability sample accounting changed")
        return value
