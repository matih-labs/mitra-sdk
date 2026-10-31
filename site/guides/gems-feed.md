# Gems feed

Gems are findings Matih writes on its own about a data source: a headline, a short explanation, the supporting figures and a chart image. They answer "what is interesting in my data?" without anyone asking a question, which makes them a good morning digest or channel feed for a bot.

!!! info "You need"
    - Product: **Gems** (scope `gems:read` to read; `gems:generate` to write new ones, which needs **Allow changes**).
    - A source that Matih has finished reading. See [Connect a data source](connect-source.md) or [Upload a file](upload-file.md).

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## List Gems

`GET /gems?source_id=...` returns the Gems for a source (omit `source_id` to use the workspace's default).

```json
{
  "state": "ready",
  "gems": [
    {
      "id": "gem_1",
      "kind": "trend",
      "headline": "Weekend sales are up 14%",
      "explanation": "...",
      "figures": [],
      "question": "How did weekend sales change?",
      "image_url": "https://workspace.matih.ai/api/v1/media/....png",
      "created_at": "2026-10-30T09:00:00Z"
    }
  ],
  "generated_at": "2026-10-30T09:00:00Z"
}
```

`state` says whether Gems exist for the source (none yet, generating, or ready). Always check it before assuming an empty `gems` list means nothing was found.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" "$BASE/gems?source_id=SOURCE_ID"
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    listing = client.gems.list(source_id="SOURCE_ID")
    print(listing.state)
    for gem in listing.gems:
        print(gem.headline, "-", gem.explanation)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            listing = await client.gems.list(source_id="SOURCE_ID")
            for gem in listing.gems:
                print(gem.headline, "-", gem.explanation)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const { state, gems } = await mitra.gems.list({ source_id: "SOURCE_ID" });
    console.log(state);
    for (const gem of gems) console.log(gem.headline, "-", gem.explanation);
    ```

=== "JavaScript (fetch)"

    ```js
    const BASE = "https://workspace.matih.ai/api/v1";
    const res = await fetch(`${BASE}/gems?source_id=SOURCE_ID`, {
      headers: { Authorization: `Bearer ${process.env.MATIH_API_KEY}` },
    });
    if (!res.ok) throw new Error(JSON.stringify((await res.json()).detail));
    const { state, gems } = await res.json();
    for (const gem of gems) console.log(gem.headline, "-", gem.explanation);
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;

    public class ListGems {
        public static void main(String[] args) throws Exception {
            HttpRequest req = HttpRequest.newBuilder(
                    URI.create("https://workspace.matih.ai/api/v1/gems?source_id=SOURCE_ID"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .GET().build();
            HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.statusCode() + " " + res.body());
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
    )

    func main() {
    	req, _ := http.NewRequest("GET", "https://workspace.matih.ai/api/v1/gems?source_id=SOURCE_ID", nil)
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	fmt.Println(res.StatusCode, string(out))
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.Net.Http;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("MATIH_API_KEY"));
    var res = await http.GetAsync("https://workspace.matih.ai/api/v1/gems?source_id=SOURCE_ID");
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/gems?source_id=SOURCE_ID");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer " . getenv("MATIH_API_KEY")],
    ]);
    $out = curl_exec($ch);
    $data = json_decode($out, true);
    foreach ($data["gems"] ?? [] as $gem) {
        echo $gem["headline"], " - ", $gem["explanation"], "\n";
    }
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"

    uri = URI("https://workspace.matih.ai/api/v1/gems?source_id=SOURCE_ID")
    req = Net::HTTP::Get.new(uri, "Authorization" => "Bearer #{ENV.fetch('MATIH_API_KEY')}")
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
    JSON.parse(res.body)["gems"].each { |gem| puts "#{gem['headline']} - #{gem['explanation']}" }
    ```

## Show the chart

Every Gem has an `image_url`: a signed, short-lived URL (15 minutes, no auth header needed). Post it, or download the bytes right away. See [Images](../concepts/images.md).

=== "curl"

    ```bash
    # With the signed URL (no auth)
    URL=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/gems/GEM_ID | jq -r .image_url)
    curl -s -o gem.png "$URL"

    # Or with your key, which always returns a fresh image
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -o gem.png $BASE/gems/GEM_ID/image.png
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()
    gem_id = client.gems.list(source_id="SOURCE_ID").gems[0].id
    png = client.gems.image(gem_id)                  # bytes
    open("gem.png", "wb").write(png)
    ```

=== "TypeScript"

    ```ts
    import { writeFile } from "node:fs/promises";
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const { gems } = await mitra.gems.list({ source_id: "SOURCE_ID" });
    const png = await mitra.gems.image(gems[0].id);  // Uint8Array
    await writeFile("gem.png", png);
    ```

`gems.image` fetches with your credential and, if the picture is not rendered yet, waits for it.

## Generate new Gems

`POST /gems/generate` starts a Job (`kind: "gems"`) and returns `202`. It spends credits, so only do it when a person asked or the list is empty and they want Gems. The SDKs send an `Idempotency-Key` automatically.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"source_id": "SOURCE_ID"}' $BASE/gems/generate
    # 202 {"id": "job_...", "kind": "gems", "state": "queued", ...}

    # Then poll
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/jobs/JOB_ID
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()
    job = client.gems.generate("SOURCE_ID")           # 202 Job
    job = client.jobs.wait(job, timeout=900)          # polls with backoff
    listing = client.gems.list(source_id="SOURCE_ID")
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            job = await client.gems.generate("SOURCE_ID")
            job = await client.jobs.wait(job, timeout=900)
            listing = await client.gems.list(source_id="SOURCE_ID")
            print(listing.state, len(listing.gems))

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const job = await mitra.gems.generate("SOURCE_ID");
    await mitra.jobs.wait(job, { timeoutMs: 15 * 60_000 });
    const fresh = await mitra.gems.list({ source_id: "SOURCE_ID" });
    ```

=== "JavaScript (fetch)"

    ```js
    const BASE = "https://workspace.matih.ai/api/v1";
    const headers = {
      Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    };
    let job = await (await fetch(`${BASE}/gems/generate`, {
      method: "POST", headers, body: JSON.stringify({ source_id: "SOURCE_ID" }),
    })).json();

    while (!["succeeded", "failed", "cancelled"].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 5000));
      job = await (await fetch(`${BASE}/jobs/${job.id}`, { headers })).json();
    }
    console.log(job.state);
    ```

Only one generation can run per source; a `409` with category `busy` means one is already in progress. Rather than polling, you can register a `gems.ready` [webhook](webhooks.md) and refresh your feed when it fires (its `data` carries `source_id` and `gem_count`).

## A daily digest in 20 lines

Run this from cron. It posts the newest Gems to a Slack incoming webhook.

```python
import os
import httpx
from mitra import Mitra

client = Mitra()
SLACK_URL = os.environ["SLACK_WEBHOOK_URL"]

listing = client.gems.list(source_id=os.environ["MATIH_SOURCE_ID"])
if listing.state != "ready" or not listing.gems:
    raise SystemExit(f"no Gems to post (state: {listing.state})")

lines = [f"*{g.headline}*\n{g.explanation}" for g in listing.gems[:3]]
httpx.post(SLACK_URL, json={"text": "Today's Gems\n\n" + "\n\n".join(lines)}).raise_for_status()
```

To let people dig in, offer each Gem's `question` as the next question to `POST /ask` in a new conversation.

## Presenting Gems

- Lead with `headline`, then one or two sentences of `explanation`. Quote `figures` as returned.
- Post the image when the channel can show one.
- Pass `language` or `Accept-Language` to get the text in another language ([Multilingual bots](multilingual.md)).

See also [Credits](../concepts/credits.md) and [Errors](../concepts/errors.md).
