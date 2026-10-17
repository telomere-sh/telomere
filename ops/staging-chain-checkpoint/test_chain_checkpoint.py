"""Temp-only tests. Linux exercises real flock, rename and file/directory fsync."""
import argparse
import contextlib
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("chain-checkpoint.py")
SPEC = importlib.util.spec_from_file_location("checkpoint", SCRIPT)
checkpoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checkpoint)
ZERO = "0x" + "0" * 64
ROOT = "0x" + "1" * 64


def fixture(version=1):
    return {
        "block": {"number": "0x1", "timestamp": hex(version)},
        "best_block_number": 1,
        "accounts": {"0x" + "a" * 40: {"nonce": 0, "balance": "0x1", "code": "0x", "storage": {}}},
        "blocks": [
            {"header": {"number": "0x1", "timestamp": hex(version), "stateRoot": ROOT, "parentHash": ZERO, "transactionsRoot": ZERO, "receiptsRoot": ZERO}, "transactions": [], "ommers": [], "withdrawals": None},
            {"header": {"number": "0x0", "stateRoot": ZERO, "parentHash": ZERO, "transactionsRoot": ZERO, "receiptsRoot": ZERO}, "transactions": [], "ommers": [], "withdrawals": None},
        ],
        "transactions": [{"info": {}, "receipt": {}, "block_hash": ZERO, "block_number": 1}],
        "historical_states": None,
    }


def encoded(version=1):
    return json.dumps(fixture(version)).encode()


class ValidationTests(unittest.TestCase):
    def setUp(self):
        if os.name == "nt":
            # Windows Python fstat/stat can expose different ctime semantics.
            # Production is Linux; keep this accommodation in the tests only.
            native_fingerprint = checkpoint.fingerprint
            patch = mock.patch.object(checkpoint, "fingerprint", side_effect=lambda info: native_fingerprint(info)[:-1])
            patch.start()
            self.addCleanup(patch.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.source = self.directory / "source.json"
        self.source.write_bytes(encoded())

    def args(self):
        return argparse.Namespace(source=self.source, directory=self.directory, max_bytes=100000, chain_id=31337, rpc_port=18547, validate_only=False)

    def test_valid_unsorted_history(self):
        number, heads = checkpoint.validate(encoded())
        self.assertEqual(number, 1)
        self.assertEqual(len(heads), 1)
        self.assertEqual(heads[0]["stateRoot"], ROOT)

    def test_rejects_incomplete_invalid_and_duplicate_json(self):
        for data in (b"", b"{", b"[]", b'{"block":{},"block":{}}', b"NaN"):
            with self.subTest(data=data), self.assertRaises(checkpoint.Skip):
                checkpoint.validate(data)

    def test_rejects_bad_schema_missing_state_and_future_transaction(self):
        for change in (
            lambda value: value.update(best_block_number=True),
            lambda value: value.update(accounts={}),
            lambda value: value.update(blocks=[]),
            lambda value: value["transactions"][0].update(block_number=2),
            lambda value: value["accounts"]["0x" + "a" * 40].update(code="0x0"),
        ):
            value = fixture()
            change(value)
            with self.assertRaises(checkpoint.Skip):
                checkpoint.validate(json.dumps(value).encode())

    def test_rejects_empty_and_oversized_source(self):
        self.source.write_bytes(b"")
        with self.assertRaises(checkpoint.Skip):
            checkpoint.stable_read(self.source, 100000)
        self.source.write_bytes(encoded())
        with self.assertRaises(checkpoint.Skip):
            checkpoint.stable_read(self.source, len(encoded()) - 1)

    def test_rejects_source_changing_between_reads(self):
        with mock.patch.object(checkpoint.time, "sleep", side_effect=lambda _: self.source.write_bytes(encoded(2))):
            with self.assertRaisesRegex(checkpoint.Skip, "snapshot chang"):
                checkpoint.stable_read(self.source, 100000)

    def test_rejects_source_changing_during_read(self):
        original = checkpoint.os.fstat
        calls = 0

        def changed(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.source.write_bytes(b"")
            return original(fd)

        with mock.patch.object(checkpoint.os, "fstat", side_effect=changed):
            with self.assertRaisesRegex(checkpoint.Skip, "changed during read"):
                checkpoint.stable_read(self.source, 100000)

    def test_validate_only_uses_no_rpc_lock_or_writes(self):
        args = self.args()
        args.validate_only = True
        with mock.patch.object(checkpoint, "rpc", side_effect=AssertionError("RPC forbidden")), mock.patch.object(checkpoint, "locked_directory", side_effect=AssertionError("lock forbidden")), mock.patch.object(checkpoint, "save", side_effect=AssertionError("save forbidden")):
            self.assertEqual(checkpoint.checkpoint(args)["status"], "valid")

    def test_rpc_blocks_transaction_method_before_connection(self):
        with mock.patch.object(checkpoint.http.client, "HTTPConnection", side_effect=AssertionError("connection forbidden")):
            with self.assertRaisesRegex(checkpoint.Skip, "not permitted"):
                checkpoint.rpc(18547, "eth_sendRawTransaction", ["0x"])

    def test_changed_live_head_and_wrong_header_never_save(self):
        before = dict(fixture()["blocks"][0]["header"], hash=ZERO)
        for after in (dict(before, hash=ROOT), dict(before, stateRoot=ZERO)):
            @contextlib.contextmanager
            def no_disk_lock(_):
                yield None
            with mock.patch.object(checkpoint, "locked_directory", no_disk_lock), mock.patch.object(checkpoint, "observe", side_effect=[before, after]), mock.patch.object(checkpoint, "save", side_effect=AssertionError("save forbidden")):
                with self.assertRaises(checkpoint.Skip):
                    checkpoint.checkpoint(self.args())
        wrong = dict(before, stateRoot=ZERO)
        with mock.patch.object(checkpoint, "locked_directory", no_disk_lock), mock.patch.object(checkpoint, "observe", side_effect=[wrong, wrong]), mock.patch.object(checkpoint, "save", side_effect=AssertionError("save forbidden")):
            with self.assertRaisesRegex(checkpoint.Skip, "does not match"):
                checkpoint.checkpoint(self.args())


@unittest.skipUnless(os.name == "posix", "Linux production filesystem semantics required")
class DurableRotationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.directory.chmod(0o700)

    def save(self, data):
        with checkpoint.locked_directory(self.directory) as fd:
            return checkpoint.save(self.directory, fd, data, 100000)

    def test_two_generation_rotation_modes_and_unchanged_noop(self):
        self.assertEqual(self.save(encoded(1)), "saved")
        self.assertEqual(self.save(encoded(2)), "saved")
        self.assertEqual(self.save(encoded(3)), "saved")
        self.assertEqual((self.directory / "last-good.json").read_bytes(), encoded(3))
        self.assertEqual((self.directory / "previous.json").read_bytes(), encoded(2))
        self.assertEqual(self.save(encoded(3)), "unchanged")
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["last-good.json", "previous.json"])
        for path in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_incomplete_current_cannot_overwrite_previous(self):
        self.save(encoded(1))
        self.save(encoded(2))
        (self.directory / "last-good.json").write_bytes(b"")
        self.save(encoded(3))
        self.assertEqual((self.directory / "previous.json").read_bytes(), encoded(1))
        self.assertEqual((self.directory / "last-good.json").read_bytes(), encoded(3))

    def test_failed_replace_preserves_durable_old_current(self):
        self.save(encoded(1))
        real_replace = checkpoint.os.replace

        def fail_current(source, destination, **kwargs):
            if destination == "last-good.json":
                raise OSError("simulated replacement failure")
            return real_replace(source, destination, **kwargs)

        with mock.patch.object(checkpoint.os, "replace", side_effect=fail_current):
            with self.assertRaises(OSError):
                self.save(encoded(2))
        self.assertEqual((self.directory / "last-good.json").read_bytes(), encoded(1))
        self.assertEqual((self.directory / "previous.json").read_bytes(), encoded(1))
        self.assertFalse((self.directory / checkpoint.TEMP).exists())

    def test_actual_directory_lock_rejects_concurrent_run(self):
        with checkpoint.locked_directory(self.directory):
            with self.assertRaisesRegex(checkpoint.Skip, "another checkpoint"):
                with checkpoint.locked_directory(self.directory):
                    self.fail("second exclusive directory lock acquired")

    def test_each_replacement_fsyncs_file_then_directory(self):
        self.save(encoded(1))
        real_fsync = checkpoint.os.fsync
        sequence = []

        def checked_fsync(fd):
            sequence.append("directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
            return real_fsync(fd)

        with mock.patch.object(checkpoint.os, "fsync", side_effect=checked_fsync):
            self.save(encoded(2))
        self.assertEqual(sequence, ["file", "directory", "file", "directory"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
