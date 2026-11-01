# Changelog

All notable changes are listed here. The Python and TypeScript SDKs share one version and are
released together: one tag `vX.Y.Z` publishes `mitra-sdk` to PyPI and `@matihlabs/mitra` and
`@matihlabs/embed` to npm.

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
