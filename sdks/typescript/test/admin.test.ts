import { describe, expect, it } from "vitest";
import { MitraError, SourceTestFailedError } from "../src/index.js";
import { ANSWER, jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const empty = (status = 204) => () => new Response(null, { status });

describe("members", () => {
  it("lists, updates and removes", async () => {
    const m = sequence(
      jsonResponse({ members: [{ id: "u1", role: "admin" }] }),
      jsonResponse({ id: "u1", role: "member" }),
      empty(),
    );
    const c = makeClient(m.fetch);
    const list = await c.members.list();
    expect(list.members[0]?.role).toBe("admin");
    const updated = await c.members.update("u1", { role: "member" });
    expect(updated.role).toBe("member");
    await c.members.remove("u1");

    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/members`,
      `PATCH ${BASE}/members/u1`,
      `DELETE ${BASE}/members/u1`,
    ]);
    expect(JSON.parse(String(m.calls[1].body))).toEqual({ role: "member" });
  });

  it("does not retry a PATCH after a 500", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 500));
    await expect(makeClient(m.fetch).members.update("u1", { role: "admin" })).rejects.toBeInstanceOf(MitraError);
    expect(m.calls).toHaveLength(1);
  });
});

describe("invitations", () => {
  it("creates by email and by phone", async () => {
    const m = sequence(jsonResponse({ id: "inv_1", role: "member" }, 201));
    const c = makeClient(m.fetch);
    await c.invitations.create({ email: "a@example.test", role: "member" });
    await c.invitations.create({ phone: "+910000000000", role: "admin" });
    expect(m.calls[0].url).toBe(`${BASE}/invitations`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ email: "a@example.test", role: "member" });
    expect(JSON.parse(String(m.calls[1].body))).toEqual({ phone: "+910000000000", role: "admin" });
  });

  it("requires an email or a phone", async () => {
    const m = sequence(jsonResponse({}));
    await expect(makeClient(m.fetch).invitations.create({ role: "member" })).rejects.toBeInstanceOf(TypeError);
    expect(m.calls).toHaveLength(0);
  });

  it("lists and revokes", async () => {
    const m = sequence(jsonResponse({ invitations: [] }), empty());
    const c = makeClient(m.fetch);
    await c.invitations.list();
    await c.invitations.revoke("inv_1");
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/invitations`,
      `DELETE ${BASE}/invitations/inv_1`,
    ]);
  });
});

describe("sources", () => {
  const source = { id: "src_1", name: "Sales", type: "postgres", status: "ready", active: true };

  it("gets, activates and deletes", async () => {
    const m = sequence(jsonResponse({ ...source, readiness: { state: "ready" } }), jsonResponse(source), empty());
    const c = makeClient(m.fetch);
    const detail = await c.sources.get("src_1");
    expect(detail.readiness).toEqual({ state: "ready" });
    await c.sources.activate("src_1");
    await c.sources.delete("src_1");
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/sources/src_1`,
      `POST ${BASE}/sources/src_1/activate`,
      `DELETE ${BASE}/sources/src_1`,
    ]);
  });

  it("creates with activate defaulting to true", async () => {
    const m = sequence(jsonResponse(source, 201));
    const out = await makeClient(m.fetch).sources.create({ config: { type: "postgres" } });
    expect(out.id).toBe("src_1");
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ config: { type: "postgres" }, activate: true });
  });

  it("can create without activating", async () => {
    const m = sequence(jsonResponse(source, 201));
    await makeClient(m.fetch).sources.create({ config: { type: "postgres" }, activate: false });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ config: { type: "postgres" }, activate: false });
  });

  it("surfaces a 422 as SourceTestFailedError carrying the test result", async () => {
    const detail = { category: "source_test", message: "Could not connect", code: "connect_failed", steps: [{ name: "dns", ok: false }] };
    const m = sequence(jsonResponse({ detail }, 422, { "x-request-id": "req_9" }));
    const err = await makeClient(m.fetch).sources.create({ config: { type: "postgres" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceTestFailedError);
    expect(err).toBeInstanceOf(MitraError);
    const failed = err as SourceTestFailedError;
    expect(failed.status).toBe(422);
    expect(failed.message).toBe("Could not connect");
    expect(failed.code).toBe("connect_failed");
    expect(failed.requestId).toBe("req_9");
    expect(failed.testResult).toEqual(detail);
    expect(m.calls).toHaveLength(1);
  });

  it("treats a body that is the test result itself as the testResult", async () => {
    const body = { ok: false, message: "bad password" };
    const m = sequence(jsonResponse(body, 422));
    const err = await makeClient(m.fetch).sources.create({ config: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceTestFailedError);
    expect((err as SourceTestFailedError).testResult).toEqual(body);
    expect((err as SourceTestFailedError).message).toBe("bad password");
  });

  it("keeps request validation errors generic", async () => {
    const m = sequence(jsonResponse({ detail: [{ loc: ["body", "config"], msg: "Field required" }] }, 422));
    const err = await makeClient(m.fetch).sources.create({ config: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MitraError);
    expect(err).not.toBeInstanceOf(SourceTestFailedError);
  });

  it("does not map 422 from other calls", async () => {
    const m = sequence(jsonResponse({ detail: { category: "validation", message: "bad" } }, 422));
    const err = await makeClient(m.fetch).sources.test({}).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SourceTestFailedError);
  });
});

describe("files", () => {
  it("uploads with onDuplicate", async () => {
    const m = sequence(jsonResponse({ id: "file_1", status: "processing" }, 201));
    await makeClient(m.fetch).files.upload(new Blob(["a,b"]), { filename: "x.csv", onDuplicate: "replace" });
    const form = m.calls[0].body as FormData;
    expect(form.has("file")).toBe(true);
    expect(form.get("on_duplicate")).toBe("replace");
  });

  it("omits on_duplicate when not given", async () => {
    const m = sequence(jsonResponse({ id: "file_1", status: "processing" }, 201));
    await makeClient(m.fetch).files.upload(new Blob(["a,b"]));
    expect((m.calls[0].body as FormData).has("on_duplicate")).toBe(false);
  });

  it("lists, gets, resolves a duplicate and deletes", async () => {
    const m = sequence(
      jsonResponse({ files: [] }),
      jsonResponse({ id: "file_1", status: "ready", analysis_state: "pending", decision_required: { options: ["replace", "keep"] } }),
      jsonResponse({ id: "file_1", status: "ready" }),
      empty(),
    );
    const c = makeClient(m.fetch);
    await c.files.list();
    const file = await c.files.get("file_1");
    expect(file.decision_required).toEqual({ options: ["replace", "keep"] });
    await c.files.duplicate("file_1", "replace");
    await c.files.delete("file_1");
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/files`,
      `GET ${BASE}/files/file_1`,
      `POST ${BASE}/files/file_1/duplicate`,
      `DELETE ${BASE}/files/file_1`,
    ]);
    expect(JSON.parse(String(m.calls[2].body))).toEqual({ decision: "replace" });
  });
});

describe("webhooks", () => {
  it("sends a test delivery and lists deliveries", async () => {
    const m = sequence(jsonResponse({ delivered: true }), jsonResponse({ deliveries: [{ id: "d1" }] }));
    const c = makeClient(m.fetch);
    await c.webhooks.test("wh_1");
    const out = await c.webhooks.deliveries("wh_1");
    expect(out.deliveries[0]?.id).toBe("d1");
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `POST ${BASE}/webhooks/wh_1/test`,
      `GET ${BASE}/webhooks/wh_1/deliveries`,
    ]);
  });
});

describe("voice answers", () => {
  it("returns the heard transcript", async () => {
    const m = sequence(jsonResponse({ ...ANSWER, heard: { transcript: "kitna revenue hai", language: "hi-IN" } }));
    const answer = await makeClient(m.fetch).askAudio(new Blob(["x"]));
    expect(answer.heard).toEqual({ transcript: "kitna revenue hai", language: "hi-IN" });
  });
});
