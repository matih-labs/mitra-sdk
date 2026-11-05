"""The bodies the Matih API answers /changes calls with, as the server builds them (mitra
backend/app/public_api/changes.py `shape` / `_batch_shape`, writes/model.py `HTTP_STATUS` for the status of
each code, public_api/conversation.py `_refusal` and public_api/idempotency.py `reused` for the refusals).

Two shapes, and a client must read both:

- A change reply is a top-level `{code, message, ...}` body, on every status (`REPLIES`: status and body).
  Its `code` is one of the server's own (NEEDS_CONFIRM, HEAVY_CONFIRM, WRITE_OK, ALREADY_UNDONE, ...).
- A refusal made before anything ran is the FastAPI envelope `{"detail": {category, message, code?}}`
  (`REFUSALS`). The conversation refusals carry a `code`; `idempotency_key_reused` is the `category`.

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
IDEMPOTENCY_KEY_REUSED = (422, {"detail": {
    "category": "idempotency_key_reused",
    "message": "This Idempotency-Key was already used with a different request; use a new key."}})
