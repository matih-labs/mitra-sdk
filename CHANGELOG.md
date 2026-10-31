# Changelog

All notable changes are listed here. The Python and TypeScript SDKs share one version and are
released together: one tag `vX.Y.Z` publishes `mitra-sdk` to PyPI and `@matihlabs/mitra` to npm.

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
