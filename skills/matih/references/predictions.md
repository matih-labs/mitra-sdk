# Predictions and jobs

Scope for predictions: `predict`.

## Start

MCP: `predict` with `question` and optionally `source_id`, `conversation_id`. REST: `POST /predictions`:

```json
{"question": "Forecast monthly revenue for the next 6 months", "source_id": "src_123"}
```

It returns 202 with a Job (`kind: "prediction"`). Predictions can take up to 30 minutes. Send an `Idempotency-Key` since it costs credits. Only run one when the user asked for a forecast, projection, model or what-if.

## Job shape

```json
{
  "id": "job_...",
  "kind": "gems" | "prediction" | "dashboard_image",
  "state": "queued" | "running" | "succeeded" | "failed" | "cancelled",
  "result": {} ,
  "error": {"category": "...", "message": "..."},
  "created_at": "...",
  "updated_at": "..."
}
```

`result` is null until `succeeded`. `error` is null unless `failed`.

## Polling cadence

MCP: `get_job` with `job_id`. REST: `GET /jobs/{id}`.

- First minute: every 5 seconds.
- Minutes 1 to 5: every 15 seconds.
- After 5 minutes: every 30 to 60 seconds.
- Stop after 30 minutes. If still not terminal, tell the user it is taking longer than the maximum, offer to cancel, and give the job id so they can check later.
- Honour `Retry-After` on 429.
- Terminal states are `succeeded`, `failed`, `cancelled`. Stop polling at any of them.
- Between polls, tell the user once that it is running and roughly how long it may take. Do not spam updates.

Alternative to polling (REST): a webhook for `prediction.completed` or `job.completed`.

## Result

```json
{
  "answer": "Revenue is forecast to grow 6% per month...",
  "attachments": [
    {"type": "forecast"},
    {"type": "table"},
    {"type": "model"},
    {"type": "what_if"}
  ],
  "image_url": "https://..."
}
```

- `answer`: present this first.
- `attachments`: each has a `type` of `forecast`, `table`, `model` or `what_if`, plus type-specific fields. Handle unknown fields gracefully and show what you recognise.
- `image_url`: optional chart, signed and valid for 15 minutes.
- State assumptions and uncertainty honestly. A forecast is an estimate, not a promise.

## Cancel

MCP has no cancel tool. REST: `POST /jobs/{id}/cancel`. Cancel when the user asks, or when you started a prediction by mistake. The job moves to `cancelled`. A job already in a terminal state cannot be cancelled. Cancelling does not necessarily refund credits.

## Failure

`state: "failed"` with `error.category` and `error.message`. See `errors.md`. Do not blindly re-run: explain the error, and if the cause is the question (not enough history, no time column), suggest a better-suited question or source.
