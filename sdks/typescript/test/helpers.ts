import { Mitra, type MitraOptions } from "../src/index.js";

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/**
 * A mocked fetch that answers with the given handlers in order; the last
 * handler repeats once the list is used up. Every call is recorded.
 */
export function sequence(...handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const mock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    const handler = handlers[Math.min(index, handlers.length - 1)] as Handler;
    index += 1;
    return handler(call);
  };
  return { fetch: mock as unknown as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Handler {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Handler {
  return () => new Response(body, { status, headers });
}

export function networkError(): Handler {
  return () => {
    throw new TypeError("fetch failed");
  };
}

export function makeClient(f: typeof fetch, extra: Partial<MitraOptions> = {}): Mitra {
  return new Mitra({ apiKey: "mtk_test", fetch: f, retryBaseDelayMs: 1, ...extra });
}

export function jobBody(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job_1",
    kind: "prediction",
    state,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

export const ANSWER = {
  status: "answered",
  answer: "Revenue was 42.",
  clarification: null,
  result: null,
  sql: null,
  image_url: null,
  follow_ups: [],
  conversation_id: "conv_1",
  request_id: "req_1",
  language: "en-IN",
};
