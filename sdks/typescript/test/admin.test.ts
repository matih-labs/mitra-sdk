import { describe, expect, it } from "vitest";
import { MitraError, SourceTestFailedError } from "../src/index.js";
import { ANSWER, fileBody, jsonResponse, makeClient, sequence, sourceBody, sourceCreatedBody } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const empty = (status = 204) => () => new Response(null, { status });

describe("members", () => {
  it("lists, updates and removes", async () => {
    const m = sequence(
      jsonResponse({ members: [{ id: "u1", role: "admin" }] }),
      jsonResponse({ id: "u1", role: "user" }),
      jsonResponse({ removed: "u1" }),
    );
    const c = makeClient(m.fetch);
    const list = await c.members.list();
    expect(list.members[0]?.role).toBe("admin");
    const updated = await c.members.update("u1", { role: "user" });
    expect(updated.role).toBe("user");
    expect(await c.members.remove("u1")).toEqual({ removed: "u1" });

    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/members`,
      `PATCH ${BASE}/members/u1`,
      `DELETE ${BASE}/members/u1`,
    ]);
    expect(JSON.parse(String(m.calls[1].body))).toEqual({ role: "user" });
  });

  it("does not retry a PATCH after a 500", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 500));
    await expect(makeClient(m.fetch).members.update("u1", { role: "admin" })).rejects.toBeInstanceOf(MitraError);
    expect(m.calls).toHaveLength(1);
  });
});

describe("invitations", () => {
  it("creates by email and by phone; the role defaults to user", async () => {
    const m = sequence(jsonResponse({ id: "inv_1", role: "user" }, 201));
    const c = makeClient(m.fetch);
    await c.invitations.create({ email: "a@example.test" });
    await c.invitations.create({ phone: "+910000000000", role: "admin", whatsappOnly: true });
    expect(m.calls[0].url).toBe(`${BASE}/invitations`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ email: "a@example.test", role: "user" });
    expect(JSON.parse(String(m.calls[1].body))).toEqual({
      phone: "+910000000000",
      role: "admin",
      whatsapp_only: true,
    });
  });

  it("requires an email or a phone", async () => {
    const m = sequence(jsonResponse({}));
    await expect(makeClient(m.fetch).invitations.create({ role: "user" })).rejects.toBeInstanceOf(TypeError);
    expect(m.calls).toHaveLength(0);
  });

  it("lists and revokes", async () => {
    const m = sequence(jsonResponse({ invitations: [] }), jsonResponse({ revoked: "inv_1" }));
    const c = makeClient(m.fetch);
    await c.invitations.list();
    expect(await c.invitations.revoke("inv_1")).toEqual({ revoked: "inv_1" });
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/invitations`,
      `DELETE ${BASE}/invitations/inv_1`,
    ]);
  });
});

describe("sources", () => {
  it("gets, activates and deletes", async () => {
    const m = sequence(jsonResponse(sourceBody("ready")), jsonResponse(sourceBody("ready")), jsonResponse({ deleted: true }));
    const c = makeClient(m.fetch);
    const detail = await c.sources.get("s1");
    expect(detail.readiness?.can_ask).toBe(true);
    await c.sources.activate("s1");
    expect(await c.sources.delete("s1")).toEqual({ deleted: true });
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/sources/s1`,
      `POST ${BASE}/sources/s1/activate`,
      `DELETE ${BASE}/sources/s1`,
    ]);
  });

  it("tests a config without saving it", async () => {
    const m = sequence(jsonResponse({ ok: true, connector_type: "postgres", duration_ms: 9, message: "ok" }));
    const out = await makeClient(m.fetch).sources.test({ connector_type: "postgres", host: "db" });
    expect(out.ok).toBe(true);
    expect(m.calls[0].url).toBe(`${BASE}/sources/test`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ config: { connector_type: "postgres", host: "db" } });
  });

  it("creates with activate defaulting to true", async () => {
    const m = sequence(jsonResponse(sourceCreatedBody("ready"), 201));
    const out = await makeClient(m.fetch).sources.create({ config: { connector_type: "postgres" } });
    expect(out.source?.id).toBe("s1");
    expect(out.applied).toBe(true);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ config: { connector_type: "postgres" }, activate: true });
  });

  it("can create without activating", async () => {
    const m = sequence(jsonResponse(sourceCreatedBody("ready"), 201));
    await makeClient(m.fetch).sources.create({ config: { connector_type: "postgres" }, activate: false });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ config: { connector_type: "postgres" }, activate: false });
  });

  it("surfaces a 422 as SourceTestFailedError carrying detail.test", async () => {
    const test = { ok: false, message: "could not connect", error_category: "timeout", field: "host" };
    const detail = { category: "connection", message: "could not connect", test };
    const m = sequence(jsonResponse({ detail }, 422, { "x-request-id": "req_9" }));
    const err = await makeClient(m.fetch).sources.create({ config: { connector_type: "postgres" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceTestFailedError);
    expect(err).toBeInstanceOf(MitraError);
    const failed = err as SourceTestFailedError;
    expect(failed.status).toBe(422);
    expect(failed.category).toBe("connection");
    expect(failed.message).toBe("could not connect");
    expect(failed.requestId).toBe("req_9");
    // The test outcome is `detail.test`, not the whole envelope.
    expect(failed.testResult).toEqual(test);
    expect(m.calls).toHaveLength(1);
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

describe("connectors", () => {
  it("lists what can be connected", async () => {
    const m = sequence(jsonResponse({ connectors: [{ type: "postgres", label: "PostgreSQL", fields: [{ name: "host", required: true }] }] }));
    const out = await makeClient(m.fetch).connectors.list();
    expect(m.calls[0].url).toBe(`${BASE}/connectors`);
    expect(out.connectors[0]?.fields?.[0]?.name).toBe("host");
  });
});

describe("files", () => {
  it("uploads with onDuplicate", async () => {
    const m = sequence(jsonResponse(fileBody("ready"), 201));
    await makeClient(m.fetch).files.upload(new Blob(["a,b"]), { filename: "x.csv", onDuplicate: "keep_both" });
    const form = m.calls[0].body as FormData;
    expect(form.has("file")).toBe(true);
    expect(form.get("on_duplicate")).toBe("keep_both");
  });

  it("omits on_duplicate when not given", async () => {
    const m = sequence(jsonResponse(fileBody("ready"), 201));
    await makeClient(m.fetch).files.upload(new Blob(["a,b"]));
    expect((m.calls[0].body as FormData).has("on_duplicate")).toBe(false);
  });

  it("lists, gets, resolves a duplicate and deletes", async () => {
    const waiting = fileBody("needs_attention", { decision_required: "duplicate", decision_options: ["use_existing", "keep_both", "cancel"] });
    const m = sequence(
      jsonResponse({ files: [], total: 0 }),
      jsonResponse(waiting),
      jsonResponse(fileBody("ready")),
      jsonResponse(fileBody("deleting")),
    );
    const c = makeClient(m.fetch);
    await c.files.list();
    const file = await c.files.get("f1");
    expect(file.decision_required).toBe("duplicate");
    await c.files.duplicate("f1", "use_existing");
    const deleted = await c.files.delete("f1");
    expect(deleted.status).toBe("deleting");
    expect(m.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/files`,
      `GET ${BASE}/files/f1`,
      `POST ${BASE}/files/f1/duplicate`,
      `DELETE ${BASE}/files/f1`,
    ]);
    expect(JSON.parse(String(m.calls[2].body))).toEqual({ decision: "use_existing" });
  });
});

describe("webhooks", () => {
  it("sends a test delivery and lists deliveries", async () => {
    const m = sequence(jsonResponse({ delivery_id: "d1", delivered: true, status: 200 }), jsonResponse({ deliveries: [{ id: "d1" }] }));
    const c = makeClient(m.fetch);
    const sent = await c.webhooks.test("wh_1");
    expect(sent.delivered).toBe(true);
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
