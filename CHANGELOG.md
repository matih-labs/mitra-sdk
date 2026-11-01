# Changelog

All notable changes are listed here. The Python and TypeScript SDKs share one version and are
released together: one tag `vX.Y.Z` publishes `mitra-sdk` to PyPI and `@matihlabs/mitra` and
`@matihlabs/embed` to npm.

## Unreleased

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

## 0.1.0 - 2026-10-31

First release. The Matih public API (`/api/v1`) is rolling out to `workspace.matih.ai` now; these
SDKs target it, and a call against a workspace it has not reached yet fails.

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
