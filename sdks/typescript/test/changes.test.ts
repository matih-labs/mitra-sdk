/**
 * changes.update / confirm / choose / cancel / undo / get: the body each sends, that
 * previousConversationId travels only when given, and the conversation refusals.
 * Mirrors sdks/python/tests/test_changes.py.
 */
import { describe, expect, it } from "vitest";
import { MitraError } from "../src/index.js";
import { jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const ASKED = { code: "needs_confirmation", message: "Set Pen to 5?", conversation_id: "cv_1", pending_id: "p_1" };
const DONE = { code: "written", message: "Done.", conversation_id: "cv_2", change_id: "ch_1", undoable: true };
const bodyOf = (call: { body: unknown }) => JSON.parse(String(call.body));

describe("changes", () => {
  it("update sends no previous id unless given, and keys the request", async () => {
    const m = sequence(jsonResponse(ASKED));
    const reply = await makeClient(m.fetch).changes.update({ text: "set Pen to 5", sourceId: "s1" });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/changes`);
    expect(bodyOf(m.calls[0])).toEqual({ text: "set Pen to 5", source_id: "s1" });
    expect(m.calls[0].headers.get("idempotency-key")).toBeTruthy();
    expect([reply.conversation_id, reply.pending_id]).toEqual(["cv_1", "p_1"]);
  });

  it("a yes names the reply that asked", async () => {
    const m = sequence(jsonResponse(DONE));
    const reply = await makeClient(m.fetch).changes.confirm("p_1", { previousConversationId: "cv_1" });
    expect(m.calls[0].url).toBe(`${BASE}/changes/pending/p_1/confirm`);
    expect(bodyOf(m.calls[0])).toEqual({ previous_conversation_id: "cv_1" });
    expect(reply.change_id).toBe("ch_1");
  });

  it("passes an older id through untouched", async () => {
    const m = sequence(jsonResponse(DONE));
    await makeClient(m.fetch).changes.update({ text: "yes", previousConversationId: "cv_old" });
    expect(bodyOf(m.calls[0]).previous_conversation_id).toBe("cv_old");
  });

  it("each call sends its contract body", async () => {
    const cases: [(c: ReturnType<typeof makeClient>["changes"]) => Promise<unknown>, string, unknown][] = [
      [(c) => c.choose("p_1", 2, { previousConversationId: "cv_1" }), "/pending/p_1/choose", { index: 2, previous_conversation_id: "cv_1" }],
      [(c) => c.cancel("p_1", { previousConversationId: "cv_1" }), "/pending/p_1/cancel", { previous_conversation_id: "cv_1" }],
      [(c) => c.confirm("p_1", { choice: 1 }), "/pending/p_1/confirm", { choice: 1 }],
      [(c) => c.batch({ items: ["a", "b"], previousConversationId: "cv_1" }), "/batch", { items: ["a", "b"], previous_conversation_id: "cv_1" }],
    ];
    for (const [call, path, body] of cases) {
      const m = sequence(jsonResponse(DONE));
      await call(makeClient(m.fetch).changes);
      expect(m.calls[0].url).toBe(`${BASE}/changes${path}`);
      expect(bodyOf(m.calls[0])).toEqual(body);
    }
  });

  it("undo and get name the change and return the conversation", async () => {
    const m = sequence(jsonResponse(DONE));
    const client = makeClient(m.fetch);
    expect((await client.changes.undo("ch_1")).conversation_id).toBe("cv_2");
    expect([m.calls[0].method, m.calls[0].url]).toEqual(["POST", `${BASE}/changes/ch_1/undo`]);
    expect((await client.changes.get("ch_1")).conversation_id).toBe("cv_2");
    expect([m.calls[1].method, m.calls[1].url]).toEqual(["GET", `${BASE}/changes/ch_1`]);
  });

  it.each([
    [404, "conversation_not_found"],
    [410, "conversation_expired"],
    [409, "conversation_other_source"],
    [422, "conversation_too_long"],
    [409, "previous_conversation_id_required"],
  ])("the %i refusal carries its code %s", async (status, code) => {
    const m = sequence(jsonResponse({ detail: { category: "validation", message: "no", code } }, status));
    const error = await makeClient(m.fetch)
      .changes.confirm("p_1", { previousConversationId: "cv_x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MitraError);
    expect((error as MitraError).code).toBe(code);
  });
});
