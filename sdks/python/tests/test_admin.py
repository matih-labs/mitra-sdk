from __future__ import annotations

import httpx
import pytest
from conftest import body_of, json_response

from mitra import CreditsError, SourceTestFailedError


def recorder(payload=None, status=200):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        if status == 204:
            return httpx.Response(204)
        return json_response(payload if payload is not None else {}, status)

    handler.seen = seen
    return handler


def test_members_list_update_remove(make_client):
    h = recorder({"members": []})
    client = make_client(h)
    client.members.list()
    assert h.seen["request"].method == "GET" and h.seen["request"].url.path.endswith("/members")
    client.members.update("m1", "admin")
    req = h.seen["request"]
    assert req.method == "PATCH" and req.url.path.endswith("/members/m1")
    assert body_of(req) == {"role": "admin"}
    client.members.remove("m1")
    assert h.seen["request"].method == "DELETE"


def test_invitation_requires_exactly_one_of_email_or_phone(make_client):
    client = make_client(recorder({"id": "i1"}, 201))
    with pytest.raises(ValueError):
        client.invitations.create("member")
    with pytest.raises(ValueError):
        client.invitations.create("member", email="a@example.com", phone="+911234567890")


def test_invitation_by_email_and_revoke(make_client):
    h = recorder({"id": "i1"}, 201)
    client = make_client(h)
    client.invitations.create("member", email="a@example.com")
    assert body_of(h.seen["request"]) == {"role": "member", "email": "a@example.com"}
    client.invitations.revoke("i1")
    assert h.seen["request"].method == "DELETE"
    assert h.seen["request"].url.path.endswith("/invitations/i1")


def test_source_create_422_raises_with_test_result(make_client):
    payload = {"detail": {"category": "source_test", "message": "could not connect",
                          "test": {"ok": False, "error": "timeout"}}}
    client = make_client(recorder(payload, 422))
    with pytest.raises(SourceTestFailedError) as info:
        client.sources.create({"type": "postgres"})
    assert info.value.status == 422
    assert info.value.test_result["test"]["error"] == "timeout"


def test_source_create_sends_activate_true_by_default(make_client):
    h = recorder({"id": "s1"}, 201)
    client = make_client(h)
    client.sources.create({"type": "postgres"})
    assert body_of(h.seen["request"]) == {"config": {"type": "postgres"}, "activate": True}


def test_source_get_activate_delete(make_client):
    h = recorder({"id": "s1", "readiness": "ready"})
    client = make_client(h)
    assert client.sources.get("s1")["readiness"] == "ready"
    client.sources.activate("s1")
    assert h.seen["request"].url.path.endswith("/sources/s1/activate")
    client.sources.delete("s1")
    assert h.seen["request"].method == "DELETE"


def test_files_upload_with_on_duplicate_and_decision(make_client):
    h = recorder({"id": "f1", "status": "processing"})
    client = make_client(h)
    client.files.upload(b"a,b\n", filename="x.csv", on_duplicate="replace")
    assert b'name="on_duplicate"' in h.seen["request"].content
    assert b"replace" in h.seen["request"].content
    client.files.duplicate("f1", "keep_both")
    assert body_of(h.seen["request"]) == {"decision": "keep_both"}
    client.files.list()
    assert h.seen["request"].url.path.endswith("/files")
    client.files.delete("f1")
    assert h.seen["request"].method == "DELETE"


def test_webhook_test_and_deliveries(make_client):
    h = recorder({"ok": True})
    client = make_client(h)
    client.webhooks.test("wh1")
    assert h.seen["request"].method == "POST"
    assert h.seen["request"].url.path.endswith("/webhooks/wh1/test")
    client.webhooks.deliveries("wh1")
    assert h.seen["request"].url.path.endswith("/webhooks/wh1/deliveries")


def test_ask_audio_returns_heard(make_client):
    h = recorder({"status": "answered", "answer": "ok", "language": "hi-IN",
                  "heard": {"transcript": "kitni bikri", "language": "hi-IN"}})
    client = make_client(h)
    answer = client.ask_audio(b"OggS", filename="note.ogg", language="hi-IN")
    assert answer.heard.transcript == "kitni bikri"
    assert b'name="language"' in h.seen["request"].content


def test_402_member_cap_is_credits_error(make_client):
    client = make_client(recorder({"detail": {"category": "member_cap", "message": "full"}}, 402))
    with pytest.raises(CreditsError) as info:
        client.invitations.create("member", email="a@example.com")
    assert info.value.category == "member_cap"
