from __future__ import annotations

import ctypes
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk.vault_income import VaultIncomeError
from telomere_sdk.vault_income_journal import FileVaultIncomeJournal, LIMIT

SCOPE = "0x" + "a" * 64
OTHER_SCOPE = "0x" + "b" * 64


def state(attempts=None, scope=SCOPE):
    # The journal checks the envelope; VaultIncomeClient checks payment records.
    return {"version": 1, "profileHash": scope, "attempts": [] if attempts is None else attempts}


@unittest.skipUnless(os.name == "nt", "Actual Windows ACL API")
class WindowsAclTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temporary.name) / "journal"
        self.journal = FileVaultIncomeJournal(self.directory)
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.journal.close)

    @staticmethod
    def acl(path, security, *, broad):
        descriptor = ctypes.c_void_p()
        sddl = "D:P(A;;FA;;;" + security.sid + ")(A;;FA;;;SY)(A;;FA;;;BA)" + ("(A;;FA;;;WD)" if broad else "")
        if not security.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise OSError("Could not create disposable test ACL")
        try:
            dacl, present, defaulted = ctypes.c_void_p(), security.w.BOOL(), security.w.BOOL()
            security.advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(security.w.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(security.w.BOOL)]
            security.advapi.GetSecurityDescriptorDacl.restype = security.w.BOOL
            if not security.advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
                raise OSError("Could not inspect disposable test ACL")
            security.advapi.SetNamedSecurityInfoW.argtypes = [security.w.LPWSTR, ctypes.c_int, security.w.DWORD] + [ctypes.c_void_p] * 4
            security.advapi.SetNamedSecurityInfoW.restype = security.w.DWORD
            if security.advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None):
                raise OSError("Could not apply disposable test ACL")
        finally:
            security.kernel.LocalFree(descriptor)

    def test_created_files_have_actual_private_windows_acls(self):
        self.journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        security = self.journal._windows
        for path in (self.directory, self.directory / ".owner.json", self.directory / "state.json"):
            security.private(path)
        # This also reproduces the Windows Python 3.13 stat/fstat ctime mismatch.
        self.assertEqual(self.journal.exclusive(SCOPE, lambda tx: tx.load()), state())

    def test_broad_directory_acl_is_rejected_without_repair(self):
        security = self.journal._windows
        try:
            self.acl(self.directory, security, broad=True)
            with self.assertRaisesRegex(VaultIncomeError, "vault_income_journal_private_required"):
                self.journal.exclusive(SCOPE, lambda tx: tx.load())
            with self.assertRaisesRegex(VaultIncomeError, "vault_income_journal_private_required"):
                security.private(self.directory)
        finally:
            self.acl(self.directory, security, broad=False)

    def test_broad_state_acl_is_rejected_without_repair(self):
        self.journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        path, security = self.directory / "state.json", self.journal._windows
        try:
            self.acl(path, security, broad=True)
            with self.assertRaisesRegex(VaultIncomeError, "vault_income_journal_private_required"):
                self.journal.exclusive(SCOPE, lambda tx: tx.load())
            with self.assertRaisesRegex(VaultIncomeError, "vault_income_journal_private_required"):
                security.private(path)
        finally:
            self.acl(path, security, broad=False)

    def test_open_directory_handle_prevents_rename(self):
        with self.assertRaises(OSError):
            self.directory.rename(self.directory.with_name("moved"))
        self.assertIsNone(self.journal.exclusive(SCOPE, lambda tx: tx.load()))

    def test_junction_ancestor_and_leaf_are_rejected(self):
        alias = pathlib.Path(self.temporary.name) / "junction"
        target = pathlib.Path(self.temporary.name) / "target"
        target.mkdir()
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(alias), str(target)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        try:
            self.assertTrue(os.path.isjunction(alias))
            for path in (alias, alias / "journal"):
                with self.subTest(path=path.name):
                    with self.assertRaisesRegex(VaultIncomeError, "vault_income_journal_private_required"):
                        FileVaultIncomeJournal(path)
            self.assertEqual(list(target.iterdir()), [])
        finally:
            # rmdir removes this junction itself and never traverses its target.
            os.rmdir(alias)


class FileVaultIncomeJournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temporary.name) / "journal"
        self.addCleanup(self.temporary.cleanup)

    def journal(self, **kwargs):
        result = FileVaultIncomeJournal(self.directory, **kwargs)
        self.addCleanup(result.close)
        return result

    def assertCode(self, code, callback):
        with self.assertRaises(VaultIncomeError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_constructor_validation(self):
        for path, options in (("relative", {}), (str(self.directory) + "\0", {}), (self.directory, {"create": 1}),
                              (self.directory, {"lock_timeout": 0}), (self.directory, {"lock_timeout": float("nan")}),
                              (self.directory, {"lock_timeout": 61}), (self.directory, {"lock_timeout": True})):
            with self.subTest(options=options):
                self.assertCode("vault_income_journal_invalid", lambda: FileVaultIncomeJournal(path, **options))

    def test_save_is_private_and_loads_are_detached(self):
        journal = self.journal()
        self.assertIsNone(journal.exclusive(SCOPE, lambda tx: tx.load()))
        original = state([{"fixture": "original bearer bytes"}])
        journal.exclusive(SCOPE, lambda tx: tx.save(original))
        original["attempts"][0]["fixture"] = "mutated caller"
        loaded = journal.exclusive(SCOPE, lambda tx: tx.load())
        loaded["attempts"].clear()
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "original bearer bytes"}]))
        if os.name != "nt":
            self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
            for name in (".owner.json", "state.json"):
                self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)

    def test_saved_bytes_survive_callback_failure_and_reopen(self):
        journal = self.journal()

        def save_then_fail(tx):
            tx.save(state([{"fixture": "first"}]))
            tx.save(state([{"fixture": "final exact original signature"}]))
            raise OSError("Disposable callback failure containing private text")

        self.assertCode("vault_income_journal_unavailable", lambda: journal.exclusive(SCOPE, save_then_fail))
        journal.close()
        reopened = self.journal(create=False)
        self.assertEqual(reopened.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "final exact original signature"}]))

    def test_non_storage_callback_error_also_preserves_save(self):
        journal = self.journal()

        def callback(tx):
            tx.save(state())
            raise RuntimeError("Disposable domain failure")

        with self.assertRaisesRegex(RuntimeError, "Disposable domain failure"):
            journal.exclusive(SCOPE, callback)
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state())

    def test_duplicate_owner_is_rejected_and_orderly_close_releases(self):
        journal = self.journal()
        self.assertCode("vault_income_journal_owned", lambda: FileVaultIncomeJournal(self.directory))
        journal.close()
        self.assertFalse((self.directory / ".owner.json").exists())
        self.assertIsNone(self.journal(create=False).exclusive(SCOPE, lambda tx: tx.load()))

    def test_other_process_cannot_open_owned_directory(self):
        self.journal()
        program = "from telomere_sdk.vault_income_journal import FileVaultIncomeJournal; from telomere_sdk.vault_income import VaultIncomeError; import sys\ntry: FileVaultIncomeJournal(sys.argv[1])\nexcept VaultIncomeError as error: print(error.code)\nelse: raise RuntimeError('Unexpected second owner')"
        environment = dict(os.environ, PYTHONPATH=str(pathlib.Path(__file__).resolve().parents[1] / "src"))
        result = subprocess.run([sys.executable, "-c", program, str(self.directory)], env=environment,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "vault_income_journal_owned"), result.stderr)

    def test_crash_preserves_state_and_requires_explicit_owner_recovery(self):
        program = "from telomere_sdk.vault_income_journal import FileVaultIncomeJournal; import sys,os\nj=FileVaultIncomeJournal(sys.argv[1]); j.exclusive(sys.argv[2], lambda tx: tx.save({'version':1,'profileHash':sys.argv[2],'attempts':[{'fixture':'crash-persisted exact signed header'}]})); os._exit(0)"
        environment = dict(os.environ, PYTHONPATH=str(pathlib.Path(__file__).resolve().parents[1] / "src"))
        result = subprocess.run([sys.executable, "-c", program, str(self.directory), SCOPE], env=environment,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.directory / ".owner.json").exists())
        self.assertCode("vault_income_journal_owned", lambda: FileVaultIncomeJournal(self.directory))
        # The test operator has observed child termination; the adapter never does this.
        (self.directory / ".owner.json").unlink()
        reopened = self.journal(create=False)
        self.assertEqual(reopened.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "crash-persisted exact signed header"}]))

    def test_closed_journal_rejects_operations_and_context_entry(self):
        journal = self.journal()
        journal.close()
        journal.close()
        self.assertCode("vault_income_journal_closed", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
        self.assertCode("vault_income_journal_closed", journal.__enter__)

    def test_scope_cannot_change_or_overwrite_persisted_profile(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        self.assertCode("vault_income_journal_scope_mismatch", lambda: journal.exclusive(OTHER_SCOPE, lambda tx: tx.save(state(scope=OTHER_SCOPE))))
        self.assertCode("vault_income_journal_invalid", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state(scope=OTHER_SCOPE))))
        journal.close()
        reopened = self.journal(create=False)
        callbacks = []
        self.assertCode("vault_income_journal_invalid", lambda: reopened.exclusive(OTHER_SCOPE, lambda tx: callbacks.append(True)))
        self.assertEqual(callbacks, [])
        self.assertEqual(json.loads((self.directory / "state.json").read_text()), state())

    def test_nested_rejection_keeps_outer_transaction_active(self):
        journal = self.journal()

        def outer(tx):
            self.assertCode("vault_income_journal_scope_mismatch", lambda: journal.exclusive(SCOPE, lambda nested: nested.load()))
            self.assertCode("vault_income_journal_busy", journal.close)
            tx.save(state([{"fixture": "outer survived"}]))

        journal.exclusive(SCOPE, outer)
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "outer survived"}]))

    def test_escaped_transaction_cannot_be_used_after_callback_or_in_later_callback(self):
        journal = self.journal()
        escaped = journal.exclusive(SCOPE, lambda tx: tx)
        self.assertCode("vault_income_journal_transaction_inactive", escaped.load)
        self.assertCode("vault_income_journal_transaction_inactive", lambda: escaped.save(state()))

        def later(tx):
            self.assertCode("vault_income_journal_transaction_inactive", escaped.load)
            self.assertCode("vault_income_journal_transaction_inactive", lambda: escaped.save(state()))
            tx.save(state())

        journal.exclusive(SCOPE, later)

    def test_transaction_rejects_calls_from_other_thread(self):
        journal = self.journal()
        outcomes = []

        def callback(tx):
            def other():
                for action in (tx.load, lambda: tx.save(state())):
                    try:
                        action()
                    except VaultIncomeError as error:
                        outcomes.append(error.code)
            thread = threading.Thread(target=other)
            thread.start(); thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertIsNone(tx.load())

        journal.exclusive(SCOPE, callback)
        self.assertEqual(outcomes, ["vault_income_journal_transaction_inactive"] * 2)

    def test_concurrent_exclusive_has_bounded_timeout(self):
        journal = self.journal(lock_timeout=0.05)
        entered, release = threading.Event(), threading.Event()
        outcomes = []

        def hold():
            def callback(tx):
                entered.set()
                if not release.wait(3):
                    raise RuntimeError("Disposable lock test timed out")
                tx.save(state())
            try:
                journal.exclusive(SCOPE, callback)
            except BaseException as error:
                outcomes.append(error)

        thread = threading.Thread(target=hold)
        thread.start()
        try:
            self.assertTrue(entered.wait(3))
            self.assertCode("vault_income_journal_busy", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
        finally:
            release.set(); thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(outcomes, [])
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state())

    def test_partial_write_failure_preserves_previous_state_and_cleans_temporary(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "previous"}])))

        def partial(descriptor, raw):
            os.write(descriptor, raw[:20])
            raise OSError("Disposable partial write")

        with patch.object(journal, "_write", side_effect=partial):
            self.assertCode("vault_income_journal_unavailable", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "replacement"}]))))
        self.assertEqual(list(self.directory.glob(".pending-*")), [])
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "previous"}]))

    def test_replace_failure_preserves_previous_state_and_cleans_temporary(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        target = patch.object(journal._windows, "replace", side_effect=OSError("Disposable replace failure")) if os.name == "nt" else patch("telomere_sdk.vault_income_journal.os.replace", side_effect=OSError("Disposable replace failure"))
        with target:
            self.assertCode("vault_income_journal_unavailable", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "replacement"}]))))
        self.assertEqual(list(self.directory.glob(".pending-*")), [])
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state())

    def test_post_replace_sync_failure_preserves_committed_state_for_recovery(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        with patch.object(journal, "_sync", side_effect=OSError("Disposable durability uncertainty")):
            self.assertCode("vault_income_journal_unavailable", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "committed retry identity"}]))))
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state([{"fixture": "committed retry identity"}]))
        self.assertEqual(list(self.directory.glob(".pending-*")), [])

    def test_size_and_attempt_bounds_do_not_replace_original(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        self.assertCode("vault_income_journal_invalid", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{}] * 129))))
        self.assertCode("vault_income_journal_limit", lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "x" * LIMIT}]))))
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state())

    def test_malformed_state_is_rejected_before_callback(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        examples = [b'{"version":1,"version":1}', b'{"version":NaN}', b'\xff', b'null', b'{',
                    json.dumps(dict(state(), unexpected=True)).encode(), json.dumps(state(attempts={})).encode(),
                    json.dumps(dict(state(), version=True)).encode()]
        callbacks = []
        for raw in examples:
            with self.subTest(raw=raw[:40]):
                (self.directory / "state.json").write_bytes(raw)
                with self.assertRaises(VaultIncomeError):
                    journal.exclusive(SCOPE, lambda tx: callbacks.append(True))
        self.assertEqual(callbacks, [])

    def test_oversized_existing_state_rejected(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        (self.directory / "state.json").write_bytes(b" " * (LIMIT + 1))
        self.assertCode("vault_income_journal_private_required", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))

    def test_hardlinked_state_rejected(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        alias = self.directory / "linked-state.json"
        os.link(self.directory / "state.json", alias)
        try:
            self.assertCode("vault_income_journal_private_required", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
        finally:
            alias.unlink()

    def test_symlinked_state_rejected(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        original, alias = self.directory / "state.json", self.directory / "original.json"
        original.rename(alias)
        try:
            try:
                original.symlink_to(alias)
            except OSError as error:
                self.skipTest("Host does not permit disposable symlinks: " + str(error.errno))
            self.assertCode("vault_income_journal_private_required", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
        finally:
            if original.is_symlink():
                original.unlink()
            alias.rename(original)

    def test_symlinked_ancestor_rejected(self):
        alias = pathlib.Path(self.temporary.name) / "alias"
        target = pathlib.Path(self.temporary.name) / "real"
        target.mkdir()
        try:
            alias.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest("Host does not permit disposable symlinks: " + str(error.errno))
        self.assertCode("vault_income_journal_private_required", lambda: FileVaultIncomeJournal(alias / "journal"))

    @unittest.skipIf(os.name == "nt", "POSIX permissions and directory descriptor")
    def test_posix_existing_nonprivate_leaf_is_not_repaired(self):
        self.directory.mkdir(mode=0o755)
        self.directory.chmod(0o755)
        self.assertCode("vault_income_journal_private_required", lambda: FileVaultIncomeJournal(self.directory))
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)

    @unittest.skipIf(os.name == "nt", "POSIX permissions and directory descriptor")
    def test_posix_nonprivate_state_is_not_repaired(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        path = self.directory / "state.json"
        path.chmod(0o644)
        try:
            self.assertCode("vault_income_journal_private_required", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        finally:
            path.chmod(0o600)

    @unittest.skipIf(os.name == "nt", "Windows intentionally denies moving open directories")
    def test_posix_directory_replacement_is_detected(self):
        journal = self.journal()
        moved = self.directory.with_name("moved")
        self.directory.rename(moved)
        self.directory.mkdir(mode=0o700)
        try:
            self.assertCode("vault_income_journal_private_required", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
        finally:
            self.directory.rmdir()
            moved.rename(self.directory)

    @unittest.skipIf(os.name == "nt", "Windows owner file handle denies replacement")
    def test_posix_replaced_owner_is_detected(self):
        journal = self.journal()
        owner, moved = self.directory / ".owner.json", self.directory / "original-owner.json"
        owner.rename(moved)
        descriptor = os.open(owner, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        try:
            self.assertCode("vault_income_journal_owned", lambda: journal.exclusive(SCOPE, lambda tx: tx.load()))
            self.assertCode("vault_income_journal_owned", journal.close)
        finally:
            owner.unlink()
            moved.rename(owner)

    @unittest.skipUnless(hasattr(os, "fork"), "Actual POSIX fork ownership")
    def test_posix_fork_cannot_reuse_inherited_owner(self):
        journal = self.journal()
        journal.exclusive(SCOPE, lambda tx: tx.save(state()))
        pid = os.fork()
        if pid == 0:
            for action in (lambda: journal.exclusive(SCOPE, lambda tx: tx.save(state([{"fixture": "fork writer"}]))), journal.close):
                try:
                    action()
                except VaultIncomeError as error:
                    if error.code != "vault_income_journal_process_mismatch":
                        os._exit(2)
                except BaseException:
                    os._exit(3)
                else:
                    os._exit(1)
            os._exit(0)
        waited, status = os.waitpid(pid, 0)
        self.assertEqual(waited, pid)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(journal.exclusive(SCOPE, lambda tx: tx.load()), state())


if __name__ == "__main__":
    unittest.main()
