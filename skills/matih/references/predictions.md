# Predictions and jobs

Scope for predictions: `predict`.

## Start

MCP: `predict` with `question` and optionally `source_id` and `language`. REST: `POST /predictions` (body `question`, optional `source_id`, `conversation_id`, `language`; the MCP tool has no `conversation_id`):

```json
{"question": "Forecast monthly revenue for the next 6 months", "source_id": "src_123"}
```

It returns 202 with a Job (`kind: "prediction"`); `?wait=N` or `Prefer: wait=N` (N up to 60) returns the finished Job if it is quick. Predictions usually take one to five minutes, and the server gives up after 30 (`failed`, category `timeout`). Send an `Idempotency-Key` since it costs credits: a retry returns the same Job. Only run one when the user asked for a forecast, projection, anomaly check, segmentation or what-if.

## Job shape

```json
{
  "id": "job_...",
  "kind": "ask" | "gems" | "prediction" | "dashboard_image",
  "state": "queued" | "running" | "succeeded" | "failed" | "cancelled",
  "result": {} ,
  "error": {"category": "...", "message": "..."},
  "created_at": "...",
  "updated_at": "..."
}
```

`result` is null until `succeeded`; its shape depends on `kind`. `error` is null unless `failed`. Final states are `succeeded`, `failed` and `cancelled`. A job interrupted by a deploy is picked up again; after three interruptions it fails with `interrupted`.

## Polling cadence

MCP: `get_job` with `job_id`. REST: `GET /jobs/{id}`.

- Every 10 to 15 seconds (the `Retry-After` on a 202 says when to look; every 2 seconds is the fastest that is useful).
- After 5 minutes: every 30 to 60 seconds.
- Stop after 30 minutes, the server's own limit. If still not final, tell the user it is taking longer than the maximum, offer to cancel, and give the job id so they can check later.
- Honour `Retry-After` on 429.
- Terminal states are `succeeded`, `failed`, `cancelled`. Stop polling at any of them.
- Between polls, tell the user once that it is running and roughly how long it may take. Do not spam updates.

Alternative to polling (REST): a webhook for `prediction.completed` or `job.completed`. A job started by a credential notifies that credential's webhooks.

## Result

A succeeded prediction Job has:

```json
{
  "conversation_id": "5c1d0a4e8b7f4e3a9d2c6b1a0f9e8d7c",
  "answer": "Revenue is forecast to grow 6% per month..."
}
```

- `answer`: a plain string. Present it first, as written.
- `conversation_id`: the prediction conversation. Pass it as `conversation_id` to `POST /predictions` to ask a follow-up in the same one.
- Over MCP, `get_job` renders the finished result as text, with the chart as an image when there is one.
- The other kinds: `ask` is the Answer, `gems` is `{source_id, state, gem_count}`, `dashboard_image` is `{image_url, width, height}`.
- State assumptions and uncertainty honestly. A forecast is an estimate, not a promise.

## Cancel

MCP has no cancel tool. REST: `POST /jobs/{id}/cancel` returns the Job in its new state. A queued job stops at once, a running one at its next checkpoint, and a final one is left as it is. Cancel when the user asks, or when you started a prediction by mistake. Cancelling does not necessarily refund credits.

## Failure

`state: "failed"` with `error.category` and `error.message`. Job categories include `no_credits`, `member_cap`, `not_available`, `not_ready`, `timeout`, `generation_failed`, `prediction_failed`, `render_unavailable`, `interrupted`, `forbidden` and `internal`. See `errors.md`. Do not blindly re-run: explain the error, and if the cause is the question (not enough history, no time column), suggest a better-suited question or source.
