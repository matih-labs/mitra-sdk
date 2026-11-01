import createClient from "openapi-fetch";
import {
  MitraError,
  JobFailedError,
  JobTimeoutError,
  embedErrorFromResponse,
  errorFromResponse,
  sourceErrorFromResponse,
} from "./errors.js";
import { HttpClient, sleep, type SendOptions } from "./http.js";
import { parseSSE } from "./sse.js";
import { isTerminalJob } from "./types.js";
import type {
  Answer,
  AskOptions,
  AskAudioParams,
  AskParams,
  Conversation,
  ConversationList,
  ConnectorList,
  AddEmbedSigningKeyParams,
  CreateEmbedParams,
  EmbedOrigins,
  EmbedSigningKey,
  EmbedSigningKeyList,
  CreateInvitationParams,
  CreateSourceParams,
  CreateWebhookParams,
  Dashboard,
  DashboardImageResult,
  DashboardList,
  DuplicateDecision,
  Embed,
  EmbedList,
  Gem,
  GemList,
  GemsResult,
  ImageBytesOptions,
  Invitation,
  InvitationList,
  InvitationRevoked,
  Job,
  LongCallOptions,
  Member,
  MemberList,
  MemberRemoved,
  PredictionParams,
  PredictionResult,
  RequestOptions,
  Source,
  SourceConfig,
  SourceCreated,
  SourceDeleted,
  SourceList,
  SourceTestResult,
  StreamEvent,
  UpdateMemberParams,
  UploadOptions,
  UploadedFile,
  UploadedFileList,
  WaitOptions,
  Webhook,
  WebhookDeliveryList,
  WebhookList,
  WebhookTestResult,
  WorkspaceChosen,
  WorkspaceList,
} from "./types.js";
import { verifyWebhook, type WebhookBody } from "./webhook.js";

/** The host only. The SDK appends `/api/v1`. */
export const DEFAULT_BASE_URL = "https://workspace.matih.ai";

const API_PREFIX = "/api/v1";

/** `https://workspace.matih.ai` -> `https://workspace.matih.ai/api/v1`. A value already ending in `/api/v1` is kept. */
function apiRoot(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  return root.endsWith(API_PREFIX) ? root : root + API_PREFIX;
}

/** Bytes accepted for uploads. */
export type BinaryInput = Blob | ArrayBuffer | Uint8Array;

export interface MitraOptions {
  /** API key (`mtk_...`). Falls back to the MATIH_API_KEY environment variable. */
  apiKey?: string;
  /** OAuth access token (`mto_...`). Falls back to MATIH_ACCESS_TOKEN. */
  accessToken?: string;
  /**
   * The host only, default `https://workspace.matih.ai` (or MATIH_BASE_URL).
   * `/api/v1` is appended for you.
   */
  baseUrl?: string;
  /** Default workspace for every request (OAuth tokens; API keys are pinned). */
  workspaceId?: string;
  /** Default BCP-47 language for response text, e.g. `hi-IN`. */
  language?: string;
  /** Custom fetch implementation, e.g. for tests or proxies. */
  fetch?: typeof fetch;
  /**
   * Per-attempt timeout in milliseconds, covering the response headers (and, for a stream, each gap between
   * events). Default 60000. A request that asks the server to wait gets that wait plus 15 s instead.
   */
  timeoutMs?: number;
  /**
   * Retries for 429 (always), and for 408, 5xx and network failures on safe calls (GET, PUT, DELETE, or a call
   * with an idempotency key). Default 2. Sleeping across all retries of one call is capped at 60 s.
   */
  maxRetries?: number;
  /** Base delay for exponential backoff with jitter, in milliseconds, capped at 8 s per wait. Default 500. */
  retryBaseDelayMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;
const DEFAULT_IMAGE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function enc(id: string): string {
  return encodeURIComponent(id);
}

function toBlob(input: BinaryInput, contentType?: string): Blob {
  if (input instanceof Blob) return input;
  const part = input as unknown as BlobPart;
  return contentType ? new Blob([part], { type: contentType }) : new Blob([part]);
}

function requestOnly(opts: WaitOptions | ImageBytesOptions): RequestOptions {
  return {
    workspaceId: opts.workspaceId,
    language: opts.language,
    signal: opts.signal,
    maxRetries: opts.maxRetries,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class JobsApi {
  constructor(private readonly http: HttpClient) {}

  get<R = Record<string, unknown>>(id: string, opts?: RequestOptions): Promise<Job<R>> {
    return this.http.json<Job<R>>({ method: "GET", path: `/jobs/${enc(id)}`, request: opts });
  }

  cancel(id: string, opts?: RequestOptions): Promise<Job> {
    return this.http.json<Job>({ method: "POST", path: `/jobs/${enc(id)}/cancel`, request: opts });
  }

  /**
   * Poll a job until it reaches a terminal state, backing off between polls.
   * Resolves with the succeeded job. Failed and cancelled jobs throw
   * JobFailedError unless `throwOnFailure` is false; running past `timeoutMs`
   * throws JobTimeoutError (the job itself keeps running).
   */
  async wait<R = Record<string, unknown>>(job: Job<R> | string, opts: WaitOptions = {}): Promise<Job<R>> {
    const id = typeof job === "string" ? job : job.id;
    const timeoutMs = opts.timeoutMs ?? (opts.timeout !== undefined ? opts.timeout * 1000 : DEFAULT_WAIT_TIMEOUT_MS);
    const maxInterval = opts.maxPollIntervalMs ?? 10_000;
    const factor = opts.backoffFactor ?? 1.5;
    const reqOpts = requestOnly(opts);
    const started = Date.now();
    let interval = opts.pollIntervalMs ?? 1000;
    let current: Job<R> = typeof job === "string" ? await this.get<R>(id, reqOpts) : job;

    for (;;) {
      opts.onProgress?.(current as unknown as Job);
      if (isTerminalJob(current)) {
        if (current.state !== "succeeded" && opts.throwOnFailure !== false) {
          throw new JobFailedError(current as unknown as Job);
        }
        return current;
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new JobTimeoutError(id, timeoutMs, current as unknown as Job);
      await sleep(Math.min(interval, remaining), opts.signal);
      interval = Math.min(interval * factor, maxInterval);
      current = await this.get<R>(id, reqOpts);
    }
  }
}

type JobKindName = "gems" | "dashboard" | "prediction";
type ResourceKind = "source" | "file";
type LongKind = JobKindName | ResourceKind;

/** Largest `Prefer: wait` the server honours (jobs 60, sources and files 120), and the default total wait, in seconds. */
const LONG_LIMITS: Record<LongKind, { cap: number; defaultWait: number }> = {
  gems: { cap: 60, defaultWait: 600 },
  dashboard: { cap: 60, defaultWait: 300 },
  prediction: { cap: 60, defaultWait: 1860 },
  source: { cap: 120, defaultWait: 300 },
  file: { cap: 120, defaultWait: 300 },
};

function parseBody(res: Response, text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MitraError("The server returned a response that is not valid JSON", {
      status: res.status,
      category: "invalid_response",
      body: text,
      cause,
    });
  }
}

function longRequest(kind: LongKind, o: SendOptions, opts: LongCallOptions, http: HttpClient) {
  const { wait, background, pollIntervalMs, onProgress, ...request } = opts;
  const { cap, defaultWait } = LONG_LIMITS[kind];
  const seconds = wait ?? defaultWait;
  const sent = Math.max(0, Math.min(Math.floor(seconds), cap));
  const send: SendOptions = {
    ...o,
    headers: background ? o.headers : { ...o.headers, Prefer: `wait=${sent}` },
    // The server may hold the request for `sent` seconds, so the per-attempt timeout must outlast it.
    request: { ...request, timeoutMs: request.timeoutMs ?? Math.max(http.config.timeoutMs, (sent + 15) * 1000) },
  };
  return { send, seconds, background: background === true, pollIntervalMs, onProgress, request };
}

/**
 * Run a job-based call (Gems, dashboard image, prediction). Sends
 * `Prefer: wait=N` (unless `background`); the server answers 200 with the
 * finished job or 202 with the job as it stands. Returns it (`background`), or
 * polls it to the end.
 */
async function jobCall<R>(
  http: HttpClient,
  jobs: JobsApi,
  kind: JobKindName,
  o: SendOptions,
  opts: LongCallOptions = {},
): Promise<Job<R>> {
  const started = Date.now();
  const plan = longRequest(kind, o, opts, http);
  const res = await http.send(plan.send);
  const job = parseBody(res, await res.text()) as Job<R>;
  if (plan.background) return job;
  return jobs.wait<R>(job, {
    workspaceId: plan.request.workspaceId,
    language: plan.request.language,
    signal: plan.request.signal,
    maxRetries: plan.request.maxRetries,
    pollIntervalMs: plan.pollIntervalMs,
    onProgress: plan.onProgress,
    timeoutMs: Math.max(0, plan.seconds * 1000 - (Date.now() - started)),
  });
}

/**
 * Run a resource call (source create, file upload). These are not jobs: the
 * server answers 201 (or 202 for a file still being read) with the resource
 * itself. Sends `Prefer: wait=N` (unless `background`) and then polls the
 * resource until `isDone`. When `wait` runs out the resource is returned as it
 * stands; nothing is thrown.
 */
async function settleCall<T>(
  http: HttpClient,
  kind: ResourceKind,
  o: SendOptions,
  opts: LongCallOptions | undefined,
  isDone: (resource: T) => boolean,
  next: (resource: T) => { path: string; merge: (current: T, polled: any) => T } | undefined,
): Promise<T> {
  const started = Date.now();
  const plan = longRequest(kind, o, opts ?? {}, http);
  const res = await http.send(plan.send);
  let current = parseBody(res, await res.text()) as T;
  if (plan.background || isDone(current)) return current;
  const target = next(current);
  if (target === undefined) return current;

  let interval = plan.pollIntervalMs ?? RESOURCE_POLL_MS;
  const pollRequest: RequestOptions = {
    workspaceId: plan.request.workspaceId,
    language: plan.request.language,
    signal: plan.request.signal,
    maxRetries: plan.request.maxRetries,
  };
  for (;;) {
    const remaining = plan.seconds * 1000 - (Date.now() - started);
    if (remaining <= interval) return current;
    await sleep(interval, plan.request.signal);
    interval = Math.min(interval * 1.5, RESOURCE_POLL_MAX_MS);
    const polled = await http.json<unknown>({ method: "GET", path: target.path, request: pollRequest });
    current = target.merge(current, polled);
    if (isDone(current)) return current;
  }
}

const RESOURCE_POLL_MS = 2000;
const RESOURCE_POLL_MAX_MS = 10_000;

function sourceReady(created: SourceCreated): boolean {
  const readiness = created.source?.readiness;
  return !readiness || readiness.can_ask || readiness.phase === "not_connected";
}

function fileSettled(file: UploadedFile): boolean {
  return (
    file.ready === true ||
    Boolean(file.decision_required) ||
    file.status === "needs_attention" ||
    file.status === "failed" ||
    file.status === "deleting" ||
    file.status === "deleted"
  );
}

class WorkspacesApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<WorkspaceList> {
    return this.http.json<WorkspaceList>({ method: "GET", path: "/workspaces", request: opts });
  }

  /**
   * Set the default workspace on the server (`PUT /me/workspace`) and for later
   * calls on this client. Returns `{ current, name }`.
   */
  async use(workspaceId: string, opts?: RequestOptions): Promise<WorkspaceChosen> {
    const chosen = await this.http.json<WorkspaceChosen>({
      method: "PUT",
      path: "/me/workspace",
      json: { workspace_id: workspaceId },
      request: opts,
    });
    this.http.config.workspaceId = chosen?.current ?? workspaceId;
    return chosen;
  }
}

class SourcesApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<SourceList> {
    return this.http.json<SourceList>({ method: "GET", path: "/sources", request: opts });
  }

  /** One source, including its readiness. */
  get(id: string, opts?: RequestOptions): Promise<Source> {
    return this.http.json<Source>({ method: "GET", path: `/sources/${enc(id)}`, request: opts });
  }

  /** Check a connection config without saving it. */
  test(config: SourceConfig, opts?: RequestOptions): Promise<SourceTestResult> {
    return this.http.json<SourceTestResult>({
      method: "POST",
      path: "/sources/test",
      json: { config },
      request: opts,
    });
  }

  /**
   * Connect a source (workspace admin, `sources:write`). The server tests the
   * connection, saves the source (201) and reads its tables in the background.
   * By default this call waits (`wait` seconds, default 300) until
   * `created.source.readiness.can_ask` is true: the first request carries
   * `Prefer: wait=N` (N at most 120) and the rest is polling `sources.get`.
   * When `wait` runs out the source comes back as it stands (`phase:
   * "building"`); nothing is thrown. `background: true` returns right after the
   * save.
   *
   * A failed connection test throws SourceTestFailedError (HTTP 422, outcome in
   * `testResult`) and saves nothing.
   */
  create(params: CreateSourceParams, opts?: LongCallOptions): Promise<SourceCreated> {
    return settleCall<SourceCreated>(
      this.http,
      "source",
      {
        method: "POST",
        path: "/sources",
        json: { config: params.config, activate: params.activate ?? true },
        mapError: sourceErrorFromResponse,
      },
      opts,
      sourceReady,
      (created) =>
        created.source
          ? {
              path: `/sources/${enc(created.source.id)}`,
              merge: (current, source: Source) => ({ ...current, source }),
            }
          : undefined,
    );
  }

  /** Make a source the workspace's active one. */
  activate(id: string, opts?: RequestOptions): Promise<Source> {
    return this.http.json<Source>({ method: "POST", path: `/sources/${enc(id)}/activate`, request: opts });
  }

  delete(id: string, opts?: RequestOptions): Promise<SourceDeleted> {
    return this.http.json<SourceDeleted>({ method: "DELETE", path: `/sources/${enc(id)}`, request: opts });
  }
}

class MembersApi {
  constructor(private readonly http: HttpClient) {}

  /** Needs the `members:read` scope. */
  list(opts?: RequestOptions): Promise<MemberList> {
    return this.http.json<MemberList>({ method: "GET", path: "/members", request: opts });
  }

  /** Change a member's role to `user` or `admin` (the owner role cannot be given). Needs `members:manage`. */
  update(id: string, params: UpdateMemberParams, opts?: RequestOptions): Promise<Member> {
    return this.http.json<Member>({
      method: "PATCH",
      path: `/members/${enc(id)}`,
      json: { role: params.role },
      request: opts,
    });
  }

  /** Remove a member from the workspace. Needs `members:manage`. */
  remove(id: string, opts?: RequestOptions): Promise<MemberRemoved> {
    return this.http.json<MemberRemoved>({ method: "DELETE", path: `/members/${enc(id)}`, request: opts });
  }
}

class InvitationsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Invite someone by email or phone number (exactly one). `role` defaults to
   * `user`; `whatsappOnly` sends a phone invitation by WhatsApp only. Needs
   * `members:manage`.
   */
  create(params: CreateInvitationParams, opts?: RequestOptions): Promise<Invitation> {
    if (params.email === undefined && params.phone === undefined) {
      return Promise.reject(new TypeError("invitations.create: pass an email or a phone"));
    }
    const body: Record<string, unknown> = { role: params.role ?? "user" };
    if (params.email !== undefined) body["email"] = params.email;
    if (params.phone !== undefined) body["phone"] = params.phone;
    if (params.whatsappOnly !== undefined) body["whatsapp_only"] = params.whatsappOnly;
    return this.http.json<Invitation>({ method: "POST", path: "/invitations", json: body, request: opts });
  }

  list(opts?: RequestOptions): Promise<InvitationList> {
    return this.http.json<InvitationList>({ method: "GET", path: "/invitations", request: opts });
  }

  revoke(id: string, opts?: RequestOptions): Promise<InvitationRevoked> {
    return this.http.json<InvitationRevoked>({ method: "DELETE", path: `/invitations/${enc(id)}`, request: opts });
  }
}

class ConnectorsApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<ConnectorList> {
    return this.http.json<ConnectorList>({ method: "GET", path: "/connectors", request: opts });
  }
}

class FilesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Upload a CSV, Parquet, JSON or Excel file as multipart form data. The
   * server stores it (201, `status: "processing"`) and reads it in the
   * background. By default this call waits (`wait` seconds, default 300) until
   * the file is settled: `ready`, `failed`, `needs_attention` or waiting for a
   * decision. The first request carries `Prefer: wait=N` (N at most 120) and the
   * rest is polling `files.get`. When `wait` runs out the file comes back as it
   * stands; nothing is thrown. `background: true` returns right after the upload.
   *
   * `onDuplicate` is `"ask"` (default: an identical file waits for
   * `files.duplicate`, see `decision_required`) or `"keep_both"`.
   */
  upload(file: BinaryInput, params: UploadOptions = {}, opts?: LongCallOptions): Promise<UploadedFile> {
    const form = new FormData();
    form.append("file", toBlob(file, params.contentType), params.filename ?? "upload");
    if (params.onDuplicate !== undefined) form.append("on_duplicate", params.onDuplicate);
    return settleCall<UploadedFile>(
      this.http,
      "file",
      { method: "POST", path: "/files", form },
      opts,
      fileSettled,
      (uploaded) => ({ path: `/files/${enc(uploaded.id)}`, merge: (_current, polled: UploadedFile) => polled }),
    );
  }

  list(opts?: RequestOptions): Promise<UploadedFileList> {
    return this.http.json<UploadedFileList>({ method: "GET", path: "/files", request: opts });
  }

  /** Status, analysis state and, when relevant, `decision_required`. */
  get(id: string, opts?: RequestOptions): Promise<UploadedFile> {
    return this.http.json<UploadedFile>({ method: "GET", path: `/files/${enc(id)}`, request: opts });
  }

  /** Answer a `decision_required` about a duplicate upload: `use_existing`, `keep_both` or `cancel`. */
  duplicate(id: string, decision: DuplicateDecision, opts?: RequestOptions): Promise<UploadedFile> {
    return this.http.json<UploadedFile>({
      method: "POST",
      path: `/files/${enc(id)}/duplicate`,
      json: { decision },
      request: opts,
    });
  }

  /** Delete a file; returns it with `status: "deleting"`. */
  delete(id: string, opts?: RequestOptions): Promise<UploadedFile> {
    return this.http.json<UploadedFile>({ method: "DELETE", path: `/files/${enc(id)}`, request: opts });
  }
}

/**
 * GET a dashboard's `image.png`. The server answers 303 with a signed URL for an
 * image drawn in the last ten minutes, or 202 with a render job. A redirect is
 * followed here, by hand, so the signed URL is fetched without credentials.
 */
async function fetchDashboardImage(
  http: HttpClient,
  jobs: JobsApi,
  id: string,
  width: number | undefined,
  opts: ImageBytesOptions = {},
): Promise<Uint8Array> {
  const res = await http.execute({
    method: "GET",
    path: `/dashboards/${enc(id)}/image.png`,
    query: { width },
    accept: "image/png, application/json",
    redirect: "manual",
    request: opts,
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) return downloadImage(http, location, opts);
  if (!res.ok) {
    throw errorFromResponse(res.status, res.headers, await res.text());
  }
  if ((res.headers.get("content-type") ?? "").startsWith("image/")) return new Uint8Array(await res.arrayBuffer());

  const queued = (await res.json()) as Job<DashboardImageResult>;
  const done = await jobs.wait<DashboardImageResult>(queued, {
    ...requestOnly(opts),
    timeoutMs: opts.waitTimeoutMs ?? DEFAULT_IMAGE_WAIT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs,
  });
  return downloadImage(http, imageUrlOf(done), opts);
}

function imageUrlOf(done: Job<DashboardImageResult>): string {
  const imageUrl = done.result?.image_url;
  if (typeof imageUrl !== "string" || imageUrl === "") {
    throw new MitraError(`Job ${done.id} finished without an image URL`, {
      status: 0,
      category: "invalid_response",
      body: done,
    });
  }
  return imageUrl;
}

/** Fetch a short-lived signed image URL. It carries its own authority, so no credentials are sent. */
function downloadImage(http: HttpClient, url: string, opts: ImageBytesOptions): Promise<Uint8Array> {
  const absolute = new URL(url, http.config.baseUrl).toString();
  return http.bytes({
    method: "GET",
    url: absolute,
    accept: "image/png",
    auth: false,
    request: { signal: opts.signal, maxRetries: opts.maxRetries },
  });
}

class GemsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly jobs: JobsApi,
  ) {}

  list(params: { source_id?: string } = {}, opts?: RequestOptions): Promise<GemList> {
    return this.http.json<GemList>({
      method: "GET",
      path: "/gems",
      query: { source_id: params.source_id },
      request: opts,
    });
  }

  /**
   * Generate Gems. `source` is optional: without it the workspace's active
   * source is used. The server answers 202 and a job; this call sends
   * `Prefer: wait=N` (N at most 60) and polls until the job ends or `wait`
   * seconds (default 600) pass. `background: true` returns the queued job; use
   * `jobs.wait` or the `gems.ready` webhook.
   */
  generate(source?: string | { source_id?: string }, opts?: LongCallOptions): Promise<Job<GemsResult>> {
    const sourceId = typeof source === "string" ? source : source?.source_id;
    return jobCall<GemsResult>(
      this.http,
      this.jobs,
      "gems",
      { method: "POST", path: "/gems/generate", json: sourceId ? { source_id: sourceId } : undefined },
      opts,
    );
  }

  /** One Gem. `sourceId` picks the source; the default is the active one. */
  get(id: string, sourceId?: string, opts?: RequestOptions): Promise<Gem> {
    return this.http.json<Gem>({
      method: "GET",
      path: `/gems/${enc(id)}`,
      query: { source_id: sourceId },
      request: opts,
    });
  }

  /** The Gem's picture as PNG bytes. */
  image(id: string, sourceId?: string, opts?: RequestOptions): Promise<Uint8Array> {
    return this.http.bytes({
      method: "GET",
      path: `/gems/${enc(id)}/image.png`,
      query: { source_id: sourceId },
      accept: "image/png",
      request: opts,
    });
  }
}

class DashboardsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly jobs: JobsApi,
  ) {}

  list(opts?: RequestOptions): Promise<DashboardList> {
    return this.http.json<DashboardList>({ method: "GET", path: "/dashboards", request: opts });
  }

  get(id: string, opts?: RequestOptions): Promise<Dashboard> {
    return this.http.json<Dashboard>({ method: "GET", path: `/dashboards/${enc(id)}`, request: opts });
  }

  /**
   * Draw a dashboard as an image. The server answers 202 and a job; this call
   * sends `Prefer: wait=N` (N at most 60) and polls until the job ends or `wait`
   * seconds (default 300) pass. The finished job's `result` has `image_url`
   * (valid for about ten minutes). `width` is the image width in pixels.
   * `background: true` returns the queued job. See `imageBytes` for PNG bytes.
   */
  image(id: string, opts: LongCallOptions & { width?: number } = {}): Promise<Job<DashboardImageResult>> {
    const { width, ...rest } = opts;
    return jobCall<DashboardImageResult>(
      this.http,
      this.jobs,
      "dashboard",
      {
        method: "POST",
        path: `/dashboards/${enc(id)}/image`,
        json: width ? { width } : undefined,
      },
      rest,
    );
  }

  /** The dashboard image as PNG bytes: follows the 303 redirect, or waits for the render job on a 202. */
  imageBytes(id: string, opts: ImageBytesOptions & { width?: number } = {}): Promise<Uint8Array> {
    const { width, ...rest } = opts;
    return fetchDashboardImage(this.http, this.jobs, id, width, rest);
  }
}

class PredictionsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly jobs: JobsApi,
  ) {}

  /**
   * Run a forecast or what-if, which can take up to 30 minutes. The server
   * answers 202 and a job; this call sends `Prefer: wait=N` (N at most 60) and
   * polls until the job ends or `wait` seconds (default 1860) pass. The job's
   * `result` is `{ conversation_id, answer }`. `background: true` returns the
   * queued job so you can poll with `jobs.wait` or wait for the
   * `prediction.completed` webhook.
   */
  create(params: PredictionParams, opts?: LongCallOptions): Promise<Job<PredictionResult>> {
    return jobCall<PredictionResult>(
      this.http,
      this.jobs,
      "prediction",
      { method: "POST", path: "/predictions", json: params, autoIdempotency: true },
      opts,
    );
  }
}

class WebhooksApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<WebhookList> {
    return this.http.json<WebhookList>({ method: "GET", path: "/webhooks", request: opts });
  }

  /** Register a webhook. The signing secret is in this response only. */
  create(params: CreateWebhookParams, opts?: RequestOptions): Promise<Webhook> {
    return this.http.json<Webhook>({ method: "POST", path: "/webhooks", json: params, request: opts });
  }

  /** Delete a webhook (HTTP 204). */
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/webhooks/${enc(id)}`, request: opts });
  }

  /** Send a test event to the webhook's URL. */
  test(id: string, opts?: RequestOptions): Promise<WebhookTestResult> {
    return this.http.json<WebhookTestResult>({
      method: "POST",
      path: `/webhooks/${enc(id)}/test`,
      request: opts,
    });
  }

  /** Recent delivery attempts for a webhook. */
  deliveries(id: string, opts?: RequestOptions): Promise<WebhookDeliveryList> {
    return this.http.json<WebhookDeliveryList>({
      method: "GET",
      path: `/webhooks/${enc(id)}/deliveries`,
      request: opts,
    });
  }
}

/**
 * The public keys your backend signs viewer tokens with (`/embeds/keys`, docs/EMBEDDED_ANALYTICS.md
 * section 1b). Needs `embeds:create`. Register the PUBLIC half only: a private key is refused and
 * never stored. Errors map like `embeds.create`: 422 `EmbedRefusedError` (read `code`:
 * `key_private`, `key_invalid`, `alg_unsupported`, `key_too_weak`, `kid_missing`), 404
 * `EmbedNotFoundError`; 409 (`kid_taken`, `too_many_keys`) is the default conflict error.
 */
class EmbedKeysApi {
  constructor(private readonly http: HttpClient) {}

  /** Register a public key (HTTP 201). An integration has at most 5 live keys. */
  add(params: AddEmbedSigningKeyParams, opts?: RequestOptions): Promise<EmbedSigningKey> {
    if (typeof params.publicKey !== "string" && (typeof params.publicKey !== "object" || params.publicKey === null)) {
      return Promise.reject(new TypeError("embeds.keys.add: publicKey must be a PEM string or a JWK object"));
    }
    const body: Record<string, unknown> = { public_key: params.publicKey };
    if (params.kid !== undefined) body["kid"] = params.kid;
    if (params.alg !== undefined) body["alg"] = params.alg;
    return this.http.json<EmbedSigningKey>({
      method: "POST",
      path: "/embeds/keys",
      json: body,
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }

  /** This integration's keys, live and revoked, oldest first. */
  list(opts?: RequestOptions): Promise<EmbedSigningKeyList> {
    return this.http.json<EmbedSigningKeyList>({
      method: "GET",
      path: "/embeds/keys",
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }

  /** Revoke a key by its `esk_...` id (HTTP 204, idempotent). Tokens it signed stop at their next request. */
  async revoke(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({
      method: "DELETE",
      path: `/embeds/keys/${enc(id)}`,
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }
}

/**
 * The origins your own signed tokens may be framed by (`/embeds/origins`). Needs `embeds:create`.
 * The page URL of a token you sign carries only your integration's id (`?e=<integration id>`),
 * never the JWT, so the frame check uses these: 1 to 10 exact origins, validated like a mint's.
 * A token whose `matih.origins` are not among them is refused (`origins_not_registered`).
 * A 422 is `EmbedRefusedError` (`invalid_origin`).
 */
class EmbedOriginsApi {
  constructor(private readonly http: HttpClient) {}

  /** The registered origins; empty until set. */
  get(opts?: RequestOptions): Promise<EmbedOrigins> {
    return this.http.json<EmbedOrigins>({
      method: "GET",
      path: "/embeds/origins",
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }

  /** Replace the registered origins (1 to 10, `https` except `http://localhost`). Returns them as stored (lower case). */
  set(origins: readonly string[], opts?: RequestOptions): Promise<EmbedOrigins> {
    if (!Array.isArray(origins) || origins.some((o) => typeof o !== "string")) {
      return Promise.reject(new TypeError("embeds.origins.set: origins must be an array of strings"));
    }
    return this.http.json<EmbedOrigins>({
      method: "PUT",
      path: "/embeds/origins",
      json: { origins },
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }
}

class EmbedsApi {
  /** The public keys you sign viewer tokens with: `add`, `list`, `revoke`. */
  readonly keys: EmbedKeysApi;
  /** The origins your own signed tokens may be framed by: `get`, `set`. */
  readonly origins: EmbedOriginsApi;

  constructor(private readonly http: HttpClient) {
    this.keys = new EmbedKeysApi(http);
    this.origins = new EmbedOriginsApi(http);
  }

  /**
   * Mint a short-lived embed token (`POST /embeds`; free; every call mints a new one, so it is
   * never retried after a 5xx). Needs `embeds:create`. Call it from your backend: the API key
   * must never reach the browser. Pass `embedSrc(embed)` and `embed.token` to `<matih-embed>`.
   *
   * Pass `viewer` to vouch for your end user (`{ external_id, name?, email?, phone?, locale?,
   * attributes? }`); the response then carries `viewer.id`. To skip this call per page, sign the
   * token yourself instead: see `embeds.keys` and the README.
   *
   * Throws EmbedRefusedError (422, read `code`), EmbedNotFoundError (404) or PermissionError (403).
   */
  create(params: CreateEmbedParams, opts?: RequestOptions): Promise<Embed> {
    const r = params.resource as { type?: unknown; id?: unknown } | undefined;
    if (!r || typeof r.type !== "string" || typeof r.id !== "string") {
      return Promise.reject(new TypeError('embeds.create: resource must be { type: "dashboard" | "gems" | "ask", id }'));
    }
    if (!Array.isArray(params.origins) || params.origins.length === 0) {
      return Promise.reject(new TypeError("embeds.create: origins must be a non-empty array of exact origins"));
    }
    const body: Record<string, unknown> = {
      resource: { type: r.type, id: r.id },
      origins: [...params.origins],
    };
    if (params.filters !== undefined) body["filters"] = params.filters;
    if (params.ttlSeconds !== undefined) body["ttl_seconds"] = params.ttlSeconds;
    if (params.viewer !== undefined) body["viewer"] = params.viewer;
    return this.http.json<Embed>({
      method: "POST",
      path: "/embeds",
      json: body,
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }

  /** Tokens minted by this key (`embeds:read`): never the secret or the filter values. */
  list(opts?: RequestOptions): Promise<EmbedList> {
    return this.http.json<EmbedList>({
      method: "GET",
      path: "/embeds",
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }

  /** Revoke one token of this key by its `emt_...` id (HTTP 204, idempotent). Needs `embeds:create`. */
  async revoke(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({
      method: "DELETE",
      path: `/embeds/${enc(id)}`,
      request: opts,
      mapError: embedErrorFromResponse,
    });
  }
}

class ConversationsApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<ConversationList> {
    return this.http.json<ConversationList>({ method: "GET", path: "/conversations", request: opts });
  }

  get(id: string, opts?: RequestOptions): Promise<Conversation> {
    return this.http.json<Conversation>({ method: "GET", path: `/conversations/${enc(id)}`, request: opts });
  }
}

export class Mitra {
  readonly workspaces: WorkspacesApi;
  readonly sources: SourcesApi;
  readonly connectors: ConnectorsApi;
  readonly files: FilesApi;
  readonly gems: GemsApi;
  readonly dashboards: DashboardsApi;
  readonly predictions: PredictionsApi;
  readonly jobs: JobsApi;
  readonly webhooks: WebhooksApi;
  readonly conversations: ConversationsApi;
  readonly members: MembersApi;
  readonly invitations: InvitationsApi;
  readonly embeds: EmbedsApi;
  /**
   * An openapi-fetch client with loose typing for endpoints without a
   * dedicated method. It shares this client's headers, retries and timeouts.
   */
  readonly raw: ReturnType<typeof createClient<any>>;

  private readonly http: HttpClient;

  constructor(options: MitraOptions = {}) {
    const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
    if (options.apiKey && options.accessToken) {
      throw new TypeError("Mitra: pass either apiKey or accessToken, not both");
    }
    const credential =
      options.apiKey || options.accessToken || env["MATIH_API_KEY"] || env["MATIH_ACCESS_TOKEN"];
    if (!credential) {
      throw new TypeError(
        "Mitra: no credential. Pass apiKey or accessToken, or set MATIH_API_KEY or MATIH_ACCESS_TOKEN.",
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Mitra: no fetch implementation available; use Node 18+ or pass options.fetch");
    }

    this.http = new HttpClient({
      baseUrl: apiRoot(options.baseUrl || env["MATIH_BASE_URL"] || DEFAULT_BASE_URL),
      credential,
      fetch: fetchImpl,
      workspaceId: options.workspaceId,
      language: options.language,
      timeoutMs: options.timeoutMs ?? 60_000,
      maxRetries: options.maxRetries ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
    });

    this.jobs = new JobsApi(this.http);
    this.workspaces = new WorkspacesApi(this.http);
    this.sources = new SourcesApi(this.http);
    this.connectors = new ConnectorsApi(this.http);
    this.files = new FilesApi(this.http);
    this.gems = new GemsApi(this.http, this.jobs);
    this.dashboards = new DashboardsApi(this.http, this.jobs);
    this.predictions = new PredictionsApi(this.http, this.jobs);
    this.webhooks = new WebhooksApi(this.http);
    this.conversations = new ConversationsApi(this.http);
    this.members = new MembersApi(this.http);
    this.invitations = new InvitationsApi(this.http);
    this.embeds = new EmbedsApi(this.http);

    const http = this.http;
    this.raw = createClient<any>({
      baseUrl: http.config.baseUrl,
      fetch: async (req: Request): Promise<Response> => {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, name) => {
          headers[name] = value;
        });
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        return http.execute({
          method: req.method,
          url: req.url,
          headers,
          rawBody: hasBody ? await req.arrayBuffer() : undefined,
        });
      },
    });
  }

  /**
   * Ask a question of your data. Spends credits; safe to retry (an
   * Idempotency-Key is generated). With `{ background: true }` the server is
   * asked to answer asynchronously (`Prefer: respond-async`) and a job of kind
   * `ask` comes back at once; follow it with `jobs.wait`, and its `result` is
   * the Answer. Without it the call waits for the answer (HTTP 200), or, if the
   * server answers 202 anyway, for the job (`wait` seconds, default 600).
   */
  ask(question: string | AskParams, opts: AskOptions & { background: true }): Promise<Job<Answer>>;
  ask(question: string | AskParams, opts?: AskOptions & { background?: false }): Promise<Answer>;
  async ask(question: string | AskParams, opts: AskOptions = {}): Promise<Answer | Job<Answer>> {
    const { background, wait, ...request } = opts;
    const body = typeof question === "string" ? { question } : question;
    const res = await this.http.send({
      method: "POST",
      path: "/ask",
      json: body,
      autoIdempotency: true,
      headers: background ? { Prefer: "respond-async" } : undefined,
      request,
    });
    const payload = parseBody(res, await res.text());
    if (res.status !== 202) return payload as Answer;
    const queued = payload as Job<Answer>;
    if (background) return queued;
    const done = await this.jobs.wait<Answer>(queued, {
      workspaceId: request.workspaceId,
      language: request.language,
      signal: request.signal,
      maxRetries: request.maxRetries,
      timeout: wait ?? 600,
    });
    return done.result as Answer;
  }

  /**
   * Ask and receive progress as server-sent events (`started`, `progress`,
   * `answer`, `error`). An `error` event is yielded, not thrown; HTTP-level
   * failures before the stream starts throw typed errors.
   */
  async *askStream(
    question: string | AskParams,
    opts?: RequestOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const base = typeof question === "string" ? { question } : question;
    const res = await this.http.send({
      method: "POST",
      path: "/ask",
      json: { ...base, stream: true },
      accept: "text/event-stream",
      autoIdempotency: true,
      stream: true,
      request: opts,
    });
    if (res.body === null) {
      throw new MitraError("The server returned no response body for a streamed answer", {
        status: res.status,
        category: "invalid_response",
        requestId: res.headers.get("x-request-id") ?? undefined,
      });
    }
    for await (const message of parseSSE(res.body, opts?.timeoutMs ?? this.http.config.timeoutMs)) {
      const event: StreamEvent = { event: message.event, data: tryParseJson(message.data) };
      if (message.id !== undefined) event.id = message.id;
      yield event;
    }
  }

  /**
   * Ask by voice note (`POST /ask/audio`). Spends credits. The answer includes
   * `heard` with the transcript and detected language. No Idempotency-Key is
   * sent unless you pass `idempotencyKey`.
   */
  askAudio(file: BinaryInput, params: AskAudioParams = {}, opts?: RequestOptions): Promise<Answer> {
    const form = new FormData();
    form.append("file", toBlob(file, params.contentType), params.filename ?? "audio");
    if (params.conversationId !== undefined) form.append("conversation_id", params.conversationId);
    if (params.sourceId !== undefined) form.append("source_id", params.sourceId);
    if (params.language !== undefined) form.append("language", params.language);
    return this.http.json<Answer>({
      method: "POST",
      path: "/ask/audio",
      form,
      request: { ...opts, language: opts?.language ?? params.language },
    });
  }

  /** Method form of the exported `verifyWebhook`. */
  verifyWebhook(
    secret: string,
    header: string | null | undefined,
    body: WebhookBody,
    toleranceSec: number = 300,
  ): boolean {
    return verifyWebhook(secret, header, body, toleranceSec);
  }
}
