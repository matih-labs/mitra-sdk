"""Shared request plumbing for the sync and async clients (internal)."""

from __future__ import annotations

import json
import os
import random
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from ._version import __version__
from .errors import MitraError, error_from_response

DEFAULT_BASE_URL = "https://workspace.matih.ai"
API_PREFIX = "/api/v1"
# 429 is retried for every call (the server did not process it). The rest only for calls that are
# safe to repeat: GET, HEAD, PUT, DELETE, or a call carrying an Idempotency-Key.
RETRY_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

# Connection and timeout defaults. One float ``timeout`` is the read and write time; connecting is
# bounded on its own so an unreachable host fails in seconds, not after a minute.
DEFAULT_TIMEOUT = 60.0
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_MAX_CONNECTIONS = 100
DEFAULT_MAX_KEEPALIVE = 20
# workspace.matih.ai closes an idle connection after about 60 s (measured: reused at 55 s, closed
# at 70 s). httpx's own default of 5 s would reconnect (TCP + TLS, ~3 round trips) for every poll
# of a long job. 30 s keeps the connection through the 15 s poll interval and stays well under 60.
DEFAULT_KEEPALIVE_EXPIRY = 30.0

# Retry pacing: exponential from 0.5 s, capped at 8 s, with jitter. A Retry-After above
# MAX_RETRY_AFTER is not slept: the error is raised so the caller decides. All sleeps of one call
# together never exceed the retry budget.
BACKOFF_BASE = 0.5
BACKOFF_CAP = 8.0
MAX_RETRY_AFTER = 60.0
DEFAULT_RETRY_BUDGET = 60.0


def api_root(base_url: str) -> str:
    """The API root for a host: ``https://workspace.matih.ai`` -> ``.../api/v1``.

    ``base_url`` is the host only. A value that already ends in ``/api/v1`` is accepted as is."""
    root = base_url.strip().rstrip("/")
    return root if root.endswith(API_PREFIX) else root + API_PREFIX


def make_timeout(timeout: float | httpx.Timeout, connect_timeout: float) -> httpx.Timeout:
    """``timeout`` seconds for reading, writing and waiting for a pooled connection; connecting
    is bounded by ``connect_timeout`` (never longer than ``timeout``). An ``httpx.Timeout`` is
    used as given."""
    if isinstance(timeout, httpx.Timeout):
        return timeout
    return httpx.Timeout(timeout, connect=min(connect_timeout, timeout))


def make_limits(
    max_connections: int, max_keepalive_connections: int, keepalive_expiry: float
) -> httpx.Limits:
    return httpx.Limits(
        max_connections=max_connections,
        max_keepalive_connections=max_keepalive_connections,
        keepalive_expiry=keepalive_expiry,
    )


def check_http2(enabled: bool) -> bool:
    """``http2=True`` needs the ``h2`` package; say how to get it instead of httpx's bare ImportError."""
    if enabled:
        try:
            import h2  # noqa: F401
        except ImportError:
            raise ImportError('http2=True needs the h2 package: pip install "mitra-sdk[http2]"') from None
    return enabled


def with_read(timeout: httpx.Timeout, seconds: float) -> httpx.Timeout:
    """``timeout`` with the read time raised to at least ``seconds`` (a server-side ``Prefer: wait``)."""
    read = seconds if timeout.read is None else max(timeout.read, seconds)
    return httpx.Timeout(connect=timeout.connect, read=read, write=timeout.write, pool=timeout.pool)


def within(timeout: httpx.Timeout, seconds: float) -> httpx.Timeout:
    """``timeout`` with every phase capped at ``seconds`` (what is left of a call's deadline)."""

    def cap(value: float | None) -> float:
        return seconds if value is None else min(value, seconds)

    return httpx.Timeout(
        connect=cap(timeout.connect), read=cap(timeout.read),
        write=cap(timeout.write), pool=cap(timeout.pool),
    )


class Settings:
    def __init__(
        self,
        *,
        api_key: str | None,
        access_token: str | None,
        base_url: str | None,
        workspace_id: str | None,
        language: str | None,
        timeout: float | httpx.Timeout,
        max_retries: int,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        retry_budget: float = DEFAULT_RETRY_BUDGET,
    ) -> None:
        if api_key and access_token:
            raise ValueError("pass either api_key or access_token, not both")
        credential = (
            api_key
            or access_token
            or os.environ.get("MATIH_API_KEY")
            or os.environ.get("MATIH_ACCESS_TOKEN")
        )
        if not credential:
            raise ValueError("pass api_key=... or access_token=... (or set MATIH_API_KEY)")
        self.credential = credential
        self.base_url = api_root(base_url or os.environ.get("MATIH_BASE_URL") or DEFAULT_BASE_URL)
        self.workspace_id = workspace_id
        self.language = language
        self.connect_timeout = connect_timeout
        self.timeout = make_timeout(timeout, connect_timeout)
        self.max_retries = max_retries
        self.retry_budget = retry_budget

    def resolve(self, timeout: float | httpx.Timeout | None) -> httpx.Timeout:
        """A per-call ``request_timeout`` (seconds or an ``httpx.Timeout``) or the client default."""
        if timeout is None:
            return self.timeout
        return make_timeout(timeout, self.connect_timeout)

    def headers(
        self,
        *,
        workspace_id: str | None = None,
        language: str | None = None,
        idempotency_key: str | None = None,
        accept: str = "application/json",
        prefer: str | None = None,
    ) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.credential}",
            "Accept": accept,
            "User-Agent": f"mitra-sdk-python/{__version__}",
        }
        workspace = workspace_id or self.workspace_id
        if workspace:
            headers["X-Matih-Workspace"] = workspace
        lang = language or self.language
        if lang:
            headers["Accept-Language"] = lang
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if prefer:
            headers["Prefer"] = prefer
        return headers


def prepare(
    settings: Settings,
    method: str,
    path: str,
    *,
    json_body: Any = None,
    params: dict[str, Any] | None = None,
    files: Any = None,
    data: dict[str, Any] | None = None,
    workspace_id: str | None = None,
    language: str | None = None,
    idempotent: bool = False,
    idempotency_key: str | None = None,
    accept: str = "application/json",
    prefer: str | None = None,
) -> dict[str, Any]:
    """Build kwargs for ``httpx.Client.request``. The idempotency key is fixed here, once."""
    key = idempotency_key or (str(uuid.uuid4()) if idempotent else None)
    kwargs: dict[str, Any] = {
        "method": method,
        "url": settings.base_url + path,
        "headers": settings.headers(
            workspace_id=workspace_id,
            language=language,
            idempotency_key=key,
            accept=accept,
            prefer=prefer,
        ),
    }
    if params:
        kwargs["params"] = {k: v for k, v in params.items() if v is not None}
    if json_body is not None:
        kwargs["json"] = json_body
    if files is not None:
        kwargs["files"] = files
    if data:
        kwargs["data"] = data
    return kwargs


def should_retry(kwargs: dict[str, Any], status: int | None, attempt: int, max_retries: int) -> bool:
    """Retry 429 always (not processed), and the other retryable statuses or network errors when
    the call is safe to repeat."""
    if attempt >= max_retries:
        return False
    if status == 429:
        return True
    return kwargs["method"] in ("GET", "HEAD", "PUT", "DELETE") or "Idempotency-Key" in kwargs["headers"]


def backoff(attempt: int) -> float:
    """0.5 s, 1 s, 2 s ... capped at 8 s, each scaled by a random 50-100% so clients that failed
    together do not retry together."""
    return min(BACKOFF_BASE * (2**attempt), BACKOFF_CAP) * (0.5 + random.random() * 0.5)


def retry_delay(response: httpx.Response | None, attempt: int) -> float | None:
    """Seconds to wait before the next attempt: the server's ``Retry-After`` when it sent one in
    seconds, else jittered exponential backoff. ``None`` when ``Retry-After`` is longer than
    ``MAX_RETRY_AFTER``: waiting that long inside a call is not something to do silently."""
    value = response.headers.get("retry-after") if response is not None else None
    if value:
        try:
            seconds = float(value)
        except ValueError:
            seconds = None  # an HTTP date: fall back to backoff
        if seconds is not None:
            return None if seconds > MAX_RETRY_AFTER else max(seconds, 0.0)
    return backoff(attempt)


class Attempts:
    """Bookkeeping of one call's attempts, shared by the sync and the async client: how long each
    attempt may take, how long to sleep before the next, and when to give up (``max_retries``, the
    retry budget, the call's deadline)."""

    def __init__(
        self,
        settings: Settings,
        kwargs: dict[str, Any],
        *,
        timeout: httpx.Timeout | None = None,
        max_retries: int | None = None,
        deadline: float | None = None,
    ) -> None:
        self.kwargs = kwargs
        self.base_timeout = timeout or settings.timeout
        self.max_retries = settings.max_retries if max_retries is None else max_retries
        self.budget = settings.retry_budget
        self.deadline = deadline
        self.started = time.monotonic()
        self.slept = 0.0
        self.attempt = 0

    def left(self) -> float | None:
        if self.deadline is None:
            return None
        return self.deadline - (time.monotonic() - self.started)

    def timeout(self) -> httpx.Timeout:
        """The timeout for the next attempt, never past the deadline."""
        left = self.left()
        if left is None:
            return self.base_timeout
        if left <= 0:
            raise MitraError(f"deadline of {self.deadline}s exceeded")
        return within(self.base_timeout, left)

    def next_delay(self, response: httpx.Response | None) -> float | None:
        """Seconds to sleep before retrying, or ``None`` to give up and raise what happened."""
        status = response.status_code if response is not None else None
        if status is not None and status not in RETRY_STATUSES:
            return None
        if not should_retry(self.kwargs, status, self.attempt, self.max_retries):
            return None
        delay = retry_delay(response, self.attempt)
        if delay is None or self.slept + delay > self.budget:
            return None
        left = self.left()
        if left is not None and delay >= left:
            return None
        self.slept += delay
        self.attempt += 1
        return delay


def raise_for_response(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        body: Any = response.json()
    except ValueError:
        body = {"detail": {"message": response.text[:500] or f"HTTP {response.status_code}"}}
    retry_after = None
    raw = response.headers.get("retry-after")
    if raw:
        try:
            retry_after = float(raw)
        except ValueError:
            retry_after = None
    raise error_from_response(
        response.status_code,
        body,
        request_id=response.headers.get("x-request-id"),
        retry_after=retry_after,
        method=response.request.method,
        path=response.request.url.path,
    )


def decode(response: httpx.Response, parse: Callable[[Any], Any] | None, raw: bool) -> Any:
    if raw:
        return response.content
    if not response.content:
        return None
    try:
        payload = response.json()
    except ValueError as exc:
        raise MitraError(
            "response was not JSON",
            status=response.status_code,
            request_id=response.headers.get("x-request-id"),
        ) from exc
    return parse(payload) if parse else payload


def parse_sse(lines: list[str]) -> tuple[str, Any] | None:
    """Turn the lines of one SSE frame into ``(event, data)``; ``None`` for comments/empty."""
    event = "message"
    data_lines: list[str] = []
    for line in lines:
        if not line or line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    if not data_lines:
        return None
    text = "\n".join(data_lines)
    try:
        return event, json.loads(text)
    except ValueError:
        return event, text
