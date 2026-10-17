"""A same-origin, bounded HTTP transport; sessions stay in memory."""

from __future__ import annotations

import json
import re
import socket
import ssl
import threading
import time
from http.client import HTTPException
from http.cookies import CookieError, SimpleCookie
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE_BYTES = 1_048_576
MAX_REQUEST_BYTES = 196_608
MAX_CYST_BODY_BYTES = 2_800_320


def response_bound(path: str, method: str, requested: int | None) -> int:
    limit = MAX_RESPONSE_BYTES if requested is None else requested
    if type(limit) is not int or not 1 <= limit <= MAX_CYST_BODY_BYTES:
        raise ValueError("Invalid Telomere response bound")
    blob_path = re.fullmatch(r"/api/cysts/0x[a-f0-9]{64}/blob", path) or re.fullmatch(
        r"/api/cyst-registry/agents/0x[a-f0-9]{64}/checkpoints/0x[a-f0-9]{64}/blob", path)
    if limit > MAX_RESPONSE_BYTES and (method != "GET" or not blob_path):
        raise ValueError("Only the exact Cyst blob endpoint permits a larger response")
    return limit


def request_bound(path: str, method: str) -> int:
    return MAX_CYST_BODY_BYTES if path == "/api/cysts" and method == "POST" else MAX_REQUEST_BYTES


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(f"Telomere request failed ({status}: {code})")


def normalize_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError("Use a valid Telomere origin") from None
    if (not isinstance(value, str) or any(ord(char) <= 32 for char in value)
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not parsed.hostname or parsed.scheme not in ("http", "https")
            or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"))):
        raise ValueError("Use HTTPS or a loopback HTTP Telomere origin")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    suffix = f":{port}" if port is not None and port != (443 if parsed.scheme == "https" else 80) else ""
    return f"{parsed.scheme}://{host}{suffix}"


def is_loopback(origin: str) -> bool:
    return urlsplit(origin).hostname in ("localhost", "127.0.0.1", "::1")


def strict_json(raw: bytes) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    def no_constant(_: str) -> None:
        raise ValueError("Non-finite JSON number")

    try:
        return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique, parse_constant=no_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise ApiError(502, "invalid_response") from None


def _response_body(response: Any, limit: int, deadline: float) -> bytes:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ApiError(503, "transport_unavailable")
    # HTTPResponse -> buffered file -> SocketIO; HTTPError adds one outer fp wrapper.
    # Capture the real socket before reading: read(n), including chunk headers, can
    # perform many receives whose individual idle timeouts never bound a trickle.
    connection = response
    for _ in range(5):
        if isinstance(connection, socket.socket):
            break
        connection = next((child for name in ("_sock", "raw", "fp")
                           if (child := getattr(connection, name, None)) is not None), None)
    if not isinstance(connection, socket.socket):
        raise ApiError(503, "transport_unavailable")
    expired = threading.Event()

    def abort_body() -> None:
        expired.set()
        try:
            # Direct OS shutdown also interrupts SSL reads without an SSL close handshake.
            socket.socket.shutdown(connection, socket.SHUT_RDWR)
        except OSError:
            pass

    watchdog = threading.Timer(remaining, abort_body)
    watchdog.daemon = True
    watchdog.start()
    try:
        raw = response.read(limit + 1)
        if expired.is_set() or time.monotonic() >= deadline:
            raise ApiError(503, "transport_unavailable")
        return raw
    finally:
        watchdog.cancel()


class Transport(Protocol):
    origin: str

    def request(self, path: str, *, method: str = "GET", body: Any = None,
                idempotency_key: str | None = None, max_response_bytes: int | None = None,
                cyst_quota_version: int | None = None) -> Any: ...

    def clear_session(self) -> None: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


class ApiTransport:
    def __init__(self, base_url: str, *, timeout: float = 30.0):
        self.origin = normalize_origin(base_url)
        if type(timeout) not in (int, float) or not 0 < timeout <= 30:
            raise ValueError("Timeout must be greater than zero and at most 30 seconds")
        self.timeout = timeout
        self._token: str | None = None
        self._expires = 0.0
        self._lock = threading.RLock()
        # No environment proxy and no redirects: authentication stays at the fixed origin.
        self._opener = build_opener(ProxyHandler({}), _NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def clear_session(self) -> None:
        with self._lock:
            self._token, self._expires = None, 0.0

    def _cookie(self, headers: Any) -> None:
        cookies = headers.get_all("Set-Cookie", [])
        for value in cookies:
            if len(value) > 4096:
                continue
            parsed = SimpleCookie()
            try:
                parsed.load(value)
            except CookieError:
                continue
            cookie = parsed.get("telomere_session")
            if cookie is None:
                continue
            host = urlsplit(self.origin).hostname
            if cookie["domain"] and cookie["domain"].lower() != host:
                continue
            if cookie["path"] != "/" or not cookie["httponly"] or cookie["samesite"].lower() != "strict":
                continue
            if self.origin.startswith("https:") and not cookie["secure"]:
                continue
            if cookie["max-age"] == "0":
                self.clear_session()
                continue
            if not re.fullmatch(r"[a-f0-9]{64}", cookie.value):
                continue
            try:
                lifetime = int(cookie["max-age"])
            except ValueError:
                continue
            if 0 < lifetime <= 8 * 3600:
                self._token, self._expires = cookie.value, time.time() + lifetime

    def request(self, path: str, *, method: str = "GET", body: Any = None,
                idempotency_key: str | None = None, max_response_bytes: int | None = None,
                command_timeout: float | None = None, cyst_quota_version: int | None = None) -> Any:
        if (not isinstance(path, str) or not re.fullmatch(r"/api/[a-zA-Z0-9/_?=&.%:-]+", path)
                or any(piece in path.lower() for piece in ("..", "%2e", "%2f", "%5c"))):
            raise ValueError("Invalid Telomere API path")
        if method not in ("GET", "POST") or (method == "GET" and body is not None):
            raise ValueError("Unsupported Telomere request")
        limit = response_bound(path, method, max_response_bytes)
        session_command = re.fullmatch(
            r"/api/platform(?:/vaults/0x[a-f0-9]{40})?/runs/0x[a-f0-9]{64}/commands", path) is not None
        if command_timeout is not None and (not session_command or method != "POST"
                                            or type(command_timeout) not in (int, float) or command_timeout != 130):
            raise ValueError("Only paid session commands permit a 130-second HTTP timeout")
        timeout = self.timeout if command_timeout is None else command_timeout
        if session_command and method == "POST":
            if (not isinstance(idempotency_key, str)
                    or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", idempotency_key)
                    or not isinstance(body, dict) or body.get("commandId") != idempotency_key):
                raise ValueError("Paid session command ID must match its idempotency key")
        elif idempotency_key is not None and not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", idempotency_key):
            raise ValueError("Invalid idempotency key")
        payload = None
        if body is not None:
            try:
                payload = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise ValueError("Invalid JSON request") from None
            if len(payload) > request_bound(path, method):
                raise ValueError("Telomere request exceeds the body limit")
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if cyst_quota_version is not None:
            if type(cyst_quota_version) is not int or cyst_quota_version != 2 or not re.match(r"^/api/cysts(?:$|[/?])", path):
                raise ValueError("Checkpoint quota profile is restricted to Cyst requests")
            headers["X-Telomere-Cyst-Quota"] = "2"
        if method == "POST":
            headers.update({"Origin": self.origin, "Content-Type": "application/json"})
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        with self._lock:
            if self._token is not None and self._expires > time.time():
                headers["Cookie"] = f"telomere_session={self._token}"
            else:
                self.clear_session()
            request = Request(self.origin + path, data=payload, headers=headers, method=method)
            deadline = time.monotonic() + timeout
            try:
                response = self._opener.open(request, timeout=timeout)
            except HTTPError as error:
                response = error
            except (URLError, TimeoutError, OSError, HTTPException):
                raise ApiError(503, "transport_unavailable") from None
            try:
                with response:
                    status = response.status
                    if 300 <= status < 400:
                        raise ApiError(status, "redirect_rejected")
                    length = response.headers.get("Content-Length")
                    if length is not None:
                        try:
                            if int(length) < 0 or int(length) > limit:
                                raise ApiError(502, "response_limit")
                        except ValueError:
                            raise ApiError(502, "invalid_response") from None
                    raw = _response_body(response, limit, deadline)
                    if len(raw) > limit:
                        raise ApiError(502, "response_limit")
                    value = strict_json(raw)
                    if not 200 <= status < 300:
                        title = value.get("title") if isinstance(value, dict) else None
                        code = title if isinstance(title, str) and re.fullmatch(r"[a-z_]{1,64}", title) else "request_failed"
                        raise ApiError(status, code)
                    self._cookie(response.headers)
                    return value
            except (TimeoutError, OSError, HTTPException):
                raise ApiError(503, "transport_unavailable") from None
