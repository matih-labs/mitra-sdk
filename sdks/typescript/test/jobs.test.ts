import { describe, expect, it } from "vitest";
import { JobFailedError, JobTimeoutError, type Job } from "../src/index.js";
import { jobBody, jsonResponse, makeClient, sequence } from "./helpers.js";

const BASE = "https://workspace.matih.ai/api/v1";
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

describe("jobs.get and jobs.cancel", () => {
  it("fetches a job", async () => {
    const m = sequence(jsonResponse(jobBody("running")));
    const job = await makeClient(m.fetch).jobs.get("job_1");
    expect(job.state).toBe("running");
    expect(m.calls[0].url).toBe(`${BASE}/jobs/job_1`);
  });

  it("cancels a job with POST", async () => {
    const m = sequence(jsonResponse(jobBody("cancelled")));
    const job = await makeClient(m.fetch).jobs.cancel("job_1");
    expect(job.state).toBe("cancelled");
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe(`${BASE}/jobs/job_1/cancel`);
  });
});

describe("jobs.wait", () => {
  it("polls until the job succeeds and reports progress", async () => {
    const m = sequence(
      jsonResponse(jobBody("queued")),
      jsonResponse(jobBody("running")),
      jsonResponse(jobBody("succeeded", { result: { answer: "done", attachments: [] } })),
    );
    const seen: string[] = [];
    const job = await makeClient(m.fetch).jobs.wait("job_1", {
      ...FAST,
      onProgress: (j: Job) => seen.push(j.state),
    });
    expect(job.state).toBe("succeeded");
    expect(job.result).toEqual({ answer: "done", attachments: [] });
    expect(seen).toEqual(["queued", "running", "succeeded"]);
    expect(m.calls).toHaveLength(3);
  });

  it("does not poll when given an already finished job", async () => {
    const m = sequence(jsonResponse({}));
    const finished = jobBody("succeeded") as unknown as Job;
    const job = await makeClient(m.fetch).jobs.wait(finished);
    expect(job.state).toBe("succeeded");
    expect(m.calls).toHaveLength(0);
  });

  it("starts from a Job object and polls for updates", async () => {
    const m = sequence(jsonResponse(jobBody("succeeded")));
    const queued = jobBody("queued") as unknown as Job;
    const job = await makeClient(m.fetch).jobs.wait(queued, FAST);
    expect(job.state).toBe("succeeded");
    expect(m.calls).toHaveLength(1);
  });

  it("throws JobFailedError for a failed job", async () => {
    const m = sequence(
      jsonResponse(jobBody("running")),
      jsonResponse(jobBody("failed", { error: { category: "model", message: "could not fit", code: "fit_failed" } })),
    );
    const err = await makeClient(m.fetch)
      .jobs.wait("job_1", FAST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailedError);
    const failed = err as JobFailedError;
    expect(failed.message).toBe("could not fit");
    expect(failed.category).toBe("model");
    expect(failed.code).toBe("fit_failed");
    expect(failed.job.id).toBe("job_1");
  });

  it("throws JobFailedError for a cancelled job", async () => {
    const m = sequence(jsonResponse(jobBody("cancelled")));
    await expect(makeClient(m.fetch).jobs.wait("job_1", FAST)).rejects.toBeInstanceOf(JobFailedError);
  });

  it("returns a failed job when throwOnFailure is false", async () => {
    const m = sequence(jsonResponse(jobBody("failed", { error: { category: "x", message: "y" } })));
    const job = await makeClient(m.fetch).jobs.wait("job_1", { ...FAST, throwOnFailure: false });
    expect(job.state).toBe("failed");
  });

  it("throws JobTimeoutError when the job never finishes", async () => {
    const m = sequence(jsonResponse(jobBody("running")));
    const err = await makeClient(m.fetch)
      .jobs.wait("job_1", { ...FAST, timeoutMs: 40 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobTimeoutError);
    const timeout = err as JobTimeoutError;
    expect(timeout.jobId).toBe("job_1");
    expect(timeout.timeoutMs).toBe(40);
    expect(timeout.job?.state).toBe("running");
  });

  it("can be aborted while sleeping", async () => {
    const m = sequence(jsonResponse(jobBody("running")));
    const controller = new AbortController();
    const pending = makeClient(m.fetch)
      .jobs.wait("job_1", { pollIntervalMs: 10_000, signal: controller.signal })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(JobTimeoutError);
    expect(err).toBeDefined();
  });
});
