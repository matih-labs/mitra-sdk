"""Each SDK call against what the server really takes: method, path, query, body and headers.

Source of truth: the ``/api/v1`` routes of the Matih server (OpenAPI at /api/v1/openapi.json).
"""

from __future__ import annotations

import httpx
import pytest
from conftest import ANSWER, body_of, job, r, seq

from mitra import CreditsError, Job


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)


def test_gems_generate_sends_no_idempotency_key(make_client):
    """The server's gems, dashboard-image and audio routes take no Idempotency-Key."""
    handler = seq(r(job("queued", kind="gems"), 202))
    make_client(handler).gems.generate("s1", background=True)
    assert "idempotency-key" not in handler.calls[0].headers


def test_dashboard_image_and_audio_send_no_idempotency_key(make_client):
    handler = seq(r(job("queued", kind="dashboard_image"), 202))
    make_client(handler).dashboards.image("d1", background=True)
    assert "idempotency-key" not in handler.calls[0].headers
    audio = seq(r(ANSWER))
    make_client(audio).ask_audio(b"OggS", filename="note.ogg")
    assert "idempotency-key" not in audio.calls[0].headers


def test_ask_and_predictions_do_send_an_idempotency_key(make_client):
    handler = seq(r(ANSWER))
    make_client(handler).ask("q")
    assert handler.calls[0].headers["idempotency-key"]
    pred = seq(r(job("queued"), 202))
    make_client(pred).predictions.create("q", background=True)
    assert pred.calls[0].headers["idempotency-key"]


def test_gems_generate_source_id_is_optional(make_client):
    handler = seq(r(job("queued", kind="gems"), 202), r(job("queued", kind="gems"), 202))
    client = make_client(handler)
    client.gems.generate(background=True)
    assert handler.calls[0].method == "POST"
    assert handler.calls[0].url.path.endswith("/gems/generate") and not handler.calls[0].content
    client.gems.generate("s1", background=True)
    assert body_of(handler.calls[1]) == {"source_id": "s1"}


def test_gems_get_and_image_pass_source_id(make_client):
    handler = seq(r({"id": "g1", "headline": "H"}), lambda: httpx.Response(200, content=b"png"))
    client = make_client(handler)
    assert client.gems.get("g1", "s1").headline == "H"
    assert client.gems.image("g1", "s1") == b"png"
    assert handler.calls[0].url.params["source_id"] == "s1"
    assert handler.calls[1].url.path.endswith("/gems/g1/image.png")
    assert handler.calls[1].url.params["source_id"] == "s1"


def test_predictions_body_carries_language_and_ids(make_client):
    handler = seq(r(job("queued"), 202))
    make_client(handler).predictions.create(
        "next quarter?", source_id="s1", conversation_id="c1", language="hi-IN", background=True)
    assert body_of(handler.calls[0]) == {
        "question": "next quarter?", "source_id": "s1", "conversation_id": "c1",
        "language": "hi-IN"}


def test_dashboard_image_width_goes_in_the_body(make_client):
    handler = seq(r(job("queued", kind="dashboard_image"), 202))
    make_client(handler).dashboards.image("d1", width=800, background=True)
    assert body_of(handler.calls[0]) == {"width": 800}


def test_dashboard_image_bytes_follows_the_303_without_credentials(make_client):
    handler = seq(
        lambda: httpx.Response(303, headers={"location": "https://workspace.matih.ai/api/v1/media/t1"}),
        lambda: httpx.Response(200, content=b"PNG"),
    )
    out = make_client(handler).dashboards.image_bytes("d1", width=800)
    assert out == b"PNG"
    assert handler.calls[0].url.path.endswith("/dashboards/d1/image.png")
    assert handler.calls[0].url.params["width"] == "800"
    assert "authorization" not in handler.calls[1].headers


def test_dashboard_image_bytes_waits_for_the_job_on_202(make_client):
    done = {"image_url": "/api/v1/media/t1", "width": 1600, "height": 900}
    handler = seq(
        r(job("queued", kind="dashboard_image"), 202, {"Retry-After": "3"}),
        r(job("succeeded", kind="dashboard_image", result=done)),
        lambda: httpx.Response(200, content=b"PNG"),
    )
    assert make_client(handler).dashboards.image_bytes("d1") == b"PNG"
    assert handler.calls[2].url.path == "/api/v1/media/t1"


def test_connectors_list(make_client):
    handler = seq(r({"connectors": [{"type": "postgres", "label": "PostgreSQL", "fields": [
        {"name": "host", "required": True}]}]}))
    out = make_client(handler).connectors.list()
    assert handler.calls[0].url.path.endswith("/connectors")
    assert out.connectors[0].fields[0].name == "host"


def test_workspaces_use_is_put_me_workspace(make_client):
    handler = seq(r({"current": "w2", "name": "Globex"}))
    out = make_client(handler).workspaces.use("w2")
    assert handler.calls[0].method == "PUT" and handler.calls[0].url.path.endswith("/me/workspace")
    assert body_of(handler.calls[0]) == {"workspace_id": "w2"}
    assert out.current == "w2"


def test_conversations_list_and_get(make_client):
    handler = seq(
        r({"conversations": [{"id": "c1", "title": "Sales", "message_count": 2}]}),
        r({"id": "c1", "messages": [{"id": "m1", "role": "user", "text": "hi"}]}),
    )
    client = make_client(handler)
    assert client.conversations.list().conversations[0].message_count == 2
    assert client.conversations.get("c1").messages[0].text == "hi"


def test_job_kinds_and_states_of_the_server(make_client):
    done = {"conversation_id": "c1", "answer": ANSWER}
    handler = seq(r(job("succeeded", kind="prediction", result=done)))
    finished = make_client(handler).jobs.get("j1")
    assert isinstance(finished, Job) and finished.is_terminal
    assert finished.result["answer"]["status"] == "answered"


def test_402_not_ready_is_a_credits_error(make_client):
    handler = seq(r({"detail": {"category": "not_ready", "message": "no credits"}}, 402))
    with pytest.raises(CreditsError) as info:
        make_client(handler).gems.generate("s1")
    assert info.value.category == "not_ready"


def test_per_call_workspace_header(make_client):
    handler = seq(r({"members": []}))
    make_client(handler).members.list(workspace_id="usr_71c0")
    assert handler.calls[0].headers["x-matih-workspace"] == "usr_71c0"

