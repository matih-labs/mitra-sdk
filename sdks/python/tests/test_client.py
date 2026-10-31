from __future__ import annotations

import httpx
import pytest
from conftest import ANSWER, body_of, json_response

from mitra import AuthError, MitraError, Mitra, RateLimitError


def test_ask_sends_auth_language_workspace_and_idempotency(make_client):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return json_response(ANSWER)

    client = make_client(handler, workspace_id="w1", language="hi-IN")
    answer = client.ask("kitni bikri hui?", conversation_id="c0", source_id="s1")

    request = seen["request"]
    assert request.method == "POST"
    assert str(request.url) == "https://workspace.matih.ai/api/v1/ask"
    assert request.headers["authorization"] == "Bearer mtk_test"
    assert request.headers["x-matih-workspace"] == "w1"
    assert request.headers["accept-language"] == "hi-IN"
    assert request.headers["idempotency-key"]
    assert body_of(request) == {"question": "kitni bikri hui?", "conversation_id": "c0",
                                "source_id": "s1"}
    assert answer.status == "answered"
    assert answer.conversation_id == "c1"
    assert answer.result.rows == [["North"]]
    assert answer.follow_ups == ["And last year?"]


def test_requires_a_credential(monkeypatch):
    monkeypatch.delenv("MATIH_API_KEY", raising=False)
    with pytest.raises(ValueError):
        Mitra()


def test_error_parsing_and_request_id(make_client):
    def handler(request):
        return json_response(
            {"detail": {"category": "scope", "message": "missing scope ask", "code": "no_scope"}},
            403,
            {"x-request-id": "req-9"},
        )

    client = make_client(handler)
    with pytest.raises(MitraError) as info:
        client.ask("q")
    err = info.value
    assert err.status == 403
    assert err.category == "scope"
    assert err.code == "no_scope"
    assert err.request_id == "req-9"
    assert type(err).__name__ == "PermissionDeniedError"


def test_401_is_auth_error(make_client):
    client = make_client(lambda r: json_response({"detail": {"category": "auth", "message": "no"}}, 401))
    with pytest.raises(AuthError):
        client.workspaces.list()


def test_rate_limit_error_carries_retry_after(make_client):
    client = make_client(
        lambda r: json_response({"detail": {"category": "rate", "message": "slow"}}, 429,
                                {"retry-after": "7"})
    )
    with pytest.raises(RateLimitError) as info:
        client.sources.list()
    assert info.value.retry_after == 7


def test_retries_429_then_succeeds_and_reuses_idempotency_key(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    keys = []

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            return json_response({"detail": {"category": "rate", "message": "slow"}}, 429,
                                 {"retry-after": "0"})
        return json_response(ANSWER)

    client = make_client(handler, max_retries=2)
    assert client.ask("q").status == "answered"
    assert len(keys) == 2 and keys[0] == keys[1]


def test_does_not_retry_5xx_on_post_without_idempotency(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = []

    def handler(request):
        calls.append(1)
        return json_response({"detail": {"category": "server", "message": "boom"}}, 503)

    client = make_client(handler, max_retries=2)
    with pytest.raises(MitraError):
        client.sources.test({"type": "postgres"})
    assert len(calls) == 1


def test_get_retries_5xx(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 3:
            return json_response({"detail": {"category": "server", "message": "boom"}}, 503)
        return json_response({"current": "w1", "workspaces": [{"id": "w1", "name": "Acme", "role": "admin", "kind": "team"}]})

    client = make_client(handler, max_retries=2)
    result = client.workspaces.list()
    assert result.current == "w1"
    assert result.workspaces[0].role == "admin"
    assert len(calls) == 3


def test_files_upload_is_multipart(make_client):
    seen = {}

    def handler(request):
        seen["ct"] = request.headers["content-type"]
        seen["body"] = request.content
        return json_response({"id": "f1", "status": "processing"})

    client = make_client(handler)
    file = client.files.upload(b"a,b\n1,2\n", filename="sales.csv", content_type="text/csv")
    assert file.id == "f1"
    assert seen["ct"].startswith("multipart/form-data")
    assert b'filename="sales.csv"' in seen["body"]
    assert b"a,b\n1,2" in seen["body"]


def test_gem_image_returns_bytes(make_client):
    client = make_client(lambda r: httpx.Response(200, content=b"\x89PNG..."))
    assert client.gems.image("g1").startswith(b"\x89PNG")


def test_gems_list_passes_source_id(make_client):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return json_response({"state": "ready", "gems": [{"id": "g1", "headline": "H"}],
                              "generated_at": "2026-10-31"})

    client = make_client(handler)
    gems = client.gems.list("s1")
    assert seen["url"].endswith("/gems?source_id=s1")
    assert gems.gems[0].headline == "H"


def test_download_image_sends_no_credentials(make_client):
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, content=b"png")

    client = make_client(handler)
    assert client.download_image("https://workspace.matih.ai/img/x?sig=1") == b"png"
    assert seen["auth"] is None


def test_dashboard_render_runs_job_and_downloads(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    step = {"n": 0}

    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/dashboards/d1/image"):
            return json_response({"id": "j1", "kind": "dashboard_image", "state": "queued"}, 202)
        if request.url.path.endswith("/jobs/j1"):
            step["n"] += 1
            state = "running" if step["n"] == 1 else "succeeded"
            result = None if state == "running" else {"image_url": "https://workspace.matih.ai/img/d1", "width": 10, "height": 10}
            return json_response({"id": "j1", "kind": "dashboard_image", "state": state, "result": result})
        return httpx.Response(200, content=b"PNGDATA")

    client = make_client(handler)
    assert client.dashboards.render("d1") == b"PNGDATA"


def test_webhooks_create_returns_secret(make_client):
    client = make_client(lambda r: json_response({"id": "wh1", "url": "https://x.example/hook",
                                                  "events": ["job.completed"], "secret": "whsec_abc"}))
    hook = client.webhooks.create("https://x.example/hook", ["job.completed"])
    assert hook.secret == "whsec_abc"
