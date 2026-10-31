import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, Mitra, MitraError, RateLimitError } from "../src/index.js";
import { ANSWER, fileBody, jobBody, jsonResponse, makeClient, networkError, sequence, textResponse } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("construction", () => {
  it("requires a credential", () => {
    vi.stubEnv("MATIH_API_KEY", "");
    vi.stubEnv("MATIH_ACCESS_TOKEN", "");
    // The old, product-specific names are not read any more.
    vi.stubEnv("MITRA_API_KEY", "mtk_old");
    expect(() => new Mitra({ fetch: sequence(jsonResponse({})).fetch })).toThrow(TypeError);
  });

  it("rejects both apiKey and accessToken", () => {
    expect(() => new Mitra({ apiKey: "mtk_a", accessToken: "mto_b" })).toThrow(TypeError);
  });

  it("reads MATIH_API_KEY from the environment", async () => {
    vi.stubEnv("MATIH_API_KEY", "mtk_env");
    const m = sequence(jsonResponse({ current: null, workspaces: [] }));
    await new Mitra({ fetch: m.fetch }).workspaces.list();
    expect(m.calls[0].headers.get("authorization")).toBe("Bearer mtk_env");
  });

  it("sends an access token as a bearer credential", async () => {
    const m = sequence(jsonResponse({ current: null, workspaces: [] }));
    await new Mitra({ accessToken: "mto_abc", fetch: m.fetch }).workspaces.list();
    expect(m.calls[0].headers.get("authorization")).toBe("Bearer mto_abc");
  });
});

describe("base URL", () => {
  it("defaults to the host and appends /api/v1", async () => {
    vi.stubEnv("MATIH_BASE_URL", "");
    const m = sequence(jsonResponse({ current: null, workspaces: [] }));
    await new Mitra({ apiKey: "mtk_a", fetch: m.fetch }).workspaces.list();
    expect(m.calls[0].url).toBe("https://workspace.matih.ai/api/v1/workspaces");
  });

  it("reads MATIH_BASE_URL as a host only", async () => {
    vi.stubEnv("MATIH_BASE_URL", "https://feat.example.test/");
    const m = sequence(jsonResponse({ current: null, workspaces: [] }));
    await new Mitra({ apiKey: "mtk_a", fetch: m.fetch }).workspaces.list();
    expect(m.calls[0].url).toBe("https://feat.example.test/api/v1/workspaces");
  });

  it("does not double the prefix when the value already ends in /api/v1", async () => {
    const m = sequence(jsonResponse({ sources: [] }));
    await makeClient(m.fetch, { baseUrl: "https://api.example.test/api/v1/" }).sources.list();
    expect(m.calls[0].url).toBe("https://api.example.test/api/v1/sources");
  });
});

describe("headers", () => {
  it("sends auth, workspace and language", async () => {
    const m = sequence(jsonResponse({ current: "ws_1", workspaces: [] }));
    const c = makeClient(m.fetch, { workspaceId: "ws_1", language: "hi-IN" });
    await c.workspaces.list();
    const call = m.calls[0];
    expect(call.url).toBe(`${BASE}/workspaces`);
    expect(call.method).toBe("GET");
    expect(call.headers.get("authorization")).toBe("Bearer mtk_test");
    expect(call.headers.get("x-matih-workspace")).toBe("ws_1");
    expect(call.headers.get("accept-language")).toBe("hi-IN");
  });

  it("lets per-request options override client defaults", async () => {
    const m = sequence(jsonResponse({ current: null, workspaces: [] }));
    const c = makeClient(m.fetch, { workspaceId: "ws_1", language: "hi-IN" });
    await c.workspaces.list({ workspaceId: "ws_2", language: "ta-IN" });
    expect(m.calls[0].headers.get("x-matih-workspace")).toBe("ws_2");
    expect(m.calls[0].headers.get("accept-language")).toBe("ta-IN");
  });

  it("workspaces.use sets the default for later calls", async () => {
    const m = sequence(jsonResponse({ current: "ws_9", name: "Globex" }), jsonResponse({ current: "ws_9", workspaces: [] }));
    const c = makeClient(m.fetch);
    const chosen = await c.workspaces.use("ws_9");
    expect(chosen).toEqual({ current: "ws_9", name: "Globex" });
    expect(m.calls[0].method).toBe("PUT");
    expect(m.calls[0].url).toBe(`${BASE}/me/workspace`);
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ workspace_id: "ws_9" });
    await c.workspaces.list();
    expect(m.calls[1].headers.get("x-matih-workspace")).toBe("ws_9");
  });

  it("honours a custom host with a trailing slash", async () => {
    const m = sequence(jsonResponse({ sources: [] }));
    await makeClient(m.fetch, { baseUrl: "https://api.example.test/" }).sources.list();
    expect(m.calls[0].url).toBe("https://api.example.test/api/v1/sources");
  });
});

describe("ask", () => {
  it("posts the question with an automatic idempotency key", async () => {
    const m = sequence(jsonResponse(ANSWER));
    const answer = await makeClient(m.fetch).ask({ question: "revenue?", source_id: "src_1" });
    expect(answer.answer).toBe("Revenue was 42.");
    const call = m.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/ask`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.body))).toEqual({ question: "revenue?", source_id: "src_1" });
    expect(call.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts a plain string question", async () => {
    const m = sequence(jsonResponse(ANSWER));
    await makeClient(m.fetch).ask("how many orders?");
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ question: "how many orders?" });
  });

  it("uses a caller-supplied idempotency key", async () => {
    const m = sequence(jsonResponse(ANSWER));
    await makeClient(m.fetch).ask("q", { idempotencyKey: "my-key" });
    expect(m.calls[0].headers.get("idempotency-key")).toBe("my-key");
  });

  it("reuses the same key across internal retries", async () => {
    const m = sequence(
      jsonResponse({ detail: { category: "internal", message: "boom" } }, 503),
      networkError(),
      jsonResponse(ANSWER),
    );
    const answer = await makeClient(m.fetch).ask("q");
    expect(answer.conversation_id).toBe("conv_1");
    expect(m.calls).toHaveLength(3);
    const keys = new Set(m.calls.map((c) => c.headers.get("idempotency-key")));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
  });

  it("generates a fresh key for each separate call", async () => {
    const m = sequence(jsonResponse(ANSWER));
    const c = makeClient(m.fetch);
    await c.ask("q");
    await c.ask("q");
    expect(m.calls[0].headers.get("idempotency-key")).not.toBe(m.calls[1].headers.get("idempotency-key"));
  });

  it("sends audio as multipart without a manual content-type", async () => {
    const m = sequence(jsonResponse(ANSWER));
    await makeClient(m.fetch).askAudio(new Blob(["voice"]), { filename: "note.ogg", conversationId: "conv_1", sourceId: "src_1", language: "hi-IN" });
    const call = m.calls[0];
    expect(call.url).toBe(`${BASE}/ask/audio`);
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect(form.has("file")).toBe(true);
    expect(form.get("conversation_id")).toBe("conv_1");
    expect(form.get("source_id")).toBe("src_1");
    expect(form.get("language")).toBe("hi-IN");
    expect(call.headers.get("accept-language")).toBe("hi-IN");
    expect(call.headers.get("content-type")).toBeNull();
    // The server's /ask/audio route takes no Idempotency-Key.
    expect(call.headers.get("idempotency-key")).toBeNull();
  });
});

describe("retries", () => {
  it("retries a GET on 500", async () => {
    const m = sequence(
      jsonResponse({ detail: { category: "internal", message: "boom" } }, 500),
      jsonResponse({ sources: [] }),
    );
    const out = await makeClient(m.fetch).sources.list();
    expect(out.sources).toEqual([]);
    expect(m.calls).toHaveLength(2);
  });

  it("does not retry when maxRetries is 0", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 500));
    await expect(makeClient(m.fetch, { maxRetries: 0 }).sources.list()).rejects.toBeInstanceOf(MitraError);
    expect(m.calls).toHaveLength(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 502));
    await expect(makeClient(m.fetch, { maxRetries: 2 }).sources.list()).rejects.toMatchObject({
      status: 502,
      message: "boom",
    });
    expect(m.calls).toHaveLength(3);
  });

  it("does not retry a 5xx on a POST without an idempotency key", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 500));
    await expect(makeClient(m.fetch).sources.test({ type: "csv" })).rejects.toBeInstanceOf(MitraError);
    expect(m.calls).toHaveLength(1);
  });

  it("retries a network failure on a GET, then succeeds", async () => {
    const m = sequence(networkError(), jsonResponse({ sources: [] }));
    await makeClient(m.fetch).sources.list();
    expect(m.calls).toHaveLength(2);
  });

  it("throws ConnectionError when the network keeps failing", async () => {
    const m = sequence(networkError());
    await expect(makeClient(m.fetch, { maxRetries: 1 }).sources.list()).rejects.toMatchObject({
      name: "ConnectionError",
      category: "network",
    });
    expect(m.calls).toHaveLength(2);
  });

  it("does not retry a network failure on an unkeyed POST", async () => {
    const m = sequence(networkError());
    await expect(makeClient(m.fetch).sources.test({ type: "csv" })).rejects.toBeInstanceOf(ConnectionError);
    expect(m.calls).toHaveLength(1);
  });

  it("retries 429 honouring Retry-After", async () => {
    const m = sequence(
      jsonResponse({ detail: { category: "rate_limited", message: "slow down" } }, 429, { "retry-after": "0" }),
      jsonResponse({ sources: [] }),
    );
    await makeClient(m.fetch).sources.list();
    expect(m.calls).toHaveLength(2);
  });

  it("retries 429 even on an unkeyed POST", async () => {
    const m = sequence(
      jsonResponse({ detail: { category: "rate_limited", message: "slow down" } }, 429, { "retry-after": "0" }),
      jsonResponse({ ok: true }),
    );
    await makeClient(m.fetch).sources.test({ type: "csv" });
    expect(m.calls).toHaveLength(2);
  });

  it("surfaces a very long Retry-After instead of sleeping", async () => {
    const m = sequence(
      jsonResponse({ detail: { category: "rate_limited", message: "slow down" } }, 429, { "retry-after": "120" }),
    );
    const err = await makeClient(m.fetch).sources.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(120);
    expect(m.calls).toHaveLength(1);
  });

  it("does not retry 4xx other than 429", async () => {
    const m = sequence(jsonResponse({ detail: { category: "scope", message: "no" } }, 403));
    await expect(makeClient(m.fetch).sources.list()).rejects.toMatchObject({ status: 403 });
    expect(m.calls).toHaveLength(1);
  });
});

describe("timeouts and aborts", () => {
  const hang = (): typeof fetch =>
    ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

  it("times out an attempt with a ConnectionError", async () => {
    const c = makeClient(hang(), { timeoutMs: 20, maxRetries: 0 });
    await expect(c.sources.list()).rejects.toMatchObject({ name: "ConnectionError", category: "timeout" });
  });

  it("propagates a caller abort without retrying", async () => {
    const controller = new AbortController();
    const c = makeClient(hang(), { timeoutMs: 5000, maxRetries: 3 });
    const pending = c.sources.list({ signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConnectionError);
  });
});

describe("namespaces", () => {
  it("lists gems with a source filter", async () => {
    const m = sequence(jsonResponse({ state: "ready", gems: [], generated_at: null }));
    await makeClient(m.fetch).gems.list({ source_id: "src 1" });
    expect(m.calls[0].url).toBe(`${BASE}/gems?source_id=src+1`);
  });

  it("starts gem generation without an idempotency key", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "gems" }), 202));
    const job = await makeClient(m.fetch).gems.generate("src_1", { background: true });
    expect(job.state).toBe("queued");
    expect(JSON.parse(String(m.calls[0].body))).toEqual({ source_id: "src_1" });
    expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
  });

  it("creates a prediction with an idempotency key and a dashboard image without one", async () => {
    const m = sequence(jsonResponse(jobBody("queued"), 202));
    const c = makeClient(m.fetch);
    await c.predictions.create({ question: "next quarter?" }, { background: true });
    await c.dashboards.image("dash/1", { background: true });
    expect(m.calls[0].url).toBe(`${BASE}/predictions`);
    expect(m.calls[1].url).toBe(`${BASE}/dashboards/dash%2F1/image`);
    expect(m.calls[0].headers.get("idempotency-key")).toBeTruthy();
    expect(m.calls[1].headers.get("idempotency-key")).toBeNull();
  });

  it("does not add an idempotency key to non-credit POSTs", async () => {
    const m = sequence(jsonResponse({ id: "wh_1", url: "https://example.test/h", events: [], secret: "s" }));
    await makeClient(m.fetch).webhooks.create({ url: "https://example.test/h", events: ["job.completed"] });
    expect(m.calls[0].headers.get("idempotency-key")).toBeNull();
  });

  it("deletes a webhook", async () => {
    const m = sequence(() => new Response(null, { status: 204 }));
    await makeClient(m.fetch).webhooks.delete("wh_1");
    expect(m.calls[0].method).toBe("DELETE");
    expect(m.calls[0].url).toBe(`${BASE}/webhooks/wh_1`);
  });

  it("uploads a file as multipart", async () => {
    const m = sequence(jsonResponse(fileBody("ready"), 201));
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b\n1,2"]), {
      filename: "x.csv",
      contentType: "text/csv",
    });
    expect(out.id).toBe("f1");
    expect(m.calls[0].body).toBeInstanceOf(FormData);
    expect((m.calls[0].body as FormData).has("file")).toBe(true);
    expect(m.calls[0].headers.get("content-type")).toBeNull();
  });

  it("reads conversations and connectors", async () => {
    const m = sequence(jsonResponse({ conversations: [] }), jsonResponse({ id: "c1" }), jsonResponse({}));
    const c = makeClient(m.fetch);
    await c.conversations.list();
    await c.conversations.get("c1");
    await c.connectors.list();
    expect(m.calls.map((x) => x.url)).toEqual([`${BASE}/conversations`, `${BASE}/conversations/c1`, `${BASE}/connectors`]);
  });

  it("returns image bytes", async () => {
    const m = sequence(textResponse("abc", 200, { "content-type": "image/png" }));
    const bytes = await makeClient(m.fetch).gems.image("gem_1");
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
    expect(m.calls[0].url).toBe(`${BASE}/gems/gem_1/image.png`);
  });

  it("waits for a render job when the dashboard image is not cached", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202),
      jsonResponse(
        jobBody("succeeded", {
          kind: "dashboard_image",
          result: { image_url: "https://signed.example/img.png?sig=1", width: 10, height: 10 },
        }),
      ),
      textResponse("png", 200, { "content-type": "image/png" }),
    );
    const bytes = await makeClient(m.fetch).dashboards.imageBytes("dash_1", { pollIntervalMs: 1 });
    expect(Array.from(bytes)).toEqual([112, 110, 103]);
    expect(m.calls[1].url).toBe(`${BASE}/jobs/job_1`);
    expect(m.calls[2].url).toBe("https://signed.example/img.png?sig=1");
    expect(m.calls[2].headers.get("authorization")).toBeNull();
  });
});

describe("raw openapi-fetch client", () => {
  it("goes through the shared pipeline", async () => {
    const m = sequence(jsonResponse({ workspaces: [] }));
    const c = makeClient(m.fetch, { workspaceId: "ws_1" });
    const raw: any = c.raw;
    const { data } = await raw.GET("/workspaces");
    expect(data).toEqual({ workspaces: [] });
    expect(m.calls[0].url).toBe(`${BASE}/workspaces`);
    expect(m.calls[0].headers.get("authorization")).toBe("Bearer mtk_test");
    expect(m.calls[0].headers.get("x-matih-workspace")).toBe("ws_1");
  });
});
