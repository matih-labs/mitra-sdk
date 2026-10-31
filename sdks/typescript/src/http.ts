import { randomUUID } from "node:crypto";
import { ConnectionError, MitraError, errorFromResponse, parseRetryAfter } from "./errors.js";
import type { RequestOptions } from "./types.js";
import { VERSION } from "./version.js";

export interface HttpConfig {
  baseUrl: string;
  credential: string;
  fetch: typeof fetch;
  workspaceId: string | undefined;
  language: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export interface SendOptions {
  method: string;
  /** Path under the base URL, e.g. `/ask`. */
  path?: string;
  /** Absolute URL; used instead of `path`. */
  url?: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  rawBody?: ArrayBuffer;
  headers?: Record<string, string>;
  accept?: string;
  /** Send the credential. Defaults to true; false for signed image URLs. */
  auth?: boolean;
  /** Generate an Idempotency-Key (reused across retries) unless one is given. */
  autoIdempotency?: boolean;
  /** `manual` returns a 3xx response as is, instead of following it. */
  redirect?: "manual";
  /** Leave a successful response body unread so it can be streamed. */
  stream?: boolean;
  request?: RequestOptions;
  /** Map a non-2xx response to a specific error; return undefined for the default. */
  mapError?: (status: number, headers: Headers, text: string) => MitraError | undefined;
}

const MAX_RETRY_AFTER_SEC = 60;
const MAX_BACKOFF_MS = 8000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasNoBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
}

/**
 * The single request pipeline: headers, idempotency, timeout, retries and
 * error mapping. Every SDK call (and the exposed openapi-fetch client) goes
 * through it.
 */
export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  private buildUrl(o: SendOptions): string {
    if (o.url !== undefined) return o.url;
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const path = (o.path ?? "").startsWith("/") ? (o.path ?? "") : `/${o.path ?? ""}`;
    let url = base + path;
    if (o.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(o.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs !== "") url += `?${qs}`;
    }
    return url;
  }

  /** Send and return a 2xx response, or throw the typed error. */
  async send(o: SendOptions): Promise<Response> {
    const res = await this.execute(o);
    if (res.ok) return res;
    const text = await res.text();
    throw o.mapError?.(res.status, res.headers, text) ?? errorFromResponse(res.status, res.headers, text);
  }

  /** Send and parse a JSON body (undefined for an empty body). */
  async json<T>(o: SendOptions): Promise<T> {
    const res = await this.send(o);
    const text = await res.text();
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MitraError("The server returned a response that is not valid JSON", {
        status: res.status,
        category: "invalid_response",
        requestId: res.headers.get("x-request-id") ?? undefined,
        body: text,
        cause,
      });
    }
  }

  /** Send and return the body as bytes. */
  async bytes(o: SendOptions): Promise<Uint8Array> {
    const res = await this.send(o);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Run the request with retries and return whatever response finally
   * arrived, including non-2xx ones. Network failures still throw.
   */
  async execute(o: SendOptions): Promise<Response> {
    const cfg = this.config;
    const opts = o.request ?? {};
    const url = this.buildUrl(o);
    const method = o.method.toUpperCase();

    const headers = new Headers();
    headers.set("Accept", o.accept ?? "application/json");
    headers.set("User-Agent", `mitra-typescript/${VERSION}`);
    if (o.auth !== false) headers.set("Authorization", `Bearer ${cfg.credential}`);
    const workspaceId = opts.workspaceId ?? cfg.workspaceId;
    if (workspaceId && o.auth !== false) headers.set("X-Matih-Workspace", workspaceId);
    const language = opts.language ?? cfg.language;
    if (language && o.auth !== false) headers.set("Accept-Language", language);

    let body: BodyInit | undefined;
    if (o.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(o.json);
    } else if (o.form !== undefined) {
      body = o.form;
    } else if (o.rawBody !== undefined && o.rawBody.byteLength > 0) {
      body = o.rawBody;
    }

    // Generated once so every retry of this call carries the same key.
    const key = opts.idempotencyKey ?? (o.autoIdempotency ? randomUUID() : undefined);
    if (key) headers.set("Idempotency-Key", key);

    if (o.headers) {
      for (const [name, value] of Object.entries(o.headers)) headers.set(name, value);
    }

    // Retrying a 5xx or a network failure is only safe when repeating the
    // call cannot repeat its effect.
    const safe =
      method === "GET" ||
      method === "HEAD" ||
      method === "PUT" ||
      method === "DELETE" ||
      headers.has("Idempotency-Key");
    const maxRetries = opts.maxRetries ?? cfg.maxRetries;
    const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    const init: RequestInit = { method, headers, body };
    if (o.redirect) init.redirect = o.redirect;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.once(url, init, o.stream === true, opts.signal, timeoutMs);
      } catch (err) {
        if (err instanceof ConnectionError && safe && attempt < maxRetries) {
          await sleep(this.backoff(attempt), opts.signal);
          continue;
        }
        throw err;
      }

      const retryable = res.status === 429 || (res.status >= 500 && safe);
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const tooLong = res.status === 429 && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SEC;
        if (!tooLong) {
          const delayMs = retryAfter !== undefined ? retryAfter * 1000 : this.backoff(attempt);
          await sleep(delayMs, opts.signal);
          continue;
        }
      }
      return res;
    }
  }

  private backoff(attempt: number): number {
    const raw = this.config.retryBaseDelayMs * 2 ** attempt;
    return Math.min(MAX_BACKOFF_MS, Math.round(raw * (0.5 + Math.random() * 0.5)));
  }

  private async once(
    url: string,
    init: RequestInit,
    stream: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const send = this.config.fetch;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    try {
      const res = await send(url, { ...init, signal: controller.signal });
      if (stream && res.ok) {
        // Headers arrived: the timeout no longer applies, but the caller's
        // signal stays linked so the stream can still be aborted.
        clearTimeout(timer);
        return res;
      }
      const buf = await res.arrayBuffer();
      cleanup();
      return new Response(hasNoBody(res.status) ? null : buf, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (err) {
      cleanup();
      if (signal?.aborted) throw err;
      if (timedOut) {
        throw new ConnectionError(`Request timed out after ${timeoutMs} ms`, { category: "timeout", cause: err });
      }
      throw new ConnectionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        { category: "network", cause: err },
      );
    }
  }
}
