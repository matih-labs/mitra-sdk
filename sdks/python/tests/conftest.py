from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from mitra import AsyncMitra, Mitra

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture
def make_client():
    """Build a sync client whose transport is a handler function."""

    def build(handler: Handler, **kwargs) -> Mitra:
        kwargs.setdefault("max_retries", 0)
        http = httpx.Client(transport=httpx.MockTransport(handler))
        return Mitra("mtk_test", http_client=http, **kwargs)

    return build


@pytest.fixture
def make_async_client():
    def build(handler: Handler, **kwargs) -> AsyncMitra:
        kwargs.setdefault("max_retries", 0)
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return AsyncMitra("mtk_test", http_client=http, **kwargs)

    return build


def json_response(payload, status: int = 200, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, json=payload, headers=headers)


def body_of(request: httpx.Request):
    return json.loads(request.content)


ANSWER = {
    "status": "answered",
    "answer": "Sales were 10 crore.",
    "clarification": None,
    "result": {"columns": [{"name": "region", "type": "text"}], "rows": [["North"]],
               "row_count": 1, "truncated": False},
    "sql": "select 1",
    "image_url": "https://workspace.matih.ai/img/abc",
    "follow_ups": ["And last year?"],
    "conversation_id": "c1",
    "request_id": "r1",
    "language": "en-IN",
}


def job(state: str, **extra) -> dict:
    return {"id": "j1", "kind": "prediction", "state": state, "result": None, "error": None,
            "created_at": "2026-10-31T00:00:00Z", "updated_at": "2026-10-31T00:00:01Z", **extra}
