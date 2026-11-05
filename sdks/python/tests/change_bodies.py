"""The bodies the Matih API answers /changes calls with, as the server builds them (mitra
backend/app/public_api/changes.py `shape` / `_batch_shape`, writes/model.py `HTTP_STATUS` for the status of
each code, public_api/conversation.py `_refusal` and public_api/idempotency.py `reused` for the refusals).

Two shapes, and a client must read both:

- A change reply is a top-level `{code, message, ...}` body, on every status (`REPLIES`: status and body).
  Its `code` is one of the server's own (NEEDS_CONFIRM, HEAVY_CONFIRM, WRITE_OK, ALREADY_UNDONE, ...).
- A refusal made before anything ran is the FastAPI envelope `{"detail": {category, message, code?}}`
  (`REFUSALS`). Every one carries a `code` beside its `category`; `idempotency_key_reused` has both, and the same
  word for each (public_api/idempotency.py `reused`: `http_error(422, "idempotency_key_reused", msg, code="idempotency_key_reused")`).
  A change reply has no `category`.

The typed TypeScript mirror is sdks/typescript/test/change_bodies.ts: keep the two the same."""

from __future__ import annotations

from typing import Any

CONV = "c0a1b2c3d4e5f60718293a4b5c6d7e8f"
CONV_NEXT = "d1b2c3d4e5f60718293a4b5c6d7e8f90"

# Every key `shape()` / `_batch_shape()` puts in a reply; a reply says the rest as null.
_FULL: dict[str, Any] = {
    "change_id": None, "code": None, "message": None, "affected": 0, "undo_until": None, "choices": [],
    "pending_id": None, "before": None, "after": None, "rows": None, "credits": None, "undoable": None,
    "expires_in": None, "batch_id": None, "items": [], "conversation_id": CONV,
}


def reply(**fields: Any) -> dict[str, Any]:
    return {**_FULL, **fields}


# 2xx replies
NEEDS_CONFIRM = (202, reply(
    code="NEEDS_CONFIRM", message="Set the price of Orbit Lamp from 100 to 120? Nothing written.",
    pending_id="pend_1", expires_in=600, before=100, after=120, conversation_id=CONV))
NEEDS_DETAIL = (202, reply(
    code="NEEDS_DETAIL", message="Which one: 1) Orbit Lamp 40W, 2) Orbit Lamp 60W?", pending_id="pend_2",
    choices=[{"index": 0, "label": "Orbit Lamp 40W"}, {"index": 1, "label": "Orbit Lamp 60W"}],
    conversation_id=CONV))
WRITE_OK = (200, reply(
    code="WRITE_OK", message="Orbit Lamp is now 120.", change_id="chg_1", batch_id="chg_1", affected=1,
    undo_until="2026-11-05T10:10:00+00:00", before=100, after=120, conversation_id=CONV_NEXT,
    items=[]))
CANCELLED = (200, reply(
    code="CANCELLED", message="Okay, I won't change Orbit Lamp. It stays 100.", conversation_id=CONV_NEXT))
UNDONE = (200, reply(
    code="UNDONE", message="Put back: Orbit Lamp is 100 again.", change_id="chg_1", batch_id="chg_1",
    affected=1, conversation_id=CONV))
PARTIAL = (207, reply(
    code="PARTIAL", message="2 of 3 saved.", batch_id="bat_1", affected=2, undo_until="2026-11-05T10:10:00+00:00",
    items=[{"index": 0, "code": "WRITE_OK", "message": "Done.", "change_id": "chg_2"},
           {"index": 1, "code": "WRITE_OK", "message": "Done.", "change_id": "chg_3"},
           {"index": 2, "code": "NO_MATCH", "message": "No item called Zorvik.", "change_id": None}],
    conversation_id=CONV_NEXT))

# Change replies the server refuses with a status (top-level body, the status of `HTTP_STATUS[code]`)
HEAVY_CONFIRM = (409, reply(
    code="HEAVY_CONFIRM", message="This changes 40 rows and costs 80 credits. Say yes to go ahead.",
    pending_id="pend_3", rows=40, credits=80, undoable=True, expires_in=600, conversation_id=CONV))
ALREADY_UNDONE = (410, reply(
    code="ALREADY_UNDONE", message="That change was already undone.", conversation_id=CONV))
UNDO_EXPIRED = (410, reply(
    code="UNDO_EXPIRED", message="The 10 minutes to undo that change are over.", change_id="chg_1",
    conversation_id=CONV))
CONFIRM_EXPIRED = (410, reply(
    code="CONFIRM_EXPIRED", message="Nothing is waiting for a yes.", conversation_id=CONV_NEXT))
NO_MATCH = (404, reply(code="NO_MATCH", message="I found no item called Zorvik.", conversation_id=CONV_NEXT))
NOT_FOUND = (404, reply(code="NOT_FOUND", message="There is nothing recent to undo.", conversation_id=None))
NOTHING_TO_UNDO = (409, reply(
    code="NOTHING_TO_UNDO", message="That change was never made, so there is nothing to put back."))
NOT_A_WRITE = (422, reply(
    code="NOT_A_WRITE", message="That was a question, not a change. Your data is as it was.",
    conversation_id=CONV_NEXT))

# Refusals made before anything ran (the `detail` envelope)
def _refusal(status: int, category: str, code: str, message: str) -> tuple[int, dict[str, Any]]:
    return status, {"detail": {"category": category, "message": message, "code": code}}


CONVERSATION_NOT_FOUND = _refusal(
    404, "not_found", "conversation_not_found",
    "That earlier request is not one of yours, or no longer exists, so nothing was changed. "
    "Leave previous_conversation_id out to start fresh.")
CONVERSATION_EXPIRED = _refusal(
    410, "gone", "conversation_expired",
    "That earlier request is too old to continue from (it can be continued for 10 minutes), so nothing was "
    "changed. Leave previous_conversation_id out to start fresh.")
CONVERSATION_OTHER_SOURCE = _refusal(
    409, "conflict", "conversation_other_source",
    "That earlier request was on another data source, so nothing was changed. Name the same source, or leave "
    "previous_conversation_id out to start fresh.")
CONVERSATION_TOO_LONG = _refusal(
    422, "invalid_request", "conversation_too_long",
    "That conversation has gone on for too many requests to continue from, so nothing was changed. "
    "Start a new one: leave previous_conversation_id out.")
IDEMPOTENCY_KEY_REUSED = _refusal(
    422, "idempotency_key_reused", "idempotency_key_reused",
    "This Idempotency-Key was already used with a different request; use a new key.")
IDEMPOTENCY_KEY_IN_PROGRESS = _refusal(
    409, "conflict", "idempotency_key_in_progress",
    "A request with this Idempotency-Key is still being processed.")
# `http_error(422, "invalid_request", "Send `text` or `item`.")` (v1/changes.py create_change): no `code` on this path
INVALID_REQUEST = (422, {"detail": {"category": "invalid_request", "message": "Send `text` or `item`."}})

# More change replies, one per status of writes/model.py HTTP_STATUS that has none above (messages: writes/billing.py,
# writes/service.py NOT_ALLOWED_SAY and the refusals, writes/audit.py UNAVAILABLE, the `reach_refused` sentence)
NO_CREDITS = (402, reply(
    code="NO_CREDITS", credits=80, conversation_id=CONV_NEXT,
    message="This needs 80 credits and you don't have enough. You have no Matih Credits left. Your data, "
            "connections, files and past chats are still available; add credits to run new questions. "
            "Nothing was changed."))
MEMBER_CAP = (402, reply(
    code="MEMBER_CAP", conversation_id=CONV_NEXT,
    message="You've reached the monthly limit an admin of this workspace set for your usage. Ask an admin to "
            "raise it, or wait until it resets at the start of next month (UTC). Nothing was changed."))
NOT_ALLOWED = (403, reply(
    code="NOT_ALLOWED", conversation_id=CONV_NEXT,
    message="You can see here but not change. Who can change things is up to your owner."))
WRITES_OFF = (403, reply(
    code="WRITES_OFF", conversation_id=CONV_NEXT,
    message="Changes are turned off here. An owner or admin can turn them on in Settings."))
READ_ONLY_SOURCE = (403, reply(
    code="READ_ONLY_SOURCE", conversation_id=CONV_NEXT,
    message="I can answer questions about this one, but I can't change what's in it."))
KEY_SOURCE_NOT_ALLOWED = (403, reply(
    code="KEY_SOURCE_NOT_ALLOWED", conversation_id=CONV_NEXT,
    message="This API key can't reach that source, so I can't change anything there. Use a key that can."))
SOURCE_ERROR = (502, reply(
    code="SOURCE_ERROR", conversation_id=CONV_NEXT,
    message="I didn't save that: the change history is down on our side, and I don't change anything without it. "
            "The team has been told."))
SOURCE_UNREACHABLE = (502, reply(
    code="SOURCE_UNREACHABLE", conversation_id=CONV_NEXT,
    message="Orders DB is not taking the connection. Our team sees these connection failures and looks into "
            "them. Your change was not saved."))
# A code this SDK has never heard of: the server may add codes, and an old SDK must still raise with it
SOMETHING_NEW = (409, reply(code="SOMETHING_NEW", message="A newer server says this.", conversation_id=CONV_NEXT))

# Replies about a batch (POST /changes/batch/{id}/undo, GET /changes/batch/{id}): `_batch_shape`, `items` per change
BATCH_UNDONE = (200, reply(
    code="UNDONE", message="Put back: 2 changes.", batch_id="bat_1", affected=2, credits=0,
    items=[{"index": 0, "code": "UNDONE", "message": "Done.", "change_id": "chg_2"},
           {"index": 1, "code": "UNDONE", "message": "Done.", "change_id": "chg_3"}],
    conversation_id=CONV))
BATCH_NOT_FOUND = (404, {"detail": {"category": "not_found", "message": "That batch doesn't exist."}})
