# Upload a file

Upload a CSV or Excel file and Matih turns it into a data source you can ask questions of. This is how a chat bot lets a user "send me your sales sheet".

!!! info "You need"
    - Product: **Files**, with **Allow changes** switched on (scopes `files:read` and `files:write`).
    - Any workspace member role that may add data in your workspace.

    Create the key under **Settings › API & MCP**. See [Credentials and products](../concepts/credentials.md).

Uploading is `multipart/form-data` with these fields:

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The CSV or Excel file |
| `on_duplicate` | no | What to do when a similar file already exists. Take the allowed values from `/api/v1/openapi.json`; do not guess them |

The response is a File with an `id` and a `status`. Processing happens in the background, so you then poll `GET /files/{id}` until the file is read.

```bash
export MATIH_API_KEY=mtk_...
export BASE=https://workspace.matih.ai/api/v1
```

## 1. Upload

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" \
      -F file=@sales.csv \
      $BASE/files
    # {"id": "file_...", "status": "processing", ...}
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    f = client.files.upload("sales.csv")           # path, bytes or a file object
    print(f.id, f.status)
    # client.files.upload("sales.csv", on_duplicate="replace")  # value from the OpenAPI spec
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            f = await client.files.upload("sales.csv")
            print(f.id, f.status)

    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { readFile } from "node:fs/promises";
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const file = await mitra.files.upload(await readFile("sales.csv"), {
      filename: "sales.csv",
      contentType: "text/csv",
      // onDuplicate: "replace", // value from the OpenAPI spec
    });
    console.log(file.id, file.status);
    ```

=== "JavaScript (fetch)"

    ```js
    import { readFile } from "node:fs/promises";

    const form = new FormData();
    form.append("file", new Blob([await readFile("sales.csv")], { type: "text/csv" }), "sales.csv");

    const res = await fetch("https://workspace.matih.ai/api/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MATIH_API_KEY}` }, // fetch sets the multipart boundary
      body: form,
    });
    if (!res.ok) throw new Error(JSON.stringify((await res.json()).detail));
    console.log(await res.json());
    ```

=== "Java"

    ```java
    import java.io.ByteArrayOutputStream;
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;
    import java.nio.charset.StandardCharsets;
    import java.nio.file.Files;
    import java.nio.file.Path;
    import java.util.UUID;

    public class UploadFile {
        public static void main(String[] args) throws Exception {
            String boundary = "----matih" + UUID.randomUUID();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            out.write(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"sales.csv\"\r\n"
                + "Content-Type: text/csv\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(Files.readAllBytes(Path.of("sales.csv")));
            out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/files"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.statusCode() + " " + res.body());
        }
    }
    ```

=== "Go"

    ```go
    package main

    import (
    	"bytes"
    	"fmt"
    	"io"
    	"mime/multipart"
    	"net/http"
    	"os"
    )

    func main() {
    	var buf bytes.Buffer
    	w := multipart.NewWriter(&buf)
    	part, _ := w.CreateFormFile("file", "sales.csv")
    	f, err := os.Open("sales.csv")
    	if err != nil {
    		panic(err)
    	}
    	defer f.Close()
    	io.Copy(part, f)
    	w.Close()

    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/files", &buf)
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", w.FormDataContentType())
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
    using System.IO;
    using System.Net.Http;
    using System.Net.Http.Headers;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    using var form = new MultipartFormDataContent();
    var file = new StreamContent(File.OpenRead("sales.csv"));
    file.Headers.ContentType = new MediaTypeHeaderValue("text/csv");
    form.Add(file, "file", "sales.csv");

    var res = await http.PostAsync("https://workspace.matih.ai/api/v1/files", form);
    Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/files");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ["file" => new CURLFile("sales.csv", "text/csv", "sales.csv")],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer " . getenv("MATIH_API_KEY")],
    ]);
    $out = curl_exec($ch);
    echo curl_getinfo($ch, CURLINFO_RESPONSE_CODE), " ", $out, "\n";
    ```

=== "Ruby"

    ```ruby
    require "net/http"

    uri = URI("https://workspace.matih.ai/api/v1/files")
    req = Net::HTTP::Post.new(uri, "Authorization" => "Bearer #{ENV.fetch('MATIH_API_KEY')}")
    File.open("sales.csv", "rb") do |f|
      req.set_form([["file", f, { filename: "sales.csv", content_type: "text/csv" }]], "multipart/form-data")
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
      puts "#{res.code} #{res.body}"
    end
    ```

!!! note "Long operations"
    File upload is a long operation. The server may answer `202` with a Job rather than the File; in that case wait for it ([Jobs](../concepts/jobs.md)) or send `Prefer: wait=30` to get the result inline when it finishes in time ([Sync and async](../concepts/sync-async.md)). Whichever you get, `GET /files/{id}` below is how you watch the file itself.

## 2. Wait until it is read

`GET /files/{id}` returns:

- `status`: the processing state; keep polling while it is `processing`.
- the analysis state: whether Matih has finished profiling the data.
- `decision_required`: `true` when Matih found a likely duplicate and needs a choice.

Poll every 3 to 5 seconds.

=== "curl"

    ```bash
    FILE_ID=file_...
    until [ "$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/files/$FILE_ID | jq -r .status)" != "processing" ]; do
      sleep 3
    done
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/files/$FILE_ID | jq .
    ```

=== "Python"

    ```python
    import time

    while True:
        info = client.files.get(f.id).model_dump()   # unknown fields are kept
        if info.get("decision_required"):
            break                                    # see step 3
        if info.get("status") != "processing":
            break
        time.sleep(3)
    print(info)
    ```

=== "TypeScript"

    ```ts
    let info = await mitra.files.get(file.id);
    while (info.status === "processing" && !info.decision_required) {
      await new Promise((r) => setTimeout(r, 3000));
      info = await mitra.files.get(file.id);
    }
    console.log(info);
    ```

## 3. Answer a duplicate prompt

When `decision_required` is `true`, show the person what was found and ask what to do. Do not choose for them. The valid `decision` values are in the OpenAPI spec and in the file's `decision_required` details.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"decision": "DECISION"}' $BASE/files/$FILE_ID/duplicate
    ```

=== "Python"

    ```python
    client.files.duplicate(f.id, "DECISION")   # the person's choice
    ```

=== "TypeScript"

    ```ts
    await mitra.files.duplicate(file.id, "DECISION"); // the person's choice
    ```

## 4. Use it

Once the file is read it appears in `GET /sources`, and you can pass its source id as `source_id` to `POST /ask`. For a bot, a good flow is: acknowledge the upload ("Reading your file..."), poll in the background, then post two or three suggested questions.

## List and delete

| Operation | Request | Scope |
|---|---|---|
| List | `GET /files` | `files:read` |
| One file | `GET /files/{id}` | `files:read` |
| Delete | `DELETE /files/{id}` | `files:write` |

!!! warning "Delete removes the data"
    Deleting a file removes its data from Matih. Confirm first.

## Errors you will meet

| Status | Category | Meaning |
|---|---|---|
| 403 | `scope` | **Files** is off for the key, or **Allow changes** is off. |
| 402 | `credits` | The workspace is out of credits. Do not retry. |
| 4xx | validation | Unsupported file type or an invalid `on_duplicate`. |

See [Errors](../concepts/errors.md) and, for databases, [Connect a data source](connect-source.md).
