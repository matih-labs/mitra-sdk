"""Shared request plumbing for the sync and async clients (internal)."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from ._version import __version__
from .errors import MitraError, error_from_response

DEFAULT_BASE_URL = "https://workspace.matih.ai"
API_PREFIX = "/api/v1"
RETRY_STATUSES = frozenset({429, 502, 503, 504})


def api_root(base_url: str) -> str:
    """The API root for a host: ``https://workspace.matih.ai`` -> ``.../api/v1``.

    ``base_url`` is the host only. A value that already ends in ``/api/v1`` is accepted as is."""
    root = base_url.strip().rstrip("/")
    return root if root.endswith(API_PREFIX) else root + API_PREFIX


class Settings:
    def __init__(
        self,
        *,
        api_key: str | None,
        access_token: str | None,
        base_url: str | None,
        workspace_id: str | None,
        language: str | None,
        timeout: float,
        max_retries: int,
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
        self.timeout = timeout
        self.max_retries = max_retries

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
    """Retry 429 always (not processed), and 5xx or network errors when the call is safe to repeat."""
    if attempt >= max_retries:
        return False
    safe = kwargs["method"] in ("GET", "HEAD", "DELETE") or "Idempotency-Key" in kwargs["headers"]
    if status == 429:
        return True
    return safe


def retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        value = response.headers.get("retry-after")
        if value:
            try:
                return min(max(float(value), 0.0), 60.0)
            except ValueError:
                pass
    return min(0.5 * (2**attempt), 8.0)


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
