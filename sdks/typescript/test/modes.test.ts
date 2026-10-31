import { describe, expect, it } from "vitest";
import { JobFailedError, JobTimeoutError, type Answer } from "../src/index.js";
import { ANSWER, fileBody, jobBody, jsonResponse, makeClient, sequence, sourceBody, sourceCreatedBody } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const FAST = { pollIntervalMs: 1 };

describe("ask: sync and background", () => {
  it("answers in one call by default, without a Prefer header", async () => {
    const m = sequence(jsonResponse(ANSWER));
    const answer: Answer = await makeClient(m.fetch).ask("how much?");
    expect(answer.answer).toBe("Revenue was 42.");
    expect(m.calls[0].headers.get("prefer")).toBeNull();
  });

  it("background: sends Prefer: respond-async and returns the job at once", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "ask" }), 202, { "preference-applied": "respond-async" }));
    const job = await makeClient(m.fetch).ask("how much?", { background: true });
    expect(m.calls[0].headers.get("prefer")).toBe("respond-async");
    expect(job.kind).toBe("ask");
    expect(job.state).toBe("queued");
    expect(m.calls).toHaveLength(1);
  });

  it("background job finishes with the Answer as its result", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "ask" }), 202),
      jsonResponse(jobBody("running", { kind: "ask" })),
      jsonResponse(jobBody("succeeded", { kind: "ask", result: ANSWER })),
    );
    const c = makeClient(m.fetch);
    const job = await c.ask("how much?", { background: true });
    const done = await c.jobs.wait<Answer>(job, FAST);
    expect(done.result?.answer).toBe("Revenue was 42.");
  });

  it("a 202 job from a plain ask is awaited and unwrapped to the Answer", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "ask" }), 202),
      jsonResponse(jobBody("succeeded", { kind: "ask", result: ANSWER })),
    );
    const answer = await makeClient(m.fetch).ask("how much?");
    expect(answer.conversation_id).toBe("conv_1");
  });
});

describe("job calls: sync (wait) and background", () => {
  it("sync: sends Prefer wait and returns the job when the server finished in time", async () => {
    const result = { source_id: "s1", state: "ready", gem_count: 3 };
    const m = sequence(jsonResponse(jobBody("succeeded", { kind: "gems", result }), 200));
    const job = await makeClient(m.fetch).gems.generate("src_1", { wait: 30 });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=30");
    expect(job.state).toBe("succeeded");
    expect(job.result?.gem_count).toBe(3);
    expect(m.calls).toHaveLength(1);
  });

  it("sync: caps the Prefer wait at what the server honours and keeps polling after a 202", async () => {
    const done = { conversation_id: "conv_1", answer: ANSWER };
    const m = sequence(
      jsonResponse(jobBody("running", { kind: "prediction" }), 202),
      jsonResponse(jobBody("running", { kind: "prediction" })),
      jsonResponse(jobBody("succeeded", { kind: "prediction", result: done })),
    );
    const job = await makeClient(m.fetch).predictions.create({ question: "next quarter?" }, { wait: 600, ...FAST });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=60");
    expect(m.calls[1].url).toBe(`${BASE}/jobs/job_1`);
    expect(job.result?.answer.answer).toBe("Revenue was 42.");
  });

  it("sync: a failed job throws JobFailedError", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202),
      jsonResponse(jobBody("failed", { error: { category: "render", message: "no data" } })),
    );
    await expect(makeClient(m.fetch).dashboards.image("d1", FAST)).rejects.toBeInstanceOf(JobFailedError);
  });

  it("sync: running past `wait` throws JobTimeoutError", async () => {
    const m = sequence(jsonResponse(jobBody("running"), 202));
    await expect(
      makeClient(m.fetch).predictions.create({ question: "q" }, { wait: 0.05, ...FAST }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });

  it("background: sends no Prefer wait and returns the queued job without polling", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "gems" }), 202));
    const job = await makeClient(m.fetch).gems.generate("src_1", { background: true });
    expect(m.calls[0].headers.get("prefer")).toBeNull();
    expect(job.state).toBe("queued");
    expect(m.calls).toHaveLength(1);
  });

  it("background: the job can be awaited later with jobs.wait", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "dashboard_image" }), 202),
      jsonResponse(jobBody("succeeded", { result: { image_url: "https://workspace.matih.ai/i", width: 1, height: 1 } })),
    );
    const c = makeClient(m.fetch);
    const queued = await c.dashboards.image("d1", { background: true });
    const done = await c.jobs.wait(queued, { timeout: 5, ...FAST });
    expect(done.state).toBe("succeeded");
  });
});

describe("resource calls: sources and files are polled, not jobs", () => {
  it("sources.create returns at once when the catalog is ready; Prefer wait is capped at 120", async () => {
    const m = sequence(jsonResponse(sourceCreatedBody("ready"), 201));
    const out = await makeClient(m.fetch).sources.create({ config: { connector_type: "postgres" } }, { wait: 300 });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=120");
    expect(out.source?.id).toBe("s1");
    expect(out.source?.readiness?.can_ask).toBe(true);
    expect(m.calls).toHaveLength(1);
  });

  it("sources.create polls GET /sources/{id} until it can ask", async () => {
    const m = sequence(
      jsonResponse(sourceCreatedBody("building"), 201),
      jsonResponse(sourceBody("building")),
      jsonResponse(sourceBody("ready")),
    );
    const out = await makeClient(m.fetch).sources.create({ config: { connector_type: "postgres" } }, { wait: 30, ...FAST });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/sources`,
      `GET ${BASE}/sources/s1`,
      `GET ${BASE}/sources/s1`,
    ]);
    expect(out.source?.readiness?.phase).toBe("ready");
    expect(out.applied).toBe(true);
    expect(out.test?.ok).toBe(true);
  });

  it("sources.create returns the source as it stands when `wait` runs out; nothing is thrown", async () => {
    const m = sequence(jsonResponse(sourceCreatedBody("building"), 201), jsonResponse(sourceBody("building")));
    const out = await makeClient(m.fetch).sources.create({ config: {} }, { wait: 0.05, ...FAST });
    expect(out.source?.readiness?.phase).toBe("building");
    expect(out.source?.readiness?.can_ask).toBe(false);
  });

  it("sources.create in the background sends no Prefer and does not poll", async () => {
    const m = sequence(jsonResponse(sourceCreatedBody("building"), 201));
    const out = await makeClient(m.fetch).sources.create({ config: {} }, { background: true });
    expect(m.calls[0].headers.get("prefer")).toBeNull();
    expect(out.source?.readiness?.phase).toBe("building");
    expect(m.calls).toHaveLength(1);
  });

  it("files.upload sends Prefer wait and polls GET /files/{id} until ready", async () => {
    const m = sequence(
      jsonResponse(fileBody("processing"), 201),
      jsonResponse(fileBody("processing")),
      jsonResponse(fileBody("ready")),
    );
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b"]), { filename: "x.csv" }, { wait: 20, ...FAST });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=20");
    expect(m.calls[1].url).toBe(`${BASE}/files/f1`);
    expect(out.status).toBe("ready");
  });

  it("files.upload caps Prefer wait at 120, not 60", async () => {
    const m = sequence(jsonResponse(fileBody("ready"), 201));
    await makeClient(m.fetch).files.upload(new Blob(["a,b"]), {}, { wait: 300 });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=120");
  });

  it("files.upload stops polling on a decision and hands it back", async () => {
    const waiting = fileBody("needs_attention", {
      decision_required: "duplicate",
      decision_options: ["use_existing", "keep_both", "cancel"],
    });
    const m = sequence(jsonResponse(fileBody("processing"), 201), jsonResponse(waiting));
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b"]), {}, { wait: 20, ...FAST });
    expect(out.decision_required).toBe("duplicate");
    expect(out.decision_options).toEqual(["use_existing", "keep_both", "cancel"]);
  });

  it("files.upload returns the file as it stands when `wait` runs out; nothing is thrown", async () => {
    const m = sequence(jsonResponse(fileBody("processing"), 201), jsonResponse(fileBody("processing")));
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b"]), {}, { wait: 0.05, ...FAST });
    expect(out.status).toBe("processing");
  });

  it("files.upload in the background sends no Prefer and does not poll", async () => {
    const m = sequence(jsonResponse(fileBody("processing"), 201));
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b"]), {}, { background: true });
    expect(m.calls[0].headers.get("prefer")).toBeNull();
    expect(out.status).toBe("processing");
    expect(m.calls).toHaveLength(1);
  });
});
