#!/usr/bin/env python3
"""Linux-only Anvil last-good checkpoint. Never restores or sends transactions."""
import argparse
import contextlib
import hashlib
import http.client
import json
import os
import pathlib
import re
import stat
import sys
import time

FIELDS = {"block", "accounts", "best_block_number", "blocks", "transactions", "historical_states"}
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
MAX_BYTES = 32 * 1024 * 1024
TEMP = ".incoming.tmp"


class Skip(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Skip(reason)


def quantity(value):
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]+", value):
        return int(value, 16)
    raise Skip("invalid unsigned quantity")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def parse(data):
    def invalid_constant(_):
        raise Skip("invalid JSON constant")
    try:
        return json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise Skip("incomplete or invalid JSON") from None


def validate(data):
    value = parse(data)
    require(isinstance(value, dict) and set(value) == FIELDS, "unexpected Anvil snapshot fields")
    head = value["best_block_number"]
    require(type(head) is int and head >= 0, "invalid best_block_number")
    require(isinstance(value["block"], dict), "invalid block environment")
    require(quantity(value["block"].get("number")) == head, "snapshot head mismatch")
    require(isinstance(value["accounts"], dict) and value["accounts"], "missing account state")
    for address, account in value["accounts"].items():
        require(bool(ADDRESS.fullmatch(address)) and isinstance(account, dict), "invalid account")
        require({"nonce", "balance", "code", "storage"} <= account.keys(), "incomplete account")
        quantity(account["nonce"])
        quantity(account["balance"])
        require(isinstance(account["code"], str) and bool(re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", account["code"])), "invalid account code")
        require(isinstance(account["storage"], dict), "invalid account storage")
    require(isinstance(value["blocks"], list) and value["blocks"], "missing block history")
    heads = []
    for block in value["blocks"]:
        require(isinstance(block, dict) and {"header", "transactions", "ommers", "withdrawals"} <= block.keys(), "invalid block history")
        header = block["header"]
        require(isinstance(header, dict), "missing block header")
        number = quantity(header.get("number"))
        require(number <= head, "block beyond snapshot head")
        for key in ("stateRoot", "parentHash", "transactionsRoot", "receiptsRoot"):
            require(isinstance(header.get(key), str) and bool(HASH.fullmatch(header[key])), "invalid block roots")
        require(isinstance(block["transactions"], list) and isinstance(block["ommers"], list), "invalid block lists")
        require(block["withdrawals"] is None or isinstance(block["withdrawals"], list), "invalid withdrawals")
        if number == head:
            heads.append(header)
    require(bool(heads), "snapshot head absent from unsorted block history")
    require(isinstance(value["transactions"], list), "invalid transaction history")
    for tx in value["transactions"]:
        require(isinstance(tx, dict) and {"info", "receipt", "block_hash", "block_number"} <= tx.keys(), "incomplete transaction history")
        require(isinstance(tx["info"], dict) and isinstance(tx["receipt"], dict), "invalid transaction history")
        require(isinstance(tx["block_hash"], str) and bool(HASH.fullmatch(tx["block_hash"])), "invalid transaction block hash")
        require(quantity(tx["block_number"]) <= head, "transaction beyond snapshot head")
    require(value["historical_states"] is None or isinstance(value["historical_states"], (dict, list)), "invalid historical states")
    return head, heads


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_once(path, maximum):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum, "snapshot empty, oversized or not a regular file")
        data = source.read(maximum + 1)
        after = os.fstat(source.fileno())
        current = os.stat(path, follow_symlinks=False)
    require(len(data) == before.st_size and fingerprint(before) == fingerprint(after) == fingerprint(current), "snapshot changed during read")
    return data, fingerprint(current)


def stable_read(path, maximum):
    first, identity = read_once(path, maximum)
    time.sleep(0.1)
    second, second_identity = read_once(path, maximum)
    require(identity == second_identity and first == second, "snapshot changing between reads")
    return second


def rpc(port, method, params):
    require(method in {"eth_chainId", "eth_getBlockByNumber"}, "RPC method not permitted")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        connection.request("POST", "/", body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        data = response.read(1024 * 1024 + 1)
        require(response.status == 200 and len(data) <= 1024 * 1024, "unexpected RPC response")
        result = parse(data)
        require(isinstance(result, dict) and result.get("id") == 1 and "error" not in result and "result" in result, "RPC error")
        return result["result"]
    except (OSError, http.client.HTTPException):
        raise Skip("loopback RPC unavailable") from None
    finally:
        connection.close()


def observe(port, expected_chain):
    require(quantity(rpc(port, "eth_chainId", [])) == expected_chain, "unexpected chain ID")
    head = rpc(port, "eth_getBlockByNumber", ["latest", False])
    require(isinstance(head, dict), "RPC head unavailable")
    quantity(head.get("number"))
    for key in ("hash", "stateRoot"):
        require(isinstance(head.get(key), str) and bool(HASH.fullmatch(head[key])), "invalid RPC head")
    return head


def header_matches(header, live):
    # Snapshot block headers omit their own hash. Compare every serialized header
    # field against the live RPC header, including roots and consensus quantities.
    for key, expected in header.items():
        actual = live.get(key)
        if isinstance(expected, str) and expected.startswith("0x") and isinstance(actual, str):
            if expected.lower() != actual.lower():
                return False
        elif expected != actual:
            return False
    return True


@contextlib.contextmanager
def locked_directory(directory):
    import fcntl
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, "checkpoint directory must be owned by this user with mode 0700")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Skip("another checkpoint is running") from None
        yield fd
    finally:
        os.close(fd)


def atomic_write(directory_fd, name, data):
    # A single fixed temporary file is bounded by --max-bytes. A killed run can
    # leave it behind; the next locked run removes it without following links.
    try:
        os.unlink(TEMP, dir_fd=directory_fd)
    except FileNotFoundError:
        pass
    fd = os.open(TEMP, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(TEMP, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        try:
            os.unlink(TEMP, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def save(directory, directory_fd, data, maximum):
    previous = None
    try:
        previous = stable_read(directory / "last-good.json", maximum)
        validate(previous)
    except (Skip, FileNotFoundError):
        previous = None
    if previous == data:
        return "unchanged"
    if previous is not None:
        # Preserve current until a durable previous copy exists. Never rotate an
        # incomplete existing last-good over the previous valid checkpoint.
        atomic_write(directory_fd, "previous.json", previous)
    atomic_write(directory_fd, "last-good.json", data)
    return "saved"


def checkpoint(args):
    if args.validate_only:
        data = stable_read(args.source, args.max_bytes)
        head, _ = validate(data)
        return {"status": "valid", "head": head, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    with locked_directory(args.directory) as directory_fd:
        before = observe(args.rpc_port, args.chain_id)
        data = stable_read(args.source, args.max_bytes)
        number, heads = validate(data)
        after = observe(args.rpc_port, args.chain_id)
        require(all(before[key] == after[key] for key in ("number", "hash", "stateRoot")), "live head changed during checkpoint")
        require(number == quantity(after["number"]) and any(header_matches(header, after) for header in heads), "snapshot does not match live head")
        status = save(args.directory, directory_fd, data, args.max_bytes)
        return {"status": status, "chainId": args.chain_id, "head": number, "headHash": after["hash"], "stateRoot": after["stateRoot"], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=pathlib.Path("/opt/telomere-pilot/data/chain.json"))
    parser.add_argument("--directory", type=pathlib.Path, default=pathlib.Path("/opt/telomere-pilot/checkpoints/staging-chain"))
    parser.add_argument("--chain-id", type=int, default=31337)
    parser.add_argument("--rpc-port", type=int, default=18547)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_bytes <= 64 * 1024 * 1024:
        parser.error("maximum must be 1..67108864 bytes")
    if args.chain_id <= 0 or not 1 <= args.rpc_port <= 65535:
        parser.error("invalid chain ID or RPC port")
    try:
        result = checkpoint(args)
        code = 0
    except Skip as error:
        result = {"status": "rejected" if args.validate_only else "skipped", "reason": str(error)}
        code = 1 if args.validate_only else 0
    except OSError as error:
        result, code = {"status": "error", "reason": str(error)}, 1
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
