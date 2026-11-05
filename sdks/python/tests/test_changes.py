"""changes.update / confirm / choose / cancel / undo / get on both clients: the body each sends,
that previous_conversation_id travels only when given, and the conversation refusals."""

from __future__ import annotations

import httpx
import pytest
from conftest import body_of, json_response

from mitra import ChangeReply, MitraError

ASKED = {"code": "needs_confirmation", "message": "Set Pen to 5?", "conversation_id": "cv_1", "pending_id": "p_1"}
DONE = {"code": "written", "message": "Done.", "conversation_id": "cv_2", "change_id": "ch_1", "undoable": True}


def recorder(payload=None, status=200):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return json_response(payload if payload is not None else DONE, status)

    handler.seen = seen
    return handler


def test_update_sends_no_previous_id_unless_given(make_client):
    h = recorder(ASKED)
    reply = make_client(h).changes.update("set Pen to 5", source_id="s1")
    request = h.seen[0]
    assert (request.method, request.url.path) == ("POST", "/api/v1/changes")
    assert body_of(request) == {"text": "set Pen to 5", "source_id": "s1"}
    assert request.headers["Idempotency-Key"]
    assert isinstance(reply, ChangeReply)
    assert (reply.conversation_id, reply.pending_id) == ("cv_1", "p_1")


def test_a_yes_names_the_reply_that_asked(make_client):
    h = recorder()
    reply = make_client(h).changes.confirm("p_1", previous_conversation_id="cv_1")
    request = h.seen[0]
    assert request.url.path == "/api/v1/changes/pending/p_1/confirm"
    assert body_of(request) == {"previous_conversation_id": "cv_1"}
    assert reply.change_id == "ch_1"


def test_an_older_id_is_passed_through_untouched(make_client):
    """A previous id can itself have its own previous id: the client sends exactly what it is given."""
    h = recorder()
    make_client(h).changes.update("yes", previous_conversation_id="cv_old")
    assert body_of(h.seen[0])["previous_conversation_id"] == "cv_old"


@pytest.mark.parametrize(
    ("call", "path", "body"),
    [
        (lambda c: c.choose("p_1", 2, previous_conversation_id="cv_1"), "/pending/p_1/choose",
         {"index": 2, "previous_conversation_id": "cv_1"}),
        (lambda c: c.cancel("p_1", previous_conversation_id="cv_1"), "/pending/p_1/cancel",
         {"previous_conversation_id": "cv_1"}),
        (lambda c: c.confirm("p_1", choice=1), "/pending/p_1/confirm", {"choice": 1}),
        (lambda c: c.batch(["a", "b"], previous_conversation_id="cv_1"), "/batch",
         {"items": ["a", "b"], "previous_conversation_id": "cv_1"}),
    ],
)
def test_each_call_sends_its_contract_body(make_client, call, path, body):
    h = recorder()
    call(make_client(h).changes)
    assert h.seen[0].url.path == "/api/v1/changes" + path
    assert body_of(h.seen[0]) == body


def test_undo_and_get_name_the_change_and_return_the_conversation(make_client):
    h = recorder(DONE)
    client = make_client(h)
    assert client.changes.undo("ch_1").conversation_id == "cv_2"
    assert (h.seen[0].method, h.seen[0].url.path) == ("POST", "/api/v1/changes/ch_1/undo")
    assert client.changes.get("ch_1").conversation_id == "cv_2"
    assert (h.seen[1].method, h.seen[1].url.path) == ("GET", "/api/v1/changes/ch_1")


@pytest.mark.parametrize(
    ("status", "code"),
    [(404, "conversation_not_found"), (410, "conversation_expired"), (409, "conversation_other_source"),
     (422, "conversation_too_long"), (409, "previous_conversation_id_required")],
)
def test_the_conversation_refusals_carry_their_code(make_client, status, code):
    h = recorder({"detail": {"category": "validation", "message": "no", "code": code}}, status)
    with pytest.raises(MitraError) as caught:
        make_client(h).changes.confirm("p_1", previous_conversation_id="cv_x")
    assert caught.value.code == code


async def test_the_async_client_sends_the_same(make_async_client):
    h = recorder()
    client = make_async_client(h)
    reply = await client.changes.cancel("p_1", previous_conversation_id="cv_1")
    assert body_of(h.seen[0]) == {"previous_conversation_id": "cv_1"}
    assert reply.conversation_id == "cv_2"
