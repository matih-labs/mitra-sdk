/**
 * Hand-written types for the Mitra public API. They intentionally do not
 * depend on the generated `schema.d.ts`, so the package compiles without it.
 */

/** Options accepted by every API method as the last argument. */
export interface RequestOptions {
  /** Workspace to act in for this request (sent as `X-Matih-Workspace`). */
  workspaceId?: string;
  /** BCP-47 language tag for human-readable text in the response, e.g. `hi-IN`. */
  language?: string;
  /** Idempotency key. Credit-spending calls generate one automatically. */
  idempotencyKey?: string;
  /** Abort the request (and any retries). */
  signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds. Overrides the client default. */
  timeoutMs?: number;
  /** Maximum retries. Overrides the client default. */
  maxRetries?: number;
}

export interface Column {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: Column[];
  rows: unknown[];
  row_count: number;
  truncated: boolean;
}

export interface Clarification {
  question: string;
  options: string[];
}

export type AnswerStatus = "answered" | "empty" | "clarification" | "error" | "cancelled";

/** What the speech recogniser heard, returned for voice questions. */
export interface Heard {
  transcript: string;
  language: string;
}

export interface Answer {
  status: AnswerStatus;
  answer: string;
  clarification: Clarification | null;
  result: QueryResult | null;
  sql: string | null;
  image_url: string | null;
  follow_ups: string[];
  conversation_id: string;
  request_id: string;
  /** The language the response text was produced in. */
  language: string;
  /** Present for answers to voice notes sent with `askAudio`. */
  heard?: Heard;
}

export interface AskParams {
  question: string;
  conversation_id?: string;
  source_id?: string;
  language?: string;
}

export interface AskAudioParams {
  conversationId?: string;
  sourceId?: string;
  /** BCP-47 language of the recording, e.g. `hi-IN`. Detected when omitted. */
  language?: string;
  /** File name sent with the upload. Defaults to `audio`. */
  filename?: string;
  /** MIME type of the recording when passing raw bytes, e.g. `audio/ogg`. */
  contentType?: string;
}

/** One server-sent event from a streamed answer. */
export interface StreamEvent {
  /** `started`, `progress`, `answer` or `error`; other names pass through. */
  event: string;
  /** Parsed JSON when the payload is JSON, the raw string otherwise. */
  data: unknown;
  id?: string;
}

export type JobKind = "ask" | "gems" | "prediction" | "dashboard_image";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobError {
  category: string;
  message: string;
  code?: string;
}

/**
 * Work that outlasts a request. `result` is set once it succeeded: for `ask` the
 * Answer, for `gems` `{ source_id, state, gem_count }`, for `prediction`
 * `{ conversation_id, answer }` and for `dashboard_image` `{ image_url, width, height }`.
 */
export interface Job<R = Record<string, unknown>> {
  id: string;
  kind: JobKind;
  state: JobState;
  result: R | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardImageResult {
  image_url: string;
  width: number;
  height: number;
}

export interface GemsResult {
  source_id: string;
  state: string;
  gem_count: number;
}

/** `result` of a succeeded prediction job. */
export interface PredictionResult {
  conversation_id: string;
  answer: Answer;
}

export interface PredictionParams {
  question: string;
  source_id?: string;
  conversation_id?: string;
  /** BCP-47 language of the response text, e.g. `hi-IN`. */
  language?: string;
}

export interface WaitOptions extends Omit<RequestOptions, "timeoutMs" | "idempotencyKey"> {
  /** Overall time to wait before throwing JobTimeoutError. Default 35 minutes. */
  timeoutMs?: number;
  /** First delay between polls. Default 1000. */
  pollIntervalMs?: number;
  /** Upper bound for the delay between polls. Default 10000. */
  maxPollIntervalMs?: number;
  /** Multiplier applied to the delay after every poll. Default 1.5. */
  backoffFactor?: number;
  /** Called with every observed job state, including the final one. */
  onProgress?: (job: Job) => void;
  /** Throw JobFailedError for failed and cancelled jobs. Default true. */
  throwOnFailure?: boolean;
  /** Overall time to wait in seconds. Same as `timeoutMs`, in seconds; `timeoutMs` wins if both are set. */
  timeout?: number;
}

/**
 * Options for calls that can outlive one request: Gem generation, predictions,
 * dashboard images, source creation and file uploads.
 *
 * By default the call blocks: it sends `Prefer: wait=N` (N is at most 60 for
 * jobs, 120 for sources and files).
 *
 * - Jobs (gems, dashboard images, predictions): when the job is not finished, the
 *   job is polled until it ends or `wait` runs out (then JobTimeoutError; the
 *   job keeps running).
 * - Sources and files are not jobs: the resource is polled (`sources.get`,
 *   `files.get`) until it is ready, and returned as it stands when `wait` runs
 *   out. Nothing is thrown.
 *
 * With `background: true` the call returns right away with what the server
 * answered: a job to follow with `jobs.wait` or a webhook, or the saved
 * source or stored file to follow with `get`.
 */
export interface LongCallOptions extends RequestOptions {
  /** Seconds to wait in total. Defaults depend on the call (5 to 31 minutes). */
  wait?: number;
  /** Return immediately with what the server answered. */
  background?: boolean;
  /** First delay between job polls. Default 1000. */
  pollIntervalMs?: number;
  /** Called with every observed job state while waiting. */
  onProgress?: (job: Job) => void;
}

/** Options for `ask`. With `background: true` the answer is delivered through a job. */
export interface AskOptions extends RequestOptions {
  /** Send `Prefer: respond-async` and return the job (kind `ask`) at once; its `result` is the Answer. */
  background?: boolean;
  /** Seconds to wait for a job the server chose to run asynchronously. Default 10 minutes. */
  wait?: number;
}

/** Options for calls that return image bytes and may wait on a render job. */
export interface ImageBytesOptions extends RequestOptions {
  /** Overall time to wait for a render job. Default 5 minutes. */
  waitTimeoutMs?: number;
  /** First delay between job polls. Default 1000. */
  pollIntervalMs?: number;
}

/** OAuth and API key scopes. */
export type Scope =
  | "workspaces:read"
  | "sources:read"
  | "sources:write"
  | "files:read"
  | "files:write"
  | "gems:read"
  | "gems:generate"
  | "ask"
  | "dashboards:read"
  | "predict"
  | "members:read"
  | "members:manage"
  | "webhooks:manage";

export type Role = "owner" | "admin" | "user" | "viewer";
/** Roles you can give: never `owner`. */
export type GivableRole = "admin" | "user" | "viewer";
/** Kept for compatibility; same as `Role`. */
export type MemberRole = Role;

export interface Workspace {
  id: string;
  name: string;
  role: Role;
  kind: string;
  own: boolean;
}

/** An open invitation addressed to the caller. */
export interface WorkspaceInvitation {
  id: string;
  workspace_id?: string;
  workspace_name?: string;
  role?: Role;
  invited_by?: string | null;
  expires_at?: string;
  [key: string]: unknown;
}

export interface WorkspaceList {
  current: string | null;
  workspaces: Workspace[];
  invitations?: WorkspaceInvitation[] | null;
}

export interface WorkspaceChosen {
  current: string;
  name?: string;
}

export interface Catalog {
  readiness: string;
  notes: string[];
  tables: number;
  included_tables: number;
  last_refresh_at?: string | null;
  published_version?: number | null;
  reading_now: boolean;
}

/** `can_ask` is true once Ask can use the source; `phase` is `ready`, `building` or `not_connected`. */
export interface SourceReadiness {
  source_id: string;
  state: string;
  phase: "ready" | "building" | "not_connected";
  can_ask: boolean;
  message: string;
  catalog?: Catalog | null;
}

export interface Source {
  id: string;
  name: string;
  connector_type: string;
  settings: Record<string, unknown>;
  /** Names of the secret fields that are set; their values are never returned. */
  secret_fields_set: string[];
  state: string;
  is_active: boolean;
  is_sample: boolean;
  managed_by?: string | null;
  last_test_ok?: boolean | null;
  last_test_message?: string | null;
  created_at: string;
  updated_at: string;
  readiness?: SourceReadiness | null;
}

/** Kept for compatibility; same as `Source`. */
export type SourceDetail = Source;

export interface SourceList {
  sources: Source[];
  active_source_id?: string | null;
}

/** `connector_type` plus that type's fields (see `connectors.list`), including any credentials. */
export type SourceConfig = Record<string, unknown>;

export interface SourceTestResult {
  ok: boolean;
  connector_type: string;
  duration_ms: number;
  message: string;
  error_category?: string | null;
  server_version?: string | null;
  warnings: string[];
  field?: string | null;
}

/** What `sources.create` returns. Check `source.readiness.can_ask` before asking. */
export interface SourceCreated {
  source: Source | null;
  test: SourceTestResult | null;
  applied: boolean;
  catalog_job_id?: string | null;
}

export interface SourceDeleted {
  deleted: boolean;
}

export interface CreateSourceParams {
  config: SourceConfig;
  /** Make the new source the active one. Default true. */
  activate?: boolean;
}

export interface ConnectorField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  secret?: boolean;
  default?: unknown;
  help?: string | null;
  options?: { value: string; label: string }[] | null;
  visible_when?: Record<string, string[]> | null;
  group?: string | null;
  advanced?: boolean;
}

export interface Connector {
  type: string;
  label?: string;
  description?: string;
  docs_url?: string | null;
  notes: string[];
  driver_installed: boolean;
  fields: ConnectorField[];
}

/** Connector types and the fields each takes. */
export interface ConnectorList {
  connectors: Connector[];
}

export type FileStatus =
  | "uploading"
  | "validating"
  | "processing"
  | "ready"
  | "needs_attention"
  | "failed"
  | "deleting"
  | "deleted";

export interface FileTableRef {
  model_name: string;
  label?: string;
  rows?: number | null;
  column_count?: number | null;
}

/**
 * An uploaded file. `ready` is true once its tables can be asked about;
 * `decision_required: "duplicate"` means it waits for `files.duplicate`.
 */
export interface UploadedFile {
  id: string;
  name: string;
  format?: string | null;
  size_bytes: number;
  status: FileStatus;
  stage?: string | null;
  ready: boolean;
  analysis_state?: string | null;
  warnings: string[];
  error_category?: string | null;
  error_message?: string | null;
  retryable: boolean;
  duplicate_of?: string | null;
  decision_required?: "duplicate" | null;
  decision_options: DuplicateDecision[];
  tables: FileTableRef[];
  uploaded_at?: string | null;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadedFileList {
  files: UploadedFile[];
  total: number;
}

/** How to resolve a duplicate upload: use the earlier file, keep both, or drop this one. */
export type DuplicateDecision = "use_existing" | "keep_both" | "cancel";

export interface UploadOptions {
  filename?: string;
  contentType?: string;
  /** `ask` (default) waits for your decision on an identical file; `keep_both` keeps both. */
  onDuplicate?: "ask" | "keep_both";
}

export interface Figure {
  label: string;
  value: string;
}

export interface Gem {
  id: string;
  kind: string;
  headline: string;
  explanation: string;
  figures: Figure[];
  question?: string | null;
  source_id?: string | null;
  image_url?: string | null;
  created_at?: string | null;
}

export type GemFeedState =
  | "none"
  | "running"
  | "ready"
  | "partial"
  | "empty"
  | "insufficient"
  | "failed"
  | "not_ready"
  | "no_source";

export interface GemList {
  /** `none` means no Gems yet: call `gems.generate`. */
  state: GemFeedState;
  gems: Gem[];
  generated_at: string | null;
}

export interface DashboardWidget {
  id: string;
  title: string;
  visual: string;
  question?: string | null;
}

export interface Dashboard {
  id: string;
  title: string;
  source_id: string;
  status: "draft" | "saved";
  revision: number;
  widget_count: number;
  created_at?: string;
  updated_at: string;
  /** Present when one dashboard is read. */
  description?: string;
  widgets?: DashboardWidget[];
}

export interface DashboardList {
  dashboards: Dashboard[];
}

export type WebhookEventName =
  | "gems.ready"
  | "prediction.completed"
  | "job.completed"
  | "dashboard_image.ready";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventName[];
  created_at: string;
  disabled_at?: string | null;
  disabled_reason?: string | null;
  failure_count: number;
  last_success_at?: string | null;
  /** Signing secret (`whsec_...`). Only present in the response that creates the webhook. */
  secret?: string;
}

export interface WebhookList {
  webhooks: Webhook[];
}

/**
 * One delivery. Deliveries are sent with the headers
 * `Matih-Signature`, `Matih-Event` and `Matih-Delivery`.
 */
export interface WebhookDelivery {
  id: string;
  event_id: string;
  event: string;
  attempt: number;
  /** `pending`, `retrying`, `delivered`, `failed` or `abandoned`. */
  state: string;
  next_attempt_at?: string | null;
  last_status?: number | null;
  last_error?: string | null;
  created_at: string;
  delivered_at?: string | null;
}

export interface WebhookDeliveryList {
  deliveries: WebhookDelivery[];
}

export interface WebhookTestResult {
  delivery_id: string;
  delivered: boolean;
  status?: number | null;
  error?: string | null;
}

export interface CreateWebhookParams {
  url: string;
  events: WebhookEventName[];
}

export interface Member {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  role: Role;
  whatsapp_only: boolean;
  joined_at?: string | null;
  last_seen_at?: string | null;
  monthly_cap_credits?: number | null;
  you: boolean;
  can_change_role: boolean;
  can_remove: boolean;
}

export interface MemberList {
  members: Member[];
}

export interface MemberRemoved {
  removed: string;
}

export interface UpdateMemberParams {
  role: GivableRole;
}

export interface Invitation {
  id: string;
  channel: "email" | "phone";
  target: string;
  role: Role;
  whatsapp_only: boolean;
  created_at: string;
  expires_at: string;
  expired: boolean;
  sent_at?: string | null;
  /** How it went out: `email`, `whatsapp`, or null. */
  delivered?: string | null;
  /** A phone invitation's code, shown once when it is made, if it could not be delivered. */
  join_code?: string | null;
  join_message?: string | null;
  join_url?: string | null;
}

export interface InvitationList {
  invitations: Invitation[];
}

export interface InvitationRevoked {
  revoked: string;
}

/** Invite by email or by phone number; pass exactly one of the two. */
export interface CreateInvitationParams {
  email?: string;
  phone?: string;
  /** `admin`, `user` or `viewer`. Default `user`. */
  role?: GivableRole;
  /** Let the person use the workspace on WhatsApp only. Default false. */
  whatsappOnly?: boolean;
}

/** `dashboard`, or `gems` (then the `id` is the source, i.e. connection, id). */
/** `ask` is an Ask embed of a source (`id` is the connection id); its token and frame check exist, the conversation is a later step. */
export type EmbedResourceType = "dashboard" | "gems" | "ask";

export interface EmbedResource {
  type: EmbedResourceType;
  id: string;
}

/**
 * A minted embed token. `token` (`met_...`) is a short-lived secret for the one resource,
 * filters and origins you asked for; it is never shown again. `id` (`emt_...`) is not secret
 * and is what `embeds.revoke` takes. `url` carries the token in its fragment: pass
 * `embedSrc(embed)` (the URL without it) and `embed.token` to `<matih-embed>`, and do not
 * log this object.
 */
export interface Embed {
  id: string;
  token: string;
  expires_at: string;
  url: string;
  resource: EmbedResource;
  origins: string[];
  /** The viewer this token vouches for, when you passed one: `vwr_...`, not secret. */
  viewer?: { id: string };
}

/** A token minted by this key, as `embeds.list` shows it. Never carries the secret or filter values. */
export interface EmbedSummary {
  id: string;
  kind?: string;
  resource?: EmbedResource | null;
  title?: string | null;
  origins?: string[];
  created_at?: string | null;
  expires_at?: string | null;
  /** When it was revoked; null while it has not been. */
  revoked_at?: string | null;
  /** The API key (or OAuth grant) that minted it. */
  key?: { integration_id?: string; key_prefix?: string; integration_name?: string } | null;
  /** The member that key acts as. */
  member?: { user_id?: string; name?: string } | null;
  /** The viewer the token vouches for (`vwr_...`), or null. */
  viewer?: { id: string } | null;
}

export interface EmbedList {
  embeds: EmbedSummary[];
}

export interface CreateEmbedParams {
  resource: EmbedResource;
  /**
   * 1 to 10 exact origins allowed to frame the page: `https://app.example.com` (https only,
   * except `http://localhost[:port]` and `http://127.0.0.1[:port]`; no paths or wildcards).
   */
  origins: string[];
  /** The viewer's row filters: exactly the parameters the dashboard declares. Gems take none. */
  filters?: Record<string, string | number>;
  /** 60 to 900, default 300. A token is never renewed: mint a new one. */
  ttlSeconds?: number;
  /**
   * Your end user this token is for. Viewers are told apart by `external_id` alone (your own id for
   * them), never by email or phone. Frozen on the token. A refusal is `EmbedRefusedError` with the
   * claim's `code` (`external_id_missing`, `email_invalid`, `attribute_value_invalid`, ...).
   */
  viewer?: EmbedViewer;
}

/** The end user an embed token vouches for (docs/EMBEDDED_ANALYTICS.md section 1). */
export interface EmbedViewer {
  /** Your id for this person, at most 128 characters. Required. */
  external_id: string;
  name?: string;
  email?: string;
  /** E.164: `+919800000042`. */
  phone?: string;
  /** A language tag such as `en-IN`. */
  locale?: string;
  /** Strings, numbers, or lists of those, as the workspace's row policies read them. */
  attributes?: Record<string, string | number | Array<string | number>>;
}

/** `RS256` (RSA, 2048 bits or more), `ES256` (P-256) or `EdDSA` (Ed25519). HS256 is never accepted. */
export type EmbedSigningAlg = "RS256" | "ES256" | "EdDSA";

/** A public JWK as `embeds.keys` returns it: the public half only. */
export type EmbedPublicJwk = Record<string, string>;

export interface AddEmbedSigningKeyParams {
  /** The PUBLIC half: a PEM string (`-----BEGIN PUBLIC KEY-----`) or a JWK object. A private key is refused (`key_private`) and never stored. */
  publicKey: string | EmbedPublicJwk;
  /** The `kid` your tokens carry in their header. Unique for the integration, even among revoked keys; defaults to the JWK's own `kid`. */
  kid?: string;
  /** Inferred from the key when absent. */
  alg?: EmbedSigningAlg;
}

/** A registered signing key. Never carries anything private. */
export interface EmbedSigningKey {
  /** `esk_...` */
  id: string;
  kid: string;
  alg: EmbedSigningAlg;
  public_key: EmbedPublicJwk;
  created_at: string;
  /** When it was revoked; null while live. */
  revoked_at: string | null;
}

export interface EmbedSigningKeyList {
  keys: EmbedSigningKey[];
}

export interface ConversationMessage {
  id: string;
  role: string;
  text: string;
  sql?: string | null;
  created_at?: string;
}

export interface Conversation {
  id: string;
  title: string;
  source_id?: string | null;
  /** Where it started: `web`, `whatsapp`, `api` or `mcp`. */
  channel?: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  /** Present when one conversation is read. */
  messages?: ConversationMessage[] | null;
}

/** Kept for compatibility; same as `Conversation`. */
export type ConversationSummary = Conversation;

export interface ConversationList {
  conversations: Conversation[];
}

export function isTerminalJob(job: Pick<Job, "state">): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}

/**
 * The embed URL without its fragment, which is where the token lives. This is the value for
 * the `src` attribute of `<matih-embed>`; it keeps the `?e=` token id the frame check needs.
 */
export function embedSrc(embed: Embed | string): string {
  const url = typeof embed === "string" ? embed : embed.url;
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}
