from __future__ import annotations

import httpx
import pytest
from conftest import ANSWER, job, json_response

from mitra import JobFailedError, MitraError


async def test_async_ask(make_async_client):
    client = make_async_client(lambda r: json_response(ANSWER))
    answer = await client.ask("q", language="ta-IN")
    assert answer.status == "answered"


async def test_async_error(make_async_client):
    client = make_async_client(
        lambda r: json_response({"detail": {"category": "conflict", "message": "not open"}}, 409)
    )
    with pytest.raises(MitraError) as info:
        await client.ask("q")
    assert type(info.value).__name__ == "BusyError"


async def test_async_jobs_wait(make_async_client, monkeypatch):
    async def no_sleep(_):
        return None

    monkeypatch.setattr("asyncio.sleep", no_sleep)
    states = iter(["queued", "running", "succeeded"])
    client = make_async_client(lambda r: json_response(job(next(states), result={"answer": "x"})))
    done = await client.jobs.wait("j1")
    assert done.state == "succeeded"


async def test_async_jobs_wait_failed(make_async_client):
    client = make_async_client(
        lambda r: json_response(job("failed", error={"category": "x", "message": "bad"}))
    )
    with pytest.raises(JobFailedError):
        await client.jobs.wait("j1")


async def test_async_gem_image(make_async_client):
    client = make_async_client(lambda r: httpx.Response(200, content=b"png"))
    assert await client.gems.image("g1") == b"png"


async def test_async_context_manager():
    from mitra import AsyncMitra

    async with AsyncMitra("mtk_test") as client:
        assert client.settings.base_url.endswith("/api/v1")
