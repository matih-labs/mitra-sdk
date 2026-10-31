import { describe, expect, it } from "vitest";
import { CreditsError, parseSSE, type SSEMessage, type StreamEvent } from "../src/index.js";
import { ANSWER, jsonResponse, makeClient, sequence } from "./helpers.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SSEMessage[]> {
  const out: SSEMessage[] = [];
  for await (const message of parseSSE(streamOf(chunks))) out.push(message);
  return out;
}

describe("parseSSE", () => {
  it("parses simple events", async () => {
    const out = await collect(["event: started\ndata: {}\n\nevent: answer\ndata: {\"a\":1}\n\n"]);
    expect(out).toEqual([
      { event: "started", data: "{}" },
      { event: "answer", data: '{"a":1}' },
    ]);
  });

  it("handles chunk boundaries inside fields and values", async () => {
    const out = await collect(["event: ans", 'wer\ndata: {"a":', "1}\n", "\n"]);
    expect(out).toEqual([{ event: "answer", data: '{"a":1}' }]);
  });

  it("handles CRLF line endings", async () => {
    const out = await collect(["event: x\r\ndata: 1\r\n\r\nevent: y\r\ndata: 2\r\n\r\n"]);
    expect(out.map((m) => [m.event, m.data])).toEqual([
      ["x", "1"],
      ["y", "2"],
    ]);
  });

  it("handles a CRLF split across chunks", async () => {
    const out = await collect(["data: a\r", "\n\r", "\ndata: b\n\n"]);
    expect(out.map((m) => m.data)).toEqual(["a", "b"]);
  });

  it("joins multi-line data with newlines", async () => {
    const out = await collect(["data: line1\ndata: line2\n\n"]);
    expect(out).toEqual([{ event: "message", data: "line1\nline2" }]);
  });

  it("ignores comments and unknown fields, keeps ids", async () => {
    const out = await collect([": keep-alive\nretry: 100\nid: 7\nevent: progress\ndata: 50\n\n"]);
    expect(out).toEqual([{ event: "progress", data: "50", id: "7" }]);
  });

  it("strips only a single leading space from values", async () => {
    const out = await collect(["data:  two\n\ndata:none\n\n"]);
    expect(out.map((m) => m.data)).toEqual([" two", "none"]);
  });

  it("dispatches a final event without a trailing blank line", async () => {
    const out = await collect(["event: answer\ndata: end"]);
    expect(out).toEqual([{ event: "answer", data: "end" }]);
  });

  it("skips events without data", async () => {
    const out = await collect(["event: ping\n\ndata: x\n\n"]);
    expect(out).toEqual([{ event: "message", data: "x" }]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: नमस्ते\n\n");
    const a = bytes.slice(0, 8);
    const b = bytes.slice(8);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
        controller.enqueue(b);
        controller.close();
      },
    });
    const out: SSEMessage[] = [];
    for await (const message of parseSSE(stream)) out.push(message);
    expect(out).toEqual([{ event: "message", data: "नमस्ते" }]);
  });

  it("cancels the stream when the consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: 1\n\ndata: 2\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const message of parseSSE(stream)) {
      expect(message.data).toBe("1");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("askStream", () => {
  const sse = (chunks: string[]) => () =>
    new Response(streamOf(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("yields parsed events in order", async () => {
    const m = sequence(
      sse([
        'event: started\ndata: {"request_id":"req_1"}\n\n',
        'event: progress\ndata: {"step":"sql"}\n\n',
        `event: answer\ndata: ${JSON.stringify(ANSWER)}\n\n`,
      ]),
    );
    const events: StreamEvent[] = [];
    for await (const ev of makeClient(m.fetch).askStream({ question: "revenue?", source_id: "src_1" })) events.push(ev);

    expect(events.map((e) => e.event)).toEqual(["started", "progress", "answer"]);
    expect(events[0]?.data).toEqual({ request_id: "req_1" });
    expect((events[2]?.data as { answer: string }).answer).toBe("Revenue was 42.");

    const call = m.calls[0];
    expect(call.method).toBe("POST");
    expect(call.headers.get("accept")).toBe("text/event-stream");
    expect(call.headers.get("idempotency-key")).toBeTruthy();
    expect(JSON.parse(String(call.body))).toEqual({ question: "revenue?", source_id: "src_1", stream: true });
  });

  it("yields error events instead of throwing", async () => {
    const m = sequence(sse(['event: error\ndata: {"category":"internal","message":"boom"}\n\n']));
    const events: StreamEvent[] = [];
    for await (const ev of makeClient(m.fetch).askStream("q")) events.push(ev);
    expect(events).toEqual([{ event: "error", data: { category: "internal", message: "boom" } }]);
  });

  it("keeps non-JSON data as a string", async () => {
    const m = sequence(sse(["event: progress\ndata: working on it\n\n"]));
    const events: StreamEvent[] = [];
    for await (const ev of makeClient(m.fetch).askStream("q")) events.push(ev);
    expect(events[0]?.data).toBe("working on it");
  });

  it("throws a typed error when the request itself fails", async () => {
    const m = sequence(jsonResponse({ detail: { category: "credits", message: "Out of credits" } }, 402));
    const run = async (): Promise<void> => {
      for await (const ev of makeClient(m.fetch).askStream("q")) void ev;
    };
    await expect(run()).rejects.toBeInstanceOf(CreditsError);
  });

  it("retries the connection with the same idempotency key", async () => {
    const m = sequence(jsonResponse({ detail: { category: "internal", message: "boom" } }, 503), sse(["event: answer\ndata: {}\n\n"]));
    const events: StreamEvent[] = [];
    for await (const ev of makeClient(m.fetch).askStream("q")) events.push(ev);
    expect(events).toHaveLength(1);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0].headers.get("idempotency-key")).toBe(m.calls[1].headers.get("idempotency-key"));
  });
});
