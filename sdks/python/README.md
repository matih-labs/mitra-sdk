<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# mitra-sdk (Python)

Python client for the Matih public API. Sync (`Mitra`) and async (`AsyncMitra`) clients on
[httpx](https://www.python-httpx.org/), pydantic v2 models for the main response shapes, SSE
streaming, background-job polling and webhook signature verification.

```bash
pip install mitra-sdk
```

Python 3.10+. The package imports as `mitra`.

Full documentation: [matih.ai/docs/api](https://matih.ai/docs/api/overview), with the [SDK reference](https://matih.ai/docs/api/sdk/python).

## Authenticate

```python
from mitra import Mitra

client = Mitra(api_key="mtk_...")            # or set MATIH_API_KEY
client = Mitra(access_token="mto_...", workspace_id="ws_123")  # OAuth token
```

API keys are pinned to one workspace. OAuth tokens pick a workspace per client with
`workspace_id=` (sent as `X-Matih-Workspace`) or per call, or set a default with
`client.workspaces.use(workspace_id)`. Keep keys in environment variables, never in source.

Admins create keys under `Settings › API & MCP`, choose the products the key may use (all on by default) and revoke keys in the same screen. Keys never expire by default. Use an API key here; an MCP connector key works only on `/api/v1/mcp`. Scopes: `workspaces:read`, `members:read`, `members:manage`, `sources:read`, `sources:write`, `files:read`, `files:write`, `gems:read`, `gems:generate`, `ask`, `dashboards:read`, `predict`, `embeds:create`, `embeds:read`, `webhooks:manage`.

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

## Change data

Needs `data:write` and the Write permission on the source. Every call is its own request and its reply carries
its own `conversation_id`. To continue from an earlier reply (a yes to the change it is holding, a
cancel, a pick from its list), pass that reply's `conversation_id` as `previous_conversation_id`.
If you need older context, pass the previous id: it can itself have its own previous id, and the
chain is followed as far back as it goes (only the 10 minute hold and undo windows limit it). Leave it
out and the call starts fresh (a "yes" sent as `text` with no id starts a new request; it is not matched to a change
waiting in an earlier one).

```python
asked = client.changes.update("set Pen to 5", source_id="s1")       # asks first: asked.pending_id, asked.message
done = client.changes.confirm(asked.pending_id, previous_conversation_id=asked.conversation_id)
client.changes.undo(done.change_id)                                  # within 10 minutes
```

`confirm(pending_id, choice=n)` answers a numbered list with the 1-based number as listed; `choose(pending_id, index)` takes
the 0-based `index` of a choice from `reply.choices`.

Every write call sends its own `Idempotency-Key` (pass `idempotency_key=` to use yours). The server dedupes `update`,
`batch`, `confirm`, `choose`, `cancel`, `undo` and `undo_batch` on that key, so a retry with the same key returns the
original reply instead of acting twice, and the client's own retries (a 429, a 5xx, a dropped connection, a timeout) keep
the key. Only a reply the server kept is replayed: after a 5xx (`SOURCE_ERROR`, `SOURCE_UNREACHABLE`), `NO_CREDITS` or
`MEMBER_CAP` the same key runs again and may answer differently. Use one key for one request, and never share a key
between `update`/`batch` and the answer calls. `batch_from_file` takes no key (the server has none on that route), so it
is not retried after a 5xx or a timeout.

If the first request with a key is still running, the server waits up to 60 s and then answers 409
`idempotency_key_in_progress` (`BusyError`): wait, then send the same call with the same `idempotency_key` again. Change
calls allow a read of at least 75 s, so you see that 409 and not a timeout.

A batch takes a list of sentences or items, and its reply has one entry per item in `items` and a `batch_id`:

```python
done = client.changes.batch(["set Pen to 5", "set Orbit Lamp to 120"], source_id="s1")
client.changes.get_batch(done.batch_id)        # what happened to each item
client.changes.undo_batch(done.batch_id)       # reverse the whole batch, within 10 minutes
client.changes.batch_from_file("rows.csv", source_id="s1")   # a CSV or .xlsx, 2 MB at most: a header row, one change per row
```

A change the server did not make is not a `ChangeReply`: it answers with a non-2xx status and raises `MitraError`
(`BusyError` for 409) with the reply's `code` and `message` (`HEAVY_CONFIRM`, `ALREADY_UNDONE`, `UNDO_EXPIRED`,
`CONFIRM_EXPIRED`, `NO_MATCH`, `NOTHING_TO_UNDO`, ...); a 402 raises `CreditsError` (`NO_CREDITS`, `MEMBER_CAP`), a 403
`PermissionDeniedError` (`NOT_ALLOWED`, `WRITES_OFF`, `READ_ONLY_SOURCE`, `KEY_SOURCE_NOT_ALLOWED`) and a 502 `MitraError`
(`SOURCE_ERROR`, `SOURCE_UNREACHABLE`). Its other fields are on the error: `err.pending_id`, `err.choices`
and the rest in `err.extra` (`rows`, `credits`, `conversation_id`, ...). That body has no `category`, so `err.category`
is `None` for a change reply: branch on `err.code`. A code this SDK has never heard of is raised as it came.

A batch over 25 rows, and a single `update` that touches many, is held for a yes with 409 `HEAVY_CONFIRM`. Repeat the batch
with `confirm=True` (the documented path); a held `update` is answered with `confirm(err.pending_id, ...)`:

```python
try:
    client.changes.batch(rows)                                       # over 25 rows: 409 HEAVY_CONFIRM
except BusyError as err:
    if err.code == "HEAVY_CONFIRM":
        client.changes.batch(rows, confirm=True, previous_conversation_id=err.extra["conversation_id"])
```

A refused conversation id raises `MitraError` with `code` `conversation_not_found` (404), `conversation_expired` (410),
`conversation_other_source` (409) or `conversation_too_long` (422, over 1000 requests in one chain). The same
`idempotency_key` with another `previous_conversation_id` or request is a 422 whose `code` and `category` are both
`idempotency_key_reused`. A request with neither `text` nor `item` is a 422 `invalid_request` (a `category`, no `code`).

## Members and invitations

Needs `members:read` / `members:manage`; only do these when a person asked for them.

```python
client.members.list()
client.invitations.create("user", email="new@example.com")   # or phone="+91..."
client.invitations.list(); client.invitations.revoke("inv_1")
client.members.update("mem_1", "admin"); client.members.remove("mem_1")
```

## Embeds

Show a dashboard (with per-viewer row filters), a Gems feed or Ask inside your own product. Needs
`embeds:create` (mint, revoke, keys) or `embeds:read` (list). Call it from your backend: the API key
never goes to the browser. The browser gets only the short-lived token, through the
`<matih-embed>` element (`@matihlabs/embed`, see `sdks/embed/`).

```python
embed = client.embeds.create(
    resource={"type": "dashboard", "id": "d_123"},   # or {"type": "gems" | "ask", "id": "<source id>"}
    filters={"customer_id": "C123"},                  # exactly the dashboard's embed parameters; none for Gems
    origins=["https://app.customer.com"],             # 1 to 10 exact origins that may frame the page
    ttl_seconds=300,                                  # 60 to 900, default 300; never renewed, mint again
    viewer={"external_id": "cust-42", "name": "Asha Rao", "attributes": {"plan": "pro"}},  # optional: your end user
)
embed.src     # the iframe URL without the token (keeps ?e=emt_...)
embed.token   # met_..., a secret; left out of repr
embed.id      # emt_..., not secret: pass it to revoke
embed.viewer  # EmbedViewerRef(id="vwr_..."), when you passed a viewer

client.embeds.list()            # tokens minted by this key (never the secret or filter values)
client.embeds.revoke(embed.id)  # 204, idempotent, returns None
```

Minting is not idempotent (every call mints) and is never retried after a 5xx. A refusal raises
`EmbedRefusedError` (422) with `.code` one of `missing_parameter`, `unknown_parameter`,
`invalid_value`, `invalid_origin`, `filters_not_supported` (Gems cannot be filtered),
`no_embed_parameters`; an unknown or unreadable dashboard or source raises `EmbedNotFoundError`
(404); a role that no longer allows it is a `PermissionDeniedError` (403). `AsyncMitra` is the
same with `await`.

### Viewers and tokens you sign yourself

A `viewer` is your end user. Only `external_id` (your own id, at most 128 characters) is required,
and it alone tells viewers apart: Matih never matches a viewer by email or phone, so two people
sharing an email are two viewers. `name`, `email`, `phone` (E.164), `locale` (`en-IN`) and
`attributes` (strings, numbers, or lists of those) are what the workspace's row policies and
Matih's own screens can use. A bad viewer is an `EmbedRefusedError` whose `.code` names the claim
(`external_id_missing`, `email_invalid`, `attribute_value_invalid`, ...), never the value.

To skip a call per page, sign the token yourself. Register the public half of a key once, then
your backend signs short-lived JWTs (RS256, ES256 or EdDSA; HS256 is refused):

```python
# Once. Only the PUBLIC key: a private key is refused (`key_private`) and never stored.
key = client.embeds.keys.add(public_key=public_pem, kid="k1")   # key.id is esk_...
client.embeds.keys.list()            # live and revoked keys
client.embeds.keys.revoke(key.id)    # 204; tokens it signed stop at their next request
# Where your pages may be framed (1 to 10 exact origins; replaces the list). The page URL names only your
# integration, never the token, so the frame check uses these; a token's own origins must be among them.
client.embeds.origins.set(["https://app.customer.com"])   # EmbedOrigins(origins=[...])
client.embeds.origins.get()                                # origins == [] until set

# Per page, on your backend (here with PyJWT and `cryptography`; any JWT library works).
import time, uuid
import jwt

now = int(time.time())
token = jwt.encode(
    {
        "iss": integration_id,                  # your integration's id
        "aud": "matih",
        "sub": "cust-42",                       # the viewer's external_id
        "jti": str(uuid.uuid4()),               # required, never reused
        "iat": now,
        "exp": now + 300,                       # at most 900 s after iat
        "matih": {
            "resource": {"type": "dashboard", "id": "d_123"},
            "origins": ["https://app.customer.com"],
            "filters": {"customer_id": "C123"},
            "viewer": {"name": "Asha Rao", "attributes": {"plan": "pro"}},  # no external_id: `sub` is it
        },
    },
    private_pem,
    algorithm="ES256",
    headers={"kid": "k1"},                      # kid is required
)
# Give the page {"token": token, "src": f"https://workspace.matih.ai/embed/dashboards/d_123?e={integration_id}"}.
```

The JWT never goes in a URL query: it carries the viewer's email, phone and attributes, and a query
string reaches access logs, `Referer` headers and browser history. `src` names only your
integration (`?e=<integration id>`, not secret and not personal) and the JWT travels in
`<matih-embed>`'s `token` attribute or `getToken`, which put it in the URL fragment and a message,
never a query. `src` with a JWT in its query is refused, by `<matih-embed>` and by Matih's frame
check. Register your origins with `embeds.origins.set` first: a token whose `origins` are not among
them is refused (`origins_not_registered`), and one shown on a site that is not among them is a 403
`origin_not_allowed`. A refused JWT is a 401 whose `code` is `jwt_alg`, `jwt_kid_missing`,
`jwt_unknown_key`, `jwt_key_revoked`, `jwt_signature`, `jwt_expired`, `jwt_claims` or `jwt_replay`,
or the finer code of the claim that failed (`invalid_origin`, `origins_not_registered`, `invalid_resource`, a viewer code).
Key errors from `embeds.keys` are `EmbedRefusedError` with `.code` one of `key_private`,
`key_invalid`, `alg_unsupported`, `alg_mismatch`, `key_too_weak`, `kid_missing`, `kid_invalid`; a
reused `kid` or a sixth live key is a `BusyError` (409).

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

## Performance and timeouts

**Make one client and reuse it.** `Mitra` and `AsyncMitra` keep a connection pool, so the TCP and TLS
handshake is paid once, not on every call. Measured against `workspace.matih.ai` from a laptop
(unauthenticated `GET`, 40 calls each): about 216 ms median with a reused connection and about 739 ms
with a new connection per call; the same probe to a nearby control host went from 17 ms to 85 ms.
Use `with Mitra() as client:` or call `client.close()` when you are done. A client is safe to share
between threads, and an `AsyncMitra` between tasks (not between event loops).

```python
client = Mitra(
    timeout=60,                    # read, write and pool wait, per attempt (seconds)
    connect_timeout=10,            # opening the connection, per attempt
    max_retries=2,
    max_connections=100,           # in flight at once; more callers wait for a free connection
    max_keepalive_connections=20,  # idle connections kept warm
    keepalive_expiry=30,           # close an idle connection after this long (the server drops them at about 70 s)
    http2=False,                   # pip install "mitra-sdk[http2]", then True: one connection, many calls at once
)
```

- **Timeouts are per attempt and per phase** (connect, read, write, pool), not one number for everything.
  A call that asks the server to wait (`wait=N` sends `Prefer: wait=N`) gets a read timeout of that wait
  plus 15 s, so a long poll is not cut off by the default. Streams use a finite read timeout too: an
  event stream that stops sending (the server sends a heartbeat every 10 s) ends with a `MitraError`.
- **Per call**, any method takes `request_timeout=` (seconds or an `httpx.Timeout`), `max_retries=` and
  `deadline=`: a limit in seconds on the whole call, every attempt and every pause between them. The
  deadline also shortens each attempt, so `deadline=5` never runs for longer than 5 s.
- **Change calls** (`changes.update`, `batch`, `confirm`, `choose`, `cancel`, `undo`, `undo_batch`) read for at least 75 s
  whatever the client timeout is, because the server holds a call whose key is still running for up to 60 s before it
  answers 409 `idempotency_key_in_progress`. A `request_timeout=` you pass is kept as given. A change call that does time
  out is retried with the same key.
- **Retries** apply to 429 on every call, and to 408, 500, 502, 503, 504 and network failures only on
  calls that are safe to repeat (`GET`, `PUT`, `DELETE`, or a call with an idempotency key). Other 4xx are
  never retried. Waits grow as 0.5 s, 1 s, 2 s ... capped at 8 s, each randomised to 50 to 100 percent so
  clients that failed together do not return together. A `Retry-After` is honoured; if it is longer than
  60 s the error is raised instead of slept on. All the sleeping of one call together is capped at 60 s.
- **Uploads** stream a file from disk when you pass a path; they are not read into memory.
- **Nothing is cached.** The API sends no `ETag` or `Cache-Control`, so there is nothing safe to reuse;
  every call asks the server. Responses are gzip-compressed on the wire.
- `pip install mitra-sdk` pulls only `httpx` and `pydantic`; the wheel is about 32 KB.

## Errors

All API errors derive from `MitraError` with `.status`, `.category`, `.code`, `.request_id` and
`.body`. `.category` is `None` when the body has none (a change reply from `changes.*`, which is told by its `.code`; the
TypeScript SDK gives `undefined`). Subclasses: `AuthError` (401), `PermissionDeniedError` (403: `scope`, `workspace_role`,
`source_access`), `CreditsError` (402: `not_ready`, `member_cap`), `BusyError` (409, a conflict with the current state),
`RateLimitError` (429, `.retry_after`), `EmbedRefusedError` (422 from `embeds.create`, read `.code`), `EmbedNotFoundError` (404 from `embeds.create` and `embeds.revoke`), `SourceTestFailedError` (422 from `sources.create`, `.test_result`), plus `JobFailedError`, `JobTimeoutError`. 429 is retried
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
