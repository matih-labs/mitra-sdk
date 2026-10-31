# TypeScript SDK

`@matihlabs/mitra` is the TypeScript client for the Matih public API. It is typed end to end, has one runtime dependency (`openapi-fetch`), retries for you, sends idempotency keys on every call that spends credits, streams answers as server-sent events, polls background jobs and verifies webhook signatures in constant time.

```bash
npm install @matihlabs/mitra
```

- Node 18 or newer (it uses the global `fetch`, `FormData`, `Blob` and `AbortSignal`).
- ESM only (`"type": "module"`). Use `import`, not `require`.
- Types ship with the package; no `@types` install needed.

```ts
import { Mitra } from "@matihlabs/mitra";
```

Source and tests: [`sdks/typescript`](https://github.com/matih-labs/mitra-sdk/tree/main/sdks/typescript).

## Create a client

```ts
import { Mitra } from "@matihlabs/mitra";

const mitra = new Mitra({ apiKey: process.env.MITRA_API_KEY });

const answer = await mitra.ask("How many orders did we get today?");
console.log(answer.answer);
```

!!! warning "Server-side only"
    An `mtk_` key can do everything its products allow. Never put one in browser code, a mobile app bundle or a public repository. The package also imports `node:crypto`, so it is built for servers (Node, Bun, Deno), not for a browser bundle. If a web page needs answers, call your own backend, which holds the key. See [SECURITY.md](https://github.com/matih-labs/mitra-sdk/blob/main/SECURITY.md) and [Credentials and products](../concepts/credentials.md).

### Constructor options

`new Mitra(options?: MitraOptions)`:

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | `process.env.MITRA_API_KEY` | API key (`mtk_...`), pinned to one workspace |
| `accessToken` | `process.env.MITRA_ACCESS_TOKEN` | OAuth access token (`mto_...`). Pass one of `apiKey` or `accessToken`, not both |
| `baseUrl` | `https://workspace.matih.ai/api/v1` | Include the `/api/v1` prefix. Trailing slashes are removed |
| `workspaceId` | none | Default `X-Matih-Workspace` (OAuth tokens; an API key is pinned) |
| `language` | none | Default `Accept-Language` for response text, for example `hi-IN`. See [Languages](../concepts/languages.md) |
| `fetch` | global `fetch` | Custom implementation, for tests or proxies |
| `timeoutMs` | `60000` | Per-attempt timeout |
| `maxRetries` | `2` | See [Retries](#retries-and-idempotency) |
| `retryBaseDelayMs` | `500` | Base of the exponential backoff |

The constructor throws a `TypeError` when no credential is found, when both `apiKey` and `accessToken` are passed, or when there is no `fetch`.

!!! note "Environment variable names"
    The TypeScript client reads `MITRA_API_KEY` and `MITRA_ACCESS_TOKEN`. The Python client reads `MATIH_API_KEY`. Pass `apiKey` explicitly if you want one name across both.

OAuth example (an app acting for one user):

```ts
const mitra = new Mitra({ accessToken: userToken, workspaceId: "ws_123" });
```

### Per-call options

Every method takes a final `RequestOptions` object:

| Option | Meaning |
|---|---|
| `workspaceId` | `X-Matih-Workspace` for this call |
| `language` | `Accept-Language` for this call |
| `idempotencyKey` | Your own `Idempotency-Key` for a credit-spending call |
| `signal` | An `AbortSignal`. Aborting cancels the request and any retries |
| `timeoutMs` | Per-attempt timeout for this call |
| `maxRetries` | Retries for this call |

```ts
await mitra.sources.list({ workspaceId: "ws_456" });
await mitra.ask("Total sales?", { language: "ta-IN", idempotencyKey: "order-1042-q1" });
```

Calls that return image bytes take `ImageBytesOptions` (`RequestOptions` plus `waitTimeoutMs` and `pollIntervalMs`). `jobs.wait` takes `WaitOptions`, described below.

## Ask

### `ask(question: string | AskParams, opts?): Promise<Answer>`

`POST /ask`, scope `ask`. Costs credits, so an idempotency key is generated and reused across retries. `AskParams` is `{ question, conversation_id?, source_id?, language? }`.

```ts
const answer = await mitra.ask({ question: "What were last month's sales by region?", source_id: "src_1" });

if (answer.status === "answered") {
  console.log(answer.answer);
  for (const row of answer.result?.rows ?? []) console.log(row);
  if (answer.image_url) {
    const res = await fetch(new URL(answer.image_url, "https://workspace.matih.ai"));
    await writeFile("chart.png", Buffer.from(await res.arrayBuffer()));
  }
} else if (answer.status === "clarification") {
  console.log(answer.clarification?.question, answer.clarification?.options);
  const next = await mitra.ask({
    question: answer.clarification!.options[0],
    conversation_id: answer.conversation_id,
  });
}
```

(`import { writeFile } from "node:fs/promises";` for the example above.)

`answer.status` is `answered`, `clarification`, `empty` or `error`; these are normal HTTP 200 responses, not exceptions. `image_url` is a short-lived signed URL, see [Images](../concepts/images.md). Reuse `answer.conversation_id` for follow-ups. Text fields come back translated when you ask for a language; `sql`, rows and column names never are.

The `Answer` type: `status`, `answer`, `clarification`, `result` (`columns`, `rows`, `row_count`, `truncated`), `sql`, `image_url`, `follow_ups`, `conversation_id`, `request_id`, `language`, and `heard` for voice questions.

### `askStream(question, opts?): AsyncGenerator<StreamEvent>`

Same arguments as `ask`. Yields `{ event, data, id? }` for `started`, `progress`, `answer` and `error`; `data` is parsed JSON when the payload is JSON. An `error` event is yielded, not thrown. If the request itself fails (bad credential, no credits) the typed error is thrown before anything is yielded.

```ts
for await (const { event, data } of mitra.askStream("Top 5 customers by revenue")) {
  if (event === "progress") console.log("working:", data);
  if (event === "answer") console.log((data as { answer: string }).answer);
  if (event === "error") console.error(data);
}
```

The timeout covers waiting for the response headers; once the stream starts only your `signal` can stop it:

```ts
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 30_000);
for await (const e of mitra.askStream("Revenue by month", { signal: ctl.signal })) { /* ... */ }
```

### `askAudio(file, params?, opts?): Promise<Answer>`

Sends a voice note to `POST /ask/audio`. `file` is a `Blob`, `ArrayBuffer` or `Uint8Array` (a Node `Buffer` is a `Uint8Array`). `AskAudioParams` is `{ conversationId?, sourceId?, language?, filename?, contentType? }`. The answer has `heard.transcript` and `heard.language`. See the [voice guide](../guides/voice.md).

```ts
import { readFile } from "node:fs/promises";

const audio = await readFile("question.ogg");
const answer = await mitra.askAudio(audio, {
  filename: "question.ogg",
  contentType: "audio/ogg",
  language: "hi-IN",
});
console.log(answer.heard?.transcript, "->", answer.answer);
```

Recordings are limited to 5 MB.

## Resources

On the client: `workspaces`, `sources`, `connectors`, `files`, `gems`, `dashboards`, `predictions`, `jobs`, `webhooks`, `conversations`, `members` and `invitations`. Methods that delete or return nothing resolve to `void`. All take [`RequestOptions`](#per-call-options) last.

### Workspaces

| Method | Endpoint |
|---|---|
| `workspaces.list()` | `GET /workspaces`, returns `{ current, workspaces }` |
| `workspaces.use(workspaceId)` | `PUT /me/workspace`; also becomes this client's default `workspaceId` |

```ts
const { current, workspaces } = await mitra.workspaces.list();
await mitra.workspaces.use(workspaces[0].id);
```

`use` is for OAuth tokens; an API key is pinned to one workspace. See [Switch workspaces](../guides/switch-workspaces.md).

### Sources and connectors

| Method | Endpoint | Notes |
|---|---|---|
| `sources.list()` | `GET /sources` | |
| `sources.get(id)` | `GET /sources/{id}` | includes readiness |
| `sources.test(config)` | `POST /sources/test` | `sources:write` |
| `sources.create({ config, activate? })` | `POST /sources` | admin and `sources:write`. `activate` defaults to `true`. Throws `SourceTestFailedError` on 422 |
| `sources.activate(id)` | `POST /sources/{id}/activate` | |
| `sources.delete(id)` | `DELETE /sources/{id}` | destructive |
| `connectors.list()` | `GET /connectors` | connector types and the fields each needs |

```ts
import { SourceTestFailedError } from "@matihlabs/mitra";

try {
  const source = await mitra.sources.create({
    config: { type: "postgres", host: "db.example.com", port: 5432, database: "sales", user: "reader", password: "..." },
  });
} catch (err) {
  if (err instanceof SourceTestFailedError) console.error(err.testResult); // nothing was saved
  else throw err;
}
```

Take the exact `type` and field names from `connectors.list()`. See [Connect a data source](../guides/connect-source.md).

### Files

| Method | Endpoint |
|---|---|
| `files.upload(file, { filename?, contentType?, onDuplicate? })` | `POST /files` (CSV or Excel, `sources:write`) |
| `files.get(id)` | `GET /files/{id}`: `status`, `analysis_state?`, `decision_required?` |
| `files.list()` | `GET /files`, returns `{ files }` |
| `files.duplicate(id, decision)` | `POST /files/{id}/duplicate` |
| `files.delete(id)` | `DELETE /files/{id}` |

```ts
import { readFile } from "node:fs/promises";

const file = await mitra.files.upload(await readFile("sales.csv"), {
  filename: "sales.csv",
  contentType: "text/csv",
  onDuplicate: "replace",
});

let status = await mitra.files.get(file.id);
while (status.status === "processing") {
  await new Promise((r) => setTimeout(r, 3000));
  status = await mitra.files.get(file.id);
}
if (status.decision_required) await mitra.files.duplicate(file.id, "replace");
```

See [Upload a file](../guides/upload-file.md).

### Gems

| Method | Endpoint |
|---|---|
| `gems.list({ source_id? })` | `GET /gems`, returns `{ state, gems, generated_at }` |
| `gems.get(id)` | `GET /gems/{id}` |
| `gems.image(id, opts?)` | `GET /gems/{id}/image.png`, returns `Uint8Array` |
| `gems.generate(source)` | `POST /gems/generate`, returns a `Job`. `source` is an id or `{ source_id }` |

```ts
const { gems } = await mitra.gems.list({ source_id: "src_1" });
const png = await mitra.gems.image(gems[0].id);

const job = await mitra.gems.generate("src_1");
await mitra.jobs.wait(job);
```

`gems.image` fetches the bytes with your credential. If the picture is still rendering, the API answers with a job; the SDK waits for it (up to `waitTimeoutMs`, default 5 minutes) and downloads the result from its signed URL. See [Gems feed](../guides/gems-feed.md).

### Dashboards

| Method | Endpoint |
|---|---|
| `dashboards.list()` | `GET /dashboards`, returns `{ dashboards }` |
| `dashboards.get(id)` | `GET /dashboards/{id}` |
| `dashboards.image(id)` | `POST /dashboards/{id}/image`, returns a `Job` whose result is `{ image_url, width, height }` |
| `dashboards.imageBytes(id, opts?)` | `GET /dashboards/{id}/image.png`, returns `Uint8Array`, waiting for a render when none is cached |

```ts
const { dashboards } = await mitra.dashboards.list();
const bytes = await mitra.dashboards.imageBytes(dashboards[0].id);
await writeFile("dashboard.png", bytes);
```

See [Dashboard image previews](../guides/dashboard-previews.md).

### Predictions

`predictions.create({ question, source_id?, conversation_id? })` calls `POST /predictions` (scope `predict`) and returns `Job<PredictionResult>`. It can take up to 30 minutes.

```ts
const job = await mitra.predictions.create({
  question: "Forecast monthly revenue for the next 6 months",
  source_id: "src_1",
});
const done = await mitra.jobs.wait(job, { onProgress: (j) => console.log(j.state) });
console.log(done.result?.answer, done.result?.attachments);
```

`PredictionResult` is `{ answer, attachments, image_url? }`. Attachment `type` is `forecast`, `table`, `model` or `what_if`. See [Predictive questions](../guides/predictive.md).

### Jobs

| Method | Endpoint |
|---|---|
| `jobs.get(id)` | `GET /jobs/{id}` |
| `jobs.cancel(id)` | `POST /jobs/{id}/cancel` |
| `jobs.wait(job, opts?)` | polls until terminal |

`jobs.wait` accepts a `Job` or an id and resolves with the succeeded job. A job is `queued`, `running`, `succeeded`, `failed` or `cancelled`.

| `WaitOptions` | Default | Meaning |
|---|---|---|
| `timeoutMs` | `2100000` (35 min) | Total time to wait; then `JobTimeoutError` (the job keeps running) |
| `pollIntervalMs` | `1000` | First delay between polls |
| `maxPollIntervalMs` | `10000` | Largest delay |
| `backoffFactor` | `1.5` | Multiplier applied after each poll |
| `onProgress` | none | Called with every observed job, including the final one |
| `throwOnFailure` | `true` | `false` returns failed or cancelled jobs instead of throwing `JobFailedError` |
| `signal`, `workspaceId`, `language`, `maxRetries` | | As in `RequestOptions` |

```ts
const job = await mitra.predictions.create({ question: "Forecast Q4 revenue" });
const done = await mitra.jobs.wait(job, {
  timeoutMs: 35 * 60_000,
  onProgress: (j) => console.log(j.state),
  throwOnFailure: false,
});
if (done.state === "failed") console.error(done.error?.category, done.error?.message);
```

See [Jobs](../concepts/jobs.md) and [Sync vs async](../concepts/sync-async.md).

### Webhooks

| Method | Endpoint |
|---|---|
| `webhooks.create({ url, events })` | `POST /webhooks`; the `secret` (`whsec_...`) is in this response only |
| `webhooks.list()` | `GET /webhooks`, returns `{ webhooks }` |
| `webhooks.test(id)` | `POST /webhooks/{id}/test` |
| `webhooks.deliveries(id)` | `GET /webhooks/{id}/deliveries`, returns `{ deliveries }` |
| `webhooks.delete(id)` | `DELETE /webhooks/{id}` |

`events` is a list of `WebhookEventName`: `gems.ready`, `prediction.completed`, `job.completed`, `dashboard_image.ready`.

```ts
const hook = await mitra.webhooks.create({
  url: "https://example.com/hooks/matih",
  events: ["gems.ready", "prediction.completed", "job.completed"],
});
console.log(hook.secret); // store it now; it is never shown again
await mitra.webhooks.test(hook.id);
```

Needs `webhooks:manage` and an admin member. See the [webhooks guide](../guides/webhooks.md).

### Members and invitations

| Method | Endpoint | Scope |
|---|---|---|
| `members.list()` | `GET /members` | `members:read` |
| `members.update(id, { role })` | `PATCH /members/{id}` | `members:manage` |
| `members.remove(id)` | `DELETE /members/{id}` | `members:manage` |
| `invitations.create({ email? \| phone?, role })` | `POST /invitations` | `members:manage` |
| `invitations.list()` | `GET /invitations` | `members:read` |
| `invitations.revoke(id)` | `DELETE /invitations/{id}` | `members:manage` |

```ts
const { members } = await mitra.members.list();
await mitra.invitations.create({ email: "teammate@example.com", role: "member" });
await mitra.invitations.create({ phone: "+910000000000", role: "member" });
```

`invitations.create` rejects with a `TypeError` when neither `email` nor `phone` is given. Roles are `owner`, `admin`, `member` or another string the workspace defines; take valid values from `members.list()`. See [Invite members](../guides/invite-members.md).

### Conversations

`conversations.list()` returns `{ conversations }`; `conversations.get(id)` returns one conversation.

### Endpoints without a method: `raw`

`mitra.raw` is an `openapi-fetch` client with loose typing. It shares the client's credential, headers, retries and timeout, so you can call an endpoint that has no dedicated method yet (see the [API reference](../api-reference.md)):

```ts
const { data, error } = await mitra.raw.GET("/workspaces");
```

## Retries and idempotency

The client retries up to `maxRetries` times (default 2), waiting for `Retry-After` when sent and otherwise using exponential backoff with jitter (500 ms base, capped at 8 s).

| Failure | Retried |
|---|---|
| `429` | Always, since the request was not processed. If `Retry-After` is over 60 s the `RateLimitError` is thrown instead |
| `5xx` | Only when repeating is safe: `GET`, `HEAD`, `PUT`, `DELETE`, or a call with an `Idempotency-Key` |
| Network error or timeout | Same rule as `5xx` |
| Other `4xx` | Never |

`ask`, `askStream`, `askAudio`, `gems.generate`, `dashboards.image` and `predictions.create` generate an `Idempotency-Key` (once per call, shared by its retries) so a retry is never charged twice. Pass `idempotencyKey` to choose it yourself, for example to survive a process restart. Use a fresh key for a new logical request.

## Errors

Every API failure throws a subclass of `MitraError`, chosen from the HTTP status. The body's `{"detail": {"category", "message", "code"}}` fills the fields. See [Errors](../concepts/errors.md).

| Class | Status | Typical `category` | Extra fields |
|---|---|---|---|
| `AuthError` | 401 | `auth` | |
| `CreditsError` | 402 | `credits`, `member_cap` | |
| `PermissionError` | 403 | `scope`, `workspace_role`, `source_access` | |
| `BusyError` | 409 | `busy` | |
| `SourceTestFailedError` | 422 from `sources.create` | `source_test` | `testResult` |
| `RateLimitError` | 429 | `rate_limit` | `retryAfter` (seconds) |
| `ConnectionError` | 0 | `network`, `timeout` | `cause` |
| `JobFailedError` | 0 | the job's error category, or its state | `job` |
| `JobTimeoutError` | 0 | `timeout` | `jobId`, `timeoutMs`, `job` |
| `MitraError` | any other | `validation`, `not_found`, `server`, ... | |

All carry `message`, `status` (`0` when no HTTP response was involved), `category`, `code?`, `requestId?` (from `x-request-id`; quote it to support) and `body`.

!!! note
    Always import `PermissionError` and `ConnectionError` by name, or alias them (`import { PermissionError as MitraPermissionError } from "@matihlabs/mitra"`) if your code already defines classes with those names.

```ts
import { CreditsError, PermissionError, RateLimitError, MitraError } from "@matihlabs/mitra";

try {
  await mitra.ask("Revenue by region");
} catch (err) {
  if (err instanceof PermissionError) console.error("missing", err.category, err.message);
  else if (err instanceof CreditsError) console.error("workspace is out of credits");
  else if (err instanceof RateLimitError) console.error("retry in", err.retryAfter, "s");
  else if (err instanceof MitraError) console.error(err.status, err.category, err.requestId);
  else throw err;
}
```

An aborted `signal` rejects with the signal's own reason (usually an `AbortError`), not a `MitraError`.

## Verify webhooks

```ts
import { verifyWebhook, signWebhook } from "@matihlabs/mitra";
```

`verifyWebhook(secret, header, body, toleranceSec = 300)` returns `true` or `false`. It is `false` for a missing or malformed header, a timestamp outside the tolerance, or a mismatch, and it compares in constant time. `body` is a `string` or `Uint8Array` and must be the raw body exactly as received. `mitra.verifyWebhook(...)` is the same function as a method.

```ts
import express from "express";
import { verifyWebhook } from "@matihlabs/mitra";

const app = express();

app.post("/hooks/matih", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyWebhook(process.env.MATIH_WEBHOOK_SECRET!, req.header("Matih-Signature"), req.body)) {
    return res.sendStatus(400);
  }
  const event = JSON.parse(req.body.toString("utf8"));
  // de-duplicate on event.id, then do the work after answering
  res.sendStatus(204);
});
```

`signWebhook(secret, body, timestampSec?)` builds a `Matih-Signature` value. Deliveries are already signed by Matih; use it in tests to produce a valid request for your own handler:

```ts
const body = JSON.stringify({ id: "evt_1", type: "ping", data: { message: "test" } });
const header = signWebhook("whsec_test", body);
// POST body to your handler with Matih-Signature: header
```

See the [webhooks guide](../guides/webhooks.md) for the events, retries and verification in other languages.

## Types

Everything is exported from the package root, including `MitraOptions`, `RequestOptions`, `WaitOptions`, `ImageBytesOptions`, `Answer`, `AskParams`, `AskAudioParams`, `StreamEvent`, `Job`, `JobState`, `JobKind`, `PredictionResult`, `DashboardImageResult`, `Gem`, `GemList`, `Dashboard`, `Webhook`, `WebhookEventName`, `Member`, `MemberRole`, `Invitation`, `UploadedFile`, `Scope`, plus `VERSION` and `DEFAULT_BASE_URL`. `Job<R>` is generic in its `result`, so `mitra.jobs.wait<MyResult>(id)` types it for you. Many response types allow extra keys, so a field the server adds later does not break your build.

## Custom fetch

Pass a `fetch` for proxies, tracing or tests. The SDK builds the headers, timeout and retries itself and calls your function with `(url, init)`:

```ts
import { ProxyAgent, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent("http://proxy.internal:3128");
const mitra = new Mitra({
  apiKey: process.env.MITRA_API_KEY,
  fetch: ((url, init) => undiciFetch(url as string, { ...(init as object), dispatcher })) as typeof fetch,
});
```

Testing without a network:

```ts
const mitra = new Mitra({
  apiKey: "mtk_test",
  maxRetries: 0,
  fetch: async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.get("Idempotency-Key")) throw new Error("expected an idempotency key");
    return new Response(
      JSON.stringify({ detail: { category: "credits", message: "Out of credits" } }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  },
});
await mitra.ask("hello").catch((e) => console.log(e.name, e.status)); // CreditsError 402
```

## Runtime notes

| Runtime | Status |
|---|---|
| Node 18 and newer | Supported |
| Bun | Works through its Node compatibility (`node:crypto`, global `fetch`) |
| Deno | Works with `npm:@matihlabs/mitra` and Node compatibility enabled |
| Cloudflare Workers and other edge runtimes | Only if `node:crypto` is available (for example with Node compatibility flags) |
| Browsers | Not supported. Keep the key on a server and expose your own endpoint |

## Next

- [Quickstart](../quickstart.md)
- [Build a chat bot](../guides/chat-bot.md)
- [Python SDK](python.md)
- [API reference](../api-reference.md)
