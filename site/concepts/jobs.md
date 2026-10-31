# Jobs

Anything slow returns `202 Accepted` and a **Job**. Poll it or receive a webhook when it finishes.

```json
{
  "id": "job_...",
  "kind": "gems",
  "state": "running",
  "result": null,
  "error": null,
  "created_at": "2026-10-31T11:20:00Z",
  "updated_at": "2026-10-31T11:20:07Z"
}
```

| Field | Notes |
|---|---|
| `kind` | `ask`, `gems`, `prediction`, `dashboard_image` and so on |
| `state` | `queued`, `running`, `succeeded`, `failed`, `cancelled`. The last three are terminal. |
| `result` | `null` until `succeeded`. Shape depends on `kind`. |
| `error` | `null` unless `failed`: `{category, message}` in the same style as [Errors](errors.md) |

## Endpoints

| | |
|---|---|
| `GET /api/v1/jobs/{id}` | Current state. Needs any one of the job-starting scopes (`ask`, `predict`, `gems:generate`, `dashboards:read`). |
| `POST /api/v1/jobs/{id}/cancel` | Ask the job to stop. |

## Polling

Poll gently: every 5 seconds for the first minute, every 15 seconds up to five minutes, then every 30
to 60 seconds. A prediction can take up to 30 minutes, so give up after that and tell the person. Honour
`Retry-After` on a `429`.

=== "curl"

    ```bash
    JOB_ID=job_...
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
[Webhooks](../guides/webhooks.md).

## Idempotency

Retrying a credit-spending `POST` with the same `Idempotency-Key` is never charged twice, and returns
the same Job. Use a **new** key for a new logical request. The SDKs generate and reuse the key for you.
