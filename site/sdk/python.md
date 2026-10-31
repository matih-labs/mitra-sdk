# Python SDK

`mitra-sdk` is the Python client for the Matih public API. It gives you a synchronous client (`Mitra`) and an asynchronous one (`AsyncMitra`) with the same surface, both built on [httpx](https://www.python-httpx.org/), with [pydantic](https://docs.pydantic.dev/) v2 models for the main response shapes, server-sent-event streaming, background-job polling, automatic retries and webhook signature verification.

```bash
pip install mitra-sdk
```

Python 3.10 or newer. The package installs as `mitra-sdk` and imports as `mitra`.

```python
from mitra import Mitra, AsyncMitra
```

Source and tests: [`sdks/python`](https://github.com/matih-labs/mitra-sdk/tree/main/sdks/python).

## Create a client

=== "Sync"

    ```python
    from mitra import Mitra

    client = Mitra(api_key="mtk_...")      # or set MATIH_API_KEY and call Mitra()

    answer = client.ask("How many orders did we get today?")
    print(answer.answer)
    ```

=== "Async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra(api_key="mtk_...") as client:
            answer = await client.ask("How many orders did we get today?")
            print(answer.answer)

    asyncio.run(main())
    ```

!!! warning "Keep keys out of source"
    Read the key from the environment or a secret store. Never commit an `mtk_` key. See [SECURITY.md](https://github.com/matih-labs/mitra-sdk/blob/main/SECURITY.md) and [Credentials and products](../concepts/credentials.md).

### Constructor options

`Mitra` and `AsyncMitra` take the same options. Everything except `api_key` is keyword-only.

| Option | Default | Meaning |
|---|---|---|
| `api_key` | `$MATIH_API_KEY` | Workspace API key (`mtk_...`). Pinned to one workspace. |
| `access_token` | `$MATIH_ACCESS_TOKEN` | OAuth access token (`mto_...`). Use instead of `api_key`. Passing both raises `ValueError`. |
| `base_url` | `$MATIH_BASE_URL`, else `https://workspace.matih.ai` | The host only: the SDK adds `/api/v1`. A trailing slash is removed. |
| `workspace_id` | none | Default `X-Matih-Workspace` header. Used by OAuth tokens; an API key is pinned and a different workspace is refused. |
| `language` | none | Default `Accept-Language`, for example `hi-IN`. See [Languages](../concepts/languages.md). |
| `timeout` | `60.0` | Per-request timeout in seconds. Streaming has no read timeout. |
| `max_retries` | `2` | Retries per call, see [Retries](#retries-and-idempotency). |
| `http_client` | a new client | Your own `httpx.Client` (`httpx.AsyncClient` for `AsyncMitra`). |

If no credential is given and neither `MATIH_API_KEY` nor `MATIH_ACCESS_TOKEN` is set, the constructor raises `ValueError`.

OAuth example (an app acting for one user):

```python
client = Mitra(access_token="mto_...", workspace_id="ws_123")
```

### Per-call options

Every endpoint method also accepts these keyword arguments, which override the client defaults for that one call:

| Keyword | Effect |
|---|---|
| `workspace_id=` | Sends `X-Matih-Workspace` for this call. |
| `language=` | Sends `Accept-Language` for this call. |
| `idempotency_key=` | Sets the `Idempotency-Key` header. The server honours it on `ask` and `predictions.create` only. |

```python
client.sources.list(workspace_id="ws_456")
client.ask("Total sales?", language="ta-IN", idempotency_key="order-1042-q1")
```

### Context managers and cleanup

The client closes the httpx client it created when you leave a `with` block (`async with` for `AsyncMitra`), or when you call `client.close()` (`await client.aclose()`). A client you pass in as `http_client` is never closed for you.

=== "Sync"

    ```python
    with Mitra() as client:
        print(client.workspaces.list().current)
    ```

=== "Async"

    ```python
    async with AsyncMitra() as client:
        print((await client.workspaces.list()).current)
    ```

## Ask

### `ask(question, *, conversation_id=None, source_id=None, language=None, background=False, **opts) -> Answer | Job`

Sends `POST /ask`. Scope `ask`. Costs credits, so an `Idempotency-Key` is generated for you and reused across retries. With `background=True` it sends `Prefer: respond-async` and returns a `Job` of kind `ask` at once; finish it with `client.jobs.wait(job).as_answer()`.

=== "Sync"

    ```python
    answer = client.ask("What were last month's sales by region?", source_id="src_1")

    if answer.status == "answered":
        print(answer.answer)
        for row in answer.result.rows:
            print(row)
        if answer.image_url:
            open("chart.png", "wb").write(client.download_image(answer.image_url))
    elif answer.status == "clarification":
        print(answer.clarification.question, answer.clarification.options)
        answer = client.ask(
            answer.clarification.options[0], conversation_id=answer.conversation_id
        )

    follow_up = client.ask(answer.follow_ups[0], conversation_id=answer.conversation_id)
    ```

=== "Async"

    ```python
    answer = await client.ask("What were last month's sales by region?", source_id="src_1")

    if answer.status == "answered":
        print(answer.answer)
        for row in answer.result.rows:
            print(row)
        if answer.image_url:
            open("chart.png", "wb").write(await client.download_image(answer.image_url))
    elif answer.status == "clarification":
        print(answer.clarification.question, answer.clarification.options)
        answer = await client.ask(
            answer.clarification.options[0], conversation_id=answer.conversation_id
        )
    ```

`answer.status` is `answered`, `empty`, `clarification`, `error` or `cancelled`. These are normal HTTP 200 responses, not exceptions. Reuse `answer.conversation_id` to keep a conversation going. Force the reply language with `language="hi-IN"`; data values, SQL and column names are never translated.

### `ask_stream(question, *, conversation_id=None, source_id=None, language=None, **opts)`

Same arguments as `ask`. Yields `StreamEvent` objects (`started`, `progress`, `answer`, `error`). An `error` event is yielded, not raised. If the request itself fails (bad credential, no credits), the matching `MitraError` is raised before anything is yielded.

=== "Sync"

    ```python
    for event in client.ask_stream("Top 5 products by revenue"):
        if event.event == "progress":
            print("...", event.data)
        elif event.event == "answer":
            answer = event.as_answer()
            print(answer.answer)
        elif event.event == "error":
            raise RuntimeError(event.data)
    ```

=== "Async"

    ```python
    async for event in client.ask_stream("Top 5 products by revenue"):
        if event.event == "progress":
            print("...", event.data)
        elif event.event == "answer":
            print(event.as_answer().answer)
        elif event.event == "error":
            raise RuntimeError(event.data)
    ```

Note that `AsyncMitra.ask_stream` is a plain method returning an async iterator, so you use `async for` and do not `await` it.

### `ask_audio(file, *, filename=None, content_type=None, conversation_id=None, source_id=None, language=None, **opts) -> Answer`

Sends a voice note to `POST /ask/audio`. `file` is a path (`str` or `PathLike`), `bytes` or an open binary file. The answer has `heard.transcript` and `heard.language`. See the [voice guide](../guides/voice.md).

=== "Sync"

    ```python
    answer = client.ask_audio("question.ogg", language="hi-IN")
    print(answer.heard.transcript, "->", answer.answer)
    ```

=== "Async"

    ```python
    answer = await client.ask_audio("question.ogg", language="hi-IN")
    print(answer.heard.transcript, "->", answer.answer)
    ```

### `download_image(image_url) -> bytes`

Downloads PNG bytes from a short-lived signed `image_url` (about 15 minutes). No credential is sent, and relative URLs are resolved against `base_url`. See [Images](../concepts/images.md).

## Resources

Each resource hangs off the client: `client.workspaces`, `client.sources`, `client.files`, `client.gems`, `client.dashboards`, `client.predictions`, `client.jobs`, `client.webhooks`, `client.members`, `client.invitations`, `client.conversations`. On `AsyncMitra` every method below is a coroutine, so put `await` in front of it. All methods accept the [per-call options](#per-call-options).

### Workspaces

| Method | Endpoint | Returns |
|---|---|---|
| `workspaces.list()` | `GET /workspaces` | `WorkspaceList` (`.current`, `.workspaces`, `.invitations`) |
| `workspaces.use(workspace_id)` | `PUT /me/workspace` | `WorkspaceChosen`. OAuth tokens only; an API key is pinned to one workspace |

```python
ws = client.workspaces.list()
print(ws.current, [(w.id, w.name, w.role) for w in ws.workspaces])
client.workspaces.use(ws.workspaces[0].id)
```

`use` changes the person's current workspace. A client with `workspace_id=` set does not follow it automatically; pass `workspace_id=` per call (sent as `X-Matih-Workspace`) or build a new client. See [Switch workspaces](../guides/switch-workspaces.md).

### Sources

| Method | Endpoint | Notes |
|---|---|---|
| `sources.list()` | `GET /sources` | `SourceList` |
| `sources.get(source_id)` | `GET /sources/{id}` | `Source`, with `readiness` (`can_ask`) |
| `sources.connectors()` | `GET /connectors` | `ConnectorList`: connector types and the fields each needs (also `client.connectors.list()`) |
| `sources.test(config)` | `POST /sources/test` | `SourceTest`; saves nothing |
| `sources.create(config, *, activate=True, wait=None, background=False)` | `POST /sources` | Admin and `sources:write`. Returns `SourceCreated`. Raises `SourceTestFailedError` on 422 |
| `sources.activate(source_id)` | `POST /sources/{id}/activate` | `sources:write` |
| `sources.delete(source_id)` | `DELETE /sources/{id}` | `SourceDeleted`. Destructive |

```python
from mitra import SourceTestFailedError

config = {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com",
          "port": 5432, "database": "sales", "user": "reader", "password": "..."}
try:
    created = client.sources.create(config, activate=True)
except SourceTestFailedError as e:
    print(e.test_result)       # nothing was saved
else:
    print(created.source.readiness.can_ask)
```

`config` is the source's settings: `connector_type` plus the fields that type takes, as listed by `sources.connectors()`. `create` waits by default until `source.readiness.can_ask` is true (up to `wait` seconds, default 300), because Matih reads the tables in the background after saving. If it is not ready by then you get the source as it stands (`readiness.phase == "building"`) and nothing is raised, so check `can_ask`. Pass `background=True` to return right after the save. See [Connect a data source](../guides/connect-source.md).

### Files

| Method | Endpoint | Notes |
|---|---|---|
| `files.upload(file, *, filename=None, content_type=None, on_duplicate=None, wait=None, background=False)` | `POST /files` | CSV, Parquet, JSON or Excel; `files:write`. Returns `File` |
| `files.get(file_id)` | `GET /files/{id}` | `status`, `ready`, `analysis_state`, `decision_required` |
| `files.list()` | `GET /files` | `FileList` |
| `files.duplicate(file_id, decision)` | `POST /files/{id}/duplicate` | `decision` is `use_existing`, `keep_both` or `cancel` |
| `files.delete(file_id)` | `DELETE /files/{id}` | Destructive |

```python
f = client.files.upload("sales.csv")           # waits until the file is settled
if f.decision_required == "duplicate":         # an identical file is already there
    f = client.files.duplicate(f.id, "use_existing")
print(f.status, f.ready, [t.model_name for t in f.tables])
```

`on_duplicate` is `ask` (the default: an identical file waits for your decision) or `keep_both`. By default `upload` waits, up to `wait` seconds (default 300), until the file is `ready`, `failed`, `needs_attention` or waiting for a decision; on timeout it returns the file as it stands. Pass `background=True` to return right after the upload and poll `files.get` yourself. See [Upload a file](../guides/upload-file.md).

### Gems

| Method | Endpoint | Notes |
|---|---|---|
| `gems.list(source_id=None)` | `GET /gems` | `GemList` |
| `gems.get(gem_id, source_id=None)` | `GET /gems/{id}` | `Gem` |
| `gems.image(gem_id, source_id=None)` | `GET /gems/{id}/image.png` | PNG `bytes` |
| `gems.generate(source_id=None, *, wait=None, background=False)` | `POST /gems/generate` | `gems:generate`. Returns the finished `Job` |

=== "Sync"

    ```python
    gems = client.gems.list(source_id="src_1")
    png = client.gems.image(gems.gems[0].id)

    job = client.gems.generate("src_1")          # waits, result: {source_id, state, gem_count}
    ```

=== "Async"

    ```python
    gems = await client.gems.list(source_id="src_1")
    png = await client.gems.image(gems.gems[0].id)

    job = await client.gems.generate("src_1")
    ```

`generate` waits for the job (up to `wait` seconds, default 600) and raises `JobTimeoutError` if it is still running then; the job keeps going. With `background=True` it returns the queued `Job` at once, and you finish with `jobs.wait` or the `gems.ready` webhook. See [Gems feed](../guides/gems-feed.md).

### Dashboards

| Method | Endpoint | Notes |
|---|---|---|
| `dashboards.list()` | `GET /dashboards` | `DashboardList` |
| `dashboards.get(dashboard_id)` | `GET /dashboards/{id}` | `Dashboard`, with `widgets` |
| `dashboards.image(dashboard_id, *, width=None, wait=None, background=False)` | `POST /dashboards/{id}/image` | Returns the finished `Job`; result `{image_url, width, height}`. `width` is 400 to 3200 (default 1600) |
| `dashboards.image_bytes(dashboard_id, *, width=None, timeout=300.0)` | `GET /dashboards/{id}/image.png` | Follows the redirect or the Job, returns PNG `bytes` |
| `dashboards.render(dashboard_id, *, width=None, timeout=300.0)` | `POST /dashboards/{id}/image` | Draws, waits, downloads, returns PNG `bytes` |

=== "Sync"

    ```python
    dash = client.dashboards.list().dashboards[0]
    png = client.dashboards.render(dash.id, width=1200)
    open("dashboard.png", "wb").write(png)
    ```

=== "Async"

    ```python
    dash = (await client.dashboards.list()).dashboards[0]
    png = await client.dashboards.render(dash.id, width=1200)
    open("dashboard.png", "wb").write(png)
    ```

A dashboard drawn in the last ten minutes at the same width is reused. See [Dashboard image previews](../guides/dashboard-previews.md).

### Predictions

| Method | Notes |
|---|---|
| `predictions.create(question, *, source_id=None, conversation_id=None, language=None, wait=None, background=False)` | `POST /predictions`, scope `predict`. Returns the finished `Job` (waits up to `wait` seconds, default 1860); predictions can take up to 30 minutes |
| `predictions.run(question, *, timeout=1860.0, **kwargs)` | Same as `create(question, wait=timeout, ...)` |

=== "Sync"

    ```python
    job = client.predictions.run("Forecast monthly revenue for the next 6 months", source_id="src_1")
    print(job.result["answer"])
    ```

=== "Async"

    ```python
    job = await client.predictions.run("Forecast monthly revenue for the next 6 months", source_id="src_1")
    print(job.result["answer"])
    ```

The result is `{conversation_id, answer}`; keep the `conversation_id` to ask a follow-up in the same conversation. With `background=True` you get the queued `Job` at once. See [Predictive questions](../guides/predictive.md).

### Jobs

| Method | Endpoint |
|---|---|
| `jobs.get(job_id)` | `GET /jobs/{id}` |
| `jobs.cancel(job_id)` | `POST /jobs/{id}/cancel` |
| `jobs.wait(job, timeout=1860.0, *, poll_interval=1.0, max_poll_interval=15.0, on_update=None, raise_on_failure=True)` | polls until terminal |

`wait` takes a `Job` or a job id. It polls with growing delays (1 s growing to 15 s by default) until the job is `succeeded`, `failed` or `cancelled`.

| `wait` option | Meaning |
|---|---|
| `timeout` | Seconds to wait. The default of 1860 is a little over the 30-minute maximum for predictions. On expiry raises `JobTimeoutError`; the job keeps running |
| `poll_interval`, `max_poll_interval` | First and largest delay between polls |
| `on_update` | Called with the `Job` on every poll and once at the end. On `AsyncMitra` it may be a plain function or a coroutine function |
| `raise_on_failure` | `True` raises `JobFailedError` for `failed` or `cancelled`; `False` returns the job so you can inspect `job.error` |

```python
job = client.predictions.create("Forecast Q4 revenue", background=True)
job = client.jobs.wait(job, timeout=2100, on_update=lambda j: print(j.state))

queued = client.ask("Revenue by region, last 4 quarters", background=True)   # a Job of kind "ask"
answer = client.jobs.wait(queued).as_answer()
```

See [Jobs](../concepts/jobs.md) and [Sync vs async](../concepts/sync-async.md).

### Webhooks

| Method | Endpoint |
|---|---|
| `webhooks.create(url, events)` | `POST /webhooks`. The `secret` (`whsec_...`) is in the response once |
| `webhooks.list()` | `GET /webhooks` |
| `webhooks.test(webhook_id)` | `POST /webhooks/{id}/test` |
| `webhooks.deliveries(webhook_id)` | `GET /webhooks/{id}/deliveries` |
| `webhooks.delete(webhook_id)` | `DELETE /webhooks/{id}` |

```python
hook = client.webhooks.create(
    "https://example.com/hooks/matih", ["gems.ready", "prediction.completed", "job.completed"]
)
print(hook.secret)               # store it now, it is never shown again
client.webhooks.test(hook.id)
```

Needs `webhooks:manage` and an admin member. See the [webhooks guide](../guides/webhooks.md).

### Members and invitations

| Method | Endpoint | Scope |
|---|---|---|
| `members.list()` | `GET /members` | `members:read` |
| `members.update(member_id, role)` | `PATCH /members/{id}` | `members:manage` |
| `members.remove(member_id)` | `DELETE /members/{id}` | `members:manage` |
| `invitations.create(role="user", *, email=None, phone=None, whatsapp_only=False)` | `POST /invitations` | `members:manage` |
| `invitations.list()` | `GET /invitations` | `members:read` |
| `invitations.revoke(invitation_id)` | `DELETE /invitations/{id}` | `members:manage` |

```python
client.invitations.create("user", email="new@example.com")
inv = client.invitations.create("viewer", phone="+910000000000")
if inv.join_code:                    # WhatsApp delivery failed: share this yourself, shown once
    print(inv.join_message)
```

Roles you can give are `admin`, `user` and `viewer`; `owner` is never givable. `invitations.create` needs exactly one of `email` or `phone`, otherwise it raises `ValueError`. See [Invite members](../guides/invite-members.md).

### Conversations

`conversations.list()` returns a `ConversationList` and `conversations.get(conversation_id)` a `Conversation` with its `messages`.

## Retries and idempotency

The client retries for you, up to `max_retries` times (default 2), with the delay taken from `Retry-After` (capped at 60 s) or else exponential backoff (0.5 s, 1 s, 2 s, up to 8 s).

| Failure | Retried |
|---|---|
| `429` | Always. The request was not processed |
| `502`, `503`, `504` | Only when the call is safe to repeat: `GET`, `HEAD`, `DELETE`, or a call that carries an `Idempotency-Key` |
| Network errors | Same rule as above |
| Other statuses, including `500` | Never |

`ask`, `ask_stream` and `predictions.create` send an `Idempotency-Key` automatically (a fresh UUID per call, reused across that call's retries). The server honours the key on `POST /ask` and `POST /predictions` only, so on those two a retry answers once and is charged once. Pass `idempotency_key=` to set your own, for example to survive a process restart:

```python
client.predictions.create("Forecast Q4 revenue", idempotency_key="report-2026-q4")
```

Use a new key for a new logical request. Other `POST` calls (such as `sources.create` or `gems.generate`) are not retried on `5xx`, because repeating them could do the work twice.

## Errors

Every API error derives from `MitraError`. The class is chosen from the HTTP status, and the details come from the `{"detail": {"category", "message", "code"}}` body. See [Errors](../concepts/errors.md).

| Exception | Status | Typical `category` | Extra attributes |
|---|---|---|---|
| `AuthError` | 401 | | |
| `CreditsError` | 402 | `not_ready`, `member_cap` | |
| `PermissionDeniedError` | 403 | `scope`, `workspace_role`, `source_access` | |
| `BusyError` | 409 | `conflict` | |
| `SourceTestFailedError` | 422 from `sources.create` | `connection` | `test_result` |
| `RateLimitError` | 429 | `rate_limited` | `retry_after` (seconds, or `None`) |
| `JobFailedError` | job `failed` or `cancelled` | | `job` |
| `JobTimeoutError` | `jobs.wait` timed out | | `job` |
| `MitraError` | anything else, and network failures | | |

All of them carry `message`, `status`, `category`, `code`, `request_id` (from `x-request-id`; quote it to support) and `body` (the decoded response).

```python
from mitra import CreditsError, PermissionDeniedError, RateLimitError, MitraError

try:
    answer = client.ask("Revenue by region")
except PermissionDeniedError as e:
    print("missing", e.category, e.message)     # category "scope": the key lacks the product
except CreditsError:
    print("workspace is out of credits; an admin must add some")
except RateLimitError as e:
    print("slow down, retry in", e.retry_after)
except MitraError as e:
    print(e.status, e.category, e.request_id)
```

`WebhookVerificationError` (a `ValueError`) is separate; it is raised only by `assert_webhook`.

## Models

`mitra.models` holds pydantic models for every response. They accept unknown fields (`extra="allow"`), so a field the server adds later never breaks an older client, and the extra values are still readable as attributes.

| Model | Fields |
|---|---|
| `Answer` | `status`, `answer`, `clarification`, `result`, `sql`, `image_url`, `follow_ups`, `conversation_id`, `request_id`, `language`, `heard` |
| `ResultTable` | `columns` (`name`, `type`), `rows`, `row_count`, `truncated` |
| `Clarification` | `question`, `options` |
| `Heard` | `transcript`, `language` |
| `Job` | `id`, `kind`, `state`, `result`, `error` (`category`, `message`), `created_at`, `updated_at`, `is_terminal`, `as_answer()` |
| `Gem`, `GemList` | `id`, `kind`, `headline`, `explanation`, `figures` (`label`, `value`), `question`, `source_id`, `image_url`, `created_at`; list has `state`, `gems`, `generated_at` |
| `Workspace`, `WorkspaceList` | `id`, `name`, `role`, `kind`, `own`; list has `current`, `workspaces`, `invitations` |
| `Source`, `SourceList` | `id`, `name`, `connector_type`, `settings`, `secret_fields_set`, `state`, `is_active`, `is_sample`, `last_test_ok`, `readiness`; list has `sources`, `active_source_id` |
| `SourceCreated` | `source`, `test`, `applied`, `catalog_job_id` |
| `SourceReadiness` | `source_id`, `phase` (`ready`, `building`, `not_connected`), `can_ask`, `message`, `catalog` |
| `Dashboard`, `DashboardList` | `id`, `title`, `description`, `source_id`, `status`, `revision`, `widget_count`, `widgets` (`id`, `title`, `visual`, `question`), `created_at`, `updated_at` |
| `File`, `FileList` | `id`, `name`, `format`, `size_bytes`, `status`, `stage`, `ready`, `analysis_state`, `warnings`, `error_category`, `error_message`, `retryable`, `duplicate_of`, `decision_required`, `decision_options`, `tables`, `is_settled` |
| `Member`, `MemberList` | `id`, `name`, `email`, `phone`, `role`, `whatsapp_only`, `joined_at`, `last_seen_at`, `monthly_cap_credits`, `you`, `can_change_role`, `can_remove` |
| `Invitation`, `InvitationList` | `id`, `channel`, `target`, `role`, `whatsapp_only`, `expires_at`, `expired`, `delivered`, `join_code`, `join_message`, `join_url` (the last three only when delivery failed, shown once) |
| `Webhook` | `id`, `url`, `events`, `failure_count`, `disabled_at`, `secret` (create response only) |
| `Conversation`, `ConversationList` | `Conversation` has its `messages` |
| `StreamEvent` | `event`, `data`, `as_answer()` |

Job states are `queued`, `running`, `succeeded`, `failed` and `cancelled`. Roles are `owner`, `admin`, `user` and `viewer`.

## Verify webhooks

```python
from mitra import verify_webhook, assert_webhook, WebhookVerificationError
```

`verify_webhook(secret, header, body, tolerance_sec=300)` returns `True` or `False`. `assert_webhook` is the same check but raises `WebhookVerificationError` with the reason (missing header, malformed header, stale timestamp, no match) and returns `True` when valid. Both compare in constant time and accept `body` as `bytes` or `str`. Pass the raw body exactly as received, not re-serialised JSON.

```python
from flask import Flask, request
from mitra import verify_webhook

app = Flask(__name__)

@app.post("/hooks/matih")
def matih_hook():
    if not verify_webhook(SECRET, request.headers.get("Matih-Signature"), request.get_data()):
        return "", 400
    event = request.get_json()
    # de-duplicate on event["id"], then do the work after answering
    return "", 204
```

See the [webhooks guide](../guides/webhooks.md) for the events and retry rules, and snippets in other languages.

## Custom HTTP client

Bring your own httpx client for proxies, custom TLS, connection limits or transports:

=== "Sync"

    ```python
    import httpx
    from mitra import Mitra

    http = httpx.Client(proxy="http://proxy.internal:3128", limits=httpx.Limits(max_connections=20))
    client = Mitra(http_client=http)
    ```

=== "Async"

    ```python
    import httpx
    from mitra import AsyncMitra

    http = httpx.AsyncClient(proxy="http://proxy.internal:3128")
    client = AsyncMitra(http_client=http)
    ```

The SDK sets the headers and the per-request timeout itself. You close a client you pass in.

## Testing your integration

Because the transport is httpx, you can test without network access using `httpx.MockTransport`:

```python
import httpx
from mitra import Mitra, CreditsError

def handler(request: httpx.Request) -> httpx.Response:
    assert request.headers["Authorization"] == "Bearer mtk_test"
    assert request.headers["Idempotency-Key"]
    return httpx.Response(402, json={"detail": {"category": "not_ready", "message": "Out of credits"}})

client = Mitra(api_key="mtk_test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
try:
    client.ask("hello")
except CreditsError as e:
    assert e.status == 402
```

To exercise your own retry handling set `max_retries=0`. For live smoke tests use a dedicated key with only the products your bot needs, and a workspace that holds sample data.

## Next

- [Quickstart](../quickstart.md)
- [Build a chat bot](../guides/chat-bot.md)
- [TypeScript SDK](typescript.md)
- [API reference](../api-reference.md)
