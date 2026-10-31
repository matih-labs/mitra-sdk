# Sync vs async

Matih follows RFC 7240 (`Prefer`) so you choose, per request, whether to hold the connection or
come back later.

| Operation | Default | How to change |
|---|---|---|
| `POST /ask` | Synchronous: the answer in the response. `Accept: text/event-stream` or `"stream": true` gives server-sent events. | `Prefer: respond-async` returns `202` and a [Job](jobs.md). |
| `POST /ask/audio` | Synchronous | Same as `/ask` |
| `POST /gems/generate`, `POST /predictions`, `POST /dashboards/{id}/image`, source creation, file upload | **Asynchronous**: `202` and a Job | `Prefer: wait=N` (or `?wait=N`) holds the connection up to N seconds and answers inline if the job finished in time; otherwise you still get the `202`. |

The response header `Preference-Applied` tells you which mode actually ran, for example
`Preference-Applied: respond-async` or `Preference-Applied: wait=20`.

## Ask asynchronously

=== "curl"

    ```bash
    curl -si https://workspace.matih.ai/api/v1/ask \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Prefer: respond-async" \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "Which products declined for three months in a row?"}'
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
        Prefer: "respond-async",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ question: "Which products declined for three months in a row?" }),
    });
    console.log(res.status, res.headers.get("Preference-Applied"), await res.json());
    ```

=== "Python"

    ```python
    import os
    import httpx

    res = httpx.post(
        "https://workspace.matih.ai/api/v1/ask",
        headers={
            "Authorization": f"Bearer {os.environ['MATIH_API_KEY']}",
            "Prefer": "respond-async",
        },
        json={"question": "Which products declined for three months in a row?"},
        timeout=30,
    )
    print(res.status_code, res.headers.get("Preference-Applied"), res.json())
    ```

`202 Accepted` with a Job:

```json
{"id": "job_...", "kind": "ask", "state": "queued", "result": null, "error": null,
 "created_at": "2026-10-31T11:20:00Z", "updated_at": "2026-10-31T11:20:00Z"}
```

When the job succeeds, `result` holds the Answer.

## Hold the line for a while with `wait=N`

For a dashboard render that usually takes a few seconds, ask the server to wait up to 20 seconds:

```bash
curl -si -X POST "https://workspace.matih.ai/api/v1/dashboards/$DASHBOARD_ID/image" \
  -H "Authorization: Bearer $MATIH_API_KEY" \
  -H "Prefer: wait=20" \
  -H "Idempotency-Key: $(uuidgen)"
```

- Finished in time: `200` with the finished Job (`state: "succeeded"`, `result` filled), `Preference-Applied: wait=20`.
- Not yet: `202` with the running Job. Poll it, or take a [webhook](../guides/webhooks.md).

## Choosing

| Situation | Choose |
|---|---|
| A chat reply the user is waiting for | Sync `ask` (or SSE for progress) |
| A chat platform with a short callback deadline (a few seconds) | `Prefer: respond-async`, then reply later from the job result or webhook |
| Forecasts (up to 30 minutes), Gem generation | Default async; webhook instead of polling at scale |
| A script that wants one call | `Prefer: wait=N` then poll if you still get `202` |

!!! tip "SDKs"
    The Python and TypeScript clients wrap the async operations for you: `client.jobs.wait(job)` polls with
    backoff until the job is terminal. See [Jobs](jobs.md).
