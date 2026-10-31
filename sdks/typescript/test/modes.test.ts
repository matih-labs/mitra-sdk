import { describe, expect, it } from "vitest";
import { JobFailedError, JobTimeoutError, type Answer, type Job } from "../src/index.js";
import { ANSWER, jobBody, jsonResponse, makeClient, sequence } from "./helpers.js";

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

describe("long calls: sync (wait) and background", () => {
  it("sync: sends Prefer wait and returns the job when the server finished in time", async () => {
    const m = sequence(jsonResponse(jobBody("succeeded", { kind: "gems", result: { gems: 3 } }), 200));
    const job = await makeClient(m.fetch).gems.generate("src_1", { wait: 30 });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=30");
    expect(job.state).toBe("succeeded");
    expect(m.calls).toHaveLength(1);
  });

  it("sync: caps the Prefer wait at what the server honours and keeps polling after a 202", async () => {
    const m = sequence(
      jsonResponse(jobBody("running", { kind: "prediction" }), 202),
      jsonResponse(jobBody("running", { kind: "prediction" })),
      jsonResponse(jobBody("succeeded", { kind: "prediction", result: { answer: "up 4%", attachments: [] } })),
    );
    const job = await makeClient(m.fetch).predictions.create({ question: "next quarter?" }, { wait: 600, ...FAST });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=60");
    expect(m.calls[1].url).toBe(`${BASE}/jobs/job_1`);
    expect(job.result?.answer).toBe("up 4%");
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
    const queued: Job = await c.dashboards.image("d1", { background: true });
    const done = await c.jobs.wait(queued, { timeout: 5, ...FAST });
    expect(done.state).toBe("succeeded");
  });

  it("sources.create waits up to 120s on the server and returns the source", async () => {
    const m = sequence(jsonResponse({ id: "src_1", name: "Sales" }, 201));
    const out = await makeClient(m.fetch).sources.create({ config: { type: "postgres" } }, { wait: 300 });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=120");
    expect(out.id).toBe("src_1");
  });

  it("sources.create in the background returns the job from a 202", async () => {
    const m = sequence(jsonResponse(jobBody("queued", { kind: "source" }), 202));
    const out = await makeClient(m.fetch).sources.create({ config: { type: "postgres" } }, { background: true });
    expect(m.calls[0].headers.get("prefer")).toBeNull();
    expect((out as Job).state).toBe("queued");
  });

  it("files.upload sends Prefer wait and polls a 202 job", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued", { kind: "file" }), 202),
      jsonResponse(jobBody("succeeded", { kind: "file" })),
    );
    const out = await makeClient(m.fetch).files.upload(new Blob(["a,b"]), { filename: "x.csv" }, { wait: 20, ...FAST });
    expect(m.calls[0].headers.get("prefer")).toBe("wait=20");
    expect((out as Job).state).toBe("succeeded");
  });
});
