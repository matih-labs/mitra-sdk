# @matihlabs/mitra

TypeScript client for the Mitra public API. Ask questions of your data in any of 22 Indian languages, generate Gems, render dashboards, run predictions, and manage sources, files, webhooks and members.

- Node 18 or newer, ESM, no runtime dependencies beyond `openapi-fetch`
- Typed errors, automatic retries, idempotency keys on every call that spends credits
- Server-sent-event streaming for answers
- Webhook signature verification (constant-time)

API base URL: `https://workspace.matih.ai/api/v1`. The OpenAPI 3.1 spec is served at `/openapi.json`.

## Install

```sh
npm install @matihlabs/mitra
```

## Authenticate

Create an API key (`mtk_...`) under Settings, Integrations as a workspace admin. A key is pinned to one workspace and acts as the member who created it, never exceeding their role. OAuth 2.1 access tokens (`mto_...`, authorization code with PKCE) work too; pass them as `accessToken`.

```ts
import { Mitra } from "@matihlabs/mitra";

const mitra = new Mitra({ apiKey: process.env.MITRA_API_KEY });
```

If you pass nothing, the client reads `MITRA_API_KEY` or `MITRA_ACCESS_TOKEN` from the environment.

Scopes: `workspaces:read`, `sources:read`, `sources:write`, `gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`, `webhooks:manage`, `members:read`, `members:manage`.

Client options:

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` / `accessToken` | env | Credential; pass one. |
| `baseUrl` | `https://workspace.matih.ai/api/v1` | Include the version prefix. |
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

Events are `started`, `progress`, `answer` and `error`. An `error` event is yielded, not thrown. If the request itself fails (bad credential, no credits), the iterator throws a typed error before yielding anything.

### Voice questions

```ts
import { readFile } from "node:fs/promises";

const audio = await readFile("question.ogg");
const answer = await mitra.askAudio(audio, { filename: "question.ogg", language: "hi-IN" });
console.log(answer.heard?.transcript, answer.answer);
```

`askAudio` accepts `{ conversationId, sourceId, language, filename, contentType }`.

## Long-running work: jobs

Gem generation, predictions and dashboard renders return a job. Wait for it, with progress and a timeout:

```ts
const job = await mitra.predictions.create({ question: "Forecast sales for next quarter" });

const done = await mitra.jobs.wait(job, {
  timeoutMs: 35 * 60_000,
  onProgress: (j) => console.log(j.state),
});
console.log(done.result);
```

`jobs.wait` polls with backoff. It throws `JobFailedError` for failed or cancelled jobs (pass `throwOnFailure: false` to get the job back instead) and `JobTimeoutError` when the wait runs out; the job keeps running. Use `mitra.jobs.get(id)` and `mitra.jobs.cancel(id)` directly if you prefer.

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
  await mitra.sources.create({ config: { type: "postgres", host: "db.example.com" } });
} catch (err) {
  if (err instanceof SourceTestFailedError) console.error(err.testResult);
  else throw err;
}
```

Files:

```ts
const file = await mitra.files.upload(await readFile("sales.csv"), {
  filename: "sales.csv",
  contentType: "text/csv",
  onDuplicate: "replace",     // optional
});
const status = await mitra.files.get(file.id);  // status, analysis_state, decision_required
if (status.decision_required) await mitra.files.duplicate(file.id, "replace");
await mitra.files.list();
await mitra.files.delete(file.id);
```

## Members and invitations

Need `members:read` and `members:manage`.

```ts
const { members } = await mitra.members.list();
await mitra.members.update(members[0].id, { role: "admin" });
await mitra.members.remove(members[1].id);

await mitra.invitations.create({ email: "teammate@example.com", role: "member" });
await mitra.invitations.create({ phone: "+910000000000", role: "member" });
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
    process.env.MITRA_WEBHOOK_SECRET!,
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
- Calls that spend credits (`ask`, `askStream`, `askAudio`, `predictions.create`, `gems.generate`, `dashboards.image`) send an `Idempotency-Key` automatically. The same key is reused across internal retries, so a retry is never charged twice. Pass `{ idempotencyKey }` to supply your own.
- `maxRetries` defaults to 2; set it per client or per call. Retries use exponential backoff with jitter.

## Errors

Every API failure is a `MitraError` with `status`, `category`, `code`, `message`, `requestId` (from `x-request-id`) and `body`.

| Class | When |
| --- | --- |
| `AuthError` | 401 |
| `CreditsError` | 402 (`credits`, `member_cap`) |
| `PermissionError` | 403 (`scope`, `workspace_role`, `source_access`) |
| `BusyError` | 409 |
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
