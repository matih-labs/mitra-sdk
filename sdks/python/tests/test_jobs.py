from __future__ import annotations

import pytest
from conftest import job, json_response

from mitra import JobFailedError, JobTimeoutError


def sequence(states, final_extra=None):
    """Handler returning the given job states one per poll, repeating the last."""
    calls = {"n": 0}

    def handler(request):
        i = min(calls["n"], len(states) - 1)
        calls["n"] += 1
        extra = final_extra if (final_extra and i == len(states) - 1) else {}
        return json_response(job(states[i], **extra))

    handler.calls = calls
    return handler


def test_wait_polls_until_succeeded(make_client, monkeypatch):
    sleeps = []
    monkeypatch.setattr("time.sleep", sleeps.append)
    handler = sequence(["queued", "running", "running", "succeeded"],
                       {"result": {"answer": "ok", "attachments": []}})
    client = make_client(handler)
    seen = []
    done = client.jobs.wait("j1", on_update=lambda j: seen.append(j.state))
    assert done.state == "succeeded"
    assert done.result["answer"] == "ok"
    assert handler.calls["n"] == 4
    assert seen[0] == "queued" and seen[-1] == "succeeded"
    assert sleeps == sorted(sleeps) and sleeps[0] == 1.0 and sleeps[1] == 1.5


def test_wait_raises_on_failed(make_client):
    handler = sequence(["failed"], {"error": {"category": "model", "message": "could not fit"}})
    client = make_client(handler)
    with pytest.raises(JobFailedError) as info:
        client.jobs.wait("j1")
    assert "could not fit" in str(info.value)
    assert info.value.job.state == "failed"


def test_wait_can_return_failed_job(make_client):
    client = make_client(sequence(["cancelled"]))
    assert client.jobs.wait("j1", raise_on_failure=False).state == "cancelled"


def test_wait_times_out(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    client = make_client(sequence(["running"]))
    with pytest.raises(JobTimeoutError):
        client.jobs.wait("j1", timeout=0.0)


def test_prediction_run_creates_and_waits(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    state = {"polls": 0}

    def handler(request):
        if request.method == "POST":
            return json_response(job("queued"), 202)
        state["polls"] += 1
        return json_response(job("succeeded", result={"answer": "up 4%", "attachments": []}))

    client = make_client(handler)
    finished = client.predictions.run("forecast sales", source_id="s1")
    assert finished.result["answer"] == "up 4%"


def test_cancel(make_client):
    client = make_client(lambda r: json_response(job("cancelled")))
    assert client.jobs.cancel("j1").state == "cancelled"
