# Errors

Error body:

```json
{"detail": {"category": "scope", "message": "Missing scope: ask", "code": "optional_machine_code"}}
```

Always read `detail.category` first, then `message`. `code` is optional. Failed jobs carry an `error` object with `category` and `message` in the same style.

## By HTTP status

| Status | Category | Meaning | What to do |
| --- | --- | --- | --- |
| 401 | (none) | Missing, wrong, expired or revoked credential. Response has `WWW-Authenticate`. | API key: ask the user for a new key. OAuth: refresh once, then re-login. Do not loop. |
| 402 | `credits` | The workspace is out of credits. | Stop. Tell the user; an admin must add credits. Do not retry. |
| 402 | `member_cap` | The workspace is at its member limit. | Tell the user an admin must raise the cap or free a seat. |
| 403 | `scope` | The credential lacks the scope for this call. | Name the scope (see `auth.md`). Ask the user to issue a key or grant with that scope. |
| 403 | `workspace_role` | The user's role in this workspace is too low for this action. | Tell the user which kind of role is needed (for example admin to add sources). Do not work around it. |
| 403 | `source_access` | The user cannot access that source, or the `source_id` belongs to another workspace. | Re-run `list_sources` for the current workspace and pick again. Ask the user if no source is permitted. |
| 409 | `busy` | Another request in the same conversation or the same long task is already running. | Wait 3 to 5 seconds and retry the same request with the same `Idempotency-Key`. Give up after about a minute and tell the user. |
| 429 | (rate limit) | Too many requests. `Retry-After` header gives seconds. | Wait at least that long, then retry once. Back off exponentially on repeats. |
| 4xx other | varies | Bad input (for example a missing field or an unknown id). | Fix the request. Do not retry unchanged. Read `message`. |
| 5xx | varies | Server error. | Retry up to 3 times with backoff (2s, 5s, 10s) using the same `Idempotency-Key`. Then report the `request_id` if one is available. |

## Idempotency

Retrying a credit-costing POST (`/ask`, `/ask/audio`, `/gems/generate`, `/predictions`, `/dashboards/{id}/image`) with the same `Idempotency-Key` is not charged twice. Always reuse the key on retry. Use a new key for a new logical request.

## Distinguish from answer statuses

An HTTP 200 Answer with `status: "error"`, `"empty"` or `"clarification"` is not an HTTP error. See `asking.md` for those.

## Job errors

A job with `state: "failed"` has `error.category` and `error.message`. The same categories apply (for example `credits` when funds ran out partway). A `cancelled` job needs no error handling beyond telling the user.

## MCP

Tool errors come back as tool results marked as errors with the same category and message text. Treat them the same as the HTTP cases above. A tool-level 401 usually means the MCP connection needs to be re-authenticated by the user.

## Telling the user

- Say what happened in one sentence, with the category in plain words.
- Say what they can do (or what you will do) next.
- Never include credentials in the message. Include `request_id` when you have one.
