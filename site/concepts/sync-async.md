# Sync vs async

Matih follows RFC 7240 (`Prefer`) so you choose, per request, whether to hold the connection or
come back later. Every response carries `Preference-Applied` saying what was done.

| Operation | Default | How to change |
|---|---|---|
| `POST /ask` | **Sync**: `200` and the Answer, `Preference-Applied: respond-sync`. | `Prefer: respond-async` or `?async=true`: `202` and a [Job](jobs.md) of kind `ask`. `Accept: text/event-stream` or `"stream": true` answers as server-sent events (`respond-stream`). |
| `POST /ask/audio` | Sync only | none |
| `POST /gems/generate` | **Async**: `202` and a Job | `Prefer: wait=N` or `?wait=N` |
| `POST /predictions` | **Async**: `202` and a Job | `Prefer: wait=N` or `?wait=N` |
| `POST /dashboards/{id}/image` | **Async**: `202` and a Job | `Prefer: wait=N` or `?wait=N` |
| `POST /sources` | `201` as soon as the source is saved (it is then read in the background) | `?wait=N` waits until Ask can use it. Not a Job: poll `GET /sources/{id}` for `readiness.can_ask`. |
| `POST /files` | `201` as soon as the file is stored, `status: processing` | `?wait=N` waits for it to be read (`202` if it is still being read). Not a Job: poll `GET /files/{id}` for `ready`. |

`wait=N` is the number of seconds the server may hold the request. `?wait=N` beats `Prefer: wait=N`. For
the four Job operations N is 0 to 60 (a larger `?wait=` is refused with `422`; a larger header value is
capped at 60). For `POST /sources` and `POST /files` N goes up to 120. The wait never ties up a worker, so
it is safe to use from many callers at once.

If the job finishes in time you get `200` and the finished Job; if not, `202` and the Job as it stands,
and you carry on with polling or a [webhook](../guides/webhooks.md). `202` answers for a Job also carry
`Location: /api/v1/jobs/{id}` and `Retry-After: 2`.

| `Preference-Applied` | Means |
|---|---|
| `respond-sync` | `POST /ask` waited and answered inline |
| `respond-async` | A Job was queued and returned at once |
| `respond-stream` | `POST /ask` answered as server-sent events |
| `wait=N` | A wait of N seconds was honoured, whether or not the work finished |

A sync `ask` can take tens of seconds for a hard question: set your client's timeout to 90 seconds or more,
or use `respond-async` behind a gateway that cuts requests at 30 or 60 seconds. `Idempotency-Key` on
`POST /ask` and `POST /predictions` makes a retry answer once and charge once.

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
{"id": "3f9c1a7b2d4e5f60", "kind": "ask", "state": "queued", "result": null, "error": null,
 "created_at": "2026-10-31T11:20:00Z", "updated_at": "2026-10-31T11:20:00Z"}
```

The headers are `Preference-Applied: respond-async`, `Location: /api/v1/jobs/3f9c1a7b2d4e5f60` and `Retry-After: 2`. When the job succeeds, `result` holds the Answer.

## Hold the line for a while with `wait=N`

A dashboard picture usually takes a few seconds. Ask the server to wait up to 20 seconds:

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
| A chat reply the person is waiting for | Sync `ask` (or SSE for progress) |
| A chat platform with a short callback deadline (a few seconds) | `Prefer: respond-async`, then reply later from the job result or webhook |
| Forecasts (minutes) and Gem generation | Default async; a webhook instead of polling at scale |
| A script that wants one call most of the time | `Prefer: wait=20`, then poll if you still get `202` |
| Connecting a source or uploading a file | `?wait=60`, then poll the source or file if it is still building |

!!! tip "SDKs"
    The Python and TypeScript clients wrap the async operations for you: `client.jobs.wait(job)` polls
    until the job is final. See [Jobs](jobs.md).
