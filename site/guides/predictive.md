# Predictive questions

Forecasts, anomaly checks, segmentation and what-ifs go through `POST /predictions`. They are heavier than a normal question, so they run as background **Jobs** that can take anywhere from a minute to 30 minutes. You start one, then either poll the job or take a webhook. The request is async by default (`202` and a Job); add `Prefer: wait=N` (or `?wait=N`, N up to 60) to have it hold until the job finishes when that is quick, and carry on polling if it is not.

!!! info "You need"
    - Product: **Predictive analytics** (scope `predict`).
    - A source Matih has finished reading with enough history for the question (a time column for a forecast, for example).
    - Credits: predictions spend workspace credits. See [Credits](../concepts/credits.md).

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## Start a prediction

Body fields: `question` (required), `source_id` (optional: the active source is used), `conversation_id` (optional, to continue a conversation) and `language` (optional, for the answer text). Send an `Idempotency-Key`: a retry with the same key returns the same Job and is charged once. The SDKs add one for you.

The response is `202` with a Job:

```json
{"id": "5d0c9e1a7b3f4a2c8e6d1f0b9a8c7e65", "kind": "prediction", "state": "queued", "result": null, "error": null,
 "created_at": "2026-10-31T10:00:00Z", "updated_at": "2026-10-31T10:00:00Z"}
```

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}' \
      $BASE/predictions
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    job = client.predictions.create(
        "Forecast monthly revenue for the next 6 months", source_id="SOURCE_ID",
        background=True,   # return the queued Job at once; without it the call waits for the result
    )
    print(job.id, job.state)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            job = await client.predictions.create(
                "Forecast monthly revenue for the next 6 months", source_id="SOURCE_ID",
                background=True,
            )
            print(job.id, job.state)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const job = await mitra.predictions.create(
      { question: "Forecast monthly revenue for the next 6 months", source_id: "SOURCE_ID" },
      { background: true }, // return the queued Job at once; without it the call waits for the result
    );
    console.log(job.id, job.state);
    ```

=== "JavaScript (fetch)"

    ```js
    const BASE = "https://workspace.matih.ai/api/v1";
    const res = await fetch(`${BASE}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        question: "Forecast monthly revenue for the next 6 months",
        source_id: "SOURCE_ID",
      }),
    });
    if (!res.ok) throw new Error(JSON.stringify((await res.json()).detail));
    const job = await res.json(); // 202
    console.log(job.id, job.state);
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;
    import java.util.UUID;

    public class Predict {
        public static void main(String[] args) throws Exception {
            String body = """
                {"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}""";
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/predictions"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.statusCode() + " " + res.body()); // 202 and the Job
        }
    }
    ```

=== "Go"

    ```go
    package main

    import (
    	"fmt"
    	"io"
    	"net/http"
    	"os"
    	"strings"
    	"time"
    )

    func main() {
    	body := `{"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}`
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/predictions", strings.NewReader(body))
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", "application/json")
    	req.Header.Set("Idempotency-Key", fmt.Sprintf("pred-%d", time.Now().UnixNano()))
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	fmt.Println(res.StatusCode, string(out)) // 202 and the Job
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.Net.Http;
    using System.Text;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    var req = new HttpRequestMessage(HttpMethod.Post, "https://workspace.matih.ai/api/v1/predictions")
    {
        Content = new StringContent(
            """{"question": "Forecast monthly revenue for the next 6 months", "source_id": "SOURCE_ID"}""",
            Encoding.UTF8, "application/json"),
    };
    req.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
    var res = await http.SendAsync(req);
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}"); // 202 and the Job
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/predictions");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            "question" => "Forecast monthly revenue for the next 6 months",
            "source_id" => "SOURCE_ID",
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Content-Type: application/json",
            "Idempotency-Key: " . bin2hex(random_bytes(16)),
        ],
    ]);
    $job = json_decode(curl_exec($ch), true);
    echo $job["id"], " ", $job["state"], "\n";
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"
    require "securerandom"

    uri = URI("https://workspace.matih.ai/api/v1/predictions")
    req = Net::HTTP::Post.new(uri, "Content-Type" => "application/json",
                                   "Authorization" => "Bearer #{ENV.fetch('MATIH_API_KEY')}",
                                   "Idempotency-Key" => SecureRandom.uuid)
    req.body = { question: "Forecast monthly revenue for the next 6 months", source_id: "SOURCE_ID" }.to_json
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
    job = JSON.parse(res.body)
    puts "#{job['id']} #{job['state']}"
    ```

## Wait for the result

Job states are `queued`, `running`, `succeeded`, `failed` and `cancelled`. Stop polling at any of the last three.

A polite cadence for a long job: every 5 seconds for the first minute, every 15 seconds up to 5 minutes, then every 30 to 60 seconds. Give up after 30 minutes and tell the person the job id so they can check later. Honour `Retry-After` on a `429`.

=== "curl"

    ```bash
    JOB_ID=...   # the "id" of the Job
    START=$(date +%s); DELAY=5
    while :; do
      JOB=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/jobs/$JOB_ID)
      STATE=$(echo "$JOB" | jq -r .state)
      case "$STATE" in
        succeeded) echo "$JOB" | jq .result; break ;;
        failed)    echo "$JOB" | jq .error >&2; exit 1 ;;
        cancelled) echo cancelled >&2; exit 1 ;;
      esac
      ELAPSED=$(( $(date +%s) - START ))
      [ "$ELAPSED" -ge 1800 ] && { echo "still $STATE after 30 minutes" >&2; exit 2; }
      [ "$ELAPSED" -ge 60 ] && DELAY=15
      [ "$ELAPSED" -ge 300 ] && DELAY=30
      sleep "$DELAY"
    done
    ```

=== "Python"

    ```python
    from mitra import JobFailedError, JobTimeoutError, Mitra

    client = Mitra()
    try:
        job = client.predictions.create("Forecast monthly revenue for the next 6 months", background=True)
        done = client.jobs.wait(job, timeout=1860, on_update=lambda j: print(j.state))
    except JobTimeoutError as e:
        print("still running, job id:", e.job.id)   # the job keeps running
        raise
    except JobFailedError as e:
        print("failed:", e.job.error)
        raise
    print(done.result["answer"])
    ```

    `client.predictions.run(question)` is the one-call version: it creates the job and waits (without `background=True`, `create` waits too).

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            done = await client.predictions.run(
                "Forecast monthly revenue for the next 6 months", source_id="SOURCE_ID"
            )
            print(done.result["answer"])

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { JobFailedError, JobTimeoutError, Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    try {
      const job = await mitra.predictions.create(
        { question: "Forecast monthly revenue for the next 6 months" },
        { background: true },
      );
      const done = await mitra.jobs.wait(job, {
        timeoutMs: 31 * 60_000,
        onProgress: (j) => console.log(j.state),
      });
      console.log(done.result?.answer);
    } catch (err) {
      if (err instanceof JobTimeoutError) console.error("still running; the job keeps going");
      else if (err instanceof JobFailedError) console.error("failed:", err.job.error);
      else throw err;
    }
    ```

=== "JavaScript (fetch)"

    ```js
    const BASE = "https://workspace.matih.ai/api/v1";
    const headers = { Authorization: `Bearer ${process.env.MATIH_API_KEY}` };
    const jobId = process.argv[2];

    const started = Date.now();
    let delay = 5000;
    for (;;) {
      const res = await fetch(`${BASE}/jobs/${jobId}`, { headers });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get("Retry-After") ?? 5) * 1000));
        continue;
      }
      const job = await res.json();
      if (job.state === "succeeded") { console.log(job.result); break; }
      if (job.state === "failed" || job.state === "cancelled") { console.error(job.error ?? job.state); break; }
      const elapsed = Date.now() - started;
      if (elapsed > 30 * 60_000) { console.error("gave up; job", jobId, "is still", job.state); break; }
      if (elapsed > 60_000) delay = 15_000;
      if (elapsed > 300_000) delay = 30_000;
      await new Promise((r) => setTimeout(r, delay));
    }
    ```

For Java, Go, C#, PHP and Ruby the loop is the same: `GET /jobs/{id}`, branch on `state`, sleep, repeat. Prefer the webhook below when you can.

## Read the result

When the job has `succeeded`, `result` is:

```json
{
  "conversation_id": "5c1d0a4e8b7f4e3a9d2c6b1a0f9e8d7c",
  "answer": "Revenue is forecast to grow 6% per month..."
}
```

- `answer`: show this first. It is the finished written answer, including the assumptions.
- `conversation_id`: the conversation the prediction ran in. Pass it as `conversation_id` on the next `POST /predictions` (or `POST /ask`) to follow up.

State the assumptions and the uncertainty. A forecast is an estimate, not a promise.

## Take a webhook instead of polling

Register `prediction.completed` (or `job.completed`) and Matih posts to your server when the job finishes. The `data` is the summarised Job (`job_id`, `kind`, `state`, `result`, `error`, `links`) with long strings cut to 500 characters; fetch the full answer from `GET /jobs/{id}`. Verify the signature first. See [Webhooks](webhooks.md).

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/hooks/matih", "events": ["prediction.completed"]}' \
  $BASE/webhooks
```

## Cancel

```bash
curl -s -X POST -H "Authorization: Bearer $MATIH_API_KEY" $BASE/jobs/$JOB_ID/cancel
```

Python `client.jobs.cancel(job_id)`; TypeScript `mitra.jobs.cancel(id)`. A queued job stops at once, a running one at its next checkpoint, and a job already in a final state is left as it is.

## When it fails

A job with `state: "failed"` carries `error.category` and `error.message`. Do not blindly re-run. If the cause is the question (not enough history, no time column), suggest a better-suited question or source. A `402` `not_ready` error when starting means the workspace is out of credits: stop and tell an admin ([Credits](../concepts/credits.md)).

Predictions can also be asked in other languages; see [Multilingual bots](multilingual.md). More on states and timing: [Jobs](../concepts/jobs.md).
