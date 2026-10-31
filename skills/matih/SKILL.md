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
- The MCP tools are: `list_workspaces`, `use_workspace`, `list_members`, `invite_member`, `list_sources`, `source_status`, `list_gems`, `get_gem`, `generate_gems`, `ask`, `list_dashboards`, `dashboard_image`, `predict`, `get_job`, `list_files`. Use an MCP connector key or an API key for MCP; a connector key returns 403 on any other path. Everything else (cancelling jobs, creating or deleting sources, uploading files, role changes, webhooks) is REST only.

## The default flow

1. Workspace. Call `list_workspaces` (REST: `GET /workspaces`). The result has `current` and a list of `{id, name, role, kind}`. If the user named a different workspace, call `use_workspace` (REST: `PUT /me/workspace {"workspace_id": ...}`, or send `X-Matih-Workspace` per request). API keys are pinned to one workspace and cannot switch. See `references/workspaces.md`.
2. Source. Call `list_sources` (REST: `GET /sources`). Pick the source whose `name` or `type` matches the question and whose `status` is healthy. If unsure it is ready to query, call `source_status` (REST: `GET /sources/{id}`, includes readiness). If exactly one source is active you can omit `source_id`. If several fit and the user did not say, ask the user which one.
3. Ask. Call `ask` with the question (REST: `POST /ask`). Read `status` first, not `answer`. See `references/asking.md`.
4. Present. Give the user the `answer` text, then the key figures from `result.rows`. Mention the `sql` only if they ask how it was computed or you need to explain a discrepancy.
5. Follow up. Reuse `conversation_id` for any question that builds on the previous one. Offer one or two `follow_ups` if useful.

## Reading an answer

`status` is one of:

- `answered`: `answer` is the text, `result` holds the table (`columns`, `rows`, `row_count`, `truncated`). If `truncated` is true, say the table is partial and do not claim totals you cannot see.
- `clarification`: Matih needs more information. `clarification.question` and `clarification.options` are set. Ask the user, then send their choice as the next `ask` in the same `conversation_id`. Do not guess for them.
- `empty`: the query ran but returned no rows. Say so plainly. Suggest widening the date range or filters. Do not fabricate numbers.
- `error`: the question could not be answered. Show `answer` (it is human readable) and offer a rephrase. For HTTP-level errors see `references/errors.md`.

Data values, column names and figures are never translated, so quote them as returned.

## Language

Write questions in the user's language. 22 Indian languages are auto-detected, and answer text, headlines, explanations, follow-ups and clarification questions come back translated. Pass `language` (BCP-47, for example `hi-IN`, `ta-IN`, `en-IN`) or `Accept-Language` to force the response language. The response field `language` says what was used. For voice notes use `POST /ask/audio`. See `references/asking.md`.

## Other capabilities

- Gems (automatic insight cards for a source): `list_gems`, `get_gem`, `generate_gems`. Generation is asynchronous and returns a job. See `references/gems.md`.
- Dashboards as images: `list_dashboards`, then `dashboard_image`. Asynchronous when not cached. See `references/dashboards.md`.
- Predictions (forecasts, what-if, models): `predict`. Always asynchronous, up to 30 minutes. See `references/predictions.md`.
- Jobs: `get_job` (REST `GET /jobs/{id}`), cancel with `POST /jobs/{id}/cancel`.
- Sources and files: `list_sources`, `source_status`, `list_files` over MCP. Connecting, activating and deleting sources, and uploading files, are REST only. See `references/sources.md`.
- Members and invitations: `list_members`, `invite_member` over MCP; role changes, removals and revoking invitations are REST only. See `references/members.md`.
- Webhooks (REST only): `GET/POST/DELETE /webhooks`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`. Needs `webhooks:manage`. Events: `gems.ready`, `prediction.completed`, `job.completed`, `dashboard_image.ready`.

## Rules for agents

- Be honest about uncertainty. Report `clarification`, `empty` and `error` states as such.
- Send an `Idempotency-Key` header on POSTs that cost credits (`/ask`, `/gems/generate`, `/predictions`, `/dashboards/{id}/image`) so retries are not charged twice. Generate one UUID per logical request and reuse it on retry.
- One in-flight request per conversation. A `409` with category `busy` means wait a few seconds and retry the same request.
- On `429` honour `Retry-After`. Do not loop faster than that.
- `image_url` values are short-lived signed URLs (15 minutes) and need no auth. Fetch or display them promptly. If expired, re-request.
- Do not poll jobs tighter than the cadence in `references/predictions.md`.
- Never print the API key, signing secrets or OAuth tokens back to the user or into logs.
- Do not take costly actions (generating gems, predictions) unless the user asked or clearly implied it.
- Admin actions (inviting people, changing roles, removing members, revoking invitations, connecting or deleting sources, deleting files) only when the user explicitly asks for that exact action. Never infer one from a vague request.
- Confirm before anything destructive or hard to undo: state what will be removed (member, source, file, invitation, webhook) and by whom it was requested, and wait for a yes. Deleting a source or removing a member is not undone by re-adding it.
- Never put database passwords or connector secrets in chat output or logs; ask the user to supply them and do not echo them back.

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

- `references/auth.md`: API keys, MCP connector keys (created under `Settings > API & MCP`), OAuth, the 13 scopes, headers.
- `references/workspaces.md`: listing and switching workspaces.
- `references/asking.md`: clarification, empty and error handling, follow-ups, language and audio, streaming.
- `references/gems.md`: Gems listing, generation, images.
- `references/dashboards.md`: dashboards and image rendering.
- `references/predictions.md`: jobs, polling, cancel, result shapes.
- `references/members.md`: members, roles, invitations.
- `references/sources.md`: connectors, sources, readiness, file uploads and duplicates.
- `references/errors.md`: every error category and the right response.
