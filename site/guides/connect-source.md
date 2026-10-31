# Connect a data source

A source is a database, warehouse or uploaded file that questions run against. This guide connects a database from code: look up the connector, test the connection, create the source, and wait until Matih has read it so [Ask](../quickstart.md) can use it.

!!! tip "Connect credentials in the app when you can"
    The API accepts credentials, stores them in the same credential vault the app uses and never returns, logs or echoes them. Still, where you can, connect a source with its credentials in the Matih app (**Data sources**) and use the API to read, activate or remove it.

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

`GET /connectors` lists the connector types and the fields each needs. Each connector has a `type` and a list of `fields`. A source `config` is `connector_type` set to that `type`, plus those fields (and an optional `display_name`); use the exact names it returns, because the Postgres config below is only an illustration.

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

`POST /sources/test` checks the config without saving anything. Repeat until it passes. A failed test is a normal `200` answer with `ok: false`, the reason in `message`, an `error_category` and, when one field is to blame, `field`; it is not an error.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"config": {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}}' \
      $BASE/sources/test
    ```

=== "Python"

    ```python
    config = {
        "connector_type": "postgres", "display_name": "Orders DB",
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
      connector_type: "postgres",
      display_name: "Orders DB",
      host: "db.example.com",
      port: 5432,
      database: "sales",
      user: "reader",
      password: process.env.DB_PASSWORD,
    };
    console.log(await mitra.sources.test(config));
    ```

## 3. Create the source

`POST /sources` tests the connection again and saves the source. `activate` defaults to `true`; send `false` to create it without making it active and call `POST /sources/{id}/activate` later. The answer is `201` and `SourceCreated`: `{source, test, applied, catalog_job_id}`, where `source.readiness` says whether Ask can use the source yet.

If the connection test fails you get `422`, category `connection`, with the test result in `detail.test`, and **nothing is created**. The SDKs raise `SourceTestFailedError` with the result in `.test_result` (Python) or `.testResult` (TypeScript).

=== "curl"

    ```bash
    curl -s -i -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"config": {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com", "port": 5432, "database": "sales", "user": "reader", "password": "REDACTED"}, "activate": true}' \
      $BASE/sources
    ```

=== "Python"

    ```python
    from mitra import Mitra, SourceTestFailedError

    client = Mitra()
    try:
        created = client.sources.create(config, activate=True)   # waits until Ask can use it
    except SourceTestFailedError as e:
        print("connection test failed:", e.test_result)
        raise
    print(created.source.id, created.source.readiness.can_ask)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra, SourceTestFailedError

    async def main():
        async with AsyncMitra() as client:
            try:
                created = await client.sources.create(config, activate=True)
            except SourceTestFailedError as e:
                print("connection test failed:", e.test_result)
                raise
            print(created.source.id, created.source.readiness.can_ask)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra, SourceTestFailedError } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    try {
      const created = await mitra.sources.create({ config, activate: true }); // waits until Ask can use it
      console.log(created.source?.id, created.source?.readiness?.can_ask);
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
                {"config": {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com", "port": 5432,
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
    	body := `{"config": {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com", "port": 5432,
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
        {"config": {"connector_type": "postgres", "display_name": "Orders DB", "host": "db.example.com", "port": 5432,
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
            "connector_type" => "postgres", "display_name" => "Orders DB", "host" => "db.example.com", "port" => 5432,
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
      config: { connector_type: "postgres", display_name: "Orders DB", host: "db.example.com", port: 5432,
                database: "sales", user: "reader", password: "REDACTED" },
      activate: true
    }.to_json
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
    # 201 created; 422 carries the connection test result and nothing was created
    puts "#{res.code} #{res.body}"
    ```

!!! note "Long reads"
    Matih reads a new source's tables in the background, which takes a minute or so (longer for a large database). Source creation is not a Job: by default the call answers `201` as soon as the source is saved, with `source.readiness.phase` set to `building` and `can_ask` false. Send `Prefer: wait=N` (or `?wait=N`, N up to 120) to have the call wait until Ask can use the source; it then answers `201` with `phase: ready`. If it is not ready within N seconds the answer is the same `201` with `phase: building`, and you poll `GET /sources/{id}`. `Preference-Applied: wait=N` says the wait was honoured. See [Sync and async](../concepts/sync-async.md). The SDKs do this for you: `sources.create` waits (default 5 minutes) unless you pass `background`.

## 4. Wait until the source is ready

A new source is not useful until Matih has finished reading it. `GET /sources/{id}` returns the source with its `readiness`; check it every few seconds before the first question rather than asking a half-read source and getting weak answers.

| `readiness` field | Meaning |
|---|---|
| `can_ask` | `true` when Ask can use the source now. This is the one to watch |
| `phase` | `building` (connected, tables being read for the first time), `ready`, or `not_connected` (the connection itself needs attention) |
| `state` | `connected`, `failed`, `not_configured`, `credentials_missing` or `project_initialization_required` |
| `message` | One plain sentence on where the source is |
| `catalog` | How far the tables got (`tables`, `included_tables`, `reading_now`). `null` when Business Definitions are off |

=== "curl"

    ```bash
    SOURCE_ID=...   # source.id from step 3
    until [ "$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/sources/$SOURCE_ID | jq -r .readiness.can_ask)" = true ]; do
      sleep 5
    done
    ```

=== "Python"

    ```python
    import time

    source_id = created.source.id
    for _ in range(60):
        source = client.sources.get(source_id)
        if source.readiness.can_ask:
            break
        print(source.readiness.message)
        time.sleep(5)
    ```

=== "TypeScript"

    ```ts
    const sourceId = created.source!.id;
    for (let i = 0; i < 60; i++) {
      const source = await mitra.sources.get(sourceId);
      if (source.readiness?.can_ask) break;
      console.log(source.readiness?.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
    ```

(`sources.create` already waits for you, so this loop matters when you create with `background` or the wait ran out.) Over MCP the same check is the `source_status` tool.

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
| 422 | `connection` | The connection test failed. Nothing was saved. Read `detail.test` (`message`, `error_category`, `field`); do not retry unchanged. |

See [Errors](../concepts/errors.md). To bring in a spreadsheet instead of a database, see [Upload a file](upload-file.md).
