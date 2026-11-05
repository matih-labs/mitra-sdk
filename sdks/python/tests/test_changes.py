"""changes.update / confirm / choose / cancel / undo / get on both clients: the body each sends,
that previous_conversation_id travels only when given, the replies the server really answers with, and
the typed error of every non-2xx change reply and conversation refusal. Bodies: change_bodies.py."""

from __future__ import annotations

import httpx
import pytest
from change_bodies import (
    ALREADY_UNDONE,
    CANCELLED,
    CONFIRM_EXPIRED,
    CONV,
    CONV_NEXT,
    CONVERSATION_EXPIRED,
    CONVERSATION_NOT_FOUND,
    CONVERSATION_OTHER_SOURCE,
    CONVERSATION_TOO_LONG,
    HEAVY_CONFIRM,
    IDEMPOTENCY_KEY_REUSED,
    NEEDS_CONFIRM,
    NEEDS_DETAIL,
    NO_MATCH,
    NOT_A_WRITE,
    NOTHING_TO_UNDO,
    PARTIAL,
    UNDO_EXPIRED,
    UNDONE,
    WRITE_OK,
)
from conftest import body_of, json_response

from mitra import BusyError, ChangeReply, MitraError


def recorder(answer=WRITE_OK):
    """A handler that answers every request with `answer` (a `(status, body)` of change_bodies) and keeps them."""
    status, payload = answer
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return json_response(payload, status)

    handler.seen = seen
    return handler


def test_update_sends_no_previous_id_unless_given(make_client):
    h = recorder(NEEDS_CONFIRM)
    reply = make_client(h).changes.update("set Pen to 5", source_id="s1")
    request = h.seen[0]
    assert (request.method, request.url.path) == ("POST", "/api/v1/changes")
    assert body_of(request) == {"text": "set Pen to 5", "source_id": "s1"}
    assert isinstance(reply, ChangeReply)
    assert (reply.code, reply.conversation_id, reply.pending_id) == ("NEEDS_CONFIRM", CONV, "pend_1")
    assert (reply.expires_in, reply.before, reply.after) == (600, 100, 120)


def test_a_yes_names_the_reply_that_asked(make_client):
    h = recorder(WRITE_OK)
    reply = make_client(h).changes.confirm("pend_1", previous_conversation_id=CONV)
    request = h.seen[0]
    assert request.url.path == "/api/v1/changes/pending/pend_1/confirm"
    assert body_of(request) == {"previous_conversation_id": CONV}
    assert (reply.code, reply.change_id, reply.conversation_id) == ("WRITE_OK", "chg_1", CONV_NEXT)


def test_an_older_id_is_passed_through_untouched(make_client):
    """A previous id can itself have its own previous id: the client sends exactly what it is given."""
    h = recorder()
    make_client(h).changes.update("yes", previous_conversation_id="c_old")
    assert body_of(h.seen[0])["previous_conversation_id"] == "c_old"


@pytest.mark.parametrize(
    ("call", "path", "body"),
    [
        (lambda c: c.choose("pend_2", 1, previous_conversation_id=CONV), "/pending/pend_2/choose",
         {"index": 1, "previous_conversation_id": CONV}),
        (lambda c: c.cancel("pend_1", previous_conversation_id=CONV), "/pending/pend_1/cancel",
         {"previous_conversation_id": CONV}),
        (lambda c: c.confirm("pend_2", choice=1), "/pending/pend_2/confirm", {"choice": 1}),
        (lambda c: c.batch(["a", "b"], previous_conversation_id=CONV), "/batch",
         {"items": ["a", "b"], "previous_conversation_id": CONV}),
    ],
)
def test_each_call_sends_its_contract_body(make_client, call, path, body):
    h = recorder()
    call(make_client(h).changes)
    assert h.seen[0].url.path == "/api/v1/changes" + path
    assert body_of(h.seen[0]) == body


def test_choose_takes_the_zero_based_index_of_a_choice_and_confirm_the_one_based_number(make_client):
    """The server's `choose` index is 0-based (`ge=0`, the `index` of a NEEDS_DETAIL choice); `confirm(choice=)` is 1-based."""
    h = recorder(NEEDS_DETAIL)
    client = make_client(h)
    asked = client.changes.update("set Orbit Lamp to 5")
    second = asked.choices[1]
    client.changes.choose(asked.pending_id, second["index"])
    client.changes.confirm(asked.pending_id, choice=2)
    assert body_of(h.seen[1]) == {"index": 1}
    assert body_of(h.seen[2]) == {"choice": 2}


def test_undo_and_get_name_the_change_and_return_the_conversation(make_client):
    h = recorder(UNDONE)
    client = make_client(h)
    assert client.changes.undo("chg_1").conversation_id == CONV
    assert (h.seen[0].method, h.seen[0].url.path) == ("POST", "/api/v1/changes/chg_1/undo")
    assert client.changes.get("chg_1").conversation_id == CONV
    assert (h.seen[1].method, h.seen[1].url.path) == ("GET", "/api/v1/changes/chg_1")


def test_a_reply_types_every_field_the_server_says(make_client):
    client = make_client(recorder(PARTIAL))
    reply = client.changes.batch(["a", "b", "c"])
    assert (reply.code, reply.batch_id, reply.affected, reply.undo_until) == (
        "PARTIAL", "bat_1", 2, "2026-11-05T10:10:00+00:00")
    assert [i["code"] for i in reply.items] == ["WRITE_OK", "WRITE_OK", "NO_MATCH"]
    queued = make_client(recorder((202, {**WRITE_OK[1], "code": "WRITE_QUEUED", "queued_for": "shop-pc",
                                         "retry_after": 30, "queue_depth": 2}))).changes.update("x")
    assert (queued.queued_for, queued.retry_after, queued.queue_depth) == ("shop-pc", 30, 2)
    assert (reply.record, reply.queued_for) == (None, None)


# ---- idempotency: the server dedupes every call below on its Idempotency-Key; a retry returns the original reply

@pytest.mark.parametrize(
    "call",
    [
        lambda c, **k: c.update("set Pen to 5", **k),
        lambda c, **k: c.batch(["a"], **k),
        lambda c, **k: c.confirm("pend_1", **k),
        lambda c, **k: c.choose("pend_2", 0, **k),
        lambda c, **k: c.cancel("pend_1", **k),
        lambda c, **k: c.undo("chg_1", **k),
    ],
)
def test_every_write_call_sends_its_own_idempotency_key_unless_given_one(make_client, call):
    h = recorder()
    client = make_client(h).changes
    call(client)
    call(client)
    call(client, idempotency_key="mine-1")
    first, second, given = (r.headers["Idempotency-Key"] for r in h.seen)
    assert first and second and first != second
    assert given == "mine-1"


def test_a_read_sends_no_idempotency_key(make_client):
    h = recorder()
    make_client(h).changes.get("chg_1")
    assert "Idempotency-Key" not in h.seen[0].headers


# ---- errors: a change the server did not make is a top-level {code, message, ...} body, a refusal is {detail: {...}}

def test_a_heavy_confirm_raises_with_its_pending_id_and_figures(make_client):
    client = make_client(recorder(HEAVY_CONFIRM))
    with pytest.raises(BusyError) as caught:
        client.changes.batch(["a"] * 40)
    err = caught.value
    assert (err.status, err.code, err.pending_id) == (409, "HEAVY_CONFIRM", "pend_3")
    assert err.message == HEAVY_CONFIRM[1]["message"]
    assert (err.extra["rows"], err.extra["credits"], err.extra["conversation_id"]) == (40, 80, CONV)


@pytest.mark.parametrize(
    "answer",
    [ALREADY_UNDONE, UNDO_EXPIRED, CONFIRM_EXPIRED, NO_MATCH, NOTHING_TO_UNDO, NOT_A_WRITE],
)
def test_a_change_reply_with_a_status_raises_with_its_code_and_message(make_client, answer):
    status, body = answer
    with pytest.raises(MitraError) as caught:
        make_client(recorder(answer)).changes.undo("chg_1")
    err = caught.value
    assert (err.status, err.code, err.message) == (status, body["code"], body["message"])
    assert err.extra["conversation_id"] == body["conversation_id"]


def test_a_refused_change_that_names_a_choice_list_keeps_it_on_the_error(make_client):
    status, body = NEEDS_DETAIL
    refused = (409, {**body, "code": "CONFLICT", "message": "That row changed since."})
    with pytest.raises(BusyError) as caught:
        make_client(recorder(refused)).changes.choose("pend_2", 0)
    assert [c["label"] for c in caught.value.choices] == ["Orbit Lamp 40W", "Orbit Lamp 60W"]


@pytest.mark.parametrize(
    "answer",
    [CONVERSATION_NOT_FOUND, CONVERSATION_EXPIRED, CONVERSATION_OTHER_SOURCE, CONVERSATION_TOO_LONG],
)
def test_the_conversation_refusals_carry_their_code_and_sentence(make_client, answer):
    status, body = answer
    with pytest.raises(MitraError) as caught:
        make_client(recorder(answer)).changes.confirm("pend_1", previous_conversation_id="c_x")
    err = caught.value
    assert (err.status, err.code, err.category) == (status, body["detail"]["code"], body["detail"]["category"])
    assert err.message == body["detail"]["message"]


def test_a_reused_idempotency_key_is_told_by_its_category(make_client):
    with pytest.raises(MitraError) as caught:
        make_client(recorder(IDEMPOTENCY_KEY_REUSED)).changes.update(
            "set Pen to 5", previous_conversation_id="c_x", idempotency_key="k1")
    err = caught.value
    assert (err.status, err.category, err.code) == (422, "idempotency_key_reused", None)


def test_a_cancel_reply_is_not_an_error(make_client):
    reply = make_client(recorder(CANCELLED)).changes.cancel("pend_1")
    assert (reply.code, reply.change_id) == ("CANCELLED", None)


async def test_the_async_client_sends_the_same(make_async_client):
    h = recorder(CANCELLED)
    client = make_async_client(h)
    reply = await client.changes.cancel("pend_1", previous_conversation_id=CONV)
    assert body_of(h.seen[0]) == {"previous_conversation_id": CONV}
    assert reply.conversation_id == CONV_NEXT


async def test_the_async_client_raises_the_same_typed_error(make_async_client):
    client = make_async_client(recorder(HEAVY_CONFIRM))
    with pytest.raises(BusyError) as caught:
        await client.changes.batch(["a"] * 40)
    assert (caught.value.code, caught.value.pending_id) == ("HEAVY_CONFIRM", "pend_3")
