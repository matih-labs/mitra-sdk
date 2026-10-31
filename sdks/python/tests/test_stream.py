from __future__ import annotations

import json

import httpx
import pytest
from conftest import ANSWER

from mitra import MitraError

SSE = (
    "event: started\ndata: {\"request_id\": \"r1\"}\n\n"
    ": keep-alive\n\n"
    "event: progress\ndata: {\"step\": \"querying\"}\n\n"
    "event: answer\ndata: " + json.dumps(ANSWER) + "\n\n"
)


def sse_handler(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    assert body["stream"] is True
    assert request.headers["accept"] == "text/event-stream"
    return httpx.Response(200, content=SSE.encode(), headers={"content-type": "text/event-stream"})


def test_ask_stream_yields_events(make_client):
    events = list(make_client(sse_handler).ask_stream("q"))
    assert [e.event for e in events] == ["started", "progress", "answer"]
    assert events[1].data == {"step": "querying"}
    assert events[2].as_answer().answer == "Sales were 10 crore."


def test_ask_stream_error_status_raises(make_client):
    client = make_client(
        lambda r: httpx.Response(402, json={"detail": {"category": "credits", "message": "out"}})
    )
    with pytest.raises(MitraError) as info:
        list(client.ask_stream("q"))
    assert info.value.category == "credits"


async def test_async_ask_stream(make_async_client):
    client = make_async_client(sse_handler)
    names = [e.event async for e in client.ask_stream("q")]
    assert names == ["started", "progress", "answer"]
