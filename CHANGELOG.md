# Changelog

All notable changes are listed here. The Python and TypeScript SDKs share one version and are
released together: one tag `vX.Y.Z` publishes `mitra-sdk` to PyPI and `@matihlabs/mitra` and
`@matihlabs/embed` to npm.

## Unreleased

Changing data from a sentence, and continuing a conversation. Contract: `docs/public-api/endpoints.md` ("Changes")
in matih-labs/mitra.

- New `changes` resource on both clients (scope `data:write`): `update`, `batch`, `batch_from_file`, `confirm`, `choose`,
  `cancel`, `undo`, `undo_batch`, `get`, `get_batch` (TypeScript `batchFromFile`, `undoBatch`, `getBatch`). Python
  `ChangeReply`; TypeScript `ChangeReply`, `UpdateParams`, `BatchParams`, `BatchFileParams`, `ChainParams`.
  `batch_from_file` uploads a CSV or `.xlsx` (2 MB at most) as multipart; the server takes no Idempotency-Key on that
  route, so none is sent and it is not retried after a 5xx or a timeout. `undo_batch` reverses a batch by `batch_id`.
- `update`, `batch`, `confirm`, `choose` and `cancel` take `previous_conversation_id` (TypeScript `previousConversationId`):
  the `conversation_id` of the earlier reply to continue from. If you need older context, pass the previous id; a previous
  id can itself have its own previous id, and the chain is followed as far back as it goes (the 10 minute hold and undo windows
  limit it). Every reply carries its own `conversation_id`. The SDK does not remember the last id for you.
- `confirm(choice)` is the 1-based number of a listed choice; `choose(index)` is the 0-based `index` of a choice from
  `reply.choices`.
- Every write call sends an `Idempotency-Key` (yours, or one per call); the server dedupes `update`, `batch`, `confirm`,
  `choose`, `cancel`, `undo` and `undo_batch` on it, so a retry returns the original reply. The client's own retries (429,
  5xx, a dropped connection, a timeout) keep the key. Only a reply the server kept is replayed: after a 5xx, `IN_PROGRESS`,
  `NO_CREDITS` or `MEMBER_CAP` the same key runs again. One `Idempotency-Key` is one request, on every change
  call (`update`, `batch`, `confirm`, `choose`, `cancel`, `undo`, `undo_batch`): the same key on another operation or with
  another request is refused with 422 `idempotency_key_reused`, never run. A retry of the same request with the same key
  gets the first reply. The key is per credential. The SDK sends a new key per call; give your own only to retry that one
  call. Needs the server release that ships with PR #384; an older server did not refuse a key shared between
  `update`/`batch` and the answer calls.
- A key whose first request is still running is held by the server for up to 60 s, then answered 409
  `idempotency_key_in_progress` (`BusyError`): send the same call with the same key again. Change calls now allow a read
  of at least 75 s (`request_timeout` / `timeoutMs` you pass is kept as given), so the 409 is seen rather than a timeout.
- A change the server did not make (409 `HEAVY_CONFIRM`, 410 `ALREADY_UNDONE`, 404 `NO_MATCH`, ...) answers with a top-level
  `{code, message, ...}` body. Errors now read it as well as the `{detail: {...}}` envelope (one mapper, both SDKs):
  `MitraError` has the reply's `code` and `message`, plus `extra` (every other field), `pending_id` / `pendingId` and
  `choices`. `ChangeReply` types every field of the reply (including `open_question` and `source`). 402 raises
  `CreditsError` (`NO_CREDITS`, `MEMBER_CAP`), 403 `PermissionDeniedError` / `PermissionError` (`NOT_ALLOWED`, `WRITES_OFF`,
  `READ_ONLY_SOURCE`, `KEY_SOURCE_NOT_ALLOWED`), 502 `MitraError` (`SOURCE_ERROR`, `SOURCE_UNREACHABLE`); a code the SDK
  does not know is raised as it came.
- A change reply has no `category`: `err.category` is `None` in Python and `undefined` in TypeScript, so branch on
  `code`.
- A refused conversation id raises `MitraError` with `code` `conversation_not_found`, `conversation_expired`,
  `conversation_other_source` or `conversation_too_long`; a reused idempotency key is a 422 with `code` and `category`
  both `idempotency_key_reused`; a request with neither `text` nor `item` is a 422 `invalid_request` (no `code`).
- A batch over 25 rows is held with 409 `HEAVY_CONFIRM`; repeat it with `confirm=True` and a new key (the SDK's default).
- npm publishing of `@matihlabs/mitra` and `@matihlabs/embed` is stage-only: each release needs the maintainer's 2FA approval.

### Changed

- TypeScript, behaviour and type: `err.category` is now only the `category` string the server sent, else `undefined`.
  Before, it fell back to a word taken from the status (`auth`, `permission`, `validation`, `not_found`, `conflict`,
  `rate_limited`, `not_ready`, `server`, `unknown`) when the body had none (proxy HTML, a string `detail`, a validation
  list, an empty body), and those words were not the server's. The server's envelope always carries a category, so a normal
  API refusal reads the same; branch on `status` or `code` for the rest. The type is `string | undefined` on
  `MitraError.category` and `MitraErrorInit.category`. Release this as 0.3.0, not a patch.
- Python, the same rule: `err.category` is the server's string or `None`. The `validation` it filled in for a 422 from
  `embeds.create` that had none is gone (the server sends one).
- Python: a request that got no response raises `MitraError` with `category` `network` or `timeout` (as TypeScript's
  `ConnectionError` already did), and so does a call that outlasts its `deadline` (`timeout`).

## 0.2.0 - 2026-11-02

Viewer identity for embeds. Contract: `docs/EMBEDS.md` section 3.1b in matih-labs/mitra.

- `embeds.create` takes `viewer` (`{external_id, name?, email?, phone?, locale?, attributes?}`;
  Python `viewer=`, TypeScript `viewer`) and the response carries `viewer.id`. `resource.type` also
  allows `"ask"`. A viewer is told apart by `external_id` alone, never by email or phone.
- `embeds.keys.add`, `.list` and `.revoke` register the public keys you sign viewer JWTs with
  (Python `EmbedSigningKey`, `EmbedSigningKeyList`; TypeScript `EmbedSigningKey`,
  `EmbedSigningKeyList`, `AddEmbedSigningKeyParams`). A private key is refused and never stored.
  Both READMEs show how to sign a token with PyJWT and with `jose`; no signing dependency is added.
- `embeds.origins.get()` and `.set(origins)` (`GET` and `PUT /embeds/origins`; Python `EmbedOrigins`,
  TypeScript `EmbedOrigins`) register the 1 to 10 origins a token you sign yourself may be framed by.
  The page URL of such a token is `...?e=<integration id>`: the JWT is never in a URL query (it carries
  the viewer's email, phone and attributes), only in `<matih-embed>`'s `token` attribute, `getToken`
  or a `matih:token` message. `<matih-embed>` refuses a `src` that has a JWT in its query
  (`invalid_src`) and takes a JWT as the token like a `met_` secret. A token whose origins are not
  among the registered ones is refused (`origins_not_registered`).
- `EmbedRefusedError.code` can now also be a viewer or key code (`external_id_missing`, `key_private`,
  ...). `EMBED_REFUSAL_CODES` is unchanged: it lists the six codes of `embeds.create` filters and origins.

The Ask embed: a question box and its answers inside your own product. Contract: `docs/EMBEDS.md` section 14 in
matih-labs/mitra.

- `<matih-embed kind="ask">` shows the Ask box. Its `theme` (`light`, `dark` or `auto`), `accent` (a hex colour:
  the send button, the focus ring and the chart's lead colour), `font`, `heading`, `placeholder` and `suggestions`
  (up to three questions, separated by `|`) go in the page's query; the token stays in the fragment. An option that does
  not fit what the page accepts is left out. An Ask frame starts at `280px` and follows its own `matih:resize`.
- `mountAsk(container, {getToken, src?, theme?, accent?, font?, heading?, placeholder?, suggestions?, height?, title?})`
  puts the element in a container and returns it; `askParams(options)` is the options as query parameters.
- Mint with `resource: {type: "ask", id: <source id>}` (already allowed). A viewer's questions are kept apart per
  viewer, and are limited to 20 an hour per viewer and 300 an hour per integration.

## 0.1.1 - 2026-11-01

Performance and timeouts, from a review of connection reuse, timeouts, retries and package size.

- Python: a connection pool you can size (`max_connections`, `max_keepalive_connections`,
  `keepalive_expiry`, default 30 s), separate `connect_timeout`, optional `http2` extra, per-call
  `request_timeout`, `max_retries` and `deadline`. Uploads stream from disk.
- Both: retries use jittered exponential backoff (capped at 8 s) and stop after 60 s of sleeping;
  408 is retried and 500, 502, 503, 504 retried on safe calls only; a `Retry-After` over 60 s is
  raised on any status, not slept on. TypeScript gains `deadlineMs`.
- Both: a call that sends `Prefer: wait=N` gets a read timeout of N plus 15 s; Python no longer
  issues a second GET after a 202 that already carried the job. Event streams end with an error when
  the server goes silent, instead of hanging.
- Package size: source maps are no longer published (TypeScript and embed); the Python sdist holds
  only the source, tests and metadata. Size budgets run in CI.

## 0.1.0 - 2026-11-01

First release. These SDKs target the Matih public API (`/api/v1`), live on `workspace.matih.ai`.

- Python SDK `mitra-sdk` (`Mitra` and `AsyncMitra`, pydantic models, SSE streaming, job polling,
  webhook signature verification) and TypeScript SDK `@matihlabs/mitra` (typed client, SSE async
  iterator, job polling, webhook signature verification).
- Covers ask (text, voice, streaming), conversations, Gems, dashboards, predictions, jobs,
  workspaces (`PUT /me/workspace`), members, invitations, connectors, sources, files and webhooks.
- Configuration is the same everywhere: `MATIH_API_KEY` (or `MATIH_ACCESS_TOKEN` for an OAuth
  token) and `MATIH_BASE_URL`, which is the host only (default `https://workspace.matih.ai`). The
  SDKs append `/api/v1`.
- Sync and async: `Prefer: wait=N` and `Prefer: respond-async`, answered with `Preference-Applied`.
  - Job calls (`gems.generate`, `dashboards.image`, `predictions.create`, `ask` with
    `background`) send `Prefer: wait=N` (N at most 60) and poll the job; `background` returns the
    queued job.
  - Resource calls (`sources.create`, `files.upload`) are not jobs: `Prefer: wait=N` (N at most
    120), then the SDK polls `GET /sources/{id}` or `GET /files/{id}`. If `wait` runs out the
    resource comes back as it stands.
- Errors use the server's envelope `{"detail": {"category", "message", "code"?}}`. A failed
  connection test on `sources.create` raises `SourceTestFailedError` with `detail.test`.
- Scopes: 13 in total. Files use `files:read` and `files:write`.
- Idempotency-Key is sent on `ask` and `predictions.create` only; the other routes take none.
- Webhooks: `Matih-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `<t>.<raw body>` keyed with the
  whole `whsec_...` secret, 300 second tolerance. `verify_webhook` / `verifyWebhook` check it.
- Admins create keys under `Settings › API & MCP`, choose the products a key may use and revoke
  keys there. Two kinds: an API key (all of `/api/v1`) and an MCP connector key (only
  `/api/v1/mcp`).
- Agent skill `skills/matih`, MCP connection guide, curl and plain-HTTP examples in six languages,
  Slack bot example, OpenAPI sync workflow and CI.

### Embeds

Embeds: show a dashboard or a Gems feed inside your own product. Contract: `docs/EMBEDS.md` in
matih-labs/mitra.

- Python `client.embeds.create(resource=, filters=, origins=, ttl_seconds=)`, `.list()` and
  `.revoke(id)` on `Mitra` and `AsyncMitra` (`list` returns `{embeds: [...]}` with `kind`, `resource`,
  `title`, `origins`, `created_at`, `expires_at`, `revoked_at`, `key` and `member`), and TypeScript `mitra.embeds.create/list/revoke`.
  Typed `Embed` (the `met_` token is kept out of `repr`), `embed_src` / `embedSrc` (the iframe URL
  without its `#token=` fragment). Minting is not idempotent: no `Idempotency-Key`, and never
  retried after a 5xx.
- A 422 on the embeds routes raises `EmbedRefusedError` with `code` one of `missing_parameter`,
  `unknown_parameter`, `invalid_value`, `invalid_origin`, `filters_not_supported`,
  `no_embed_parameters`; a 404 raises `EmbedNotFoundError`.
- New scopes `embeds:create` (mint, revoke) and `embeds:read` (list), and an Embeds product.
- New npm package `@matihlabs/embed`: the `<matih-embed>` web component. Token only in the URL
  fragment, `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"`, answers
  `matih:token-expiring` only from the iframe's own window and origin and replies to that exact
  origin, never `"*"`. Follows the embed page's `matih:resize` height (taken only from its own
  frame and origin, capped), with `height` as the initial value. Emits `matih:ready` and
  `matih:error`. It joins the release workflow.
- `examples/embed/`: a Node (`node:http`) and a Python example that mint and show an embed.
