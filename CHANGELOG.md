# Changelog

All notable changes are listed here. Python and TypeScript SDKs are versioned independently
(tags `py-v*` and `ts-v*`).

## Unreleased

- Python SDK `mitra-sdk` (sync and async clients, pydantic models, SSE streaming, job polling,
  webhook signature verification).
- TypeScript SDK `@matihlabs/mitra` (typed client, SSE async iterator, job polling, webhook
  signature verification).
- Admin surface in both SDKs: members, invitations, sources (get, activate, delete), files
  (list, duplicate decision, delete), webhook test and deliveries, voice `heard`.
- Agent skill `skills/matih`, MCP connection guide, curl recipes, Slack bot example.
- OpenAPI sync workflow and CI.
- Scopes: 13 in total. Files now use `files:read` (`GET /files`, `GET /files/{id}`) and
  `files:write` (`POST /files`, `POST /files/{id}/duplicate`, `DELETE /files/{id}`) instead of
  `sources:read` and `sources:write`.
- Docs: admins create keys under `Settings › API & MCP`, choose the products a key may use (all on
  by default) and revoke keys there. Keys never expire by default. Two kinds: an API key (all of
  `/api/v1`) and an MCP connector key (only `/api/v1/mcp`, 403 elsewhere).
- Sync and async everywhere: `Prefer: wait=N` and `Prefer: respond-async` supported by the API.
  Both SDKs: every long call (`gems.generate`, `predictions.create`, `dashboards.image`,
  `sources.create`, `files.upload`) takes `wait` (seconds) or `background`; `ask` takes
  `background`; `jobs.wait(job, timeout)` polls; `Job.as_answer()` in Python. Python keeps `Mitra`
  and `AsyncMitra` at full parity.
