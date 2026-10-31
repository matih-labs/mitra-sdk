import { describe, expect, it } from "vitest";
import {
  AuthError,
  BusyError,
  CreditsError,
  MitraError,
  PermissionError,
  RateLimitError,
} from "../src/index.js";
import { errorFromResponse, parseRetryAfter } from "../src/errors.js";
import { jsonResponse, makeClient, sequence, textResponse } from "./helpers.js";

function detail(category: string, message: string, code?: string): { detail: Record<string, string> } {
  return { detail: code ? { category, message, code } : { category, message } };
}

describe("errorFromResponse", () => {
  it("parses the detail envelope", () => {
    const headers = new Headers({ "x-request-id": "req_42" });
    const err = errorFromResponse(403, headers, JSON.stringify(detail("scope", "Missing scope ask", "missing_scope")));
    expect(err).toBeInstanceOf(PermissionError);
    expect(err).toBeInstanceOf(MitraError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(err.category).toBe("scope");
    expect(err.code).toBe("missing_scope");
    expect(err.message).toBe("Missing scope ask");
    expect(err.requestId).toBe("req_42");
    expect(err.body).toEqual(detail("scope", "Missing scope ask", "missing_scope"));
  });

  it.each([
    [401, AuthError, "AuthError"],
    [402, CreditsError, "CreditsError"],
    [403, PermissionError, "PermissionError"],
    [409, BusyError, "BusyError"],
    [429, RateLimitError, "RateLimitError"],
  ] as const)("maps %i to its class", (status, cls, name) => {
    const err = errorFromResponse(status, new Headers(), JSON.stringify(detail("x", "m")));
    expect(err).toBeInstanceOf(cls);
    expect(err.name).toBe(name);
  });

  it("uses the base class for other statuses", () => {
    const err = errorFromResponse(404, new Headers(), JSON.stringify(detail("not_found", "no such gem")));
    expect(err.constructor).toBe(MitraError);
    expect(err.name).toBe("MitraError");
    expect(err.category).toBe("not_found");
  });

  it("reads Retry-After seconds on 429", () => {
    const err = errorFromResponse(429, new Headers({ "retry-after": "7" }), JSON.stringify(detail("rate_limit", "slow")));
    expect((err as RateLimitError).retryAfter).toBe(7);
  });

  it("leaves retryAfter undefined when the header is absent", () => {
    const err = errorFromResponse(429, new Headers(), JSON.stringify(detail("rate_limit", "slow")));
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  it("falls back for a string detail", () => {
    const err = errorFromResponse(401, new Headers(), JSON.stringify({ detail: "Not authenticated" }));
    expect(err.message).toBe("Not authenticated");
    expect(err.category).toBe("auth");
  });

  it("summarises a validation error array", () => {
    const body = { detail: [{ loc: ["body", "question"], msg: "Field required" }] };
    const err = errorFromResponse(422, new Headers(), JSON.stringify(body));
    expect(err.category).toBe("validation");
    expect(err.message).toBe("body.question: Field required");
  });

  it("copes with a non-JSON body", () => {
    const err = errorFromResponse(502, new Headers(), "<html>Bad gateway</html>");
    expect(err.status).toBe(502);
    expect(err.category).toBe("server");
    expect(err.message).toBe("<html>Bad gateway</html>");
    expect(err.body).toBe("<html>Bad gateway</html>");
  });

  it("copes with an empty body", () => {
    const err = errorFromResponse(500, new Headers(), "");
    expect(err.message).toBe("HTTP 500");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds, dates and junk", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter("0.5")).toBe(0.5);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
  });
});

describe("errors from the client", () => {
  it("throws CreditsError with category and request id", async () => {
    const m = sequence(jsonResponse(detail("not_ready", "Out of credits"), 402, { "x-request-id": "req_7" }));
    const err = await makeClient(m.fetch).ask("q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditsError);
    const e = err as CreditsError;
    expect(e.status).toBe(402);
    expect(e.category).toBe("not_ready");
    expect(e.requestId).toBe("req_7");
    expect(m.calls).toHaveLength(1);
  });

  it("throws AuthError for 401", async () => {
    const m = sequence(jsonResponse(detail("auth", "Invalid token"), 401, { "www-authenticate": "Bearer" }));
    await expect(makeClient(m.fetch).workspaces.list()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws BusyError for 409 (a conflict, not a busy server)", async () => {
    const m = sequence(jsonResponse(detail("conflict", "The invitation is no longer open"), 409));
    await expect(makeClient(m.fetch).invitations.revoke("inv_1")).rejects.toBeInstanceOf(BusyError);
  });

  it("throws RateLimitError after retries are exhausted", async () => {
    const m = sequence(jsonResponse(detail("rate_limit", "slow"), 429, { "retry-after": "0" }));
    const err = await makeClient(m.fetch, { maxRetries: 1 }).sources.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(0);
    expect(m.calls).toHaveLength(2);
  });

  it("wraps an invalid JSON success body", async () => {
    const m = sequence(textResponse("not json", 200));
    await expect(makeClient(m.fetch).workspaces.list()).rejects.toMatchObject({ category: "invalid_response" });
  });
});
