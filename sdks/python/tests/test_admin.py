from __future__ import annotations

import httpx
import pytest
from conftest import body_of, file_payload, json_response, source

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
        client.invitations.create("user")
    with pytest.raises(ValueError):
        client.invitations.create("user", email="a@example.com", phone="+911234567890")


def test_invitation_role_defaults_to_user(make_client):
    h = recorder({"id": "i1"}, 201)
    make_client(h).invitations.create(email="a@example.com")
    assert body_of(h.seen["request"]) == {"role": "user", "email": "a@example.com"}


def test_invitation_by_phone_whatsapp_only(make_client):
    h = recorder({"id": "i1", "whatsapp_only": True, "join_code": "123456"}, 201)
    out = make_client(h).invitations.create("viewer", phone="+919812345678", whatsapp_only=True)
    assert body_of(h.seen["request"]) == {
        "role": "viewer", "phone": "+919812345678", "whatsapp_only": True}
    assert out.join_code == "123456"


def test_invitation_by_email_and_revoke(make_client):
    h = recorder({"id": "i1"}, 201)
    client = make_client(h)
    client.invitations.create("admin", email="a@example.com")
    assert body_of(h.seen["request"]) == {"role": "admin", "email": "a@example.com"}
    client.invitations.revoke("i1")
    assert h.seen["request"].method == "DELETE"
    assert h.seen["request"].url.path.endswith("/invitations/i1")


def test_source_create_422_raises_with_test_result(make_client):
    payload = {"detail": {"category": "connection", "message": "could not connect",
                          "test": {"ok": False, "message": "could not connect",
                                   "error_category": "timeout", "field": "host"}}}
    client = make_client(recorder(payload, 422))
    with pytest.raises(SourceTestFailedError) as info:
        client.sources.create({"connector_type": "postgres"})
    assert info.value.status == 422
    assert info.value.category == "connection"
    assert info.value.test_result["error_category"] == "timeout"  # detail.test, not the envelope
    assert info.value.test_result["field"] == "host"


def test_source_create_sends_activate_true_by_default(make_client):
    h = recorder({"source": source("ready"), "test": None, "applied": True}, 201)
    client = make_client(h)
    client.sources.create({"connector_type": "postgres"})
    assert body_of(h.seen["request"]) == {"config": {"connector_type": "postgres"}, "activate": True}


def test_source_get_activate_delete(make_client):
    h = recorder(source("ready"))
    client = make_client(h)
    assert client.sources.get("s1").readiness.can_ask is True
    client.sources.activate("s1")
    assert h.seen["request"].url.path.endswith("/sources/s1/activate")
    h2 = recorder({"deleted": True})
    deleted = make_client(h2).sources.delete("s1")
    assert h2.seen["request"].method == "DELETE" and deleted.deleted is True


def test_files_upload_with_on_duplicate_and_decision(make_client):
    h = recorder(file_payload("ready"), 201)
    client = make_client(h)
    client.files.upload(b"a,b\n", filename="x.csv", on_duplicate="keep_both")
    assert b'name="on_duplicate"' in h.seen["request"].content
    assert b"keep_both" in h.seen["request"].content
    client.files.duplicate("f1", "keep_both")
    assert body_of(h.seen["request"]) == {"decision": "keep_both"}
    h2 = recorder({"files": [file_payload("ready")], "total": 1})
    listed = make_client(h2).files.list()
    assert h2.seen["request"].url.path.endswith("/files") and listed.total == 1
    h3 = recorder(file_payload("deleting"))
    gone = make_client(h3).files.delete("f1")
    assert h3.seen["request"].method == "DELETE" and gone.status == "deleting"


def test_webhook_test_and_deliveries(make_client):
    h = recorder({"delivery_id": "whd_1", "delivered": True, "status": 200})
    client = make_client(h)
    assert client.webhooks.test("wh1").delivered is True
    assert h.seen["request"].method == "POST"
    assert h.seen["request"].url.path.endswith("/webhooks/wh1/test")
    h2 = recorder({"deliveries": [{"id": "whd_1", "event_id": "evt_1", "event": "gems.ready",
                                   "attempt": 1, "state": "delivered",
                                   "created_at": "2026-10-31T00:00:00Z"}]})
    out = make_client(h2).webhooks.deliveries("wh1")
    assert h2.seen["request"].url.path.endswith("/webhooks/wh1/deliveries")
    assert out.deliveries[0].state == "delivered"


def test_webhook_delete_is_204_none(make_client):
    h = recorder(status=204)
    assert make_client(h).webhooks.delete("wh1") is None
    assert h.seen["request"].method == "DELETE"


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
        client.invitations.create("user", email="a@example.com")
    assert info.value.category == "member_cap"
