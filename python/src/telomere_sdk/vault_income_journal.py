"""Private single-owner native Vault payer journal on a local filesystem.

Successful saves survive later callback failures. A crash intentionally leaves
the owner lock; stale locks are never removed automatically or by PID alone.
"""
from __future__ import annotations

import ctypes
import json
import os
import pathlib
import secrets
import stat
import struct
import threading
from typing import Any, Callable, TypeVar

from .client import _bytes32, _canonical
from .transport import ApiError, strict_json
from .vault_income import VaultIncomeError, _fail

T = TypeVar("T")
LIMIT = 1_048_576


def _identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def _same_file(left: os.stat_result, right: os.stat_result) -> bool:
    # Python's Windows stat/fstat expose different legacy st_ctime values on
    # some releases; birthtime is stable across both APIs. POSIX ctime remains
    # useful for detecting changes that preserve the size and mtime.
    changed = (getattr(left, "st_birthtime_ns", None) == getattr(right, "st_birthtime_ns", None)
               if os.name == "nt" else left.st_ctime_ns == right.st_ctime_ns)
    return (_identity(left) == _identity(right) and left.st_mode == right.st_mode and left.st_uid == right.st_uid
            and left.st_nlink == right.st_nlink and left.st_size == right.st_size
            and left.st_mtime_ns == right.st_mtime_ns and changed)


def _entry(value: os.stat_result, *, directory: bool = False) -> None:
    if (stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400
            or (not stat.S_ISDIR(value.st_mode) if directory else not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or not 0 <= value.st_size <= LIMIT)):
        _fail("vault_income_journal_private_required")
    if os.name != "nt" and (value.st_uid != os.geteuid() or stat.S_IMODE(value.st_mode) != (0o700 if directory else 0o600)):
        _fail("vault_income_journal_private_required")


class _WindowsPrivate:
    """Fixed Win32 security APIs; paths are data, never command source."""

    def __init__(self):
        from ctypes import wintypes as w
        self.w = w
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel.GetCurrentProcess.restype = w.HANDLE
        self.kernel.CloseHandle.argtypes = [w.HANDLE]; self.kernel.CloseHandle.restype = w.BOOL
        self.kernel.LocalFree.argtypes = [ctypes.c_void_p]; self.kernel.LocalFree.restype = ctypes.c_void_p
        self.kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
        self.kernel.CreateFileW.restype = w.HANDLE
        self.kernel.CreateDirectoryW.argtypes = [w.LPCWSTR, ctypes.c_void_p]; self.kernel.CreateDirectoryW.restype = w.BOOL
        self.kernel.MoveFileExW.argtypes = [w.LPCWSTR, w.LPCWSTR, w.DWORD]; self.kernel.MoveFileExW.restype = w.BOOL
        self.advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]; self.advapi.OpenProcessToken.restype = w.BOOL
        self.advapi.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
        self.advapi.GetTokenInformation.restype = w.BOOL
        self.advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
        self.advapi.ConvertSidToStringSidW.restype = w.BOOL
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
        self.advapi.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD] + [ctypes.POINTER(ctypes.c_void_p)] * 5
        self.advapi.GetNamedSecurityInfoW.restype = w.DWORD
        self.advapi.GetAce.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.POINTER(ctypes.c_void_p)]; self.advapi.GetAce.restype = w.BOOL
        token, needed = w.HANDLE(), w.DWORD()
        if not self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x8, ctypes.byref(token)):
            _fail("vault_income_journal_private_required")
        try:
            self.advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
            if not 1 <= needed.value <= 16_384:
                _fail("vault_income_journal_private_required")
            buffer = ctypes.create_string_buffer(needed.value)
            if not self.advapi.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
                _fail("vault_income_journal_private_required")
            self.sid = self._sid(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0])
        finally:
            self.kernel.CloseHandle(token)
        self.trusted = {self.sid, "S-1-5-18", "S-1-5-32-544"}

    def _sid(self, pointer: Any) -> str:
        value = self.w.LPWSTR()
        if not pointer or not self.advapi.ConvertSidToStringSidW(pointer, ctypes.byref(value)):
            _fail("vault_income_journal_private_required")
        try:
            return value.value
        finally:
            self.kernel.LocalFree(ctypes.cast(value, ctypes.c_void_p))

    def private(self, path: pathlib.Path) -> None:
        owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        result = self.advapi.GetNamedSecurityInfoW(str(path), 1, 0x5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
        if result:
            _fail("vault_income_journal_private_required")
        try:
            if not dacl or self._sid(owner) not in self.trusted:
                _fail("vault_income_journal_private_required")
            _revision, _reserved, acl_size, count, _reserved2 = struct.unpack("<BBHHH", ctypes.string_at(dacl, 8))
            if not 8 <= acl_size <= 65_535 or count > 1024:
                _fail("vault_income_journal_private_required")
            for index in range(count):
                ace = ctypes.c_void_p()
                if not self.advapi.GetAce(dacl, index, ctypes.byref(ace)):
                    _fail("vault_income_journal_private_required")
                kind, _flags, size = struct.unpack("<BBH", ctypes.string_at(ace, 4))
                if size < 8 or size > acl_size:
                    _fail("vault_income_journal_private_required")
                if kind in (0, 5):
                    offset = 8
                    if kind == 5:
                        flags = int.from_bytes(ctypes.string_at(ace.value + 8, 4), "little")
                        if flags & ~3:
                            _fail("vault_income_journal_private_required")
                        offset = 12 + (16 if flags & 1 else 0) + (16 if flags & 2 else 0)
                    if offset + 8 > size or self._sid(ace.value + offset) not in self.trusted:
                        _fail("vault_income_journal_private_required")
                elif kind not in (1, 6, 10, 12):
                    # Unsupported conditional allow entries fail closed.
                    _fail("vault_income_journal_private_required")
        finally:
            self.kernel.LocalFree(descriptor)

    def _security(self):
        class Attributes(ctypes.Structure):
            _fields_ = [("length", self.w.DWORD), ("descriptor", ctypes.c_void_p), ("inherit", self.w.BOOL)]
        descriptor = ctypes.c_void_p()
        sddl = "O:" + self.sid + "D:P(A;;FA;;;" + self.sid + ")(A;;FA;;;SY)(A;;FA;;;BA)"
        if not self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            _fail("vault_income_journal_private_required")
        return Attributes(ctypes.sizeof(Attributes), descriptor, False), descriptor

    def mkdir(self, path: pathlib.Path) -> None:
        attributes, descriptor = self._security()
        try:
            if not self.kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)) and ctypes.get_last_error() != 183:
                _fail("vault_income_journal_private_required")
        finally:
            self.kernel.LocalFree(descriptor)

    def directory_handle(self, path: pathlib.Path):
        # Deny delete sharing on every ancestor while this journal is open.
        handle = self.kernel.CreateFileW(str(path), 0x80, 0x3, None, 3, 0x02000000 | 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            _fail("vault_income_journal_private_required")
        return handle

    def open(self, path: pathlib.Path, *, create: bool) -> int:
        import msvcrt
        attributes, descriptor = self._security() if create else (None, None)
        try:
            handle = self.kernel.CreateFileW(str(path), 0xC0000000 if create else 0x80000000, 0 if create else 1,
                         ctypes.byref(attributes) if attributes else None, 1 if create else 3, 0x00200000 | 0x80000000, None)
            if handle == ctypes.c_void_p(-1).value:
                if create and ctypes.get_last_error() in (80, 183):
                    raise FileExistsError()
                _fail("vault_income_journal_unavailable")
            try:
                return msvcrt.open_osfhandle(handle, os.O_BINARY | (os.O_RDWR if create else os.O_RDONLY))
            except Exception:
                self.kernel.CloseHandle(handle)
                raise
        finally:
            if descriptor:
                self.kernel.LocalFree(descriptor)

    def replace(self, source: pathlib.Path, target: pathlib.Path) -> None:
        if not self.kernel.MoveFileExW(str(source), str(target), 0x1 | 0x8):
            _fail("vault_income_journal_unavailable")


class FileVaultIncomeJournal:
    """Durable private adapter, one process and one reviewed profile per directory.

    New leaf directories/files are created privately; existing permissions are
    verified and never repaired. Local filesystems with atomic same-directory
    replacement and durable fsync/write-through are required. A process crash
    leaves `.owner.json`; verify the old owner has stopped before an operator
    explicitly removes that lock. This class never steals an existing lock.
    An inherited instance cannot be used by a forked child process.
    """

    def __init__(self, directory: str | os.PathLike[str], *, create: bool = True, lock_timeout: float = 5):
        raw = os.fspath(directory)
        if (not isinstance(raw, str) or not pathlib.Path(raw).is_absolute() or "\0" in raw or len(raw) > 4096
                or type(create) is not bool or type(lock_timeout) not in (int, float) or not 0 < lock_timeout <= 60):
            _fail("vault_income_journal_invalid")
        self.directory = pathlib.Path(os.path.abspath(raw))
        self._lock, self._timeout, self._closed, self._active = threading.RLock(), lock_timeout, False, 0
        self._pid = os.getpid()
        self._windows = _WindowsPrivate() if os.name == "nt" else None
        self._handles, self._root_fd, self._owner_fd, self._owner_identity = [], None, None, None
        self._scope = None
        try:
            self._ancestors()
            if create:
                if self._windows:
                    self._windows.mkdir(self.directory)
                else:
                    try:
                        os.mkdir(self.directory, 0o700)
                        parent = os.open(self.directory.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                        try:
                            os.fsync(parent)
                        finally:
                            os.close(parent)
                    except FileExistsError:
                        pass
            self._root_identity = os.lstat(self.directory)
            _entry(self._root_identity, directory=True)
            if self._windows:
                self._windows.private(self.directory)
                for component in reversed((self.directory, *self.directory.parents)):
                    self._handles.append(self._windows.directory_handle(component))
            else:
                self._root_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                if _identity(os.fstat(self._root_fd)) != _identity(self._root_identity):
                    _fail("vault_income_journal_private_required")
            self._guard()
            try:
                self._owner_fd = self._open(".owner.json", create=True)
            except FileExistsError:
                _fail("vault_income_journal_owned")
            owner = json.dumps({"version": 1, "pid": os.getpid(), "ownerId": secrets.token_hex(32)}, separators=(",", ":")).encode()
            self._write(self._owner_fd, owner); os.fsync(self._owner_fd)
            self._owner_identity = os.fstat(self._owner_fd)
            _entry(self._owner_identity)
            if self._windows:
                self._windows.private(self.directory / ".owner.json")
            self._sync()
        except Exception:
            self._release_handles()
            raise

    def __enter__(self):
        if self._closed:
            _fail("vault_income_journal_closed")
        return self

    def __exit__(self, _kind, _value, _traceback):
        self.close()

    def _ancestors(self) -> None:
        for component in reversed((self.directory.parent, *self.directory.parent.parents)):
            value = os.lstat(component)
            if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
                _fail("vault_income_journal_private_required")

    def _guard(self) -> None:
        if os.getpid() != self._pid:
            _fail("vault_income_journal_process_mismatch")
        self._ancestors()
        current = os.lstat(self.directory)
        _entry(current, directory=True)
        if _identity(current) != _identity(self._root_identity):
            _fail("vault_income_journal_private_required")
        if self._windows:
            self._windows.private(self.directory)
        elif _identity(os.fstat(self._root_fd)) != _identity(self._root_identity):
            _fail("vault_income_journal_private_required")
        if self._owner_identity is not None:
            named, opened = os.lstat(self.directory / ".owner.json"), os.fstat(self._owner_fd)
            _entry(named); _entry(opened)
            if not _same_file(named, opened) or not _same_file(opened, self._owner_identity):
                _fail("vault_income_journal_owned")

    def _open(self, name: str, *, create: bool) -> int:
        if self._windows:
            return self._windows.open(self.directory / name, create=create)
        flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_RDWR | os.O_CREAT | os.O_EXCL if create else os.O_RDONLY)
        return os.open(name, flags, 0o600, dir_fd=self._root_fd)

    def _sync(self) -> None:
        self._guard()
        if self._root_fd is not None:
            os.fsync(self._root_fd)
        self._guard()

    @staticmethod
    def _write(descriptor: int, raw: bytes) -> None:
        total = 0
        while total < len(raw):
            size = os.write(descriptor, raw[total:])
            if size <= 0:
                _fail("vault_income_journal_unavailable")
            total += size

    def _read(self) -> dict[str, Any] | None:
        self._guard()
        path = self.directory / "state.json"
        try:
            named = os.lstat(path)
        except FileNotFoundError:
            self._guard(); return None
        _entry(named)
        if self._windows:
            self._windows.private(path)
        descriptor = self._open("state.json", create=False)
        try:
            opened = os.fstat(descriptor); _entry(opened)
            if not _same_file(named, opened):
                _fail("vault_income_journal_private_required")
            raw = bytearray()
            while len(raw) <= LIMIT:
                part = os.read(descriptor, min(65_536, LIMIT + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part)
            after, current = os.fstat(descriptor), os.lstat(path)
            _entry(after); _entry(current)
            if len(raw) != opened.st_size or not _same_file(opened, after) or not _same_file(after, current):
                _fail("vault_income_journal_private_required")
            self._guard()
            if self._windows:
                self._windows.private(path)
            try:
                value = strict_json(bytes(raw))
            except ApiError:
                _fail("vault_income_journal_invalid")
            return self._state(value)
        finally:
            if "raw" in locals():
                raw[:] = b"\0" * len(raw)
            os.close(descriptor)

    def _state(self, value: Any) -> dict[str, Any]:
        if (not isinstance(value, dict) or set(value) != {"version", "profileHash", "attempts"}
                or type(value["version"]) is not int or value["version"] != 1 or _bytes32(value["profileHash"]) != self._scope
                or not isinstance(value["attempts"], list) or len(value["attempts"]) > 128):
            _fail("vault_income_journal_invalid")
        if len(_canonical(value).encode()) > LIMIT:
            _fail("vault_income_journal_limit")
        return value

    def _save(self, state: dict[str, Any]) -> None:
        self._guard()
        raw = _canonical(self._state(state)).encode()
        previous = self._read()
        previous_identity = os.lstat(self.directory / "state.json") if previous is not None else None
        name = ".pending-" + secrets.token_hex(32)
        descriptor, temporary_identity, replaced = None, None, False
        try:
            descriptor = self._open(name, create=True)
            temporary_identity = os.fstat(descriptor)
            self._write(descriptor, raw); os.fsync(descriptor)
            temporary_identity = os.fstat(descriptor); _entry(temporary_identity)
            os.close(descriptor); descriptor = None
            if self._windows:
                self._windows.private(self.directory / name)
            self._guard()
            try:
                current = os.lstat(self.directory / "state.json")
            except FileNotFoundError:
                current = None
            if (current is None) != (previous_identity is None) or current is not None and not _same_file(current, previous_identity):
                _fail("vault_income_journal_unavailable")
            if self._windows:
                self._windows.replace(self.directory / name, self.directory / "state.json")
            else:
                os.replace(name, "state.json", src_dir_fd=self._root_fd, dst_dir_fd=self._root_fd)
            replaced = True
            self._sync()
            named = os.lstat(self.directory / "state.json"); _entry(named)
            if _identity(named) != _identity(temporary_identity):
                _fail("vault_income_journal_unavailable")
            if self._windows:
                self._windows.private(self.directory / "state.json")
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if not replaced and temporary_identity is not None:
                try:
                    current = os.lstat(self.directory / name)
                except FileNotFoundError:
                    current = None
                if current is not None and _identity(current) == _identity(temporary_identity):
                    if self._windows:
                        os.unlink(self.directory / name)
                    else:
                        os.unlink(name, dir_fd=self._root_fd)
                    self._sync()

    def exclusive(self, scope: str, callback: Callable[[Any], T]) -> T:
        if os.getpid() != self._pid:
            _fail("vault_income_journal_process_mismatch")
        scope = _bytes32(scope)
        if not self._lock.acquire(timeout=self._timeout):
            _fail("vault_income_journal_busy")
        activated = False
        try:
            if self._closed:
                _fail("vault_income_journal_closed")
            if self._active or self._scope is not None and self._scope != scope:
                _fail("vault_income_journal_scope_mismatch")
            self._scope, self._active = scope, 1
            activated = True
            self._guard()
            self._read()
            owner = self
            thread = threading.get_ident()
            valid = True

            class Transaction:
                def _check(self):
                    if not valid or threading.get_ident() != thread or owner._closed or not owner._active:
                        _fail("vault_income_journal_transaction_inactive")

                def load(self):
                    self._check()
                    return owner._read()

                def save(self, state):
                    self._check()
                    owner._save(state)
            try:
                return callback(Transaction())
            finally:
                valid = False
        except VaultIncomeError:
            raise
        except (OSError, ValueError, TypeError, RecursionError):
            _fail("vault_income_journal_unavailable")
        finally:
            if activated:
                self._active = 0
            self._lock.release()

    def _release_handles(self) -> None:
        if self._owner_fd is not None:
            os.close(self._owner_fd); self._owner_fd = None
        if self._root_fd is not None:
            os.close(self._root_fd); self._root_fd = None
        if self._windows:
            for handle in reversed(self._handles):
                self._windows.kernel.CloseHandle(handle)
        self._handles = []

    def close(self) -> None:
        if os.getpid() != self._pid:
            _fail("vault_income_journal_process_mismatch")
        with self._lock:
            if self._closed:
                return
            if self._active:
                _fail("vault_income_journal_busy")
            try:
                self._guard()
                identity = os.lstat(self.directory / ".owner.json")
                if not _same_file(identity, self._owner_identity):
                    _fail("vault_income_journal_owned")
                os.close(self._owner_fd); self._owner_fd = None
                self._owner_identity = None
                if self._windows:
                    os.unlink(self.directory / ".owner.json")
                else:
                    os.unlink(".owner.json", dir_fd=self._root_fd)
                self._sync()
            finally:
                self._closed = True
                self._release_handles()
