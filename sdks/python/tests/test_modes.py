"""Sync and background modes: Prefer headers, 202 jobs and polling, for both clients."""

from __future__ import annotations

import pytest
from conftest import ANSWER, job, json_response

from mitra import Job, JobFailedError, JobTimeoutError


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


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)

    async def instant(_):
        return None

    monkeypatch.setattr("asyncio.sleep", instant)


# ---------------------------------------------------------------- sync client

def test_ask_default_has_no_prefer_header(make_client):
    handler = seq(r(ANSWER))
    answer = make_client(handler).ask("how much?")
    assert answer.answer == "Sales were 10 crore."
    assert "prefer" not in handler.calls[0].headers


def test_ask_background_returns_job_with_respond_async(make_client):
    handler = seq(r(job("queued", kind="ask"), 202, {"Preference-Applied": "respond-async"}))
    result = make_client(handler).ask("how much?", background=True)
    assert isinstance(result, Job) and result.kind == "ask" and result.state == "queued"
    assert handler.calls[0].headers["prefer"] == "respond-async"
    assert len(handler.calls) == 1


def test_ask_background_job_resolves_to_answer(make_client):
    handler = seq(
        r(job("queued", kind="ask"), 202),
        r(job("running", kind="ask")),
        r(job("succeeded", kind="ask", result=ANSWER)),
    )
    client = make_client(handler)
    queued = client.ask("how much?", background=True)
    done = client.jobs.wait(queued.id, 30)
    assert done.as_answer().conversation_id == "c1"


def test_predictions_create_waits_by_default(make_client):
    handler = seq(
        r(job("running"), 202),
        r(job("running")),
        r(job("succeeded", result={"answer": "up 4%", "attachments": []})),
    )
    done = make_client(handler).predictions.create("next quarter?", wait=600)
    assert handler.calls[0].headers["prefer"] == "wait=60"  # capped at what the server honours
    assert done.result["answer"] == "up 4%"
    assert handler.calls[1].url.path.endswith("/jobs/j1")


def test_predictions_create_done_within_server_wait(make_client):
    handler = seq(r(job("succeeded", result={"answer": "ok"}), 200))
    done = make_client(handler).predictions.create("q", wait=20)
    assert handler.calls[0].headers["prefer"] == "wait=20"
    assert done.state == "succeeded" and len(handler.calls) == 1


def test_background_returns_queued_job_without_prefer_or_polling(make_client):
    handler = seq(r(job("queued", kind="gems"), 202))
    queued = make_client(handler).gems.generate("s1", background=True)
    assert queued.state == "queued"
    assert "prefer" not in handler.calls[0].headers
    assert len(handler.calls) == 1


def test_gems_generate_failed_job_raises(make_client):
    handler = seq(r(job("queued"), 202), r(job("failed", error={"category": "x", "message": "bad"})))
    with pytest.raises(JobFailedError):
        make_client(handler).gems.generate("s1")


def test_wait_runs_out_raises_timeout(make_client):
    handler = seq(r(job("running"), 202))
    with pytest.raises(JobTimeoutError):
        make_client(handler).predictions.create("q", wait=0)


def test_dashboard_image_modes(make_client):
    done = {"image_url": "https://workspace.matih.ai/img/d1", "width": 1, "height": 1}
    handler = seq(r(job("queued", kind="dashboard_image"), 202), r(job("succeeded", result=done)))
    client = make_client(handler)
    assert client.dashboards.image("d1", wait=30).result["image_url"].endswith("/img/d1")
    assert handler.calls[0].headers["prefer"] == "wait=30"
    bg = make_client(seq(r(job("queued", kind="dashboard_image"), 202))).dashboards.image(
        "d1", background=True
    )
    assert bg.state == "queued"


def test_sources_create_waits_up_to_120(make_client):
    handler = seq(r({"id": "s1", "name": "Sales"}, 201))
    out = make_client(handler).sources.create({"type": "postgres"}, wait=300)
    assert handler.calls[0].headers["prefer"] == "wait=120"
    assert out["id"] == "s1"


def test_sources_create_background_202_returns_job(make_client):
    handler = seq(r(job("queued", kind="source"), 202))
    out = make_client(handler).sources.create({"type": "postgres"}, background=True)
    assert isinstance(out, Job) and out.state == "queued"
    assert "prefer" not in handler.calls[0].headers


def test_files_upload_waits_on_202(make_client):
    handler = seq(r(job("queued", kind="file"), 202), r(job("succeeded", kind="file")))
    out = make_client(handler).files.upload(b"a,b\n", filename="x.csv", wait=20)
    assert handler.calls[0].headers["prefer"] == "wait=20"
    assert out.state == "succeeded"


def test_files_upload_returns_file_when_processed(make_client):
    handler = seq(r({"id": "f1", "status": "ready"}, 201))
    out = make_client(handler).files.upload(b"a,b\n", filename="x.csv")
    assert out.id == "f1"


# --------------------------------------------------------------- async client

async def test_async_ask_background(make_async_client):
    handler = seq(r(job("queued", kind="ask"), 202))
    result = await make_async_client(handler).ask("how much?", background=True)
    assert isinstance(result, Job) and result.kind == "ask"
    assert handler.calls[0].headers["prefer"] == "respond-async"


async def test_async_ask_default(make_async_client):
    handler = seq(r(ANSWER))
    answer = await make_async_client(handler).ask("how much?")
    assert answer.status == "answered"
    assert "prefer" not in handler.calls[0].headers


async def test_async_ask_job_to_answer(make_async_client):
    handler = seq(r(job("queued", kind="ask"), 202), r(job("succeeded", kind="ask", result=ANSWER)))
    client = make_async_client(handler)
    queued = await client.ask("how much?", background=True)
    done = await client.jobs.wait(queued.id, 30)
    assert done.as_answer().answer == "Sales were 10 crore."


async def test_async_predictions_wait(make_async_client):
    handler = seq(r(job("running"), 202), r(job("succeeded", result={"answer": "up"})))
    done = await make_async_client(handler).predictions.create("q", wait=45)
    assert handler.calls[0].headers["prefer"] == "wait=45"
    assert done.result["answer"] == "up"


async def test_async_background_returns_job(make_async_client):
    handler = seq(r(job("queued", kind="gems"), 202))
    queued = await make_async_client(handler).gems.generate("s1", background=True)
    assert queued.state == "queued" and len(handler.calls) == 1
    assert "prefer" not in handler.calls[0].headers


async def test_async_failed_and_timeout(make_async_client):
    failing = seq(r(job("queued"), 202), r(job("failed", error={"category": "x", "message": "bad"})))
    with pytest.raises(JobFailedError):
        await make_async_client(failing).dashboards.image("d1")
    with pytest.raises(JobTimeoutError):
        await make_async_client(seq(r(job("running"), 202))).predictions.create("q", wait=0)


async def test_async_sources_and_files(make_async_client):
    src = seq(r({"id": "s1"}, 201))
    assert (await make_async_client(src).sources.create({"type": "postgres"}))["id"] == "s1"
    assert src.calls[0].headers["prefer"] == "wait=120" or src.calls[0].headers["prefer"].startswith("wait=")
    up = seq(r(job("queued", kind="file"), 202), r(job("succeeded", kind="file")))
    out = await make_async_client(up).files.upload(b"a\n", filename="x.csv", wait=10)
    assert out.state == "succeeded"
