/**
 * changes.update / batch / batchFromFile / confirm / choose / cancel / undo / undoBatch / get / getBatch: the body
 * each sends, that previousConversationId travels only when given, the replies the server really answers with,
 * the retries (a retried call keeps its Idempotency-Key), and the typed error of every non-2xx change reply and
 * refusal. Bodies: change_bodies.ts.
 * Mirrors sdks/python/tests/test_changes.py.
 */
import { describe, expect, it, vi } from "vitest";
import { BusyError, CreditsError, MitraError, PermissionError } from "../src/index.js";
import {
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
  type Answer,
} from "./change_bodies.js";
import { jsonResponse, makeClient, networkError, sequence } from "./helpers.js";

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
      ["undoBatch", (c, k) => c.undoBatch("bat_1", { idempotencyKey: k })],
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
      const changes = makeClient(m.fetch).changes;
      await changes.get("chg_1");
      await changes.getBatch("bat_1");
      expect(m.calls.map((c) => c.headers.get("idempotency-key"))).toEqual([null, null]);
    });

    const keyOf = (call: { headers: Headers }) => call.headers.get("idempotency-key");

    it("a retried change call keeps its key and the next call gets a new one", async () => {
      const m = sequence(jsonResponse({ detail: { category: "rate_limited", message: "slow" } }, 429, { "retry-after": "0" }), answer(WRITE_OK));
      const changes = makeClient(m.fetch).changes;
      await changes.confirm("pend_1", { previousConversationId: CONV });
      await changes.confirm("pend_1", { previousConversationId: CONV });
      const [first, retry, next] = m.calls.map(keyOf);
      expect(m.calls).toHaveLength(3);
      expect(retry).toBe(first);
      expect(next).not.toBe(first);
    });

    const retried: [string, (c: Changes) => Promise<unknown>][] = [
      ["undo", (c) => c.undo("chg_1")],
      ["undoBatch", (c) => c.undoBatch("bat_1")],
      ["cancel", (c) => c.cancel("pend_1")],
      ["update", (c) => c.update({ text: "set Pen to 5" })],
    ];
    it.each(retried)("a %s call that got a 502 is retried with the same key", async (_name, call) => {
      // The server keeps no 5xx reply under a key, so the retry runs again; a replayed refusal cannot happen.
      const m = sequence(answer(SOURCE_UNREACHABLE), answer(UNDONE));
      const reply = await call(makeClient(m.fetch).changes);
      expect((reply as { code: string }).code).toBe("UNDONE");
      expect(m.calls).toHaveLength(2);
      expect(keyOf(m.calls[1])).toBe(keyOf(m.calls[0]));
    });

    it("a change call that lost the connection is retried with the same key", async () => {
      const m = sequence(networkError(), answer(WRITE_OK));
      const reply = await makeClient(m.fetch).changes.update({ text: "set Pen to 5" });
      expect(reply.code).toBe("WRITE_OK");
      expect(keyOf(m.calls[1])).toBe(keyOf(m.calls[0]));
    });

    it("a change call that timed out is retried with the same key", async () => {
      // A client timeout while the server still holds a busy key is safe to retry: the same key gets the first reply.
      const keys: (string | null)[] = [];
      const flaky = ((_url: string, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        if (keys.length > 1) return Promise.resolve(new Response(JSON.stringify(WRITE_OK[1]), { status: 200, headers: { "content-type": "application/json" } }));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as unknown as typeof fetch;
      const reply = await makeClient(flaky).changes.update({ text: "set Pen to 5" }, { timeoutMs: 20 });
      expect(reply.code).toBe("WRITE_OK");
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    /** The attempt timers a call sets, in ms (the client's own backoff sleeps are small). */
    async function attemptTimers(run: (c: Changes) => Promise<unknown>, timeoutMs: number): Promise<number[]> {
      const real = globalThis.setTimeout;
      const delays: number[] = [];
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        if (typeof ms === "number") delays.push(ms);
        return real(fn, ms);
      }) as unknown as typeof setTimeout);
      try {
        await run(makeClient(sequence(answer(WRITE_OK)).fetch, { timeoutMs }).changes);
      } finally {
        spy.mockRestore();
      }
      return delays;
    }

    it("change calls wait longer than the servers 60 second hold on a busy key", async () => {
      // The server waits up to 60 s on a key still running before it answers 409; the read must outlast that.
      expect(await attemptTimers((c) => c.update({ text: "a" }), 10_000)).toContain(75_000);
      expect(await attemptTimers((c) => c.undoBatch("bat_1"), 10_000)).toContain(75_000);
      expect(await attemptTimers((c) => c.get("chg_1"), 10_000)).not.toContain(75_000);
    });

    it("a client timeout longer than the floor is kept", async () => {
      expect(await attemptTimers((c) => c.update({ text: "a" }), 120_000)).toContain(120_000);
    });

    it("a time given for one change call is kept", async () => {
      const delays = await attemptTimers((c) => c.update({ text: "a" }, { timeoutMs: 5_000 }), 10_000);
      expect(delays).toContain(5_000);
      expect(delays).not.toContain(75_000);
    });
  });

  describe("batches: undo and read by batch id, and a batch from a CSV or Excel file", () => {
    it("undoBatch and getBatch name the batch and return its items", async () => {
      const m = sequence(answer(BATCH_UNDONE));
      const changes = makeClient(m.fetch).changes;
      const undone = await changes.undoBatch("bat_1");
      expect([m.calls[0].method, m.calls[0].url]).toEqual(["POST", `${BASE}/changes/batch/bat_1/undo`]);
      expect(bodyOf(m.calls[0])).toEqual({});
      expect([undone.code, undone.batch_id, undone.credits, undone.conversation_id]).toEqual(["UNDONE", "bat_1", 0, CONV]);
      expect((undone.items ?? []).map((i) => i["change_id"])).toEqual(["chg_2", "chg_3"]);
      const got = await changes.getBatch("bat_1");
      expect([m.calls[1].method, m.calls[1].url]).toEqual(["GET", `${BASE}/changes/batch/bat_1`]);
      expect(got.batch_id).toBe("bat_1");
    });

    it("a batch id with a slash stays one path segment", async () => {
      const m = sequence(answer(BATCH_UNDONE));
      await makeClient(m.fetch).changes.undoBatch("a/b");
      expect(m.calls[0].url).toBe(`${BASE}/changes/batch/a%2Fb/undo`);
    });

    it("a batch that does not exist is a not found error", async () => {
      const err = await caught(makeClient(sequence(answer(BATCH_NOT_FOUND)).fetch).changes.getBatch("bat_9"));
      expect([err.status, err.category]).toEqual([404, "not_found"]);
    });

    it("a batch undone twice throws ALREADY_UNDONE", async () => {
      const err = await caught(makeClient(sequence(answer(ALREADY_UNDONE)).fetch).changes.undoBatch("bat_1"));
      expect([err.status, err.code]).toEqual([410, "ALREADY_UNDONE"]);
    });

    const formOf = (call: { body: unknown }) => call.body as FormData;
    const csv = () => new TextEncoder().encode("name,price\nOrbit Lamp,120\n");

    it("batchFromFile uploads the file as multipart with its fields", async () => {
      const m = sequence(answer(PARTIAL));
      const reply = await makeClient(m.fetch).changes.batchFromFile(csv(), {
        filename: "rows.csv", contentType: "text/csv", sourceId: "s1", confirm: true, previousConversationId: CONV,
      });
      expect([m.calls[0].method, m.calls[0].url]).toEqual(["POST", `${BASE}/changes/batch/file`]);
      const form = formOf(m.calls[0]);
      const file = form.get("file") as File;
      expect([file.name, file.type]).toEqual(["rows.csv", "text/csv"]);
      expect(await file.text()).toContain("Orbit Lamp,120");
      expect([form.get("source_id"), form.get("confirm"), form.get("previous_conversation_id")]).toEqual(["s1", "true", CONV]);
      expect([reply.code, reply.batch_id, (reply.items ?? []).length]).toEqual(["PARTIAL", "bat_1", 3]);
    });

    it("batchFromFile sends only the fields it is given", async () => {
      const m = sequence(answer(PARTIAL));
      await makeClient(m.fetch).changes.batchFromFile(csv(), { filename: "rows.csv" });
      const form = formOf(m.calls[0]);
      expect([...form.keys()]).toEqual(["file"]);
    });

    it("batchFromFile sends no idempotency key, even one it is given", async () => {
      // The server takes no Idempotency-Key on this route, so none is sent.
      const m = sequence(answer(PARTIAL));
      await makeClient(m.fetch).changes.batchFromFile(csv(), { filename: "rows.xlsx" }, { idempotencyKey: "mine" });
      expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
    });

    it("batchFromFile is not retried after a 5xx because it has no key", async () => {
      const m = sequence(answer(SOURCE_ERROR), answer(PARTIAL));
      const err = await caught(makeClient(m.fetch).changes.batchFromFile(csv(), { filename: "rows.csv" }));
      expect(err).toBeInstanceOf(MitraError);
      expect(m.calls).toHaveLength(1);
    });

    it("batchFromFile over 25 rows throws a heavy confirm to repeat with confirm", async () => {
      const err = await caught(makeClient(sequence(answer(HEAVY_CONFIRM)).fetch).changes.batchFromFile(csv(), { filename: "rows.csv" }));
      expect(err).toBeInstanceOf(BusyError);
      expect([err.code, err.extra["rows"]]).toEqual(["HEAVY_CONFIRM", 40]);
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

    it("a reused idempotency key carries the same word as code and category", async () => {
      const [status, body] = IDEMPOTENCY_KEY_REUSED;
      const err = await caught(
        makeClient(sequence(jsonResponse(body, status)).fetch).changes.update(
          { text: "set Pen to 5", previousConversationId: "c_x" },
          { idempotencyKey: "k1" },
        ),
      );
      expect([err.status, err.category, err.code]).toEqual([422, "idempotency_key_reused", "idempotency_key_reused"]);
    });

    it("a key still running after the servers wait is a busy error to send again with the same key", async () => {
      const m = sequence(answer(IDEMPOTENCY_KEY_IN_PROGRESS));
      const err = await caught(makeClient(m.fetch).changes.confirm("pend_1", {}, { idempotencyKey: "k1" }));
      expect(err).toBeInstanceOf(BusyError);
      expect([err.status, err.category, err.code]).toEqual([409, "conflict", "idempotency_key_in_progress"]);
      expect(m.calls).toHaveLength(1); // a 409 is never retried inside the call: the caller decides
    });

    const failed: [string, Answer, new (...args: never[]) => MitraError][] = [
      ["NO_CREDITS", NO_CREDITS, CreditsError],
      ["MEMBER_CAP", MEMBER_CAP, CreditsError],
      ["NOT_ALLOWED", NOT_ALLOWED, PermissionError],
      ["WRITES_OFF", WRITES_OFF, PermissionError],
      ["READ_ONLY_SOURCE", READ_ONLY_SOURCE, PermissionError],
      ["KEY_SOURCE_NOT_ALLOWED", KEY_SOURCE_NOT_ALLOWED, PermissionError],
      ["SOURCE_ERROR", SOURCE_ERROR, MitraError],
      ["SOURCE_UNREACHABLE", SOURCE_UNREACHABLE, MitraError],
    ];
    it.each(failed)("a %s reply throws the error of its status with its code", async (_name, [status, body], error) => {
      const m = sequence(jsonResponse(body, status));
      const err = await caught(makeClient(m.fetch, { maxRetries: 0 }).changes.update({ text: "set Pen to 5" }));
      expect(err.constructor).toBe(error);
      expect([err.status, err.code, err.message]).toEqual([status, body["code"], body["message"]]);
    });

    it("a code the SDK has never heard of is kept as it came", async () => {
      const [status, body] = SOMETHING_NEW;
      const err = await caught(makeClient(sequence(jsonResponse(body, status)).fetch).changes.update({ text: "set Pen to 5" }));
      expect(err).toBeInstanceOf(BusyError);
      expect([err.status, err.code, err.message]).toEqual([status, "SOMETHING_NEW", body["message"]]);
      expect(err.extra["conversation_id"]).toBe(CONV_NEXT);
    });

    it("a request with neither text nor item is an invalid request with no code", async () => {
      const err = await caught(makeClient(sequence(answer(INVALID_REQUEST)).fetch).changes.update({}));
      expect([err.status, err.category, err.code, err.message]).toEqual([422, "invalid_request", undefined, "Send `text` or `item`."]);
    });

    const noCategory: [string, Answer][] = [
      ["HEAVY_CONFIRM", HEAVY_CONFIRM],
      ["ALREADY_UNDONE", ALREADY_UNDONE],
      ["NO_CREDITS", NO_CREDITS],
      ["SOURCE_ERROR", SOURCE_ERROR],
    ];
    it.each(noCategory)("a %s change reply has no category, as in the Python SDK", async (_name, [status, body]) => {
      // The server puts a `category` only on a refusal of the door; a change reply is told by its `code`.
      const err = await caught(makeClient(sequence(jsonResponse(body, status)).fetch, { maxRetries: 0 }).changes.undo("chg_1"));
      expect(err.category).toBeUndefined();
      expect(err.code).toBe(body["code"]);
    });

    it("a refusal of the door keeps the category the server sent", async () => {
      const err = await caught(makeClient(sequence(answer(CONVERSATION_EXPIRED)).fetch).changes.undo("chg_1"));
      expect(err.category).toBe("gone");
    });

    it("a cancel reply is not an error", async () => {
      const reply = await makeClient(sequence(answer(CANCELLED)).fetch).changes.cancel("pend_1");
      expect([reply.code, reply.change_id]).toEqual(["CANCELLED", null]);
    });
  });
});
