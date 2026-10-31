/**
 * Each SDK call against what the server really takes: method, path, query,
 * body and headers. Mirrors sdks/python/tests/test_contract.py.
 *
 * Source of truth: the /api/v1 routes of the Matih server (OpenAPI at
 * /api/v1/openapi.json).
 */
import { describe, expect, it } from "vitest";
import { CreditsError } from "../src/index.js";
import { ANSWER, jobBody, jsonResponse, makeClient, sequence, textResponse } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const FAST = { pollIntervalMs: 1 };

describe("idempotency keys", () => {
  it("gems.generate sends none: the route takes no Idempotency-Key", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "gems" }), 202));
    await makeClient(m.fetch).gems.generate("s1", { background: true });
    expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
  });

  it("dashboards.image and askAudio send none", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202));
    await makeClient(m.fetch).dashboards.image("d1", { background: true });
    expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
    const audio = sequence(jsonResponse(ANSWER));
    await makeClient(audio.fetch).askAudio(new Blob(["OggS"]), { filename: "note.ogg" });
    expect(audio.calls[0].headers.get("idempotency-key")).toBeNull();
  });

  it("ask and predictions.create do send one", async () => {
    const ask = sequence(jsonResponse(ANSWER));
    await makeClient(ask.fetch).ask("q");
    expect(ask.calls[0].headers.get("idempotency-key")).toBeTruthy();
    const pred = sequence(jsonResponse(jobBody("queued"), 202));
    await makeClient(pred.fetch).predictions.create({ question: "q" }, { background: true });
    expect(pred.calls[0].headers.get("idempotency-key")).toBeTruthy();
  });
});

describe("gems", () => {
  it("generate takes an optional source_id", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "gems" }), 202));
    const c = makeClient(m.fetch);
    await c.gems.generate(undefined, { background: true });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/gems/generate`);
    expect(m.calls[0].body).toBeUndefined();
    await c.gems.generate("s1", { background: true });
    expect(JSON.parse(String(m.calls[1].body))).toEqual({ source_id: "s1" });
    await c.gems.generate({ source_id: "s2" }, { background: true });
    expect(JSON.parse(String(m.calls[2].body))).toEqual({ source_id: "s2" });
  });

  it("get and image pass source_id", async () => {
    const m = sequence(jsonResponse({ id: "g1", headline: "H" }), textResponse("png", 200, { "content-type": "image/png" }));
    const c = makeClient(m.fetch);
    expect((await c.gems.get("g1", "s1")).headline).toBe("H");
    expect(Array.from(await c.gems.image("g1", "s1"))).toEqual([112, 110, 103]);
    expect(m.calls[0].url).toBe(`${BASE}/gems/g1?source_id=s1`);
    expect(m.calls[1].url).toBe(`${BASE}/gems/g1/image.png?source_id=s1`);
  });
});

describe("predictions", () => {
  it("the body carries language and ids", async () => {
    const m = sequence(jsonResponse(jobBody("queued"), 202));
    await makeClient(m.fetch).predictions.create(
      { question: "next quarter?", source_id: "s1", conversation_id: "c1", language: "hi-IN" },
      { background: true },
    );
    expect(JSON.parse(String(m.calls[0].body))).toEqual({
      question: "next quarter?",
      source_id: "s1",
      conversation_id: "c1",
      language: "hi-IN",
    });
  });
});

describe("dashboards", () => {
  it("image width goes in the body", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202));
    await makeClient(m.fetch).dashboards.image("d1", { width: 800, background: true });
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ width: 800 });
  });

  it("imageBytes follows the 303 itself, without credentials", async () => {
    const m = sequence(
      textResponse("", 303, { location: "https://workspace.matih.ai/api/v1/media/t1" }),
      textResponse("PNG", 200, { "content-type": "image/png" }),
    );
    const bytes = await makeClient(m.fetch).dashboards.imageBytes("d1", { width: 800 });
    expect(new TextDecoder().decode(bytes)).toBe("PNG");
    expect(m.calls[0].url).toBe(`${BASE}/dashboards/d1/image.png?width=800`);
    // fetch must not follow the redirect on its own, or it would resend the credential.
    expect(m.calls[0].redirect).toBe("manual");
    expect(m.calls[1].url).toBe("https://workspace.matih.ai/api/v1/media/t1");
    expect(m.calls[1].headers.get("authorization")).toBeNull();
  });

  it("imageBytes waits for the job on a 202", async () => {
    const done = { image_url: "/api/v1/media/t1", width: 1600, height: 900 };
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202, { "retry-after": "3" }),
      jsonResponse(jobBody("succeeded", { kind: "dashboard_image", result: done })),
      textResponse("PNG", 200, { "content-type": "image/png" }),
    );
    const bytes = await makeClient(m.fetch).dashboards.imageBytes("d1", FAST);
    expect(new TextDecoder().decode(bytes)).toBe("PNG");
    expect(m.calls[2].url).toBe("https://workspace.matih.ai/api/v1/media/t1");
    expect(m.calls[2].headers.get("authorization")).toBeNull();
  });
});

describe("workspaces, conversations, errors", () => {
  it("workspaces.use is PUT /me/workspace", async () => {
    const m = sequence(jsonResponse({ current: "w2", name: "Globex" }));
    const out = await makeClient(m.fetch).workspaces.use("w2");
    expect(m.calls[0].method).toBe("PUT");
    expect(m.calls[0].url).toBe(`${BASE}/me/workspace`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ workspace_id: "w2" });
    expect(out.current).toBe("w2");
  });

  it("conversations list and get", async () => {
    const m = sequence(
      jsonResponse({ conversations: [{ id: "c1", title: "Sales", message_count: 2 }] }),
      jsonResponse({ id: "c1", messages: [{ id: "m1", role: "user", text: "hi" }] }),
    );
    const c = makeClient(m.fetch);
    expect((await c.conversations.list()).conversations[0]?.message_count).toBe(2);
    expect((await c.conversations.get("c1")).messages?.[0]?.text).toBe("hi");
  });

  it("402 not_ready is a CreditsError", async () => {
    const m = sequence(jsonResponse({ detail: { category: "not_ready", message: "no credits" } }, 402));
    const err = await makeClient(m.fetch).gems.generate("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditsError);
    expect((err as CreditsError).category).toBe("not_ready");
  });

  it("a per-call workspace header", async () => {
    const m = sequence(jsonResponse({ members: [] }));
    await makeClient(m.fetch).members.list({ workspaceId: "usr_71c0" });
    expect(m.calls[0].headers.get("x-matih-workspace")).toBe("usr_71c0");
  });
});
