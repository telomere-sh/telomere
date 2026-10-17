"""Human-gated LangGraph starter for one Base USDC paid CPU Cell.

The process holds an in-memory LangGraph checkpoint and the checked SDK quote.
The owner signs and broadcasts the displayed openRun intent in an external wallet.
No private key, transaction broadcaster, or model API key is used here.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from typing import Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from telomere_sdk import DeploymentPins, EthAccountVerifier, QuotedRun, TelomereClient


class CellState(TypedDict, total=False):
    leash_id: str
    text: str
    max_seconds: int
    idempotency_key: str
    run_id: str
    ceiling: str
    wallet_plan: dict[str, Any]
    tx_hash: str
    admitted: dict[str, Any]
    observed: dict[str, Any]


def wallet_plan_json(quoted: QuotedRun) -> dict[str, Any]:
    action = quoted.wallet_action
    return {"planId": action.plan_id, "purpose": action.purpose, "requiresWallet": action.requires_wallet,
            "runId": action.run_id, "leashId": action.leash_id, "expiresAt": action.expires_at,
            "nextStep": action.next_step,
            "intents": [{"chainId": item.chain_id, "to": item.to, "data": item.data,
                         "value": item.value, "summary": item.summary} for item in action.intents]}


def build_graph(client: TelomereClient, *, poll_seconds: float = 20.0):
    """Quote, pause for an external wallet, admit its original receipt, then observe."""
    quotes: dict[str, QuotedRun] = {}

    def prepare(state: CellState) -> dict[str, Any]:
        quoted = client.quote({"leashId": state["leash_id"],
                               "task": {"kind": "sha256", "text": state["text"]},
                               "maxSeconds": state["max_seconds"]},
                              idempotency_key=state["idempotency_key"])
        run_id = quoted.quote["runId"]
        quotes[run_id] = quoted
        return {"run_id": run_id, "ceiling": quoted.ceiling, "wallet_plan": wallet_plan_json(quoted)}

    def owner_wallet(state: CellState) -> dict[str, Any]:
        # Keep this node side-effect free. LangGraph re-enters it on resume.
        tx_hash = interrupt({"runId": state["run_id"], "walletAction": state["wallet_plan"]})
        if not isinstance(tx_hash, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash):
            raise ValueError("Paste the original confirmed openRun transaction hash")
        return {"tx_hash": tx_hash.lower()}

    def admit(state: CellState) -> dict[str, Any]:
        quoted = quotes.get(state["run_id"])
        if quoted is None:
            raise ValueError("The in-memory verified quote is gone; reconcile the original run before retrying")
        return {"admitted": client.admit(quoted, state["tx_hash"])}

    def observe(state: CellState) -> dict[str, Any]:
        deadline = time.monotonic() + poll_seconds
        while True:
            run = client.run(state["run_id"])
            if run["status"] in {"completed", "failed", "cancelled", "timed_out", "refunded"} or time.monotonic() >= deadline:
                return {"observed": run}
            time.sleep(0.25)

    builder = StateGraph(CellState)
    builder.add_node("prepare_quote", prepare)
    builder.add_node("external_owner_wallet", owner_wallet)
    builder.add_node("admit_original_payment", admit)
    builder.add_node("observe_run", observe)
    builder.add_edge(START, "prepare_quote")
    builder.add_edge("prepare_quote", "external_owner_wallet")
    builder.add_edge("external_owner_wallet", "admit_original_payment")
    builder.add_edge("admit_original_payment", "observe_run")
    builder.add_edge("observe_run", END)
    return builder.compile(checkpointer=InMemorySaver())


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Reviewed Telomere HTTPS origin or loopback demo origin")
    parser.add_argument("--chain-id", type=int, required=True, help="31337 local demo, 84532 Base Sepolia, or 8453 Base mainnet")
    parser.add_argument("--escrow-address", required=True)
    parser.add_argument("--token-address", required=True, help="Reviewed Circle native USDC address on Base; local demo token on 31337")
    parser.add_argument("--token-code-hash", help="Independently reviewed USDC proxy code hash; required on Base")
    parser.add_argument("--token-implementation-address", help="Independently reviewed Circle proxy implementation; required on Base")
    parser.add_argument("--token-implementation-code-hash", help="Independently reviewed implementation code hash; required on Base")
    parser.add_argument("--receipt-signer", required=True)
    parser.add_argument("--leash-id", required=True, help="Already funded and confirmed owner Leash ID")
    parser.add_argument("--idempotency-key", required=True, help="Reuse this exact key if quote response is uncertain")
    parser.add_argument("--text", required=True, help="Bounded SHA-256 task input")
    parser.add_argument("--max-seconds", type=int, default=5)
    parser.add_argument("--poll-seconds", type=float, default=20.0)
    authentication = parser.add_mutually_exclusive_group(required=True)
    authentication.add_argument("--demo-auth", action="store_true", help="Explicit loopback demo sign-in")
    authentication.add_argument("--owner-address", help="Sign in with an external wallet message signature")
    args = parser.parse_args(argv)
    if not 1 <= args.max_seconds <= 120 or not 0 <= args.poll_seconds <= 30:
        parser.error("Use 1–120 CPU seconds and 0–30 status-poll seconds")
    if args.chain_id in (8453, 84532) and not all((args.token_code_hash, args.token_implementation_address,
                                                    args.token_implementation_code_hash)):
        parser.error("Base USDC requires independent proxy and implementation code pins")
    return args


def main(argv: list[str] | None = None) -> int:
    args = arguments(argv)
    implementation = ({"address": args.token_implementation_address, "codeHash": args.token_implementation_code_hash}
                      if args.token_implementation_address and args.token_implementation_code_hash else None)
    pins = DeploymentPins(args.chain_id, args.escrow_address, args.token_address, args.receipt_signer,
                          token_code_hash=args.token_code_hash, asset_implementation=implementation)
    client = TelomereClient(args.origin, pins=pins, verifier=EthAccountVerifier())
    if args.demo_auth:
        client.authenticate_demo(explicitly_enabled=True)
    else:
        def sign_in(message: str) -> str:
            print("Sign this Telomere login challenge with the external owner wallet:\n" + message, file=sys.stderr, flush=True)
            print("Paste its message signature: ", file=sys.stderr, end="", flush=True)
            return sys.stdin.readline().strip()
        client.authenticate(args.owner_address, chain_id=args.chain_id, sign_message=sign_in)

    graph = build_graph(client, poll_seconds=args.poll_seconds)
    config = {"configurable": {"thread_id": args.idempotency_key}}
    state = graph.invoke({"leash_id": args.leash_id, "text": args.text,
                          "max_seconds": args.max_seconds, "idempotency_key": args.idempotency_key}, config)
    if "__interrupt__" not in state or not state["__interrupt__"]:
        raise RuntimeError("LangGraph did not pause before the owner wallet")
    payload = state["__interrupt__"][0].value
    print(json.dumps({"type": "wallet_action", "runId": payload["runId"],
                      "ceiling": state["ceiling"], "walletAction": payload["walletAction"]},
                     separators=(",", ":")), flush=True)
    print("Submit the exact openRun intent in the external owner wallet, wait for confirmation, then paste its hash: ",
          file=sys.stderr, end="", flush=True)
    original_hash = sys.stdin.readline().strip()
    if not original_hash:
        print("No transaction hash supplied; the prepared quote has not been admitted.", file=sys.stderr)
        return 2
    finished = graph.invoke(Command(resume=original_hash), config)
    if "__interrupt__" in finished:
        raise RuntimeError("LangGraph unexpectedly paused after the wallet confirmation")
    print(json.dumps({"type": "run_status", "runId": finished["run_id"],
                      "admitted": finished["admitted"], "observed": finished["observed"]},
                     separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
