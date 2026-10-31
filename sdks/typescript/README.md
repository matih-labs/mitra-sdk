<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# @matihlabs/mitra

TypeScript client for the Mitra public API. Ask questions of your data in any of 22 Indian languages, generate Gems, render dashboards, run predictions, and manage sources, files, webhooks and members.

- Node 18 or newer, ESM, no runtime dependencies beyond `openapi-fetch`
- Typed errors, automatic retries, an idempotency key on the two calls that spend credits (`ask`, `predictions.create`)
- Server-sent-event streaming for answers
- Webhook signature verification (constant-time)

API base URL: `https://workspace.matih.ai/api/v1`. The OpenAPI 3.1 spec is served at `/api/v1/openapi.json`.

## Install

```sh
npm install @matihlabs/mitra
```

## Authenticate

Create an API key (`mtk_...`) under `Settings › API & MCP` as a workspace admin. A key is pinned to one workspace and acts as the member who created it, never exceeding their role. OAuth 2.1 access tokens (`mto_...`, authorization code with PKCE) work too; pass them as `accessToken`.

```ts
import { Mitra } from "@matihlabs/mitra";

const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
```

If you pass nothing, the client reads `MATIH_API_KEY` or `MATIH_ACCESS_TOKEN` from the environment (and `MATIH_BASE_URL`, the host only, if you need another server).

Create keys under `Settings › API & MCP`; choose the products the key may use (all on by default) and revoke keys in the same screen. Keys never expire by default. Use an API key here, not an MCP connector key, which works only on `/api/v1/mcp`.

Scopes: `workspaces:read`, `sources:read`, `sources:write`, `files:read`, `files:write`, `gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`, `webhooks:manage`, `members:read`, `members:manage`.

Client options:

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` / `accessToken` | env | Credential; pass one. |
| `baseUrl` | `$MATIH_BASE_URL`, else `https://workspace.matih.ai` | The host only: the SDK adds `/api/v1`. |
| `workspaceId` | none | Default `X-Matih-Workspace` (OAuth tokens). |
| `language` | none | Default `Accept-Language`, e.g. `hi-IN`. |
| `fetch` | global `fetch` | Custom implementation. |
| `timeoutMs` | `60000` | Per-attempt timeout. |
| `maxRetries` | `2` | See Retries. |

Every method takes a final options object: `{ workspaceId, language, idempotencyKey, signal, timeoutMs, maxRetries }`.

## Ask a question

```ts
const answer = await mitra.ask("What was revenue last month?");
console.log(answer.answer, answer.result?.rows);

// Follow-up in the same conversation, in Hindi
const next = await mitra.ask(
  { question: "और पिछले साल?", conversation_id: answer.conversation_id },
  { language: "hi-IN" },
);
```

`answer.status` is `answered`, `clarification`, `empty` or `error`. Human-readable text comes back translated; data values and column names never are.

### Stream progress

```ts
for await (const { event, data } of mitra.askStream("Top 5 customers by revenue")) {
  if (event === "progress") console.log("working:", data);
  if (event === "answer") console.log((data as { answer: string }).answer);
  if (event === "error") console.error(data);
}
```

Events are `started`, `progress`, `answer` and `error`. An `error` event is yielded, not thrown. If the request itself fails (bad credential, workspace pool empty), the iterator throws a typed error before yielding anything.

### Voice questions

```ts
import { readFile } from "node:fs/promises";

const audio = await readFile("question.ogg");
const answer = await mitra.askAudio(audio, { filename: "question.ogg", language: "hi-IN" });
console.log(answer.heard?.transcript, answer.answer);
```

`askAudio` accepts `{ conversationId, sourceId, language, filename, contentType }`.

## Sync vs async

Everything is promise-based. Long calls (`gems.generate`, `predictions.create`, `dashboards.image`, `sources.create`, `files.upload`) have two modes:

- **Wait** (default): sends `Prefer: wait=N` (the server honours at most 60 s for jobs and 120 s for sources and files) and, when the answer is not final, keeps polling. `wait` is the total time in seconds (default 10 minutes for Gems, 5 for images, sources and files, 31 for predictions).
  - Job calls (`gems.generate`, `dashboards.image`, `predictions.create`) poll `/jobs/{id}`. Running past `wait` throws `JobTimeoutError`; the job keeps running.
  - Resource calls (`sources.create`, `files.upload`) poll the source or the file. Running past `wait` throws nothing: you get the source or file as it stands (for example `phase: "building"`), so check `readiness.can_ask` or `status`.
- **Background**: `{ background: true }` returns right away. For job calls that is the queued job; for `sources.create` and `files.upload` it is whatever the server answered.

```ts
const done = await mitra.predictions.create({ question: "Forecast Q4" }, { wait: 900, onProgress: (j) => console.log(j.state) });

const job = await mitra.predictions.create({ question: "Forecast Q4" }, { background: true });
const later = await mitra.jobs.wait(job, { timeout: 900 });   // seconds; or timeoutMs
console.log(later.result);

// ask can be asynchronous too (Prefer: respond-async); the job's result is the Answer
const queued = await mitra.ask("Top customers this year", { background: true });
const answer = (await mitra.jobs.wait<Answer>(queued, { timeout: 120 })).result;
```

`jobs.wait` polls with backoff. It throws `JobFailedError` for failed or cancelled jobs (pass `throwOnFailure: false` to get the job back instead) and `JobTimeoutError` when the wait runs out. Use `mitra.jobs.get(id)` and `mitra.jobs.cancel(id)` directly if you prefer.

## Gems and dashboards

```ts
const { gems } = await mitra.gems.list({ source_id: "src_1" });
const png = await mitra.gems.image(gems[0].id);        // Uint8Array

const render = await mitra.gems.generate("src_1");
await mitra.jobs.wait(render);

const { dashboards } = await mitra.dashboards.list();
const bytes = await mitra.dashboards.imageBytes(dashboards[0].id);
```

`image_url` values in responses are short-lived signed URLs (15 minutes) that need no authentication. `gems.image` and `dashboards.imageBytes` fetch the bytes with your credential instead, and wait for a render when none is cached.

## Workspaces, sources, files, connectors

```ts
const { current, workspaces } = await mitra.workspaces.list();
await mitra.workspaces.use(workspaces[0].id);   // also becomes this client's default

const { sources } = await mitra.sources.list();
const source = await mitra.sources.get("src_1"); // includes readiness
await mitra.sources.activate("src_1");

const { connectors } = (await mitra.connectors.list()) as { connectors?: unknown };
```

Creating a source tests the connection first. A failed test saves nothing and throws `SourceTestFailedError` with the outcome in `.testResult`:

```ts
import { SourceTestFailedError } from "@matihlabs/mitra";

try {
  await mitra.sources.create({ config: { connector_type: "postgres", display_name: "Orders DB", host: "db.example.com" } });
} catch (err) {
  if (err instanceof SourceTestFailedError) console.error(err.testResult);
  else throw err;
}
```

Files (`files:read` to list and get; `files:write` to upload, answer a duplicate prompt and delete):

```ts
const file = await mitra.files.upload(await readFile("sales.csv"), {
  filename: "sales.csv",
  contentType: "text/csv",
  onDuplicate: "ask",         // optional: "ask" (default) or "keep_both"
});
const status = await mitra.files.get(file.id);  // status, decision_required, decision_options
if (status.decision_required) await mitra.files.duplicate(file.id, "use_existing");  // or "keep_both", "cancel"
await mitra.files.list();
await mitra.files.delete(file.id);
```

## Members and invitations

Need `members:read` and `members:manage`.

```ts
const { members } = await mitra.members.list();
await mitra.members.update(members[0].id, { role: "admin" });
await mitra.members.remove(members[1].id);

await mitra.invitations.create({ email: "teammate@example.com", role: "user" });
await mitra.invitations.create({ phone: "+910000000000", role: "user" });
const { invitations } = await mitra.invitations.list();
await mitra.invitations.revoke(invitations[0].id);
```

## Webhooks

```ts
const hook = await mitra.webhooks.create({
  url: "https://example.com/hooks/mitra",
  events: ["gems.ready", "prediction.completed", "job.completed", "dashboard_image.ready"],
});
console.log(hook.secret); // whsec_...  shown once; store it

await mitra.webhooks.test(hook.id);              // send a test delivery
await mitra.webhooks.deliveries(hook.id);        // recent attempts
await mitra.webhooks.delete(hook.id);
```

Each delivery carries the headers `Matih-Signature`, `Matih-Event` and `Matih-Delivery`. `Matih-Signature` has the form `t=<unix>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `"<t>.<raw body>"` keyed with the webhook secret. Verify against the exact raw body, before parsing it:

```ts
import express from "express";
import { verifyWebhook } from "@matihlabs/mitra";

app.post("/hooks/mitra", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyWebhook(
    process.env.MATIH_WEBHOOK_SECRET!,
    req.header("Matih-Signature"),
    req.body, // Buffer
    300,      // tolerance in seconds (default 300)
  );
  if (!ok) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString("utf8"));
  // ...
  res.sendStatus(200);
});
```

`verifyWebhook(secret, header, body, toleranceSec = 300)` returns `false` for a missing or malformed header, a timestamp outside the tolerance, or a mismatch. The comparison is constant-time. It is also available as `mitra.verifyWebhook(...)`.

## Retries and idempotency

- `429` is retried, honouring `Retry-After` (a wait longer than 60 seconds is surfaced as a `RateLimitError` instead).
- `5xx` and network failures are retried for `GET`, `PUT` and `DELETE`, and for any call that carries an idempotency key.
- `ask` and `predictions.create` send an `Idempotency-Key` automatically. The same key is reused across internal retries, so a retry is never charged twice. The server honours the key on these two calls only. Pass `{ idempotencyKey }` to supply your own.
- `maxRetries` defaults to 2; set it per client or per call. Retries use exponential backoff with jitter.

## Errors

Every API failure is a `MitraError` with `status`, `category`, `code`, `message`, `requestId` (from `x-request-id`) and `body`.

| Class | When |
| --- | --- |
| `AuthError` | 401 |
| `CreditsError` | 402 (`not_ready`, `member_cap`) |
| `PermissionError` | 403 (`scope`, `workspace_role`, `source_access`) |
| `BusyError` | 409, a conflict with the current state (category `conflict`) |
| `RateLimitError` | 429, with `retryAfter` in seconds |
| `SourceTestFailedError` | 422 from `sources.create`, with `testResult` |
| `JobFailedError` | a job failed or was cancelled, with `job` |
| `JobTimeoutError` | `jobs.wait` ran out of time |
| `ConnectionError` | network failure or timeout, status 0 |

```ts
import { CreditsError, RateLimitError } from "@matihlabs/mitra";

try {
  await mitra.ask("...");
} catch (err) {
  if (err instanceof RateLimitError) console.log("retry in", err.retryAfter, "s");
  else if (err instanceof CreditsError) console.log("out of credits", err.requestId);
  else throw err;
}
```

## Endpoints without a dedicated method

`mitra.raw` is an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client that goes through the same headers, retries and timeouts:

```ts
const { data, error } = await (mitra.raw as any).GET("/workspaces");
```

Generate precise types from the spec with `npm run generate` (writes `src/schema.d.ts`; skipped when the spec is absent).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Apache-2.0.
