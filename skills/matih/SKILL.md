---
name: matih
description: Use for questions about the user's business data in Matih (Mitra), including ad-hoc data questions in plain English or any of 22 Indian languages, Gems (automatic insight cards), saved dashboards rendered as images, forecasts and what-if predictions, listing data sources and uploaded files, checking source readiness, switching between Matih workspaces, and (only when explicitly asked) managing members, invitations, sources and files. Works through the Matih MCP tools (list_workspaces, use_workspace, list_members, invite_member, list_sources, source_status, list_gems, get_gem, generate_gems, ask, list_dashboards, dashboard_image, predict, get_job, list_files) or the REST API at https://workspace.matih.ai/api/v1. Trigger on "ask Matih", "Matih gems", "show my dashboard as an image", "forecast", "switch workspace", "invite a teammate to Matih", "is my source ready", or any request to query a connected Matih data source.
---

# Matih

Matih answers questions over a workspace's connected data sources (databases, warehouses, uploaded CSV/Excel files). This skill tells you how to use it well from an agent, either through the hosted MCP server or plain REST.

Base URL: `https://workspace.matih.ai/api/v1`
MCP endpoint: `https://workspace.matih.ai/api/v1/mcp` (streamable HTTP)
OpenAPI 3.1 spec: `GET /openapi.json`, docs at `/docs`.

## Pick a path

- If Matih MCP tools are available in this session (names like `ask`, `list_sources`), use them. Images come back as MCP image content.
- Otherwise use REST with `curl` or any HTTP client. Auth is `Authorization: Bearer $MATIH_API_KEY`. See `references/auth.md`.
- Never invent endpoints or tool names. The tool list and endpoint list in this skill is complete.
- The MCP tools are: `list_workspaces`, `use_workspace`, `list_members`, `invite_member`, `list_sources`, `source_status`, `list_gems`, `get_gem`, `generate_gems`, `ask`, `list_dashboards`, `dashboard_image`, `predict`, `get_job`, `list_files`. Use an MCP connector key or an API key for MCP; a connector key is refused with 401 on any other path. Everything else (cancelling jobs, creating or deleting sources, uploading files, role changes, webhooks, voice questions) is REST only.

## The default flow

1. Workspace. Call `list_workspaces` (REST: `GET /workspaces`). The result has `current` and a list of `{id, name, role, kind}`. If the user named a different workspace, call `use_workspace` (REST: `PUT /me/workspace {"workspace_id": ...}`, or send `X-Matih-Workspace` per request). API keys are pinned to one workspace and cannot switch. See `references/workspaces.md`.
2. Source. Call `list_sources` (REST: `GET /sources`). Each source has `id`, `name`, `connector_type`, `state` and `is_active`. Pick the one whose `name` or `connector_type` matches the question. If unsure it is ready to query, call `source_status` (REST: `GET /sources/{id}`, whose `readiness.can_ask` says whether Ask can use it now). If you omit `source_id`, Matih uses the workspace's active source. If several fit and the user did not say, ask the user which one.
3. Ask. Call `ask` with the question (REST: `POST /ask`). Read `status` first, not `answer`. See `references/asking.md`.
4. Present. Give the user the `answer` text, then the key figures from `result.rows`. Mention the `sql` only if they ask how it was computed or you need to explain a discrepancy.
5. Follow up. Reuse `conversation_id` for any question that builds on the previous one. Offer one or two `follow_ups` if useful.

## Reading an answer

`status` is one of:

- `answered`: `answer` is the text, `result` holds the table (`columns`, `rows`, `row_count`, `truncated`). If `truncated` is true, say the table is partial and do not claim totals you cannot see.
- `clarification`: Matih needs more information. `clarification.question` and `clarification.options` are set. Ask the user, then send their choice as the next `ask` in the same `conversation_id`. Do not guess for them.
- `empty`: the query ran but returned no rows. Say so plainly. Suggest widening the date range or filters. Do not fabricate numbers.
- `error` and `cancelled`: the question could not be answered and nothing was charged. Show `answer` (it is human readable) and offer a rephrase. For HTTP-level errors see `references/errors.md`.

Data values, column names and figures are never translated, so quote them as returned.

## Language

Write questions in the user's language. 22 Indian languages are auto-detected, and answer text, headlines, explanations, follow-ups and clarification questions come back translated. Pass `language` (BCP-47, for example `hi-IN`, `ta-IN`, `en-IN`) or `Accept-Language` to force the response language; the body wins. The response field `language` says what was used. For voice notes use `POST /ask/audio` (REST only, 5 MB at most). See `references/asking.md`.

## Other capabilities

- Gems (automatic insight cards for a source): `list_gems`, `get_gem`, `generate_gems`. Generation is asynchronous and returns a job. See `references/gems.md`.
- Dashboards as images: `list_dashboards`, then `dashboard_image`. Asynchronous: a job unless it finishes in time (a recent drawing at the same width is reused). See `references/dashboards.md`.
- Predictions (forecasts, what-if, anomaly checks): `predict`. Takes minutes, so it returns a job. See `references/predictions.md`.
- Jobs: `get_job` (REST `GET /jobs/{id}`), cancel with `POST /jobs/{id}/cancel`.
- Sources and files: `list_sources`, `source_status`, `list_files` over MCP. Connecting, activating and deleting sources, and uploading files, are REST only. See `references/sources.md`.
- Members and invitations: `list_members`, `invite_member` over MCP; role changes, removals and revoking invitations are REST only. See `references/members.md`.
- Embeds (REST only): `POST /embeds` mints a short-lived token to show one dashboard (with row filters) or a Gems feed in the customer's own product, `GET /embeds` lists, `DELETE /embeds/{id}` revokes. Needs `embeds:create` (`embeds:read` to list). It is for developers building an integration, not for answering a user's data question: do not mint tokens unless asked, never print or log the `met_` token, and call it from a backend, not from a browser. See `references/embeds.md`.
- Webhooks (REST only): `GET/POST/DELETE /webhooks`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`. Needs `webhooks:manage` and an admin. Events: `gems.ready`, `prediction.completed`, `job.completed`, `dashboard_image.ready`.

## Rules for agents

- Be honest about uncertainty. Report `clarification`, `empty` and `error` states as such.
- Send an `Idempotency-Key` header on `POST /ask` and `POST /predictions` (the two calls that honour it) so a retry answers once and is charged once. Generate one UUID per logical request and reuse it on retry. Other POSTs ignore the header: do not blindly retry `/gems/generate`.
- On `429` honour `Retry-After`. Do not loop faster than that.
- `image_url` values are public, unguessable URLs that expire after 15 minutes and need no auth. Fetch or display them promptly. If expired, re-request.
- Do not poll jobs tighter than the cadence in `references/predictions.md`.
- Never print the API key, signing secrets or OAuth tokens back to the user or into logs.
- Do not take costly actions (generating gems, predictions) unless the user asked or clearly implied it.
- Admin actions (inviting people, changing roles, removing members, revoking invitations, connecting or deleting sources, deleting files) only when the user explicitly asks for that exact action. Never infer one from a vague request.
- Confirm before anything destructive or hard to undo: state what will be removed (member, source, file, invitation, webhook) and by whom it was requested, and wait for a yes. Deleting a source or removing a member is not undone by re-adding it.
- Never put database passwords or connector secrets in chat output or logs; ask the user to supply them and do not echo them back.

## Waiting or not

Gems, predictions and dashboard images are **Jobs**: they answer `202` and a Job, or `200` and the
finished Job when you send `Prefer: wait=N` (or `?wait=N`; N is 0 to 60). If the wait runs out you
get `202` and the Job as it stands, to poll at `GET /jobs/{id}`. `POST /ask` is the other way round:
it answers `200` and the Answer, and `Prefer: respond-async` (or `?async=true`) gives a Job of kind
`ask` whose `result` is the Answer. `Preference-Applied` says what the server did.

Connecting a source (`POST /sources`) and uploading a file (`POST /files`) are **not** Jobs. They
return the source or the file at once; `Prefer: wait=N` (N up to 120) holds the request until the
catalog or the file is ready. If it is not, poll `GET /sources/{id}` for `readiness.can_ask` or
`GET /files/{id}` for `ready`.

In the SDKs: `wait=` (seconds) or `background=True` (TypeScript `{ wait }`, `{ background: true }`),
and `jobs.wait(job, timeout)` to wait on a Job you already hold.

## Quick REST reference

```bash
BASE=https://workspace.matih.ai/api/v1
H="Authorization: Bearer $MATIH_API_KEY"

curl -s -H "$H" $BASE/workspaces
curl -s -H "$H" $BASE/sources
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"question":"Top 5 products by revenue last month"}' $BASE/ask
```

More recipes: `examples/curl/README.md` in this repository.

## References

- `references/auth.md`: API keys, MCP connector keys (created under `Settings › API & MCP`), OAuth, the 15 scopes, headers.
- `references/workspaces.md`: listing and switching workspaces.
- `references/asking.md`: clarification, empty and error handling, follow-ups, language and audio, streaming.
- `references/gems.md`: Gems listing, generation, images.
- `references/embeds.md`: minting embed tokens for dashboards and Gems.
- `references/dashboards.md`: dashboards and image rendering.
- `references/predictions.md`: jobs, polling, cancel, result shapes.
- `references/members.md`: members, roles, invitations.
- `references/sources.md`: connectors, sources, readiness, file uploads and duplicates.
- `references/errors.md`: every error category and the right response.
