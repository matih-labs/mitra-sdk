# Connect a data source

A source is a database, warehouse or uploaded file that questions run against. This guide connects a database from code: look up the connector, test the connection, create the source, and wait until Matih has read it so [Ask](../quickstart.md) can use it.

!!! info "You need"
    - Product: **Data sources**, with **Allow changes** switched on (scopes `sources:read` and `sources:write`).
    - A workspace **admin** as the member the key acts as. Scopes only narrow a key; the workspace role is checked first.
    - Database credentials you are allowed to use. Create a read-only database user for Matih.

    Create the key under **Settings › API & MCP**. See [Credentials and products](../concepts/credentials.md) and [Scopes](../concepts/scopes.md).

!!! warning "Never log the config"
    A connection config holds a password or connection string. Do not print it, do not put it in an error report and do not commit it. Read it from a secret store or environment variable.

The examples assume:

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## 1. Find the connector and its fields

`GET /connectors` lists the connector types and the fields each needs. Use the exact `type` and field names it returns; the Postgres config below is only an illustration.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/connectors
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    print(client.sources.connectors())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    console.log(await mitra.connectors.list());
    ```

## 2. Test the connection

`POST /sources/test` checks the config without saving anything. Repeat until it passes.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"config": {"type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}}' \
      $BASE/sources/test
    ```

=== "Python"

    ```python
    config = {
        "type": "postgres",
        "host": "db.example.com",
        "port": 5432,
        "database": "sales",
        "user": "reader",
        "password": "REDACTED",
    }
    print(client.sources.test(config))
    ```

=== "TypeScript"

    ```ts
    const config = {
      type: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "sales",
      user: "reader",
      password: process.env.DB_PASSWORD,
    };
    console.log(await mitra.sources.test(config));
    ```

## 3. Create the source

`POST /sources` tests the connection again and saves the source. `activate` defaults to `true`; send `false` to create it without making it active and call `POST /sources/{id}/activate` later.

If the connection test fails you get `422` with the test result and **nothing is created**. The SDKs raise `SourceTestFailedError` with the result in `.test_result` (Python) or `.testResult` (TypeScript).

=== "curl"

    ```bash
    curl -s -i -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"config": {"type": "postgres", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}, "activate": true}' \
      $BASE/sources
    ```

=== "Python"

    ```python
    from mitra import Mitra, SourceTestFailedError

    client = Mitra()
    try:
        source = client.sources.create(config, activate=True)
    except SourceTestFailedError as e:
        print("connection test failed:", e.test_result)
        raise
    print(source)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra, SourceTestFailedError

    async def main():
        async with AsyncMitra() as client:
            try:
                source = await client.sources.create(config, activate=True)
            except SourceTestFailedError as e:
                print("connection test failed:", e.test_result)
                raise
            print(source)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra, SourceTestFailedError } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    try {
      const source = await mitra.sources.create({ config, activate: true });
      console.log(source);
    } catch (err) {
      if (err instanceof SourceTestFailedError) console.error(err.testResult);
      else throw err;
    }
    ```

=== "JavaScript (fetch)"

    ```js
    const BASE = "https://workspace.matih.ai/api/v1";
    const res = await fetch(`${BASE}/sources`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ config, activate: true }),
    });
    const body = await res.json();
    if (res.status === 422) console.error("connection test failed", body);
    else if (!res.ok) throw new Error(JSON.stringify(body.detail));
    else console.log(body);
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;

    public class ConnectSource {
        public static void main(String[] args) throws Exception {
            String body = """
                {"config": {"type": "postgres", "host": "db.example.com", "port": 5432,
                            "database": "sales", "user": "reader", "password": "REDACTED"},
                 "activate": true}""";
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/sources"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
            // 201 created; 422 carries the connection test result and nothing was created
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
    	"strings"
    )

    func main() {
    	body := `{"config": {"type": "postgres", "host": "db.example.com", "port": 5432,
    	  "database": "sales", "user": "reader", "password": "REDACTED"}, "activate": true}`
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/sources", strings.NewReader(body))
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", "application/json")
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	// 201 created; 422 carries the connection test result and nothing was created
    	fmt.Println(res.StatusCode, string(out))
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.Net.Http;
    using System.Text;

    var http = new HttpClient { BaseAddress = new Uri("https://workspace.matih.ai/api/v1/") };
    http.DefaultRequestHeaders.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    var body = """
        {"config": {"type": "postgres", "host": "db.example.com", "port": 5432,
                    "database": "sales", "user": "reader", "password": "REDACTED"},
         "activate": true}
        """;
    var res = await http.PostAsync("sources", new StringContent(body, Encoding.UTF8, "application/json"));
    // 201 created; 422 carries the connection test result and nothing was created
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    ```

=== "PHP"

    ```php
    <?php
    $body = json_encode([
        "config" => [
            "type" => "postgres", "host" => "db.example.com", "port" => 5432,
            "database" => "sales", "user" => "reader", "password" => "REDACTED",
        ],
        "activate" => true,
    ]);
    $ch = curl_init("https://workspace.matih.ai/api/v1/sources");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Content-Type: application/json",
        ],
    ]);
    $out = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    // 201 created; 422 carries the connection test result and nothing was created
    echo $status, " ", $out, "\n";
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"

    uri = URI("https://workspace.matih.ai/api/v1/sources")
    req = Net::HTTP::Post.new(uri, "Content-Type" => "application/json",
                                   "Authorization" => "Bearer #{ENV.fetch('MATIH_API_KEY')}")
    req.body = {
      config: { type: "postgres", host: "db.example.com", port: 5432,
                database: "sales", user: "reader", password: "REDACTED" },
      activate: true
    }.to_json
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
    # 201 created; 422 carries the connection test result and nothing was created
    puts "#{res.code} #{res.body}"
    ```

!!! note "Long reads"
    Reading a large database can take a while. Source creation is a long operation, so the server may answer `202` with a Job instead of `201` with the source. If you receive a Job, wait for it as described in [Jobs](../concepts/jobs.md), or send `Prefer: wait=30` to have the server answer inline when it finishes in time (see [Sync and async](../concepts/sync-async.md)). `/api/v1/openapi.json` is the authority on the exact response of your deployment.

## 4. Wait until the source is ready

A new source is not useful until Matih has finished reading it. `GET /sources/{id}` reports readiness; check it every few seconds before the first question rather than asking a half-read source and getting weak answers.

=== "curl"

    ```bash
    SOURCE_ID=src_...
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/sources/$SOURCE_ID | jq .
    ```

=== "Python"

    ```python
    import time

    source_id = "src_..."
    for _ in range(60):
        detail = client.sources.get(source_id)
        print(detail)          # includes readiness
        # Stop when the readiness fields in your response say it is ready.
        time.sleep(5)
    ```

=== "TypeScript"

    ```ts
    const sourceId = "src_...";
    for (let i = 0; i < 60; i++) {
      const detail = await mitra.sources.get(sourceId);
      console.log(detail); // includes readiness
      await new Promise((r) => setTimeout(r, 5000));
    }
    ```

The readiness field names are listed in `/api/v1/openapi.json` under the source detail schema. Over MCP the same check is the `source_status` tool.

## 5. Ask

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"question": "How many orders yesterday?", "source_id": "src_..."}' $BASE/ask
```

## Other source operations

| Operation | Request | Scope |
|---|---|---|
| List | `GET /sources` | `sources:read` |
| Activate | `POST /sources/{id}/activate` | `sources:write` |
| Delete | `DELETE /sources/{id}` | `sources:write` |

!!! warning "Delete is destructive"
    Deleting a source can break the Gems, conversations and dashboards that depended on it. Confirm with a person first.

## Errors you will meet

| Status | Category | Meaning |
|---|---|---|
| 403 | `scope` | The key's **Data sources** product is off, or **Allow changes** is off. |
| 403 | `workspace_role` | The member the key acts as is not an admin. |
| 422 | (validation) | The connection test failed, or a field is invalid. Read the test result; do not retry unchanged. |

See [Errors](../concepts/errors.md). To bring in a spreadsheet instead of a database, see [Upload a file](upload-file.md).
