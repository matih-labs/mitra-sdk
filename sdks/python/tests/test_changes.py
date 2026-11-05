"""changes.update / batch / batch_from_file / confirm / choose / cancel / undo / undo_batch / get / get_batch on
both clients: the body each sends, that previous_conversation_id travels only when given, the replies the server
really answers with, the retries (a retried call keeps its Idempotency-Key), and the typed error of every non-2xx
change reply and refusal. Bodies: change_bodies.py."""

from __future__ import annotations

import httpx
import pytest
from change_bodies import (
    ALREADY_UNDONE,
    BATCH_NOT_FOUND,
    BATCH_UNDONE,
    CANCELLED,
    CONFIRM_EXPIRED,
    CONV,
    CONV_NEXT,
    CONVERSATION_EXPIRED,
    CONVERSATION_NOT_FOUND,
    CONVERSATION_OTHER_SOURCE,
    CONVERSATION_TOO_LONG,
    HEAVY_CONFIRM,
    IDEMPOTENCY_KEY_IN_PROGRESS,
    IDEMPOTENCY_KEY_REUSED,
    INVALID_REQUEST,
    KEY_SOURCE_NOT_ALLOWED,
    MEMBER_CAP,
    NEEDS_CONFIRM,
    NEEDS_DETAIL,
    NO_CREDITS,
    NO_MATCH,
    NOT_A_WRITE,
    NOT_ALLOWED,
    NOTHING_TO_UNDO,
    PARTIAL,
    READ_ONLY_SOURCE,
    SOMETHING_NEW,
    SOURCE_ERROR,
    SOURCE_UNREACHABLE,
    UNDO_EXPIRED,
    UNDONE,
    WRITE_OK,
    WRITES_OFF,
)
from conftest import body_of, json_response, seq

from mitra import BusyError, ChangeReply, CreditsError, MitraError, PermissionDeniedError


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
        lambda c, **k: c.undo_batch("bat_1", **k),
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
    client = make_client(h).changes
    client.get("chg_1")
    client.get_batch("bat_1")
    assert all("Idempotency-Key" not in r.headers for r in h.seen)


def test_a_retried_change_call_keeps_its_key_and_the_next_call_gets_a_new_one(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    keys: list[str] = []
    answers = iter([(429, {"detail": {"category": "rate_limited", "message": "slow"}}), WRITE_OK, WRITE_OK])

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        status, body = next(answers)
        return json_response(body, status, {"retry-after": "0"} if status == 429 else None)

    changes = make_client(handler, max_retries=2).changes
    changes.confirm("pend_1", previous_conversation_id=CONV)
    changes.confirm("pend_1", previous_conversation_id=CONV)
    assert len(keys) == 3 and keys[0] == keys[1] and keys[2] != keys[0]


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.undo("chg_1"),
        lambda c: c.undo_batch("bat_1"),
        lambda c: c.cancel("pend_1"),
        lambda c: c.update("set Pen to 5"),
    ],
)
def test_a_change_call_that_got_a_502_is_retried_with_the_same_key(make_client, monkeypatch, call):
    """The server keeps no 5xx reply under a key, so the retry runs again; a replayed refusal cannot happen."""
    monkeypatch.setattr("time.sleep", lambda s: None)
    h = seq(lambda: json_response(SOURCE_UNREACHABLE[1], 502), lambda: json_response(UNDONE[1], 200))
    reply = call(make_client(h, max_retries=2).changes)
    keys = [r.headers["idempotency-key"] for r in h.calls]
    assert reply.code == "UNDONE" and len(keys) == 2 and keys[0] == keys[1]


def test_a_change_call_that_timed_out_is_retried_with_the_same_key(make_client, monkeypatch):
    """A client timeout while the server still holds a busy key is safe to retry: the same key gets the first reply."""
    monkeypatch.setattr("time.sleep", lambda s: None)
    keys: list[str] = []

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return json_response(WRITE_OK[1])

    reply = make_client(handler, max_retries=2).changes.update("set Pen to 5")
    assert reply.code == "WRITE_OK" and len(keys) == 2 and keys[0] == keys[1]


def _read_seconds(request: httpx.Request) -> float:
    return request.extensions["timeout"]["read"]


def test_change_calls_wait_longer_than_the_servers_60_second_hold_on_a_busy_key(make_client):
    """The server waits up to 60 s on a key still running before it answers 409; the read must outlast that."""
    h = recorder()
    client = make_client(h, timeout=10).changes
    client.update("a")
    client.undo_batch("bat_1")
    client.batch_from_file(b"a\n1\n", filename="rows.csv")
    client.get("chg_1")
    assert [_read_seconds(r) for r in h.seen] == [75.0, 75.0, 75.0, 10.0]


def test_a_read_time_given_for_one_change_call_is_kept(make_client):
    h = recorder()
    make_client(h).changes.update("a", request_timeout=5)
    assert _read_seconds(h.seen[0]) == 5


# ---- batches: undo and read by batch id, and a batch from a CSV or Excel file

def test_undo_batch_and_get_batch_name_the_batch_and_return_its_items(make_client):
    h = recorder(BATCH_UNDONE)
    client = make_client(h).changes
    undone = client.undo_batch("bat_1")
    assert (h.seen[0].method, h.seen[0].url.path, h.seen[0].content) == (
        "POST", "/api/v1/changes/batch/bat_1/undo", b"")
    assert (undone.code, undone.batch_id, undone.credits, undone.conversation_id) == ("UNDONE", "bat_1", 0, CONV)
    assert [i["change_id"] for i in undone.items] == ["chg_2", "chg_3"]
    got = client.get_batch("bat_1")
    assert (h.seen[1].method, h.seen[1].url.path) == ("GET", "/api/v1/changes/batch/bat_1")
    assert got.batch_id == "bat_1"


def test_a_batch_id_with_a_slash_stays_one_path_segment(make_client):
    h = recorder(BATCH_UNDONE)
    make_client(h).changes.undo_batch("a/b")
    assert h.seen[0].url.raw_path.decode().split("?")[0] == "/api/v1/changes/batch/a%2Fb/undo"


def test_a_batch_that_does_not_exist_is_a_not_found_error(make_client):
    with pytest.raises(MitraError) as caught:
        make_client(recorder(BATCH_NOT_FOUND)).changes.get_batch("bat_9")
    assert (caught.value.status, caught.value.category) == (404, "not_found")


def test_a_batch_undone_twice_raises_already_undone(make_client):
    with pytest.raises(MitraError) as caught:
        make_client(recorder(ALREADY_UNDONE)).changes.undo_batch("bat_1")
    assert (caught.value.status, caught.value.code) == (410, "ALREADY_UNDONE")


def _form(request: httpx.Request) -> bytes:
    assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
    return request.content


def test_batch_from_file_uploads_the_file_as_multipart_with_its_fields(make_client):
    h = recorder(PARTIAL)
    reply = make_client(h).changes.batch_from_file(
        b"name,price\nOrbit Lamp,120\n", filename="rows.csv", content_type="text/csv",
        source_id="s1", confirm=True, previous_conversation_id=CONV)
    request = h.seen[0]
    assert (request.method, request.url.path) == ("POST", "/api/v1/changes/batch/file")
    form = _form(request)
    assert b'name="file"; filename="rows.csv"' in form and b"Orbit Lamp,120" in form
    assert b'name="source_id"\r\n\r\ns1' in form
    assert b'name="confirm"\r\n\r\ntrue' in form
    assert b'name="previous_conversation_id"\r\n\r\n' + CONV.encode() in form
    assert (reply.code, reply.batch_id, len(reply.items)) == ("PARTIAL", "bat_1", 3)


def test_batch_from_file_sends_only_the_fields_it_is_given(make_client):
    h = recorder(PARTIAL)
    make_client(h).changes.batch_from_file(b"a\n1\n", filename="rows.csv")
    form = _form(h.seen[0])
    assert b'name="file"' in form
    assert all(name not in form for name in (b'name="source_id"', b'name="confirm"', b'name="previous_conversation_id"'))


def test_batch_from_file_reads_a_path_and_sends_no_idempotency_key(make_client, tmp_path):
    """The server takes no Idempotency-Key on this route, so none is sent."""
    path = tmp_path / "rows.xlsx"
    path.write_bytes(b"PK-not-really-excel")
    h = recorder(PARTIAL)
    make_client(h).changes.batch_from_file(path)
    assert b'filename="rows.xlsx"' in _form(h.seen[0])
    assert "Idempotency-Key" not in h.seen[0].headers


def test_batch_from_file_drops_an_idempotency_key_it_is_given(make_client):
    h = recorder(PARTIAL)
    make_client(h).changes.batch_from_file(b"a\n1\n", filename="rows.csv", idempotency_key="mine")
    assert "Idempotency-Key" not in h.seen[0].headers


def test_batch_from_file_is_not_retried_after_a_5xx_because_it_has_no_key(make_client, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    h = seq(lambda: json_response(SOURCE_ERROR[1], 502), lambda: json_response(PARTIAL[1], 207))
    with pytest.raises(MitraError):
        make_client(h, max_retries=2).changes.batch_from_file(b"a\n1\n", filename="rows.csv")
    assert len(h.calls) == 1


def test_batch_from_file_over_25_rows_raises_a_heavy_confirm_to_repeat_with_confirm(make_client):
    with pytest.raises(BusyError) as caught:
        make_client(recorder(HEAVY_CONFIRM)).changes.batch_from_file(b"a\n1\n", filename="rows.csv")
    assert (caught.value.code, caught.value.extra["rows"]) == ("HEAVY_CONFIRM", 40)


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


def test_a_key_reused_on_another_operation_is_refused_with_the_same_word_as_code_and_category(make_client):
    h = seq(lambda: json_response(WRITE_OK[1]), lambda: json_response(IDEMPOTENCY_KEY_REUSED[1], 422))
    client = make_client(h)
    client.changes.update("set Pen to 5", idempotency_key="k1")
    with pytest.raises(MitraError) as caught:
        client.changes.confirm("pend_1", idempotency_key="k1")
    err = caught.value
    assert [c.headers["idempotency-key"] for c in h.calls] == ["k1", "k1"]
    assert (err.status, err.category, err.code) == (422, "idempotency_key_reused", "idempotency_key_reused")


def test_a_key_still_running_after_the_servers_wait_is_a_busy_error_to_send_again_with_the_same_key(make_client):
    h = recorder(IDEMPOTENCY_KEY_IN_PROGRESS)
    with pytest.raises(BusyError) as caught:
        make_client(h).changes.confirm("pend_1", idempotency_key="k1")
    err = caught.value
    assert (err.status, err.category, err.code) == (409, "conflict", "idempotency_key_in_progress")
    assert len(h.seen) == 1  # a 409 is never retried inside the call: the caller decides


@pytest.mark.parametrize(
    ("answer", "error"),
    [
        (NO_CREDITS, CreditsError),
        (MEMBER_CAP, CreditsError),
        (NOT_ALLOWED, PermissionDeniedError),
        (WRITES_OFF, PermissionDeniedError),
        (READ_ONLY_SOURCE, PermissionDeniedError),
        (KEY_SOURCE_NOT_ALLOWED, PermissionDeniedError),
        (SOURCE_ERROR, MitraError),
        (SOURCE_UNREACHABLE, MitraError),
    ],
)
def test_a_refused_or_failed_change_raises_the_error_of_its_status_with_its_code(make_client, answer, error):
    status, body = answer
    with pytest.raises(error) as caught:
        make_client(recorder(answer)).changes.update("set Pen to 5")
    err = caught.value
    assert type(err) is error
    assert (err.status, err.code, err.message) == (status, body["code"], body["message"])


def test_a_code_the_sdk_has_never_heard_of_is_kept_as_it_came(make_client):
    status, body = SOMETHING_NEW
    with pytest.raises(BusyError) as caught:
        make_client(recorder(SOMETHING_NEW)).changes.update("set Pen to 5")
    err = caught.value
    assert (err.status, err.code, err.message) == (status, "SOMETHING_NEW", body["message"])
    assert err.extra["conversation_id"] == CONV_NEXT


def test_a_request_with_neither_text_nor_item_is_an_invalid_request_with_no_code(make_client):
    with pytest.raises(MitraError) as caught:
        make_client(recorder(INVALID_REQUEST)).changes.update()
    err = caught.value
    assert (err.status, err.category, err.code, err.message) == (
        422, "invalid_request", None, "Send `text` or `item`.")


@pytest.mark.parametrize("answer", [HEAVY_CONFIRM, ALREADY_UNDONE, NO_CREDITS, SOURCE_ERROR])
def test_a_change_reply_that_was_not_made_has_no_category(make_client, answer):
    """The server puts a `category` only on a refusal of the door; a change reply is told by its `code`."""
    with pytest.raises(MitraError) as caught:
        make_client(recorder(answer)).changes.undo("chg_1")
    assert caught.value.category is None
    assert caught.value.code == answer[1]["code"]


def test_a_refusal_of_the_door_keeps_the_category_the_server_sent(make_client):
    with pytest.raises(MitraError) as caught:
        make_client(recorder(CONVERSATION_EXPIRED)).changes.undo("chg_1")
    assert caught.value.category == "gone"


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


async def test_the_async_client_undoes_and_reads_a_batch_and_uploads_a_file(make_async_client):
    h = recorder(BATCH_UNDONE)
    client = make_async_client(h).changes
    assert (await client.undo_batch("bat_1")).code == "UNDONE"
    assert (await client.get_batch("bat_1")).batch_id == "bat_1"
    await client.batch_from_file(b"a\n1\n", filename="rows.csv", source_id="s1")
    assert [(r.method, r.url.path) for r in h.seen] == [
        ("POST", "/api/v1/changes/batch/bat_1/undo"),
        ("GET", "/api/v1/changes/batch/bat_1"),
        ("POST", "/api/v1/changes/batch/file"),
    ]
    assert b'name="source_id"' in h.seen[2].content


async def test_the_async_client_waits_longer_than_the_servers_hold_on_a_busy_key(make_async_client):
    h = recorder()
    await make_async_client(h, timeout=10).changes.cancel("pend_1")
    assert _read_seconds(h.seen[0]) == 75.0
