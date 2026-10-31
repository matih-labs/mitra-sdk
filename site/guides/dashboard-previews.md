# Dashboard image previews

Turn a saved dashboard into a PNG you can drop into a chat message, an email or a link preview. Matih renders the dashboard as it looks right now, so the picture is a snapshot.

!!! info "You need"
    - Product: **Dashboards** (scope `dashboards:read`). Rendering an image is a read; no **Allow changes** needed.
    - The member the key acts as must be allowed to see the dashboard.

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## 1. Find the dashboard

`GET /dashboards` returns `{"dashboards": [{"id", "title", "source_id", "status", "revision", "widget_count", "created_at", "updated_at"}]}`, only the dashboards the member can see. `status` is `draft` or `saved`. `GET /dashboards/{id}` adds the `widgets` (`id`, `title`, `visual`, `question`). Match the user's wording to `title` and, when several are close, list them and ask.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/dashboards
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    for d in client.dashboards.list().dashboards:
        print(d.id, d.title, d.updated_at)
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const { dashboards } = await mitra.dashboards.list();
    for (const d of dashboards) console.log(d.id, d.title, d.updated_at);
    ```

## 2. Render it

`POST /dashboards/{id}/image` is asynchronous by default: it answers `202` with a Job (`kind: "dashboard_image"`). When the job succeeds its `result` is:

```json
{"image_url": "https://workspace.matih.ai/api/v1/media/<token>.png", "width": 1600, "height": 900}
```

The body is optional: `{"width": 1600}` (400 to 3200, default 1600). A dashboard drawn in the last ten minutes at the same width is reused. Send `Prefer: wait=20` (or `?wait=20`, up to 60) to let the server hold the request and answer `200` with the finished Job if the render completes in time; `Preference-Applied` in the response says which mode ran. Either way you may still get a Job that is not finished, so be ready to poll. See [Sync and async](../concepts/sync-async.md) and [Jobs](../concepts/jobs.md).

The SDKs hide the loop. Python `dashboards.render` starts the job, waits and downloads the PNG; TypeScript `dashboards.imageBytes` does the same.

=== "curl"

    ```bash
    DASHBOARD_ID=dsh_...

    # Start, and ask the server to wait up to 20 s for the result
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Prefer: wait=20" -X POST $BASE/dashboards/$DASHBOARD_ID/image

    # If the state is not "succeeded", poll the job id it returned
    JOB_ID=9b1d4c0e7a2f4c1e8d3b5a6f70e1c2d3   # the id from the 202 body
    while :; do
      JOB=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/jobs/$JOB_ID)
      STATE=$(echo "$JOB" | jq -r .state)
      [ "$STATE" = succeeded ] && { URL=$(echo "$JOB" | jq -r .result.image_url); break; }
      [ "$STATE" = failed ] || [ "$STATE" = cancelled ] && { echo "$JOB" | jq .error >&2; exit 1; }
      sleep 3
    done
    curl -s -o dashboard.png "$URL"      # no auth header needed
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()
    dashboard_id = client.dashboards.list().dashboards[0].id
    png = client.dashboards.render(dashboard_id)       # bytes
    open("dashboard.png", "wb").write(png)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            listing = await client.dashboards.list()
            png = await client.dashboards.render(listing.dashboards[0].id)
            open("dashboard.png", "wb").write(png)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { writeFile } from "node:fs/promises";
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const { dashboards } = await mitra.dashboards.list();
    const png = await mitra.dashboards.imageBytes(dashboards[0].id); // Uint8Array
    await writeFile("dashboard.png", png);
    ```

=== "JavaScript (fetch)"

    ```js
    import { writeFile } from "node:fs/promises";

    const BASE = "https://workspace.matih.ai/api/v1";
    const auth = { Authorization: `Bearer ${process.env.MATIH_API_KEY}` };
    const id = process.argv[2]; // dashboard id

    let job = await (await fetch(`${BASE}/dashboards/${id}/image`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": crypto.randomUUID(), Prefer: "wait=20" },
    })).json();

    while (!["succeeded", "failed", "cancelled"].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 3000));
      job = await (await fetch(`${BASE}/jobs/${job.id}`, { headers: auth })).json();
    }
    if (job.state !== "succeeded") throw new Error(JSON.stringify(job.error));

    const png = await fetch(job.result.image_url);       // no auth header needed
    await writeFile("dashboard.png", Buffer.from(await png.arrayBuffer()));
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;
    import java.util.UUID;

    public class DashboardImage {
        public static void main(String[] args) throws Exception {
            String id = args[0]; // dashboard id
            HttpClient http = HttpClient.newHttpClient();
            HttpRequest req = HttpRequest.newBuilder(
                    URI.create("https://workspace.matih.ai/api/v1/dashboards/" + id + "/image"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .header("Prefer", "wait=20")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.statusCode() + " " + res.body());
            // Read "state" and "result.image_url" from the body with your JSON library.
            // If state is not "succeeded", poll GET /jobs/{id} until it is.
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
    	"time"
    )

    func main() {
    	id := os.Args[1] // dashboard id
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/dashboards/"+id+"/image", nil)
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Idempotency-Key", fmt.Sprintf("dash-%d", time.Now().UnixNano()))
    	req.Header.Set("Prefer", "wait=20")
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	fmt.Println(res.StatusCode, res.Header.Get("Preference-Applied"), string(out))
    	// Decode "state" and "result.image_url". If state is not "succeeded", poll GET /jobs/{id}.
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.Net.Http;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("MATIH_API_KEY"));
    http.DefaultRequestHeaders.Add("Prefer", "wait=20");

    var id = args[0]; // dashboard id
    var req = new HttpRequestMessage(HttpMethod.Post, $"https://workspace.matih.ai/api/v1/dashboards/{id}/image");
    req.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
    var res = await http.SendAsync(req);
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    // Parse "state" and "result.image_url" with System.Text.Json.
    // If state is not "succeeded", poll GET /jobs/{id}.
    ```

=== "PHP"

    ```php
    <?php
    $id = $argv[1]; // dashboard id
    $ch = curl_init("https://workspace.matih.ai/api/v1/dashboards/$id/image");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Idempotency-Key: " . bin2hex(random_bytes(16)),
            "Prefer: wait=20",
        ],
    ]);
    $job = json_decode(curl_exec($ch), true);
    echo $job["state"], "\n";
    if ($job["state"] === "succeeded") {
        file_put_contents("dashboard.png", file_get_contents($job["result"]["image_url"]));
    } // otherwise poll GET /jobs/{id}
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"
    require "securerandom"

    id = ARGV.fetch(0) # dashboard id
    uri = URI("https://workspace.matih.ai/api/v1/dashboards/#{id}/image")
    req = Net::HTTP::Post.new(uri, "Authorization" => "Bearer #{ENV.fetch('MATIH_API_KEY')}",
                                   "Idempotency-Key" => SecureRandom.uuid, "Prefer" => "wait=20")
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
    job = JSON.parse(res.body)
    puts job["state"]
    File.binwrite("dashboard.png", Net::HTTP.get(URI(job["result"]["image_url"]))) if job["state"] == "succeeded"
    # otherwise poll GET /jobs/{id}
    ```

## Or fetch the PNG directly

`GET /dashboards/{id}/image.png` with your key answers `303` to the image when one was drawn recently and otherwise answers `202` with a Job. Follow redirects:

```bash
curl -sL -H "Authorization: Bearer $MATIH_API_KEY" -o dashboard.png $BASE/dashboards/$DASHBOARD_ID/image.png
head -c 200 dashboard.png   # if this is JSON, a render job was started: poll it as above
```

## Short-lived links

`image_url` is an unguessable URL under `/api/v1/media/{token}.png`. It needs no `Authorization` header and expires after **15 minutes**. That makes it safe to hand to a chat platform that fetches the image itself (WhatsApp, Teams, Slack unfurls), but treat it like a secret for those 15 minutes: anyone holding it can see the picture. Download or post it immediately; request a new render when it expires. See [Images](../concepts/images.md).

## Notify when ready

For renders you start and walk away from, register a `dashboard_image.ready` [webhook](webhooks.md). Its `data` is the finished Job: `job_id`, `kind`, `state`, `result` (`image_url`, `width`, `height`) and `links`. It carries no `dashboard_id`, so keep your own map of job id to dashboard.

## Tips

- The picture is a snapshot. State when it was taken (the job's `updated_at`) if people decide from it.
- If someone wants a number from the dashboard, ask the underlying question with `POST /ask` instead of reading it off the picture.
- A bot serving many people should cache the PNG for a few minutes per dashboard instead of rendering on every message.
- Rendering is free of credits; it still counts against [rate limits](../concepts/rate-limits.md).

See [Errors](../concepts/errors.md) for 403 `scope`, 404 and 429 handling.
