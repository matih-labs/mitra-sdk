<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# mitra-sdk (Python)

Python client for the Matih public API. Sync (`Mitra`) and async (`AsyncMitra`) clients on
[httpx](https://www.python-httpx.org/), pydantic v2 models for the main response shapes, SSE
streaming, background-job polling and webhook signature verification.

> Pre-release (0.1.0): the package is not on PyPI until `/api/v1` is live for every workspace. Install from a checkout with
> `pip install -e sdks/python`.

```bash
pip install mitra-sdk        # once released
```

Python 3.10+. The package imports as `mitra`.

## Authenticate

```python
from mitra import Mitra

client = Mitra(api_key="mtk_...")            # or set MATIH_API_KEY
client = Mitra(access_token="mto_...", workspace_id="ws_123")  # OAuth token
```

API keys are pinned to one workspace. OAuth tokens pick a workspace per client with
`workspace_id=` (sent as `X-Matih-Workspace`) or per call, or set a default with
`client.workspaces.use(workspace_id)`. Keep keys in environment variables, never in source.

Admins create keys under `Settings › API & MCP`, choose the products the key may use (all on by default) and revoke keys in the same screen. Keys never expire by default. Use an API key here; an MCP connector key works only on `/api/v1/mcp`. Scopes: `workspaces:read`, `members:read`, `members:manage`, `sources:read`, `sources:write`, `files:read`, `files:write`, `gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`, `webhooks:manage`.

## Ask

```python
answer = client.ask("What were last month's sales by region?", language="en-IN")

if answer.status == "answered":
    print(answer.answer)
    for row in answer.result.rows:
        print(row)
    if answer.image_url:
        open("chart.png", "wb").write(client.download_image(answer.image_url))
elif answer.status == "clarification":
    print(answer.clarification.question, answer.clarification.options)
    # reply in the same conversation
    answer = client.ask(answer.clarification.options[0], conversation_id=answer.conversation_id)

follow_up = client.ask(answer.follow_ups[0], conversation_id=answer.conversation_id)
```

Questions may be in any of 22 Indian languages and are auto-detected; pass `language="hi-IN"` to
force the response language. Data values, column names and figures are never translated.

Voice notes: `answer = client.ask_audio("note.ogg", language="hi-IN")`; `answer.heard` holds the
transcript and detected language.

### Streaming

```python
for event in client.ask_stream("Top 5 products by revenue"):
    if event.event == "progress":
        print("...", event.data)
    elif event.event == "answer":
        answer = event.as_answer()
    elif event.event == "error":
        raise RuntimeError(event.data)
```

## Gems, dashboards, forecasts

```python
gems = client.gems.list(source_id="src_1")
png = client.gems.image(gems.gems[0].id)                  # bytes

job = client.gems.generate("src_1")                        # waits, returns the finished Job
job = client.gems.generate("src_1", background=True)       # returns the queued Job at once
job = client.jobs.wait(job, 600)                           # poll it later

dashboards = client.dashboards.list()
png = client.dashboards.render(dashboards.dashboards[0].id)   # job + wait + download

job = client.predictions.create("Forecast next quarter's revenue", source_id="src_1")
print(job.result["answer"], job.result.get("attachments"))
```

`jobs.wait(job, timeout=1860, poll_interval=1.0, max_poll_interval=15.0, on_update=fn)` raises
`JobTimeoutError` (the job keeps running) or `JobFailedError` (failed or cancelled). Predictions
can take up to 30 minutes. `ask` and `predictions.create` send an `Idempotency-Key` automatically
and reuse it across retries, so a retry is never charged twice (the server honours the key on
these two calls only). Pass `idempotency_key=` to control it.

## Sources and files

```python
client.sources.list()
client.sources.get("src_1")                               # includes readiness
client.sources.connectors()
client.sources.test({"connector_type": "postgres", "display_name": "Orders DB", "host": "...", "database": "..."})
try:
    client.sources.create({...}, activate=True)           # admin, sources:write
except SourceTestFailedError as e:                        # HTTP 422
    print(e.test_result)
client.sources.activate("src_1"); client.sources.delete("src_1")

# files: files:read to list and get; files:write to upload, answer a duplicate prompt and delete
f = client.files.upload("sales.csv", on_duplicate="ask")         # CSV or Excel; "ask" (default) or "keep_both"
client.files.get(f.id)          # status, decision_required, decision_options
client.files.duplicate(f.id, "use_existing")              # answer a duplicate prompt: use_existing, keep_both or cancel
client.files.list(); client.files.delete(f.id)
```

## Members and invitations

Needs `members:read` / `members:manage`; only do these when a person asked for them.

```python
client.members.list()
client.invitations.create("user", email="new@example.com")   # or phone="+91..."
client.invitations.list(); client.invitations.revoke("inv_1")
client.members.update("mem_1", "admin"); client.members.remove("mem_1")
```

## Webhooks

```python
hook = client.webhooks.create("https://example.com/hooks/matih", ["prediction.completed"])
print(hook.secret)   # whsec_..., shown once
client.webhooks.test(hook.id); client.webhooks.deliveries(hook.id)

# Deliveries carry Matih-Signature, Matih-Event and Matih-Delivery headers.

# In your web handler, with the RAW request body:
from mitra import verify_webhook
if not verify_webhook(secret, request.headers["Matih-Signature"], raw_body):  # constant-time
    return 400
# assert_webhook(...) is the same check but raises WebhookVerificationError with the reason.
```

## Sync vs async

Two independent choices: the client (`Mitra` blocks the thread, `AsyncMitra` is awaited) and the
mode of each long call (wait for the result, or get a job back and come back later). Both
clients have the same methods, including members, sources, files, webhooks, voice and jobs.

Every long call (`gems.generate`, `predictions.create`, `dashboards.image`, `sources.create`,
`files.upload`) takes:

- `wait=` seconds (default 10 minutes for Gems, 5 for images, sources and files, 31 for
  predictions). The SDK sends `Prefer: wait=N` (the server honours at most 60 s for jobs, 120 s
  for sources and files) and keeps polling until the result is final or `wait` runs out.
    - Job calls (`gems.generate`, `predictions.create`, `dashboards.image`) poll the job. Running
      out raises `JobTimeoutError`; the job keeps running.
    - Resource calls (`sources.create`, `files.upload`) poll the source or the file. Running out
      raises nothing: you get the source or file as it stands (for example `phase: building`), so
      check `readiness.can_ask` or `status`.
- `background=True` to return right away: the queued `Job`, or for `sources.create` and
  `files.upload` whatever the server answered. No `Prefer: wait` is sent.

```python
job = client.predictions.create("Forecast Q4", wait=900)               # blocks, finished Job
job = client.predictions.create("Forecast Q4", background=True)        # returns immediately
job = client.jobs.wait(job.id, 900)                                    # later, or from another process

queued = client.ask("Top customers this year", background=True)        # Prefer: respond-async
done = client.jobs.wait(queued.id, 120)
answer = done.as_answer()                                              # the Answer held in job.result
```

Without `background=True`, `ask` answers in one call. `predictions.run` and
`dashboards.render` are shortcuts for the waiting form (`render` also downloads the PNG).

## Async

```python
import asyncio
from mitra import AsyncMitra

async def main():
    async with AsyncMitra(api_key="mtk_...") as client:
        answer = await client.ask("How many orders today?")
        job = await client.predictions.create("Forecast Q4", background=True)
        job = await client.jobs.wait(job.id, 900)
        async for event in client.ask_stream("Top customers"):
            print(event.event)

asyncio.run(main())
```

## Errors

All API errors derive from `MitraError` with `.status`, `.category`, `.code`, `.request_id` and
`.body`. Subclasses: `AuthError` (401), `PermissionDeniedError` (403: `scope`, `workspace_role`,
`source_access`), `CreditsError` (402: `not_ready`, `member_cap`), `BusyError` (409, a conflict with the current state),
`RateLimitError` (429, `.retry_after`), `SourceTestFailedError` (422 from `sources.create`, `.test_result`), plus `JobFailedError`, `JobTimeoutError`. 429 is retried
automatically (honouring `Retry-After`) up to `max_retries` (default 2), as are 5xx and network
errors on GETs and on calls with an idempotency key.

## Models

`mitra.models` holds pydantic models for the main shapes (`Answer`, `Job`, `Gem`, `Workspace`, ...).
They accept unknown fields, so new server fields never break old clients. See
[`scripts/README.md`](scripts/README.md) for generating models from the OpenAPI spec.

## Develop

```bash
pip install -e "sdks/python[dev]"
pytest && ruff check .
```

License: Apache-2.0.
