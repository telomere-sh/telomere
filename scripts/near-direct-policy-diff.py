"""Compare a saved, hardware-appraised NEAR direct packet with exact expired v6 policy.

This historical comparison never admits a workload, renews a policy, or calls
NEAR. The vendored verifier may fetch read-only Intel/NVIDIA collateral while
rechecking raw hardware evidence with the pinned local NVIDIA implementation.
"""

import argparse
import asyncio
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
import time


V6_POLICY_SHA256 = "75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa"
V6_POLICY_VERSION = "near-direct-glm-e1-2026-10-03.6-nvat"
MODEL = "z-ai/glm-5.3-flash"
HEX32 = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"nearaidev/compose-manager@sha256:[0-9a-f]{64}\Z")
SAFE_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,63}\Z")


class DiffError(Exception):
    pass


def direct_appraiser():
    source = Path(__file__).with_name("near-direct-appraisal.py")
    spec = importlib.util.spec_from_file_location("near_direct_appraisal_for_diff", source)
    if spec is None or spec.loader is None:
        raise DiffError()
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hex_value(value, size):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{%d}" % (size * 2), value) is not None


def check_measurements(value, sizes):
    return (isinstance(value, dict) and set(value) == set(sizes)
            and all(hex_value(value[key], size) for key, size in sizes.items()))


def check_gpu_models(value):
    return (isinstance(value, list) and 1 <= len(value) <= 32
            and all(isinstance(item, str) and 1 <= len(item) <= 128 for item in value))


def load_pinned_policy(path, claimed_sha256, verifier, appraiser):
    if (not path.is_absolute() or path.is_symlink() or claimed_sha256 != V6_POLICY_SHA256):
        raise DiffError()
    try:
        raw = appraiser.read_regular(path, 1_048_576)
        if hashlib.sha256(raw).hexdigest() != V6_POLICY_SHA256:
            raise DiffError()
        policy = verifier.parse_json(raw)
        if not isinstance(policy, dict):
            raise DiffError()
        start = verifier.timestamp(policy.get("validFrom"))
        end = verifier.timestamp(policy.get("validUntil"))
        expected_nvat = {"mode": "local", "sdkVersion": verifier.NVAT_VERSION,
                         "binarySha256": verifier.NVAT_BINARY_SHA256,
                         "librarySha256": verifier.NVAT_LIBRARY_SHA256}
        profiles = policy.get("profiles")
        if (type(policy.get("schemaVersion")) is not int or policy["schemaVersion"] != 1
                or policy.get("version") != V6_POLICY_VERSION
                or policy.get("nvidiaVerifier") != expected_nvat
                or not start < end or type(policy.get("maxSessionSeconds")) is not int
                or not 1 <= policy["maxSessionSeconds"] <= 300
                or not isinstance(profiles, list) or not 1 <= len(profiles) <= 32):
            raise DiffError()
        for profile in profiles:
            if (not isinstance(profile, dict) or not isinstance(profile.get("model"), str)
                    or not 1 <= len(profile["model"]) <= 512
                    or not hex_value(profile.get("appComposeSha256"), 32)
                    or not hex_value(profile.get("composeManagerActionsSha256"), 32)
                    or not isinstance(profile.get("composeManagerImage"), str)
                    or not IMAGE.fullmatch(profile["composeManagerImage"])
                    or type(profile.get("gpuCount")) is not int
                    or not 1 <= profile["gpuCount"] <= 32
                    or not check_gpu_models(profile.get("gpuModels"))
                    or not check_measurements(profile.get("measurements"), verifier.MEASUREMENTS)):
                raise DiffError()
        return policy, start, end
    except Exception:
        raise DiffError() from None


def checked_facts(facts, document, verifier):
    if (not isinstance(facts, dict) or facts.get("model") != MODEL
            or facts.get("cpuStatus") != "UpToDate"
            or facts.get("tlsSpkiSha256") != document["tlsSpkiSha256"]
            or type(facts.get("gpuCount")) is not int or not 1 <= facts["gpuCount"] <= 32
            or not check_gpu_models(facts.get("gpuModels"))
            or not isinstance(facts.get("appComposeSha256"), str)
            or not HEX32.fullmatch(facts["appComposeSha256"])
            or not isinstance(facts.get("composeManagerActionsSha256"), str)
            or not HEX32.fullmatch(facts["composeManagerActionsSha256"])
            or not isinstance(facts.get("composeManagerImage"), str)
            or not IMAGE.fullmatch(facts["composeManagerImage"])
            or not check_measurements(facts.get("measurements"), verifier.MEASUREMENTS)):
        raise DiffError()
    return facts


def profile_deltas(profile, facts, verifier):
    deltas = []
    if profile["gpuModels"] != facts["gpuModels"]:
        deltas.append({"field": "gpuModels"})
    if profile["composeManagerActionsSha256"] != facts["composeManagerActionsSha256"]:
        deltas.append({"field": "composeManagerActionsSha256",
                       "baseline": profile["composeManagerActionsSha256"],
                       "candidate": facts["composeManagerActionsSha256"]})
    for key in verifier.MEASUREMENTS:
        if profile["measurements"][key] != facts["measurements"][key]:
            deltas.append({"field": "measurements." + key,
                           "baseline": profile["measurements"][key],
                           "candidate": facts["measurements"][key]})
    return deltas


def base(status, time_gate):
    return {"status": status, "policyTimeGate": time_gate, "approval": "UNAPPROVED",
            "liveAdmission": False, "policyRenewed": False,
            "newNearReportGets": 0, "paidInferencePosts": 0}


async def compare_packet(packet_path, policy_path, claimed_sha256, binary_path,
                         library_path, verifier, appraiser, *, now=None):
    document = appraiser.load_packet(packet_path, verifier)
    policy, start, end = load_pinned_policy(policy_path, claimed_sha256, verifier, appraiser)
    nvidia = appraiser.local_nvidia_config(verifier, binary_path, library_path)
    current = time.time() if now is None else now
    if (isinstance(current, bool) or not isinstance(current, (int, float))
            or not math.isfinite(current)):
        raise DiffError()
    time_gate = "NOT_YET_VALID" if current < start else "EXPIRED" if current >= end else "IN_WINDOW"
    try:
        facts = await asyncio.wait_for(verifier.inspect_evidence(document, nvidia_local=nvidia), 250)
        checked_facts(facts, document, verifier)
    except Exception as error:
        code = getattr(error, "code", None)
        return {**base("HARDWARE_REJECTED", time_gate),
                "reasonCode": code if isinstance(code, str) and SAFE_CODE.fullmatch(code)
                else "APPRAISAL_FAILED"}
    candidates = [(index, profile) for index, profile in enumerate(policy["profiles"])
                  if (profile["model"] == facts["model"]
                      and profile["gpuCount"] == facts["gpuCount"]
                      and profile["appComposeSha256"] == facts["appComposeSha256"]
                      and profile["composeManagerImage"] == facts["composeManagerImage"])]
    safe_facts = {"model": MODEL, "gpuCount": facts["gpuCount"],
                  "composeManagerActionsSha256": facts["composeManagerActionsSha256"]}
    if len(candidates) != 1:
        return {**base("PROFILE_NOT_FOUND" if not candidates else "PROFILE_AMBIGUOUS", time_gate),
                **safe_facts}
    index, profile = candidates[0]
    deltas = profile_deltas(profile, facts, verifier)
    status = ("POLICY_NOT_YET_VALID" if time_gate == "NOT_YET_VALID" else
              "POLICY_EXPIRED" if time_gate == "EXPIRED" else
              "PROFILE_DIFFERENT" if deltas else "PROFILE_MATCH_NO_ADMISSION")
    return {**base(status, time_gate), **safe_facts, "baselineProfileIndex": index,
            "profileExactMatch": not deltas, "deltas": deltas}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", required=True, help="Absolute private direct candidate directory")
    parser.add_argument("--policy", required=True, help="Absolute exact v6 provider-policy.json")
    parser.add_argument("--policy-sha256", required=True, help="Exact pinned v6 file SHA-256")
    parser.add_argument("--nvat-binary", help="Absolute pinned local NVIDIA NVAT binary")
    parser.add_argument("--nvat-library", help="Absolute pinned local NVIDIA NVAT library")
    arguments = parser.parse_args()
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra" / "near"))
        verifier = importlib.import_module("verifier")
        result = asyncio.run(compare_packet(
            Path(arguments.packet), Path(arguments.policy), arguments.policy_sha256,
            arguments.nvat_binary or os.environ.get("NEAR_NVAT_BINARY"),
            arguments.nvat_library or os.environ.get("NEAR_NVAT_LIBRARY"), verifier,
            direct_appraiser()))
        print(json.dumps(result, separators=(",", ":")))
        # A successful historical comparison is never live authorization.
        return 1
    except Exception:
        print(json.dumps({**base("DIFF_FAILED", "UNKNOWN"),
                          "reasonCode": "PACKET_POLICY_OR_RUNTIME_INVALID"},
                         separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
