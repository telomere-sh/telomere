"""Fail-closed subprocess boundary. stdin contains public evidence, never API keys.

NRAS is the default. Protected NVIDIA_VERIFIER_MODE/NVIDIA_NVAT_BINARY/
NVIDIA_NVAT_LIBRARY configuration must agree with the exact reviewed policy to
enable local raw GPU verification. Input documents cannot select an executable.
"""
import argparse
import asyncio
import json
import hashlib
import re
import signal
import sys
from pathlib import Path

from verifier import MAX_DOCUMENT_BYTES, VerificationError, parse_json, verify, verify_cloud, verify_cloud_archive, verify_direct_archive, verify_gateway


async def run_verification(operation, document, policy):
    """Let a parent SIGTERM cancel verification so the native child is reaped."""
    loop, task = asyncio.get_running_loop(), asyncio.current_task()
    previous = signal.getsignal(signal.SIGTERM)
    installed = False
    try:
        # UNIX process termination is cooperative. A caller may still apply its
        # process-group deadline if this bounded child cleanup cannot complete.
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
        installed = True
    except (NotImplementedError, RuntimeError, ValueError):
        # The pinned local NVIDIA SDK is Linux-only. NRAS Windows verification
        # retains normal platform signal behavior and never spawns this SDK.
        pass
    try:
        return await operation(document, policy)
    finally:
        if installed:
            loop.remove_signal_handler(signal.SIGTERM)
            signal.signal(signal.SIGTERM, previous)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    parser.add_argument("--policy-sha256", help="Require the exact reviewed policy bytes")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--gateway", action="store_true", help="Verify a NEAR AI Cloud gateway report")
    mode.add_argument("--cloud", action="store_true", help="Verify gateway and all model candidates")
    mode.add_argument("--cloud-archive", action="store_true", help="Replay saved Cloud evidence; never authorize a live session")
    mode.add_argument("--direct-archive", action="store_true", help="Replay saved direct-model evidence; never authorize a live session")
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise VerificationError("INPUT_INVALID")
        with Path(args.policy).open("rb") as source:
            policy = source.read(MAX_DOCUMENT_BYTES + 1)
        if len(policy) > MAX_DOCUMENT_BYTES:
            raise VerificationError("POLICY_INVALID")
        if args.policy_sha256 is not None:
            if not re.fullmatch(r"0x[0-9a-f]{64}", args.policy_sha256):
                raise VerificationError("POLICY_INVALID")
            if "0x" + hashlib.sha256(policy).hexdigest() != args.policy_sha256:
                raise VerificationError("POLICY_CHANGED")
        operation = verify_direct_archive if args.direct_archive else verify_cloud_archive if args.cloud_archive else verify_cloud if args.cloud else verify_gateway if args.gateway else verify
        result = asyncio.run(run_verification(operation, parse_json(raw), parse_json(policy)))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except asyncio.CancelledError:
        print(json.dumps({"ok": False, "error": "VERIFICATION_ABORTED"}))
    except VerificationError as error:
        print(json.dumps({"ok": False, "error": error.code}))
    except Exception:
        # Native DCAP/HTTP exceptions can contain evidence, addresses, and headers.
        print(json.dumps({"ok": False, "error": "VERIFICATION_FAILED"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
