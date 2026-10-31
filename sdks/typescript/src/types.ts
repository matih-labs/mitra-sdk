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

export type AnswerStatus = "answered" | "clarification" | "empty" | "error";

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

export type JobKind = "gems" | "prediction" | "dashboard_image";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobError {
  category: string;
  message: string;
  code?: string;
}

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

export interface PredictionAttachment {
  type: "forecast" | "table" | "model" | "what_if";
  [key: string]: unknown;
}

export interface PredictionResult {
  answer: string;
  attachments: PredictionAttachment[];
  image_url?: string;
}

export interface PredictionParams {
  question: string;
  source_id?: string;
  conversation_id?: string;
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
 * By default the call blocks: it sends `Prefer: wait=N` and, when the server
 * answers 202 with a job, polls the job until it finishes or `wait` runs out
 * (then JobTimeoutError; the job keeps running). With `background: true` it
 * returns right away with what the server answered, a job to follow with
 * `jobs.wait` or a webhook.
 */
export interface LongCallOptions extends RequestOptions {
  /** Seconds to wait in total. Defaults depend on the call (5 to 31 minutes). */
  wait?: number;
  /** Return the job (or whatever the server answered) immediately. */
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
  | "gems:read"
  | "gems:generate"
  | "ask"
  | "dashboards:read"
  | "predict"
  | "webhooks:manage"
  | "members:read"
  | "members:manage";

export interface Workspace {
  id: string;
  name: string;
  role: string;
  kind: string;
}

export interface WorkspaceList {
  current: string | null;
  workspaces: Workspace[];
}

export interface Source {
  id: string;
  name: string;
  type: string;
  status: string;
  active: boolean;
}

export interface SourceList {
  sources: Source[];
}

export type SourceConfig = Record<string, unknown>;

/** A source with the extra fields returned when fetching one by id, including readiness. */
export interface SourceDetail extends Source {
  [key: string]: unknown;
}

export interface CreateSourceParams {
  config: SourceConfig;
  /** Make the new source the active one. Default true. */
  activate?: boolean;
}

/** Connector types and their fields, as returned by the API. */
export type ConnectorList = Record<string, unknown>;

export interface UploadedFile {
  id: string;
  /** Upload and processing status. */
  status: string;
  /** State of the automatic analysis of the file, when reported. */
  analysis_state?: string;
  /** Set when the file needs a decision, e.g. it duplicates an earlier upload. */
  decision_required?: unknown;
  [key: string]: unknown;
}

export interface UploadedFileList {
  files: UploadedFile[];
}

/** How to resolve a duplicate upload; the allowed values come from `decision_required`. */
export type DuplicateDecision = string;

export interface UploadOptions {
  filename?: string;
  contentType?: string;
  /** What to do when the file duplicates an earlier upload. */
  onDuplicate?: string;
}

export interface Gem {
  id: string;
  kind: string;
  headline: string;
  explanation: string;
  figures: unknown;
  question: string;
  image_url: string | null;
  created_at: string;
}

export interface GemList {
  state: string;
  gems: Gem[];
  generated_at: string | null;
}

export interface Dashboard {
  id: string;
  title: string;
  updated_at: string;
  [key: string]: unknown;
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
  /** Signing secret (`whsec_...`). Only present in the response that creates the webhook. */
  secret?: string;
  [key: string]: unknown;
}

export interface WebhookList {
  webhooks: Webhook[];
}

/**
 * One delivery attempt. Deliveries are sent with the headers
 * `Matih-Signature`, `Matih-Event` and `Matih-Delivery`.
 */
export interface WebhookDelivery {
  id: string;
  [key: string]: unknown;
}

export interface WebhookDeliveryList {
  deliveries: WebhookDelivery[];
}

export interface CreateWebhookParams {
  url: string;
  events: WebhookEventName[];
}

export type MemberRole = "owner" | "admin" | "member" | (string & {});

export interface Member {
  id: string;
  role: MemberRole;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  [key: string]: unknown;
}

export interface MemberList {
  members: Member[];
}

export interface UpdateMemberParams {
  role: MemberRole;
}

export interface Invitation {
  id: string;
  role: MemberRole;
  email?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

export interface InvitationList {
  invitations: Invitation[];
}

/** Invite by email or by phone number; pass one of the two. */
export interface CreateInvitationParams {
  email?: string;
  phone?: string;
  role: MemberRole;
}

export interface ConversationSummary {
  id: string;
  [key: string]: unknown;
}

export interface ConversationList {
  conversations: ConversationSummary[];
}

export interface Conversation {
  id: string;
  [key: string]: unknown;
}

export function isTerminalJob(job: Pick<Job, "state">): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}
