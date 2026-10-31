# Upload a file

Upload a CSV, Parquet, JSON or Excel file and Matih reads it into tables you can ask questions of. This is how a chat bot lets a user "send me your sales sheet".

!!! info "You need"
    - Product: **Files**, with **Allow changes** switched on (scopes `files:read` and `files:write`).
    - A workspace role of `user` or above. A `viewer` can list and read files but not upload, answer a duplicate prompt or delete.

    Create the key under **Settings › API & MCP**. See [Credentials and products](../concepts/credentials.md).

Uploading is `multipart/form-data` with these fields:

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The file: CSV, Parquet, JSON or Excel (`.xlsx`). The type comes from the file name |
| `on_duplicate` | no | What to do when an identical file is already here: `ask` (the default) waits for your decision, `keep_both` keeps both |

The response is a File with an `id` and a `status` (`201`, `status: processing`). Reading happens in the background and takes seconds to minutes, so you then watch `GET /files/{id}` until `ready` is true, or send `Prefer: wait=N` (N up to 120) to have the call wait for you.

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
    print(f.id, f.status, f.ready)   # waits until the file is settled (up to 5 minutes)
    # client.files.upload("sales.csv", on_duplicate="keep_both")
    # client.files.upload("sales.csv", background=True)  # return right after the upload
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra

    async def main():
        async with AsyncMitra() as client:
            f = await client.files.upload("sales.csv")
            print(f.id, f.status, f.ready)

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
      // onDuplicate: "keep_both", // default "ask"; background: true returns right after the upload
    });
    console.log(file.id, file.status, file.ready); // waits until the file is settled (up to 5 minutes)
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

!!! note "Waiting for the file"
    A file is not a Job: the upload answers with the File itself. By default it answers `201` at once with `status: processing`. With `Prefer: wait=N` (or `?wait=N`, N up to 120) it waits until the file is `ready`, needs a decision or fails and answers `201` with the final status; if it is still being read after N seconds the answer is `202` with `status: processing`. `Preference-Applied: wait=N` says the wait was honoured. See [Sync and async](../concepts/sync-async.md). The SDKs do this for you: `files.upload` waits (default 5 minutes) unless you pass `background`.

    Limits: the workspace's file size limit applies (`413` `too_large`, refused before the body is read in full), an unsupported type is `415`, and a request that is not multipart, has no `file` part or has an empty file is `400`.

## 2. Wait until it is read

`GET /files/{id}` returns:

- `status`: `uploading`, `validating`, `processing`, `ready`, `needs_attention`, `failed`, `deleting` or `deleted`. Keep polling while it is one of the first three.
- `ready`: `true` once the file's tables can be asked about. `tables` then lists them (`model_name`, `label`, `rows`, `column_count`).
- `stage` and `analysis_state`: what Matih is doing now, in plain words, and how far its profiling of the data got.
- `warnings`, and on a failure `error_category`, `error_message` and `retryable`.
- `decision_required`: `"duplicate"` when Matih found an identical file and needs a choice, with the open choices in `decision_options`.

Poll every 3 to 5 seconds. Stop when `ready` is true, when `decision_required` is set, or when `status` is `needs_attention` or `failed`.

=== "curl"

    ```bash
    FILE_ID=...   # the "id" from step 1
    while :; do
      INFO=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" $BASE/files/$FILE_ID)
      [ "$(echo "$INFO" | jq -r '.ready or (.decision_required != null) or (.status | IN("needs_attention","failed"))')" = true ] && break
      sleep 3
    done
    echo "$INFO" | jq .
    ```

=== "Python"

    ```python
    import time

    info = f
    while not info.is_settled:           # ready, failed, needs_attention or waiting for a decision
        time.sleep(3)
        info = client.files.get(f.id)
    print(info.status, info.ready, info.decision_required)
    ```

=== "TypeScript"

    ```ts
    let info = await mitra.files.get(file.id);
    while (!info.ready && !info.decision_required && !["needs_attention", "failed"].includes(info.status)) {
      await new Promise((r) => setTimeout(r, 3000));
      info = await mitra.files.get(file.id);
    }
    console.log(info);
    ```

(`files.upload` already waits for you, so these loops matter when you upload with `background` or the upload timed out.)

## 3. Answer a duplicate prompt

When `decision_required` is `"duplicate"`, the new file is identical to one already in the workspace (`duplicate_of` is that file's id). Show the person what was found and ask what to do. Do not choose for them. The `decision` values are `use_existing` (drop this upload and use the earlier file), `keep_both` and `cancel` (drop this upload); the file's `decision_options` lists the ones open. A file that is not waiting for a decision answers `409`.

=== "curl"

    ```bash
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -d '{"decision": "use_existing"}' $BASE/files/$FILE_ID/duplicate
    ```

=== "Python"

    ```python
    client.files.duplicate(f.id, "use_existing")   # the person's choice
    ```

=== "TypeScript"

    ```ts
    await mitra.files.duplicate(file.id, "use_existing"); // the person's choice
    ```

## 4. Use it

Once `ready` is true its tables can be asked about: they belong to the workspace's uploaded-files source in `GET /sources`, whose id you can pass as `source_id` to `POST /ask`. For a bot, a good flow is: acknowledge the upload ("Reading your file..."), poll in the background, then post two or three suggested questions.

## List and delete

| Operation | Request | Scope |
|---|---|---|
| List | `GET /files` | `files:read` |
| One file | `GET /files/{id}` | `files:read` |
| Delete | `DELETE /files/{id}` | `files:write` |

!!! warning "Delete removes the data"
    Deleting a file removes it and its tables, and Gems, dashboards and answers built on those tables are affected. It is not instant: the file comes back as `deleting` and leaves the list when done. Confirm first.

## Errors you will meet

| Status | Category | Meaning |
|---|---|---|
| 403 | `scope` | **Files** is off for the key, or **Allow changes** is off. |
| 403 | `workspace_role` | The member is a `viewer`; uploading needs `user` or above. |
| 400 | `invalid` | Not multipart, no `file` part, an empty file, or an `on_duplicate` that is not `ask` or `keep_both`. |
| 413 | `too_large` | Over the workspace's file size limit. Nothing was kept. |
| 415 | | Not a supported file type. |
| 409 | | `files.duplicate` on a file that is not waiting for a decision. |

See [Errors](../concepts/errors.md) and, for databases, [Connect a data source](connect-source.md).
