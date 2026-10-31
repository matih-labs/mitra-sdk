// Matih API example: plain Node.js (fetch, FormData, Blob). No dependencies.
//
// Run (Node 18 or newer):
//   export MATIH_API_KEY=mtk_...
//   node example.mjs
//   node example.mjs --skip-predict
//   node example.mjs --background     (predict without Prefer: wait, start a job and poll it)
//   node example.mjs --upload ./sales.csv
//   node example.mjs --invite teammate@example.com --role ROLE   (admin action, never runs by default)
//
// Environment:
//   MATIH_API_KEY    required. Create one under Settings, Integrations in Matih.
//   MATIH_BASE_URL   optional. Default https://workspace.matih.ai ("/api/v1" is appended).
//   MATIH_ON_DUPLICATE  optional. Passed as the on_duplicate form field of the file upload.
//
// Teaching example. Do not commit your API key.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const API_KEY = process.env.MATIH_API_KEY;
const BASE =
  (process.env.MATIH_BASE_URL || "https://workspace.matih.ai").replace(/\/+$/, "") + "/api/v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Errors from the API look like {"detail": {"category": "...", "message": "..."}}.
class ApiError extends Error {
  constructor(status, category, message) {
    super(`HTTP ${status} [${category ?? "unknown"}] ${message}`);
    this.status = status;
    this.category = category;
  }
}

function retryAfterSeconds(value) {
  if (value == null) return 5;
  const clamp = (n) => Math.min(Math.max(n, 1), 60);
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds);
  const date = Date.parse(value); // Retry-After may also be an HTTP date
  if (!Number.isNaN(date)) return clamp((date - Date.now()) / 1000);
  return 5;
}

// One request, returning { status, data }. On a 429 it honours Retry-After once and
// retries with the same Idempotency-Key, so a credit-costing call is never charged twice.
// prefer is the value of an optional RFC 7240 Prefer header: "wait=30" or "respond-async".
async function send(method, path, { json, form, idempotencyKey, prefer } = {}, retried = false) {
  const headers = { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (prefer) headers.Prefer = prefer;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets the multipart Content-Type and boundary itself
  }

  const res = await fetch(BASE + path, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();

  if (res.status === 429 && !retried) {
    const wait = retryAfterSeconds(res.headers.get("retry-after"));
    console.error(`rate limited (429), waiting ${wait}s and retrying once`);
    await sleep(wait * 1000);
    return send(method, path, { json, form, idempotencyKey, prefer }, true);
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new ApiError(
      res.status,
      detail && detail.category,
      (detail && detail.message) || text.slice(0, 300) || res.statusText,
    );
  }
  return { status: res.status, data };
}

// Same as send() but returns only the decoded body.
async function request(method, path, options) {
  return (await send(method, path, options)).data;
}

// Poll GET /jobs/{id} until the job is succeeded, failed or cancelled.
// The delay starts at firstDelayMs and grows by 1.5x up to maxDelayMs.
async function waitForJob(jobId, { firstDelayMs, maxDelayMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let delay = firstDelayMs;
  for (;;) {
    const job = await request("GET", `/jobs/${encodeURIComponent(jobId)}`);
    console.log(`  job ${jobId}: ${job.state}`);
    if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
    if (Date.now() + delay > deadline) {
      throw new Error(`timed out waiting for job ${jobId} (last state ${job.state})`);
    }
    await sleep(delay);
    delay = Math.min(maxDelayMs, Math.round(delay * 1.5));
  }
}

function requireSucceeded(job) {
  if (job.state !== "succeeded") {
    const e = job.error || {};
    throw new Error(`job ${job.id} ${job.state}: [${e.category ?? "-"}] ${e.message ?? ""}`);
  }
  return job.result || {};
}

// ---------------------------------------------------------------------------
// (1) Ask a question
// ---------------------------------------------------------------------------
// Costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
// question and reuse the same key only when retrying that exact request.
// The answer has a conversation_id: send it back as conversation_id in the next
// POST /ask to ask a follow-up in the same conversation.
async function ask(question, conversationId) {
  const body = { question };
  if (conversationId) body.conversation_id = conversationId;
  const answer = await request("POST", "/ask", { json: body, idempotencyKey: randomUUID() });
  console.log(`status: ${answer.status}`);
  console.log(`answer: ${answer.answer}`);
  if (answer.status === "clarification" && answer.clarification) {
    console.log(`clarification: ${answer.clarification.question}`);
    console.log(`options: ${JSON.stringify(answer.clarification.options)}`);
  }
  if (answer.result) console.log(`rows: ${answer.result.row_count}`);
  console.log(`conversation_id: ${answer.conversation_id} (pass it back to continue this conversation)`);
  return answer.conversation_id;
}

// ---------------------------------------------------------------------------
// (2) List Gems
// ---------------------------------------------------------------------------
async function listGems() {
  const data = await request("GET", "/gems");
  console.log(`state: ${data.state}, ${data.gems.length} gem(s)`);
  for (const gem of data.gems) console.log(`  ${gem.id}  ${gem.kind}  ${gem.headline}`);
}

// ---------------------------------------------------------------------------
// (1b) Ask in the background (Prefer: respond-async)
// ---------------------------------------------------------------------------
// With "Prefer: respond-async" POST /ask returns 202 at once with a Job of kind "ask".
// Poll GET /jobs/{id}; when it succeeds the job's result is the same Answer that the
// synchronous call returns.
async function askAsync(question) {
  const { status, data: job } = await send("POST", "/ask", {
    json: { question },
    idempotencyKey: randomUUID(),
    prefer: "respond-async",
  });
  console.log(`POST /ask answered ${status}, job ${job.id} (kind ${job.kind})`);
  const done = await waitForJob(job.id, { firstDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 5 * 60_000 });
  const answer = requireSucceeded(done);
  console.log(`status: ${answer.status}`);
  console.log(`answer: ${answer.answer}`);
  console.log(`conversation_id: ${answer.conversation_id}`);
}

// ---------------------------------------------------------------------------
// Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds)
// ---------------------------------------------------------------------------
// Works on POST /gems/generate, /predictions and /dashboards/{id}/image. The server
// answers 200 or 201 when the work finished within N seconds, otherwise 202 with a Job.
// Either way this returns the result object; on 202 it falls back to polling the job.
// If a finished answer carries a Job (it has a "state"), its result field is used.
const WAIT_SECONDS = 30;

async function runWithWait(path, options, pollOptions) {
  const { status, data } = await send("POST", path, { ...options, prefer: `wait=${WAIT_SECONDS}` });
  if (status === 202) {
    console.log(`  not finished within ${WAIT_SECONDS}s (202), polling job ${data.id}`);
    return requireSucceeded(await waitForJob(data.id, pollOptions));
  }
  console.log(`  finished within ${WAIT_SECONDS}s (${status})`);
  if (data && data.state) return requireSucceeded(data);
  return data || {};
}

// ---------------------------------------------------------------------------
// (3) Dashboard image job
// ---------------------------------------------------------------------------
// Sync-with-fallback: wait=N, and if the job is still running, poll GET /jobs/{id}
// with a growing delay. image_url is a signed URL valid for about 15 minutes that
// needs no Authorization header.
async function dashboardImage() {
  const data = await request("GET", "/dashboards");
  if (data.dashboards.length === 0) {
    console.log("no dashboards in this workspace");
    return;
  }
  const dashboard = data.dashboards[0];
  console.log(`dashboard: ${dashboard.id} ${dashboard.title}`);
  const result = await runWithWait(
    `/dashboards/${encodeURIComponent(dashboard.id)}/image`,
    {},
    { firstDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 5 * 60_000 },
  );
  console.log(`image_url: ${result.image_url} (${result.width}x${result.height})`);
}

// ---------------------------------------------------------------------------
// (4) Predict
// ---------------------------------------------------------------------------
// A prediction can run for up to 30 minutes. Poll every 5 to 10 seconds.
// Webhooks (prediction.completed) avoid polling.
function printPrediction(result) {
  console.log(`answer: ${result.answer}`);
  for (const attachment of result.attachments || []) console.log(`  attachment: ${attachment.type}`);
  if (result.image_url) console.log(`image_url: ${result.image_url}`);
}

const PREDICT_POLL = { firstDelayMs: 5000, maxDelayMs: 10000, timeoutMs: 31 * 60_000 };

// Sync-with-fallback: wait=N, then poll on 202.
async function predict(question) {
  const result = await runWithWait(
    "/predictions",
    { json: { question }, idempotencyKey: randomUUID() },
    PREDICT_POLL,
  );
  printPrediction(result);
}

// Background variant: no Prefer header. POST /predictions returns 202 with a Job straight
// away. Keep the job id (store it, hand it to another process) and poll GET /jobs/{id}
// whenever you like; here we poll right after for the demo.
async function predictBackground(question) {
  const job = await request("POST", "/predictions", {
    json: { question },
    idempotencyKey: randomUUID(),
  });
  console.log(`started job ${job.id}; poll GET /jobs/${job.id} later`);
  printPrediction(requireSucceeded(await waitForJob(job.id, PREDICT_POLL)));
}

// ---------------------------------------------------------------------------
// (5) List sources
// ---------------------------------------------------------------------------
async function listSources() {
  const data = await request("GET", "/sources");
  for (const s of data.sources) {
    console.log(`  ${s.id}  ${s.name}  type=${s.type}  status=${s.status}  active=${s.active}`);
  }
  if (data.sources.length === 0) console.log("no sources yet");
}

// ---------------------------------------------------------------------------
// (6) Upload a CSV or Excel file (multipart, field name "file")
// ---------------------------------------------------------------------------
// Needs the files:write scope. The optional on_duplicate field says what to do
// when the same file was uploaded before.
function contentTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    default:
      return "application/octet-stream";
  }
}

async function uploadFile(path) {
  const bytes = await readFile(path);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentTypeFor(path) }), basename(path));
  if (process.env.MATIH_ON_DUPLICATE) form.append("on_duplicate", process.env.MATIH_ON_DUPLICATE);

  let file = await request("POST", "/files", { form });
  console.log(`uploaded: ${file.id} status=${file.status}`);
  // Processing is asynchronous. Needs the files:read scope to follow it.
  for (let i = 0; i < 40 && file.status === "processing"; i++) {
    await sleep(3000);
    file = await request("GET", `/files/${encodeURIComponent(file.id)}`);
    console.log(`  status=${file.status}`);
  }
  console.log(JSON.stringify(file, null, 2));
  if (file.decision_required) console.log("the file needs a decision (duplicate handling); see POST /files/{id}/duplicate");
}

// ---------------------------------------------------------------------------
// (7) Invite a member (admin action, members:manage)
// ---------------------------------------------------------------------------
// Only runs when you pass --invite. Valid role values come from GET /members.
async function inviteMember(target, role) {
  const body = target.includes("@") ? { email: target, role } : { phone: target, role };
  const invitation = await request("POST", "/invitations", { json: body });
  console.log(JSON.stringify(invitation, null, 2));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  if (!API_KEY) {
    console.error("MATIH_API_KEY is required");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (i + 1 >= args.length) {
      console.error(`${name} needs a value`);
      process.exit(2);
    }
    return args[i + 1];
  };
  const uploadPath = flag("--upload");
  const inviteTarget = flag("--invite");
  const inviteRole = flag("--role");
  if (inviteTarget && !inviteRole) {
    console.error("--invite needs --role ROLE (valid values come from GET /members)");
    process.exit(2);
  }

  console.log(`base url: ${BASE}`);
  let failed = 0;
  const step = async (name, fn) => {
    console.log(`\n== ${name} ==`);
    try {
      await fn();
    } catch (e) {
      failed++;
      console.error(`failed: ${e.message}`);
    }
  };

  await step("ask", () => ask("What were total sales last month?"));
  await step("ask in the background (respond-async)", () => askAsync("How many orders came in last week?"));
  await step("gems", listGems);
  await step("dashboard image (wait=30, falls back to polling)", dashboardImage);
  if (!args.includes("--skip-predict")) {
    const question = "Forecast next quarter's revenue.";
    if (args.includes("--background")) {
      await step("predict, background variant", () => predictBackground(question));
    } else {
      await step("predict (wait=30, falls back to polling)", () => predict(question));
    }
  }
  await step("sources", listSources);
  if (uploadPath) await step("upload file", () => uploadFile(uploadPath));
  if (inviteTarget) await step("invite member", () => inviteMember(inviteTarget, inviteRole));

  process.exit(failed === 0 ? 0 : 1);
}

main();
