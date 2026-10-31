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


def seq(*responses):
    """Handler that answers with the given responses in order, repeating the last."""
    calls: list = []

    def handler(request):
        calls.append(request)
        return responses[min(len(calls) - 1, len(responses) - 1)]()

    handler.calls = calls
    return handler


def r(payload, status=200, headers=None):
    return lambda: json_response(payload, status, headers)


def source(phase: str = "ready", **extra) -> dict:
    """A Source as the server returns it; ``phase`` is ready, building or not_connected."""
    can_ask = phase == "ready"
    return {
        "id": "s1", "name": "Orders DB", "connector_type": "postgres", "settings": {},
        "secret_fields_set": ["password"], "state": "connected", "is_active": True,
        "is_sample": False, "created_at": "2026-10-31T00:00:00Z",
        "updated_at": "2026-10-31T00:00:01Z",
        "readiness": {"source_id": "s1", "state": "connected", "phase": phase,
                      "can_ask": can_ask, "message": "x"},
        **extra,
    }


def source_created(phase: str = "ready") -> dict:
    return {"source": source(phase), "test": {"ok": True, "connector_type": "postgres",
            "duration_ms": 12, "message": "ok"}, "applied": True, "catalog_job_id": "cj1"}


def file_payload(status: str, **extra) -> dict:
    return {"id": "f1", "name": "sales.csv", "format": "csv", "size_bytes": 10, "status": status,
            "ready": status == "ready", "decision_options": [], "tables": [],
            "created_at": "2026-10-31T00:00:00Z", "updated_at": "2026-10-31T00:00:01Z", **extra}
