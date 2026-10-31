import createClient from "openapi-fetch";
import { MitraError, JobFailedError, JobTimeoutError, sourceErrorFromResponse } from "./errors.js";
import { HttpClient, sleep } from "./http.js";
import { parseSSE } from "./sse.js";
import { isTerminalJob } from "./types.js";
import type {
  Answer,
  AskAudioParams,
  AskParams,
  Conversation,
  ConversationList,
  ConnectorList,
  CreateInvitationParams,
  CreateSourceParams,
  CreateWebhookParams,
  Dashboard,
  DashboardImageResult,
  DashboardList,
  DuplicateDecision,
  Gem,
  GemList,
  ImageBytesOptions,
  InvitationList,
  Invitation,
  Job,
  Member,
  MemberList,
  PredictionParams,
  PredictionResult,
  RequestOptions,
  Source,
  SourceConfig,
  SourceDetail,
  SourceList,
  StreamEvent,
  UploadOptions,
  UpdateMemberParams,
  UploadedFile,
  UploadedFileList,
  WaitOptions,
  Webhook,
  WebhookDeliveryList,
  WebhookList,
  WorkspaceList,
} from "./types.js";
import { verifyWebhook, type WebhookBody } from "./webhook.js";

export const DEFAULT_BASE_URL = "https://workspace.matih.ai/api/v1";

/** Bytes accepted for uploads. */
export type BinaryInput = Blob | ArrayBuffer | Uint8Array;

export interface MitraOptions {
  /** API key (`mtk_...`). Falls back to the MITRA_API_KEY environment variable. */
  apiKey?: string;
  /** OAuth access token (`mto_...`). Falls back to MITRA_ACCESS_TOKEN. */
  accessToken?: string;
  /** API base URL including the version prefix. Default `https://workspace.matih.ai/api/v1`. */
  baseUrl?: string;
  /** Default workspace for every request (OAuth tokens; API keys are pinned). */
  workspaceId?: string;
  /** Default BCP-47 language for response text, e.g. `hi-IN`. */
  language?: string;
  /** Custom fetch implementation, e.g. for tests or proxies. */
  fetch?: typeof fetch;
  /** Per-attempt timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Retries for 429 and for 5xx or network failures on safe calls. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. Default 500. */
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
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
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

class WorkspacesApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<WorkspaceList> {
    return this.http.json<WorkspaceList>({ method: "GET", path: "/workspaces", request: opts });
  }

  /** Set the default workspace on the server and for later calls on this client. */
  async use(workspaceId: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({
      method: "PUT",
      path: "/me/workspace",
      json: { workspace_id: workspaceId },
      request: opts,
    });
    this.http.config.workspaceId = workspaceId;
  }
}

class SourcesApi {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<SourceList> {
    return this.http.json<SourceList>({ method: "GET", path: "/sources", request: opts });
  }

  /** One source, including its readiness. */
  get(id: string, opts?: RequestOptions): Promise<SourceDetail> {
    return this.http.json<SourceDetail>({ method: "GET", path: `/sources/${enc(id)}`, request: opts });
  }

  /** Check a connection config without saving it. */
  test(config: SourceConfig, opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.http.json<Record<string, unknown>>({
      method: "POST",
      path: "/sources/test",
      json: { config },
      request: opts,
    });
  }

  /**
   * Create a source (needs a workspace admin and the `sources:write` scope).
   * The connection is tested first; when the test fails nothing is saved and
   * SourceTestFailedError is thrown with the test outcome in `testResult`.
   */
  create(params: CreateSourceParams, opts?: RequestOptions): Promise<Source> {
    return this.http.json<Source>({
      method: "POST",
      path: "/sources",
      json: { config: params.config, activate: params.activate ?? true },
      request: opts,
      mapError: sourceErrorFromResponse,
    });
  }

  /** Make a source the workspace's active one. */
  activate(id: string, opts?: RequestOptions): Promise<Source> {
    return this.http.json<Source>({ method: "POST", path: `/sources/${enc(id)}/activate`, request: opts });
  }

  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/sources/${enc(id)}`, request: opts });
  }
}

class MembersApi {
  constructor(private readonly http: HttpClient) {}

  /** Needs the `members:read` scope. */
  list(opts?: RequestOptions): Promise<MemberList> {
    return this.http.json<MemberList>({ method: "GET", path: "/members", request: opts });
  }

  /** Change a member's role. Needs `members:manage`. */
  update(id: string, params: UpdateMemberParams, opts?: RequestOptions): Promise<Member> {
    return this.http.json<Member>({
      method: "PATCH",
      path: `/members/${enc(id)}`,
      json: { role: params.role },
      request: opts,
    });
  }

  /** Remove a member from the workspace. Needs `members:manage`. */
  async remove(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/members/${enc(id)}`, request: opts });
  }
}

class InvitationsApi {
  constructor(private readonly http: HttpClient) {}

  /** Invite someone by email or phone number. Needs `members:manage`. */
  create(params: CreateInvitationParams, opts?: RequestOptions): Promise<Invitation> {
    if (params.email === undefined && params.phone === undefined) {
      return Promise.reject(new TypeError("invitations.create: pass an email or a phone"));
    }
    const body: Record<string, unknown> = { role: params.role };
    if (params.email !== undefined) body["email"] = params.email;
    if (params.phone !== undefined) body["phone"] = params.phone;
    return this.http.json<Invitation>({ method: "POST", path: "/invitations", json: body, request: opts });
  }

  list(opts?: RequestOptions): Promise<InvitationList> {
    return this.http.json<InvitationList>({ method: "GET", path: "/invitations", request: opts });
  }

  async revoke(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/invitations/${enc(id)}`, request: opts });
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

  /** Upload a CSV or Excel file as multipart form data. */
  upload(file: BinaryInput, params: UploadOptions = {}, opts?: RequestOptions): Promise<UploadedFile> {
    const form = new FormData();
    form.append("file", toBlob(file, params.contentType), params.filename ?? "upload");
    if (params.onDuplicate !== undefined) form.append("on_duplicate", params.onDuplicate);
    return this.http.json<UploadedFile>({ method: "POST", path: "/files", form, request: opts });
  }

  list(opts?: RequestOptions): Promise<UploadedFileList> {
    return this.http.json<UploadedFileList>({ method: "GET", path: "/files", request: opts });
  }

  /** Status, analysis state and, when relevant, `decision_required`. */
  get(id: string, opts?: RequestOptions): Promise<UploadedFile> {
    return this.http.json<UploadedFile>({ method: "GET", path: `/files/${enc(id)}`, request: opts });
  }

  /** Answer a `decision_required` about a duplicate upload. */
  duplicate(id: string, decision: DuplicateDecision, opts?: RequestOptions): Promise<UploadedFile> {
    return this.http.json<UploadedFile>({
      method: "POST",
      path: `/files/${enc(id)}/duplicate`,
      json: { decision },
      request: opts,
    });
  }

  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/files/${enc(id)}`, request: opts });
  }
}

/**
 * GET an authenticated .png endpoint. A cached image comes back as bytes; a
 * render in progress comes back as a 202 job, which is awaited and then
 * downloaded from its short-lived signed URL (sent without credentials).
 */
async function fetchImage(
  http: HttpClient,
  jobs: JobsApi,
  path: string,
  opts: ImageBytesOptions = {},
): Promise<Uint8Array> {
  const res = await http.send({
    method: "GET",
    path,
    accept: "image/png, application/json",
    request: opts,
  });
  if (res.status !== 202) return new Uint8Array(await res.arrayBuffer());

  const queued = (await res.json()) as Job<DashboardImageResult>;
  const done = await jobs.wait<DashboardImageResult>(queued, {
    ...requestOnly(opts),
    timeoutMs: opts.waitTimeoutMs ?? DEFAULT_IMAGE_WAIT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs,
  });
  const imageUrl = done.result?.image_url;
  if (typeof imageUrl !== "string" || imageUrl === "") {
    throw new MitraError(`Job ${done.id} finished without an image URL`, {
      status: 0,
      category: "invalid_response",
      body: done,
    });
  }
  const absolute = new URL(imageUrl, http.config.baseUrl).toString();
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

  /** Start generating Gems for a source. Returns a job; use `jobs.wait`. */
  generate(source: string | { source_id: string }, opts?: RequestOptions): Promise<Job> {
    const sourceId = typeof source === "string" ? source : source.source_id;
    return this.http.json<Job>({
      method: "POST",
      path: "/gems/generate",
      json: { source_id: sourceId },
      autoIdempotency: true,
      request: opts,
    });
  }

  get(id: string, opts?: RequestOptions): Promise<Gem> {
    return this.http.json<Gem>({ method: "GET", path: `/gems/${enc(id)}`, request: opts });
  }

  /** The Gem's picture as PNG bytes. */
  image(id: string, opts?: ImageBytesOptions): Promise<Uint8Array> {
    return fetchImage(this.http, this.jobs, `/gems/${enc(id)}/image.png`, opts);
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

  /** Start rendering a dashboard image. Returns a job whose result has `image_url`. */
  image(id: string, opts?: RequestOptions): Promise<Job<DashboardImageResult>> {
    return this.http.json<Job<DashboardImageResult>>({
      method: "POST",
      path: `/dashboards/${enc(id)}/image`,
      autoIdempotency: true,
      request: opts,
    });
  }

  /** The dashboard image as PNG bytes, waiting for a render when none is cached. */
  imageBytes(id: string, opts?: ImageBytesOptions): Promise<Uint8Array> {
    return fetchImage(this.http, this.jobs, `/dashboards/${enc(id)}/image.png`, opts);
  }
}

class PredictionsApi {
  constructor(private readonly http: HttpClient) {}

  /** Start a prediction. Returns a job that can take up to 30 minutes. */
  create(params: PredictionParams, opts?: RequestOptions): Promise<Job<PredictionResult>> {
    return this.http.json<Job<PredictionResult>>({
      method: "POST",
      path: "/predictions",
      json: params,
      autoIdempotency: true,
      request: opts,
    });
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

  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/webhooks/${enc(id)}`, request: opts });
  }

  /** Send a test delivery to the webhook's URL. */
  test(id: string, opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.http.json<Record<string, unknown>>({
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
      options.apiKey || options.accessToken || env["MITRA_API_KEY"] || env["MITRA_ACCESS_TOKEN"];
    if (!credential) {
      throw new TypeError(
        "Mitra: no credential. Pass apiKey or accessToken, or set MITRA_API_KEY or MITRA_ACCESS_TOKEN.",
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Mitra: no fetch implementation available; use Node 18+ or pass options.fetch");
    }

    this.http = new HttpClient({
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
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
    this.predictions = new PredictionsApi(this.http);
    this.webhooks = new WebhooksApi(this.http);
    this.conversations = new ConversationsApi(this.http);
    this.members = new MembersApi(this.http);
    this.invitations = new InvitationsApi(this.http);

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

  /** Ask a question of your data. Spends credits; safe to retry. */
  ask(question: string | AskParams, opts?: RequestOptions): Promise<Answer> {
    const body = typeof question === "string" ? { question } : question;
    return this.http.json<Answer>({
      method: "POST",
      path: "/ask",
      json: body,
      autoIdempotency: true,
      request: opts,
    });
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
    for await (const message of parseSSE(res.body)) {
      const event: StreamEvent = { event: message.event, data: tryParseJson(message.data) };
      if (message.id !== undefined) event.id = message.id;
      yield event;
    }
  }

  /**
   * Ask by voice note. Spends credits; safe to retry. The answer includes
   * `heard` with the transcript and detected language.
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
      autoIdempotency: true,
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
