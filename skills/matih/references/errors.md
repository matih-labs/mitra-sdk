# Errors

Error body:

```json
{"detail": {"category": "scope", "message": "This credential is not allowed to do that: it needs ask."}}
```

Always read `detail.category` first, then `message`. `code` is optional and, where present, a finer machine-readable reason. Failed jobs carry an `error` object with `category` and `message` in the same style.

## By HTTP status

| Status | Category | Meaning | What to do |
| --- | --- | --- | --- |
| 401 | `authentication` | Missing, wrong, revoked or expired credential (keys do not expire by default). Response has `WWW-Authenticate`. An MCP connector key used outside `/api/v1/mcp` is also a 401. | API key: ask the user for a new key. OAuth: refresh once, then re-login. For a connector key on a REST path, use an API key (`Settings › API & MCP`). Do not loop. |
| 402 | `not_ready` | The workspace has no Matih Credits left. | Stop. Tell the user; an admin must add credits. Do not retry. |
| 402 | `member_cap` | The member reached the monthly credit cap an admin set for them. | Tell the user an admin must raise the cap. Do not retry. |
| 403 | `scope` | The credential lacks the scope for this call. | Name the scope (see `auth.md`). Ask the user to issue a key or grant with that scope. A key made without the matching product (for example Files) lacks its scopes. |
| 403 | `workspace_role` | The user's role in this workspace is too low for this action. | Tell the user which kind of role is needed (for example admin to add sources). Do not work around it. |
| 403 | `workspace` | A key pinned to one workspace was sent an `X-Matih-Workspace` for another. | Drop the header, or use a key made in that workspace. |
| 403 | `source_access` | The user may not use that source. | Re-run `list_sources` for the current workspace and pick again. Ask the user if no source is permitted. |
| 403 | `support_view` | The call came from a Support View session. | Not available there. |
| 404 | `not_found` | No such resource in this workspace. A resource of another member or workspace gives the same 404. | List again; a `source_id` from another workspace looks like this. |
| 409 | varies | The resource is not in a state for this: a file not waiting for a decision, an invitation no longer open, a workspace with 20 webhooks already. | Read `message`, list the resource, and fix the state. Do not retry unchanged. |
| 413 / 415 | `too_large` / `unsupported_audio_type` | An upload over the size limit; audio over 5 MB or not audio. | Send a smaller or supported file. |
| 422 | `invalid_request` | An invalid body or parameter; `message` names the field. | Fix the request. Do not retry unchanged. |
| 422 | `connection` | On `POST /sources`: the connection test failed, so nothing was saved. The body also carries the `test` result. | Read the test result (host unreachable, bad credentials, missing permission, wrong database). Tell the user what failed without echoing secrets, fix the config together, and call `POST /sources/test` until it passes. |
| 422 | `not_heard` | `POST /ask/audio`: no speech could be made out. | Ask the user to speak again or type the question. |
| 429 | `rate_limited` | Too many requests. `Retry-After` header gives seconds. | Wait at least that long, then retry once. Back off exponentially on repeats. |
| 5xx / 503 | `internal`, `unavailable`, `disabled`, `speech_unavailable`, `language_unavailable` | Server error or a part that is off or busy. | Retry up to 3 times with backoff (2s, 5s, 10s). For `POST /ask` and `POST /predictions` reuse the same `Idempotency-Key`. Then report the `request_id` if one is available. |

## Idempotency

Only `POST /ask` and `POST /predictions` honour `Idempotency-Key`: a retry with the same key answers once and is charged once. Reuse the key on retry and use a new one for a new logical request. Other POSTs (`/gems/generate`, `/dashboards/{id}/image`, `/ask/audio`, `/sources`, `/files`, `/invitations`) ignore it, so check state before you repeat one.

## Distinguish from answer statuses

An HTTP 200 Answer with `status: "error"`, `"empty"` or `"clarification"` is not an HTTP error. See `asking.md` for those.

## Job errors

A job with `state: "failed"` has `error.category` and `error.message`. The categories include `no_credits`, `member_cap`, `not_available`, `not_ready`, `timeout`, `generation_failed`, `prediction_failed`, `render_unavailable`, `interrupted`, `forbidden` and `internal`. A `cancelled` job needs no error handling beyond telling the user.

## MCP

Tool errors come back as tool results marked as errors with the same category and message text. Treat them the same as the HTTP cases above. A 401 means the MCP connection needs to be re-authenticated by the user.

## Telling the user

- Say what happened in one sentence, with the category in plain words.
- Say what they can do (or what you will do) next.
- Never include credentials in the message. Include `request_id` when you have one.
