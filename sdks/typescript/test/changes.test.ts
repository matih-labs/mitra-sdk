/**
 * changes.update / confirm / choose / cancel / undo / get: the body each sends, that
 * previousConversationId travels only when given, the replies the server really answers with, and the
 * typed error of every non-2xx change reply and conversation refusal. Bodies: change_bodies.ts.
 * Mirrors sdks/python/tests/test_changes.py.
 */
import { describe, expect, it } from "vitest";
import { BusyError, MitraError } from "../src/index.js";
import {
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
  type Answer,
} from "./change_bodies.js";
import { jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const bodyOf = (call: { body: unknown }) => JSON.parse(String(call.body));
const answer = (a: Answer) => jsonResponse(a[1], a[0]);
type Changes = ReturnType<typeof makeClient>["changes"];

const caught = (promise: Promise<unknown>) => promise.catch((e: unknown) => e) as Promise<MitraError>;

describe("changes", () => {
  it("update sends no previous id unless given", async () => {
    const m = sequence(answer(NEEDS_CONFIRM));
    const reply = await makeClient(m.fetch).changes.update({ text: "set Pen to 5", sourceId: "s1" });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/changes`);
    expect(bodyOf(m.calls[0])).toEqual({ text: "set Pen to 5", source_id: "s1" });
    expect([reply.code, reply.conversation_id, reply.pending_id]).toEqual(["NEEDS_CONFIRM", CONV, "pend_1"]);
    expect([reply.expires_in, reply.before, reply.after]).toEqual([600, 100, 120]);
  });

  it("a yes names the reply that asked", async () => {
    const m = sequence(answer(WRITE_OK));
    const reply = await makeClient(m.fetch).changes.confirm("pend_1", { previousConversationId: CONV });
    expect(m.calls[0].url).toBe(`${BASE}/changes/pending/pend_1/confirm`);
    expect(bodyOf(m.calls[0])).toEqual({ previous_conversation_id: CONV });
    expect([reply.code, reply.change_id, reply.conversation_id]).toEqual(["WRITE_OK", "chg_1", CONV_NEXT]);
  });

  it("passes an older id through untouched", async () => {
    const m = sequence(answer(WRITE_OK));
    await makeClient(m.fetch).changes.update({ text: "yes", previousConversationId: "c_old" });
    expect(bodyOf(m.calls[0]).previous_conversation_id).toBe("c_old");
  });

  it("each call sends its contract body", async () => {
    const cases: [(c: Changes) => Promise<unknown>, string, unknown][] = [
      [(c) => c.choose("pend_2", 1, { previousConversationId: CONV }), "/pending/pend_2/choose", { index: 1, previous_conversation_id: CONV }],
      [(c) => c.cancel("pend_1", { previousConversationId: CONV }), "/pending/pend_1/cancel", { previous_conversation_id: CONV }],
      [(c) => c.confirm("pend_2", { choice: 1 }), "/pending/pend_2/confirm", { choice: 1 }],
      [(c) => c.batch({ items: ["a", "b"], previousConversationId: CONV }), "/batch", { items: ["a", "b"], previous_conversation_id: CONV }],
    ];
    for (const [call, path, body] of cases) {
      const m = sequence(answer(WRITE_OK));
      await call(makeClient(m.fetch).changes);
      expect(m.calls[0].url).toBe(`${BASE}/changes${path}`);
      expect(bodyOf(m.calls[0])).toEqual(body);
    }
  });

  it("choose takes the zero-based index of a choice and confirm the one-based number", async () => {
    const m = sequence(answer(NEEDS_DETAIL));
    const client = makeClient(m.fetch);
    const asked = await client.changes.update({ text: "set Orbit Lamp to 5" });
    const second = (asked.choices ?? [])[1];
    await client.changes.choose(asked.pending_id!, second.index as number);
    await client.changes.confirm(asked.pending_id!, { choice: 2 });
    expect(bodyOf(m.calls[1])).toEqual({ index: 1 });
    expect(bodyOf(m.calls[2])).toEqual({ choice: 2 });
  });

  it("undo and get name the change and return the conversation", async () => {
    const m = sequence(answer(UNDONE));
    const client = makeClient(m.fetch);
    expect((await client.changes.undo("chg_1")).conversation_id).toBe(CONV);
    expect([m.calls[0].method, m.calls[0].url]).toEqual(["POST", `${BASE}/changes/chg_1/undo`]);
    expect((await client.changes.get("chg_1")).conversation_id).toBe(CONV);
    expect([m.calls[1].method, m.calls[1].url]).toEqual(["GET", `${BASE}/changes/chg_1`]);
  });

  it("a reply types every field the server says", async () => {
    const reply = await makeClient(sequence(answer(PARTIAL)).fetch).changes.batch({ items: ["a", "b", "c"] });
    expect([reply.code, reply.batch_id, reply.affected, reply.undo_until]).toEqual([
      "PARTIAL", "bat_1", 2, "2026-11-05T10:10:00+00:00",
    ]);
    expect((reply.items ?? []).map((i) => i["code"])).toEqual(["WRITE_OK", "WRITE_OK", "NO_MATCH"]);
    const queued = await makeClient(
      sequence(jsonResponse({ ...WRITE_OK[1], code: "WRITE_QUEUED", queued_for: "shop-pc", retry_after: 30, queue_depth: 2 }, 202)).fetch,
    ).changes.update({ text: "x" });
    expect([queued.queued_for, queued.retry_after, queued.queue_depth]).toEqual(["shop-pc", 30, 2]);
    expect([reply.record, reply.queued_for]).toEqual([undefined, undefined]);
  });

  describe("idempotency: the server dedupes these calls on their key, and a retry returns the original reply", () => {
    const writes: [string, (c: Changes, idempotencyKey?: string) => Promise<unknown>][] = [
      ["update", (c, k) => c.update({ text: "set Pen to 5" }, { idempotencyKey: k })],
      ["batch", (c, k) => c.batch({ items: ["a"] }, { idempotencyKey: k })],
      ["confirm", (c, k) => c.confirm("pend_1", {}, { idempotencyKey: k })],
      ["choose", (c, k) => c.choose("pend_2", 0, {}, { idempotencyKey: k })],
      ["cancel", (c, k) => c.cancel("pend_1", {}, { idempotencyKey: k })],
      ["undo", (c, k) => c.undo("chg_1", { idempotencyKey: k })],
    ];
    it.each(writes)("%s sends its own key unless given one", async (_name, call) => {
      const m = sequence(answer(WRITE_OK));
      const changes = makeClient(m.fetch).changes;
      await call(changes);
      await call(changes);
      await call(changes, "mine-1");
      const [first, second, given] = m.calls.map((c) => c.headers.get("idempotency-key"));
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(first).not.toBe(second);
      expect(given).toBe("mine-1");
    });

    it("a read sends no key", async () => {
      const m = sequence(answer(WRITE_OK));
      await makeClient(m.fetch).changes.get("chg_1");
      expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
    });
  });

  describe("errors: a change the server did not make is a top-level {code, message, ...} body, a refusal is {detail}", () => {
    it("a heavy confirm throws with its pending id and figures", async () => {
      const err = await caught(makeClient(sequence(answer(HEAVY_CONFIRM)).fetch).changes.batch({ items: ["a"] }));
      expect(err).toBeInstanceOf(BusyError);
      expect([err.status, err.code, err.pendingId]).toEqual([409, "HEAVY_CONFIRM", "pend_3"]);
      expect(err.message).toBe(HEAVY_CONFIRM[1]["message"]);
      expect([err.extra["rows"], err.extra["credits"], err.extra["conversation_id"]]).toEqual([40, 80, CONV]);
    });

    const statusReplies: [string, Answer][] = [
      ["ALREADY_UNDONE", ALREADY_UNDONE],
      ["UNDO_EXPIRED", UNDO_EXPIRED],
      ["CONFIRM_EXPIRED", CONFIRM_EXPIRED],
      ["NO_MATCH", NO_MATCH],
      ["NOTHING_TO_UNDO", NOTHING_TO_UNDO],
      ["NOT_A_WRITE", NOT_A_WRITE],
    ];
    it.each(statusReplies)("a %s reply throws with its code and message", async (_name, [status, body]) => {
      const err = await caught(makeClient(sequence(jsonResponse(body, status)).fetch).changes.undo("chg_1"));
      expect(err).toBeInstanceOf(MitraError);
      expect([err.status, err.code, err.message]).toEqual([status, body["code"], body["message"]]);
      expect(err.extra["conversation_id"]).toBe(body["conversation_id"]);
    });

    it("a refused change that names a choice list keeps it on the error", async () => {
      const refused = jsonResponse({ ...NEEDS_DETAIL[1], code: "CONFLICT", message: "That row changed since." }, 409);
      const err = await caught(makeClient(sequence(refused).fetch).changes.choose("pend_2", 0));
      expect(err).toBeInstanceOf(BusyError);
      expect(err.choices.map((c) => (c as { label: string }).label)).toEqual(["Orbit Lamp 40W", "Orbit Lamp 60W"]);
    });

    const refusals: [string, Answer][] = [
      ["conversation_not_found", CONVERSATION_NOT_FOUND],
      ["conversation_expired", CONVERSATION_EXPIRED],
      ["conversation_other_source", CONVERSATION_OTHER_SOURCE],
      ["conversation_too_long", CONVERSATION_TOO_LONG],
    ];
    it.each(refusals)("the %s refusal carries its code and sentence", async (_name, [status, body]) => {
      const detail = body["detail"] as Record<string, string>;
      const err = await caught(
        makeClient(sequence(jsonResponse(body, status)).fetch).changes.confirm("pend_1", { previousConversationId: "c_x" }),
      );
      expect([err.status, err.code, err.category, err.message]).toEqual([status, detail["code"], detail["category"], detail["message"]]);
    });

    it("a reused idempotency key is told by its category", async () => {
      const [status, body] = IDEMPOTENCY_KEY_REUSED;
      const err = await caught(
        makeClient(sequence(jsonResponse(body, status)).fetch).changes.update(
          { text: "set Pen to 5", previousConversationId: "c_x" },
          { idempotencyKey: "k1" },
        ),
      );
      expect([err.status, err.category, err.code]).toEqual([422, "idempotency_key_reused", undefined]);
    });

    it("a cancel reply is not an error", async () => {
      const reply = await makeClient(sequence(answer(CANCELLED)).fetch).changes.cancel("pend_1");
      expect([reply.code, reply.change_id]).toEqual(["CANCELLED", null]);
    });
  });
});
