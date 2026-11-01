import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, Mitra, MitraError, parseSSE } from "../src/index.js";
import { ANSWER, jobBody, jsonResponse, makeClient, sequence } from "./helpers.js";

const boom = (status: number, headers: Record<string, string> = {}) =>
  jsonResponse({ detail: { category: "internal", message: "boom" } }, status, headers);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection reuse", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(): Promise<{ baseUrl: string; connections: () => number; requests: () => number }> {
    let connections = 0;
    let requests = 0;
    server = createServer((req, res) => {
      requests += 1;
      const found = req.url?.includes("/connectors");
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(found ? { connectors: [] } : { detail: { category: "not_found", message: "no" } }));
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, connections: () => connections, requests: () => requests };
  }

  it("sends twenty calls, answers and errors alike, over one connection", async () => {
    const s = await listen();
    const client = new Mitra({ apiKey: "mtk_test", baseUrl: s.baseUrl });
    for (let i = 0; i < 10; i++) {
      await client.connectors.list();
      await expect(client.sources.get("x")).rejects.toBeInstanceOf(MitraError);
    }
    expect(s.requests()).toBe(20);
    // A body left unread, or a response the client does not drain, would strand its socket.
    expect(s.connections()).toBe(1);
  });
});

describe("retries", () => {
  it("retries a 408 on a GET and never a 4xx", async () => {
    const m = sequence(boom(408), jsonResponse({ sources: [] }));
    await makeClient(m.fetch).sources.list();
    expect(m.calls).toHaveLength(2);

    for (const status of [400, 401, 403, 404, 409, 422]) {
      const e = sequence(boom(status));
      await expect(makeClient(e.fetch, { maxRetries: 3 }).sources.list()).rejects.toMatchObject({ status });
      expect(e.calls).toHaveLength(1);
    }
  });

  it("throws a 5xx with a Retry-After beyond a minute instead of sleeping on it", async () => {
    const m = sequence(boom(503, { "retry-after": "120" }));
    await expect(makeClient(m.fetch, { maxRetries: 3 }).sources.list()).rejects.toMatchObject({ status: 503 });
    expect(m.calls).toHaveLength(1);
  });

  it("waits the Retry-After it is given, no sooner", async () => {
    vi.useFakeTimers();
    const m = sequence(boom(429, { "retry-after": "3" }), jsonResponse({ sources: [] }));
    const call = makeClient(m.fetch).sources.list();
    await vi.advanceTimersByTimeAsync(2999);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(m.calls).toHaveLength(2);
  });

  it("keeps the sleeping of one call inside a retry budget", async () => {
    vi.useFakeTimers();
    const m = sequence(boom(503, { "retry-after": "40" }));
    const call = makeClient(m.fetch, { maxRetries: 5 }).sources.list();
    const outcome = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(40_000);
    // 40 s slept, a second 40 s would pass the 60 s budget: the last error is thrown.
    expect(await outcome).toMatchObject({ status: 503 });
    expect(m.calls).toHaveLength(2);
  });

  it("does not sleep past a call's deadline", async () => {
    const m = sequence(boom(503, { "retry-after": "2" }));
    await expect(
      makeClient(m.fetch, { maxRetries: 3 }).sources.list({ deadlineMs: 1000 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(m.calls).toHaveLength(1);
  });

  it("backs off with jitter, doubling and capped", async () => {
    const sleeps: number[] = [];
    const real = globalThis.setTimeout;
    // Record every backoff sleep and run it at once; leave the 60 s attempt timers alone.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number" && ms < 60_000) {
        sleeps.push(ms);
        return real(fn, 0);
      }
      return real(fn, ms);
    }) as unknown as typeof setTimeout);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const m = sequence(boom(503));
    const client = new Mitra({ apiKey: "mtk_test", fetch: m.fetch, maxRetries: 6 });
    await expect(client.sources.list()).rejects.toMatchObject({ status: 503 });
    // 500 ms base, doubled, scaled to 50% by the stubbed random, capped at 8 s (before scaling)
    expect(sleeps).toEqual([250, 500, 1000, 2000, 4000, 4000]);
  });
});

describe("deadlines and timeouts", () => {
  const hang = (): typeof fetch =>
    ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

  it("cuts an attempt off at the call's deadline, not at the longer attempt timeout", async () => {
    const client = makeClient(hang(), { timeoutMs: 10_000 });
    const started = Date.now();
    const err = await client.sources.list({ deadlineMs: 60 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).category).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives a waiting request an attempt timeout beyond the wait the server is asked for", async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return real(fn, ms);
    }) as unknown as typeof setTimeout);
    const m = sequence(jsonResponse(jobBody("succeeded", { kind: "gems" })));
    await makeClient(m.fetch).gems.generate("s1", { wait: 60 });
    expect(m.calls[0]?.headers.get("prefer")).toBe("wait=60");
    expect(delays).toContain(75_000); // 60 s wait + 15 s
  });
});

describe("streams", () => {
  const encoder = new TextEncoder();
  const stalls = (cancelled: { value: boolean }) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: started\ndata: {"request_id":"r1"}\n\n'));
      },
      cancel() {
        cancelled.value = true;
      },
    });

  it("parseSSE ends a silent stream with a timeout error and releases it", async () => {
    const cancelled = { value: false };
    const seen: string[] = [];
    const run = async () => {
      for await (const message of parseSSE(stalls(cancelled), 40)) seen.push(message.event);
    };
    await expect(run()).rejects.toMatchObject({ name: "ConnectionError", category: "timeout" });
    expect(seen).toEqual(["started"]);
    expect(cancelled.value).toBe(true);
  });

  it("askStream gives up on a stream that stops sending, after the attempt timeout", async () => {
    const cancelled = { value: false };
    const m = sequence(
      () => new Response(stalls(cancelled), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const events: string[] = [];
    const run = async () => {
      for await (const event of makeClient(m.fetch).askStream("q", { timeoutMs: 40 })) events.push(event.event);
    };
    await expect(run()).rejects.toBeInstanceOf(ConnectionError);
    expect(events).toEqual(["started"]);
  });

  it("a stream that keeps sending is not cut off by the idle timeout", async () => {
    const m = sequence(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let i = 0; i < 4; i++) {
                controller.enqueue(encoder.encode(`event: progress\ndata: ${i}\n\n`));
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              controller.enqueue(encoder.encode(`event: answer\ndata: ${JSON.stringify(ANSWER)}\n\n`));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const names: string[] = [];
    for await (const event of makeClient(m.fetch).askStream("q", { timeoutMs: 250 })) names.push(event.event);
    expect(names).toEqual(["progress", "progress", "progress", "progress", "answer"]);
  });
});
