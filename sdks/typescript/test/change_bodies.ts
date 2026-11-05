/**
 * The bodies the Matih API answers /changes calls with, as the server builds them (mitra
 * backend/app/public_api/changes.py `shape` / `_batch_shape`, writes/model.py `HTTP_STATUS` for the status
 * of each code, public_api/conversation.py `_refusal` and public_api/idempotency.py `reused` for the
 * refusals). Mirrors sdks/python/tests/change_bodies.py: keep the two the same.
 *
 * Two shapes, and a client must read both:
 * - A change reply is a top-level `{code, message, ...}` body, on every status. Its `code` is one of the
 *   server's own (NEEDS_CONFIRM, HEAVY_CONFIRM, WRITE_OK, ALREADY_UNDONE, ...).
 * - A refusal made before anything ran is the FastAPI envelope `{"detail": {category, message, code?}}`.
 *   The conversation refusals carry a `code`; `idempotency_key_reused` is the `category`.
 */
export type Answer = readonly [status: number, body: Record<string, unknown>];

export const CONV = "c0a1b2c3d4e5f60718293a4b5c6d7e8f";
export const CONV_NEXT = "d1b2c3d4e5f60718293a4b5c6d7e8f90";

// Every key `shape()` / `_batch_shape()` puts in a reply; a reply says the rest as null.
const FULL: Record<string, unknown> = {
  change_id: null, code: null, message: null, affected: 0, undo_until: null, choices: [],
  pending_id: null, before: null, after: null, rows: null, credits: null, undoable: null,
  expires_in: null, batch_id: null, items: [], conversation_id: CONV,
};

export const reply = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...FULL, ...fields });

// 2xx replies
export const NEEDS_CONFIRM: Answer = [202, reply({
  code: "NEEDS_CONFIRM", message: "Set the price of Orbit Lamp from 100 to 120? Nothing written.",
  pending_id: "pend_1", expires_in: 600, before: 100, after: 120, conversation_id: CONV,
})];
export const NEEDS_DETAIL: Answer = [202, reply({
  code: "NEEDS_DETAIL", message: "Which one: 1) Orbit Lamp 40W, 2) Orbit Lamp 60W?", pending_id: "pend_2",
  choices: [{ index: 0, label: "Orbit Lamp 40W" }, { index: 1, label: "Orbit Lamp 60W" }], conversation_id: CONV,
})];
export const WRITE_OK: Answer = [200, reply({
  code: "WRITE_OK", message: "Orbit Lamp is now 120.", change_id: "chg_1", batch_id: "chg_1", affected: 1,
  undo_until: "2026-11-05T10:10:00+00:00", before: 100, after: 120, conversation_id: CONV_NEXT,
})];
export const CANCELLED: Answer = [200, reply({
  code: "CANCELLED", message: "Okay, I won't change Orbit Lamp. It stays 100.", conversation_id: CONV_NEXT,
})];
export const UNDONE: Answer = [200, reply({
  code: "UNDONE", message: "Put back: Orbit Lamp is 100 again.", change_id: "chg_1", batch_id: "chg_1", affected: 1,
  conversation_id: CONV,
})];
export const PARTIAL: Answer = [207, reply({
  code: "PARTIAL", message: "2 of 3 saved.", batch_id: "bat_1", affected: 2, undo_until: "2026-11-05T10:10:00+00:00",
  items: [
    { index: 0, code: "WRITE_OK", message: "Done.", change_id: "chg_2" },
    { index: 1, code: "WRITE_OK", message: "Done.", change_id: "chg_3" },
    { index: 2, code: "NO_MATCH", message: "No item called Zorvik.", change_id: null },
  ],
  conversation_id: CONV_NEXT,
})];

// Change replies the server refuses with a status (top-level body, the status of `HTTP_STATUS[code]`)
export const HEAVY_CONFIRM: Answer = [409, reply({
  code: "HEAVY_CONFIRM", message: "This changes 40 rows and costs 80 credits. Say yes to go ahead.",
  pending_id: "pend_3", rows: 40, credits: 80, undoable: true, expires_in: 600, conversation_id: CONV,
})];
export const ALREADY_UNDONE: Answer = [410, reply({
  code: "ALREADY_UNDONE", message: "That change was already undone.", conversation_id: CONV,
})];
export const UNDO_EXPIRED: Answer = [410, reply({
  code: "UNDO_EXPIRED", message: "The 10 minutes to undo that change are over.", change_id: "chg_1", conversation_id: CONV,
})];
export const CONFIRM_EXPIRED: Answer = [410, reply({
  code: "CONFIRM_EXPIRED", message: "Nothing is waiting for a yes.", conversation_id: CONV_NEXT,
})];
export const NO_MATCH: Answer = [404, reply({
  code: "NO_MATCH", message: "I found no item called Zorvik.", conversation_id: CONV_NEXT,
})];
export const NOT_FOUND: Answer = [404, reply({
  code: "NOT_FOUND", message: "There is nothing recent to undo.", conversation_id: null,
})];
export const NOTHING_TO_UNDO: Answer = [409, reply({
  code: "NOTHING_TO_UNDO", message: "That change was never made, so there is nothing to put back.",
})];
export const NOT_A_WRITE: Answer = [422, reply({
  code: "NOT_A_WRITE", message: "That was a question, not a change. Your data is as it was.", conversation_id: CONV_NEXT,
})];

// Refusals made before anything ran (the `detail` envelope)
const refusal = (status: number, category: string, code: string, message: string): Answer => [
  status, { detail: { category, message, code } },
];

export const CONVERSATION_NOT_FOUND = refusal(
  404, "not_found", "conversation_not_found",
  "That earlier request is not one of yours, or no longer exists, so nothing was changed. " +
    "Leave previous_conversation_id out to start fresh.",
);
export const CONVERSATION_EXPIRED = refusal(
  410, "gone", "conversation_expired",
  "That earlier request is too old to continue from (it can be continued for 10 minutes), so nothing was " +
    "changed. Leave previous_conversation_id out to start fresh.",
);
export const CONVERSATION_OTHER_SOURCE = refusal(
  409, "conflict", "conversation_other_source",
  "That earlier request was on another data source, so nothing was changed. Name the same source, or leave " +
    "previous_conversation_id out to start fresh.",
);
export const CONVERSATION_TOO_LONG = refusal(
  422, "invalid_request", "conversation_too_long",
  "That conversation has gone on for too many requests to continue from, so nothing was changed. " +
    "Start a new one: leave previous_conversation_id out.",
);
export const IDEMPOTENCY_KEY_REUSED: Answer = [
  422,
  {
    detail: {
      category: "idempotency_key_reused",
      message: "This Idempotency-Key was already used with a different request; use a new key.",
    },
  },
];
