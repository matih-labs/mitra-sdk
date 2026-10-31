# Jobs

Work that can outlast a request runs as a **Job**: `ask` (when you send `Prefer: respond-async`), Gem
generation, predictions and dashboard images. You get `202 Accepted` and a Job straight away, and poll it
or receive a webhook when it finishes. Connecting a source and uploading a file are **not** Jobs: they
answer `201` and you poll `GET /sources/{id}` or `GET /files/{id}` ([Sync vs async](sync-async.md)).

```json
{
  "id": "3f9c1a7b2d4e5f60",
  "kind": "dashboard_image",
  "state": "succeeded",
  "result": {"image_url": "https://workspace.matih.ai/api/v1/media/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978.png",
             "width": 1600, "height": 1100},
  "error": null,
  "created_at": "2026-10-31T10:15:00Z",
  "updated_at": "2026-10-31T10:15:09Z"
}
```

| Field | Notes |
|---|---|
| `kind` | `ask`, `gems`, `prediction` or `dashboard_image` |
| `state` | `queued`, `running`, `succeeded`, `failed`, `cancelled`. The last three are final. |
| `result` | `null` until `succeeded`. By kind: `ask` is the Answer; `gems` is `{source_id, state, gem_count}`; `prediction` is `{conversation_id, answer}`; `dashboard_image` is `{image_url, width, height}` (the URL needs no credential and expires in 15 minutes). |
| `error` | `null` unless `failed`: `{category, message}`. Categories include `forbidden` (the member who asked left the workspace), `not_available`, `not_ready` (the source is not ready for Gems), `timeout`, `generation_failed`, `prediction_failed`, `render_unavailable` and `interrupted`. |

## Endpoints

| | |
|---|---|
| `GET /api/v1/jobs/{id}` | Current state. Needs `workspaces:read` and the scope of the job's kind (`ask`, `gems:generate`, `predict`, `dashboards:read`). |
| `POST /api/v1/jobs/{id}/cancel` | Same scopes. A queued job stops at once, a running one at its next checkpoint, a final one is left as it is. Returns the Job in its new state. |

A job of another member or workspace, or one your credential has no scope for, is a `404`.

A job that is interrupted (a deploy, a crashed worker) is picked up again and finished, not lost; after
three interruptions it fails with category `interrupted`. Gem generation gives up after 20 minutes and a
prediction after 30 (`timeout`). `Idempotency-Key` on `POST /ask` or `POST /predictions` returns the same
Job on a retry and charges once.

## Polling

Every 2 seconds is plenty for a quick job (the `Retry-After` on the `202` says so). For a prediction,
which takes minutes, poll every 5 to 15 seconds, and give up after 30 minutes and tell the person. Honour
`Retry-After` on a `429`.

=== "curl"

    ```bash
    JOB_ID=3f9c1a7b2d4e5f60
    until STATE=$(curl -s "https://workspace.matih.ai/api/v1/jobs/$JOB_ID" \
          -H "Authorization: Bearer $MATIH_API_KEY" | jq -r .state); \
          [ "$STATE" = succeeded ] || [ "$STATE" = failed ] || [ "$STATE" = cancelled ]; do
      sleep 5
    done
    echo "$STATE"
    ```

=== "Python"

    ```python
    from mitra import Mitra, JobFailedError, JobTimeoutError

    client = Mitra()
    job = client.predictions.create("Forecast monthly revenue for the next 6 months")
    try:
        job = client.jobs.wait(job, timeout=1860, on_update=lambda j: print(j.state))
        print(job.result["answer"])
    except JobFailedError as err:
        print("failed:", err)
    except JobTimeoutError:
        print("still running; check again later with", job.id)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main() -> None:
        async with AsyncMitra() as client:
            job = await client.predictions.create("Forecast monthly revenue for the next 6 months")
            job = await client.jobs.wait(job)
            print(job.result["answer"])


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra, JobFailedError, JobTimeoutError } from "@matihlabs/mitra";

    const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const job = await client.predictions.create({ question: "Forecast monthly revenue for the next 6 months" });
    try {
      const done = await client.jobs.wait(job, { timeoutMs: 35 * 60_000, onProgress: (j) => console.log(j.state) });
      console.log(done.result);
    } catch (err) {
      if (err instanceof JobFailedError) console.error("failed", err.message);
      else if (err instanceof JobTimeoutError) console.error("still running", job.id);
      else throw err;
    }
    ```

=== "JavaScript (fetch)"

    ```js
    async function waitForJob(id, { timeoutMs = 30 * 60_000 } = {}) {
      const start = Date.now();
      let delay = 5000;
      for (;;) {
        const res = await fetch(`https://workspace.matih.ai/api/v1/jobs/${id}`, {
          headers: { Authorization: `Bearer ${process.env.MATIH_API_KEY}` },
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, Number(res.headers.get("Retry-After") ?? 5) * 1000));
          continue;
        }
        const job = await res.json();
        if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
        if (Date.now() - start > timeoutMs) throw new Error(`job ${id} still ${job.state}`);
        await new Promise((r) => setTimeout(r, delay));
        const elapsed = Date.now() - start;
        delay = elapsed > 300_000 ? 30000 : elapsed > 60_000 ? 15000 : 5000;
      }
    }
    ```

=== "Go"

    ```go
    func waitForJob(id string) (map[string]any, error) {
    	deadline := time.Now().Add(30 * time.Minute)
    	delay := 5 * time.Second
    	for time.Now().Before(deadline) {
    		req, _ := http.NewRequest("GET", "https://workspace.matih.ai/api/v1/jobs/"+id, nil)
    		req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    		res, err := http.DefaultClient.Do(req)
    		if err != nil {
    			return nil, err
    		}
    		var job map[string]any
    		err = json.NewDecoder(res.Body).Decode(&job)
    		res.Body.Close()
    		if err != nil {
    			return nil, err
    		}
    		switch job["state"] {
    		case "succeeded", "failed", "cancelled":
    			return job, nil
    		}
    		time.Sleep(delay)
    		if delay < 30*time.Second {
    			delay *= 2
    		}
    	}
    	return nil, fmt.Errorf("job %s did not finish in 30 minutes", id)
    }
    ```

## Webhooks instead of polling

At any scale prefer webhooks: `job.completed` fires when any job reaches a final state, and
`gems.ready`, `prediction.completed` and `dashboard_image.ready` fire for those kinds. See
[Webhooks](../guides/webhooks.md). The payload is `{job_id, kind, state, result, error}`, the same as the Job, and
it is delivered once the job is final. Jobs started by a credential notify that credential's webhooks.

## Idempotency

Retrying `POST /ask` or `POST /predictions` with the same `Idempotency-Key` is answered once, charged once
and returns the same Job. Use a **new** key for a new logical request. The SDKs generate and reuse the key
for you.
