import type { Job } from "./types.js";

export interface MitraErrorInit {
  /** HTTP status, or 0 when the error did not come from an HTTP response. */
  status: number;
  category: string;
  code?: string;
  requestId?: string;
  body?: unknown;
  cause?: unknown;
}

/** Base class for every error thrown by the SDK for an API failure. */
export class MitraError extends Error {
  readonly status: number;
  readonly category: string;
  readonly code: string | undefined;
  /** Value of the `x-request-id` response header, useful when contacting support. */
  readonly requestId: string | undefined;
  /** Parsed JSON error body, or the raw text when it was not JSON. */
  readonly body: unknown;

  constructor(message: string, init: MitraErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "MitraError";
    this.status = init.status;
    this.category = init.category;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

/** 429. `retryAfter` is the server's Retry-After value in seconds, when sent. */
export class RateLimitError extends MitraError {
  readonly retryAfter: number | undefined;

  constructor(message: string, init: MitraErrorInit & { retryAfter?: number }) {
    super(message, init);
    this.name = "RateLimitError";
    this.retryAfter = init.retryAfter;
  }
}

/** 401: missing, invalid or expired credential. */
export class AuthError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "AuthError";
  }
}

/** 403: scope, workspace role or source access is insufficient. */
export class PermissionError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "PermissionError";
  }
}

/** 402: out of credits or the member cap was reached. */
export class CreditsError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "CreditsError";
  }
}

/** 409: the resource is busy; retry later. */
export class BusyError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "BusyError";
  }
}

/**
 * 422 from creating a source: the connection test failed and nothing was
 * saved. `testResult` carries the test outcome from the response body.
 */
export class SourceTestFailedError extends MitraError {
  readonly testResult: unknown;

  constructor(message: string, init: MitraErrorInit & { testResult: unknown }) {
    super(message, init);
    this.name = "SourceTestFailedError";
    this.testResult = init.testResult;
  }
}

/** Network failure or timeout before a response arrived (status 0). */
export class ConnectionError extends MitraError {
  constructor(message: string, init: { category: "network" | "timeout"; cause?: unknown }) {
    super(message, { status: 0, category: init.category, cause: init.cause });
    this.name = "ConnectionError";
  }
}

/** A job ended in the failed or cancelled state. */
export class JobFailedError extends MitraError {
  readonly job: Job;

  constructor(job: Job) {
    super(job.error?.message ?? `Job ${job.id} ${job.state}`, {
      status: 0,
      category: job.error?.category ?? job.state,
      code: job.error?.code,
      body: job,
    });
    this.name = "JobFailedError";
    this.job = job;
  }
}

/** Waiting for a job took longer than the allowed time. The job keeps running. */
export class JobTimeoutError extends MitraError {
  readonly jobId: string;
  readonly timeoutMs: number;
  readonly job: Job | undefined;

  constructor(jobId: string, timeoutMs: number, job?: Job) {
    super(`Timed out after ${timeoutMs} ms waiting for job ${jobId}`, {
      status: 0,
      category: "timeout",
      body: job,
    });
    this.name = "JobTimeoutError";
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
    this.job = job;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function defaultCategory(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "validation";
    case 401:
      return "auth";
    case 402:
      return "credits";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    case 409:
      return "busy";
    case 429:
      return "rate_limit";
    default:
      return status >= 500 ? "server" : "unknown";
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - nowMs) / 1000);
}

/**
 * Build the typed error for a non-2xx response. Understands the API's
 * `{"detail": {"category", "message", "code"?}}` envelope and falls back
 * gracefully for string details, validation arrays and non-JSON bodies.
 */
export function errorFromResponse(status: number, headers: Headers, text: string): MitraError {
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  let category = defaultCategory(status);
  let message = text.trim() !== "" && parsed === undefined ? text.trim().slice(0, 300) : `HTTP ${status}`;
  let code: string | undefined;

  if (isRecord(parsed)) {
    const detail = parsed["detail"];
    if (isRecord(detail)) {
      if (typeof detail["category"] === "string") category = detail["category"];
      if (typeof detail["message"] === "string") message = detail["message"];
      if (typeof detail["code"] === "string") code = detail["code"];
    } else if (typeof detail === "string") {
      message = detail;
    } else if (Array.isArray(detail)) {
      category = "validation";
      message = detail
        .map((item) => {
          if (!isRecord(item)) return String(item);
          const loc = Array.isArray(item["loc"]) ? item["loc"].join(".") : "";
          const msg = typeof item["msg"] === "string" ? item["msg"] : "invalid";
          return loc ? `${loc}: ${msg}` : msg;
        })
        .join("; ");
    } else if (typeof parsed["message"] === "string") {
      message = parsed["message"];
    }
  }

  const init: MitraErrorInit = {
    status,
    category,
    code,
    requestId: headers.get("x-request-id") ?? undefined,
    body: parsed === undefined ? text : parsed,
  };

  switch (status) {
    case 401:
      return new AuthError(message, init);
    case 402:
      return new CreditsError(message, init);
    case 403:
      return new PermissionError(message, init);
    case 409:
      return new BusyError(message, init);
    case 429:
      return new RateLimitError(message, {
        ...init,
        retryAfter: parseRetryAfter(headers.get("retry-after")),
      });
    default:
      return new MitraError(message, init);
  }
}

/**
 * Error mapper for `POST /sources`, where 422 means the connection test
 * failed and the body is the test result rather than a validation error.
 */
export function sourceErrorFromResponse(status: number, headers: Headers, text: string): MitraError | undefined {
  if (status !== 422) return undefined;
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const detail = parsed["detail"];
  if (Array.isArray(detail)) return undefined; // request validation, not a test result
  const testResult: unknown = detail !== undefined ? detail : parsed;
  const info = isRecord(testResult) ? testResult : {};
  return new SourceTestFailedError(
    typeof info["message"] === "string" ? info["message"] : "The connection test for this source failed",
    {
      status,
      category: typeof info["category"] === "string" ? info["category"] : "source_test",
      code: typeof info["code"] === "string" ? info["code"] : undefined,
      requestId: headers.get("x-request-id") ?? undefined,
      body: parsed,
      testResult,
    },
  );
}
