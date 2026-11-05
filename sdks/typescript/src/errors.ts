import type { Job } from "./types.js";

export interface MitraErrorInit {
  /** HTTP status, or 0 when the error did not come from an HTTP response. */
  status: number;
  category: string;
  code?: string;
  requestId?: string;
  body?: unknown;
  /** Every other field of the error body, see `MitraError.extra`. */
  extra?: Record<string, unknown>;
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
  /**
   * Every other field of the error (`detail` or top-level body): for example the `pending_id`, `choices`,
   * `rows` and `credits` of a `409 HEAVY_CONFIRM`, or the `conversation_id` of a refused change call.
   * Empty when there are none.
   */
  readonly extra: Record<string, unknown>;

  constructor(message: string, init: MitraErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "MitraError";
    this.status = init.status;
    this.category = init.category;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
    this.extra = init.extra ?? {};
  }

  /** The held change a refused change call names (`409 HEAVY_CONFIRM`): confirm or cancel it with this. */
  get pendingId(): string | undefined {
    const value = this.extra["pending_id"];
    return typeof value === "string" ? value : undefined;
  }

  /** The numbered `choices` a refused change call lists, if any. */
  get choices(): unknown[] {
    const value = this.extra["choices"];
    return Array.isArray(value) ? value : [];
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

/** 403: category `scope`, `workspace_role`, `workspace` or `source_access`. */
export class PermissionError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "PermissionError";
  }
}

/** 402: category `not_ready` (the workspace is out of credits) or `member_cap`. */
export class CreditsError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "CreditsError";
  }
}

/** 409: a conflict with the current state: revoking an invitation that is no longer open, answering a file that is not waiting for a decision, or a workspace already at its 20 webhooks. Read `category`, `code` and `message`. */
export class BusyError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "BusyError";
  }
}

/**
 * 422 from creating a source: the connection test failed and nothing was
 * saved. `testResult` is the server's `detail.test` (`ok`, `message`,
 * `error_category`, `field`, ...), or undefined.
 */
export class SourceTestFailedError extends MitraError {
  readonly testResult: unknown;

  constructor(message: string, init: MitraErrorInit & { testResult: unknown }) {
    super(message, init);
    this.name = "SourceTestFailedError";
    this.testResult = init.testResult;
  }
}

/** The 422 codes `embeds.create` can answer with. The server may add more; they pass through in `code`. */
export const EMBED_REFUSAL_CODES = [
  "missing_parameter",
  "unknown_parameter",
  "invalid_value",
  "invalid_origin",
  "filters_not_supported",
  "no_embed_parameters",
] as const;

/**
 * 422 from `embeds.create`: nothing was minted. `code` says why: `missing_parameter` (filters
 * lack a declared parameter), `unknown_parameter`, `invalid_value` (a filter value is not valid
 * for its type), `invalid_origin`, `filters_not_supported` (filters sent for Gems),
 * `no_embed_parameters` (filters sent for a dashboard that declares none). `code` is undefined
 * for a plain request-validation 422.
 */
export class EmbedRefusedError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "EmbedRefusedError";
  }
}

/**
 * 404 from `embeds.create` or `embeds.revoke`: the dashboard or source does not exist or the
 * key's member cannot read it, or (revoke) the token id is not one of this key's.
 */
export class EmbedNotFoundError extends MitraError {
  constructor(message: string, init: MitraErrorInit) {
    super(message, init);
    this.name = "EmbedNotFoundError";
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
      return "not_ready";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
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
 * Build the typed error for a non-2xx response. One reader for both shapes the API answers with: the
 * `{"detail": {"category", "message", "code"?}}` envelope (`detail` may also be a string or a validation
 * array), and the top-level `{code, message, ...}` body the `/changes` routes answer with (`409
 * HEAVY_CONFIRM` with its `pending_id`, `410 ALREADY_UNDONE`, ...). Where both are present the envelope
 * wins. Whatever else the body carries is kept in `extra`. Non-JSON bodies fall back to their text.
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
  let extra: Record<string, unknown> = {};

  if (isRecord(parsed)) {
    const { detail, ...top } = parsed;
    // The fields are the top-level body with the envelope's own laid over it, so a code beside a string
    // `detail` is read too.
    const fields: Record<string, unknown> = isRecord(detail) ? { ...top, ...detail } : top;
    if (typeof fields["category"] === "string") category = fields["category"];
    if (typeof fields["code"] === "string") code = fields["code"];
    if (typeof fields["message"] === "string" && fields["message"] !== "") message = fields["message"];
    if (typeof detail === "string") {
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
    }
    extra = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "message" && key !== "category" && key !== "code"));
  }

  const init: MitraErrorInit = {
    status,
    category,
    code,
    requestId: headers.get("x-request-id") ?? undefined,
    body: parsed === undefined ? text : parsed,
    extra,
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
 * Error mapper for `POST /sources`, where 422 with a `detail` object means the
 * connection test failed (`detail.test` is the test result), unlike a request
 * validation 422 whose `detail` is an array.
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
  if (!isRecord(detail)) return undefined; // request validation, not a test result
  return new SourceTestFailedError(
    typeof detail["message"] === "string" ? detail["message"] : "The connection test for this source failed",
    {
      status,
      category: typeof detail["category"] === "string" ? detail["category"] : "connection",
      code: typeof detail["code"] === "string" ? detail["code"] : undefined,
      requestId: headers.get("x-request-id") ?? undefined,
      body: parsed,
      testResult: detail["test"],
    },
  );
}

/**
 * Error mapper for the `/embeds` routes: 422 becomes EmbedRefusedError (read `code`) and 404
 * EmbedNotFoundError. Anything else keeps the default mapping (401, 403, 429, ...).
 */
export function embedErrorFromResponse(status: number, headers: Headers, text: string): MitraError | undefined {
  if (status !== 422 && status !== 404) return undefined;
  const base = errorFromResponse(status, headers, text);
  const init: MitraErrorInit = {
    status,
    category: base.category,
    code: base.code,
    requestId: base.requestId,
    body: base.body,
    extra: base.extra,
  };
  return status === 422 ? new EmbedRefusedError(base.message, init) : new EmbedNotFoundError(base.message, init);
}
