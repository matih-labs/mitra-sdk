# Quickstart

Five minutes from nothing to a first answer.

!!! info "You need"
    - A Matih workspace with at least one connected data source or uploaded file.
    - A workspace **owner or admin** to create the key (the `user` and `viewer` roles cannot).

## 1. Create an API key

1. In Matih open **Settings › API & MCP** (owners and admins see this tab).
2. Choose **New API key** (kind **API key**: it works on all of `/api/v1`; the other kind, **MCP connector**, works only on `/api/v1/mcp`).
3. Pick the **products** the key may use: Ask, Data sources, Files, Predictive analytics, Dashboards, Gems, Workspaces, Users & members, Webhooks. All are on by default. Each product with writes has an **Allow changes** switch; leave it off for a bot that only reads.
4. Leave expiry empty (no expiry is the default) or choose a date.
5. Copy the key. It starts with `mtk_` and **is shown once**.

!!! warning "Treat the key like a password"
    The key acts as the member who created it and is pinned to one workspace. Keep it in an
    environment variable or a secret store, never in source control or a browser. See [Security](security.md).

The same page prints copy-paste snippets for the products you switched on.

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## 2. Check the key works

=== "curl"

    ```bash
    curl -s "$BASE/workspaces" -H "Authorization: Bearer $MATIH_API_KEY"
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    print(client.workspaces.list())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    console.log(await client.workspaces.list());
    ```

You get the workspace the key is pinned to. A `401` means the key is wrong, revoked or expired; a
`403` with category `scope` means that product is switched off for the key (see [Errors](concepts/errors.md)).

## 3. Ask your first question

`POST /ask` takes a `question` and, optionally, a `source_id` (needed only when the workspace has
more than one active source). List your sources with `GET /sources`.

=== "curl"

    ```bash
    curl -s "$BASE/ask" \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "What were last month'"'"'s sales by region?"}'
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()
    answer = client.ask("What were last month's sales by region?")

    print(answer.status)          # answered | clarification | empty | error | cancelled
    print(answer.answer)
    if answer.result:
        for row in answer.result.rows[:5]:
            print(row)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main() -> None:
        async with AsyncMitra() as client:
            answer = await client.ask("What were last month's sales by region?")
            print(answer.status, answer.answer)


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const answer = await client.ask("What were last month's sales by region?");

    console.log(answer.status, answer.answer);
    console.log(answer.result?.rows.slice(0, 5));
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ question: "What were last month's sales by region?" }),
    });
    if (!res.ok) throw new Error(JSON.stringify(await res.json()));
    const answer = await res.json();
    console.log(answer.status, answer.answer);
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;
    import java.util.UUID;

    public class Ask {
        public static void main(String[] args) throws Exception {
            String body = "{\"question\": \"What were last month's sales by region?\"}";
            HttpRequest request = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/ask"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            HttpResponse<String> response =
                HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
            System.out.println(response.statusCode() + " " + response.body());
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

    	"github.com/google/uuid"
    )

    func main() {
    	body := strings.NewReader(`{"question": "What were last month's sales by region?"}`)
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/ask", body)
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", "application/json")
    	req.Header.Set("Idempotency-Key", uuid.NewString())

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
    using System.Net.Http.Headers;
    using System.Text;

    var http = new HttpClient { BaseAddress = new Uri("https://workspace.matih.ai/api/v1/") };
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    var request = new HttpRequestMessage(HttpMethod.Post, "ask")
    {
        Content = new StringContent(
            "{\"question\": \"What were last month's sales by region?\"}", Encoding.UTF8, "application/json"),
    };
    request.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());

    var response = await http.SendAsync(request);
    Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/ask");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Content-Type: application/json",
            "Idempotency-Key: " . bin2hex(random_bytes(16)),
        ],
        CURLOPT_POSTFIELDS => json_encode(["question" => "What were last month's sales by region?"]),
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    echo $status, " ", $body, "\n";
    ```

=== "Ruby"

    ```ruby
    require "json"
    require "net/http"
    require "securerandom"

    uri = URI("https://workspace.matih.ai/api/v1/ask")
    request = Net::HTTP::Post.new(uri)
    request["Authorization"] = "Bearer #{ENV.fetch('MATIH_API_KEY')}"
    request["Content-Type"] = "application/json"
    request["Idempotency-Key"] = SecureRandom.uuid
    request.body = { question: "What were last month's sales by region?" }.to_json

    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(request) }
    puts "#{response.code} #{response.body}"
    ```

The response is an **Answer**:

```json
{
  "status": "answered",
  "answer": "Revenue last month was 1.2 crore, up 8% on the month before.",
  "clarification": null,
  "result": {
    "columns": [{"name": "region", "type": "VARCHAR"}, {"name": "sales", "type": "DOUBLE"}],
    "rows": [["North", 4200000.0], ["South", 3100000.0]],
    "row_count": 2,
    "truncated": false
  },
  "sql": "SELECT region, SUM(amount) AS sales FROM orders WHERE ...",
  "image_url": "https://workspace.matih.ai/api/v1/media/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978.png",
  "follow_ups": ["Break that down by product"],
  "conversation_id": "5c1d0a4e8b7f4e3a9d2c6b1a0f9e8d7c",
  "request_id": "b7e1c2d3a4f5469788a9b0c1d2e3f405",
  "language": "en-IN"
}
```

`status` is always one of:

| `status` | What it means | What your bot does |
|---|---|---|
| `answered` | Matih ran the question. | Show `answer`, a few `result.rows` and `image_url`. |
| `clarification` | Matih needs to know which of a few meanings you intend. `clarification` has `question` and `options`. | Show the options; send the chosen one as the next `question` with the same `conversation_id`. |
| `empty` | The query ran and matched nothing. | Say so; suggest another range or filter. |
| `error` | Matih could not answer. `answer` says why in plain words. | Offer to rephrase; log `request_id`. |
| `cancelled` | The question was cancelled before it finished. | Nothing was delivered or charged; ask again if it was not on purpose. |

An HTTP `200` with `status: "error"` or `"cancelled"` is not an HTTP error, and neither is charged.

## 4. Ask a follow-up

Reuse `conversation_id` and Matih keeps the context.

=== "curl"

    ```bash
    curl -s "$BASE/ask" \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "Now split that by product", "conversation_id": "5c1d0a4e8b7f4e3a9d2c6b1a0f9e8d7c"}'
    ```

=== "Python"

    ```python
    follow_up = client.ask("Now split that by product", conversation_id=answer.conversation_id)
    print(follow_up.answer)
    ```

=== "TypeScript"

    ```ts
    const followUp = await client.ask({
      question: "Now split that by product",
      conversation_id: answer.conversation_id,
    });
    console.log(followUp.answer);
    ```

## 5. Download the chart

`image_url` is a short-lived signed URL (15 minutes) that needs no authorization header, so you
can hand it straight to Slack or put it in an `<img>`. See [Images](concepts/images.md).

```bash
curl -s -o chart.png "$(curl -s "$BASE/ask" \
  -H "Authorization: Bearer $MATIH_API_KEY" -H "Content-Type: application/json" \
  -d '{"question": "Revenue by month this year"}' | jq -r .image_url)"
```

## Where next

- Make a bot: [Slack](guides/slack-bot.md), [WhatsApp or Teams style](guides/chat-bot.md).
- Slow work and webhooks: [Sync and async](concepts/sync-async.md), [Webhooks](guides/webhooks.md).
- Every option of the clients: [Python SDK](sdk/python.md), [TypeScript SDK](sdk/typescript.md).
- Use Matih from an AI assistant: [MCP](mcp/index.md).
