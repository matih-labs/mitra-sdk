# Voice questions

People on WhatsApp, Telegram or a phone app often send a voice note instead of typing. `POST /api/v1/ask/audio` takes the recording, understands the speech, asks the question and returns an ordinary Ask response in the language that was spoken, plus what Matih heard so you can show it back.

!!! info "You need"
    - Product: **Ask** (scope `ask`).
    - Credits are the Ask's own. Listening and translating are not metered separately.

## The request

`multipart/form-data`:

| Field | Required | |
|---|---|---|
| `file` | yes | The recording. Any audio type: `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`, `audio/mpeg`. 5 MB at most. |
| `conversation_id` | no | Continue a conversation. |
| `source_id` | no | The data source to ask. |
| `language` | no | The language spoken, for example `hi-IN`. Otherwise it is detected. |

Send an `Idempotency-Key` so a retry is never charged twice (the SDKs do this for you).

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/ask/audio \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Idempotency-Key: $(uuidgen)" \
      -F file=@question.ogg \
      -F source_id=SOURCE_ID \
      -F language=hi-IN
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY

    answer = client.ask_audio("question.ogg", language="hi-IN")
    print("heard:", answer.heard.transcript, answer.heard.language)
    print(answer.answer)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main():
        async with AsyncMitra() as client:
            answer = await client.ask_audio("question.ogg", language="hi-IN")
            print("heard:", answer.heard.transcript if answer.heard else None)
            print(answer.answer)


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { readFile } from "node:fs/promises";
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });

    const audio = await readFile("question.ogg");
    const answer = await mitra.askAudio(audio, {
      filename: "question.ogg",
      contentType: "audio/ogg",
      language: "hi-IN",
    });
    console.log("heard:", answer.heard?.transcript);
    console.log(answer.answer);
    ```

=== "JavaScript (fetch)"

    ```js
    import { readFile } from "node:fs/promises";

    const form = new FormData();
    form.append("file", new Blob([await readFile("question.ogg")], { type: "audio/ogg" }), "question.ogg");
    form.append("language", "hi-IN");

    const res = await fetch("https://workspace.matih.ai/api/v1/ask/audio", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: form, // fetch sets the multipart boundary itself
    });
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

    public class AskAudio {
        public static void main(String[] args) throws Exception {
            String boundary = "----matih" + UUID.randomUUID();
            byte[] audio = Files.readAllBytes(Path.of("question.ogg"));

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            out.write(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"language\"\r\n\r\nhi-IN\r\n"
                + "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"question.ogg\"\r\n"
                + "Content-Type: audio/ogg\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(audio);
            out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/ask/audio"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient()
                .send(req, HttpResponse.BodyHandlers.ofString());
            System.out.println(res.body());
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
    	_ = w.WriteField("language", "hi-IN")
    	part, _ := w.CreateFormFile("file", "question.ogg")
    	audio, err := os.ReadFile("question.ogg")
    	if err != nil {
    		panic(err)
    	}
    	part.Write(audio)
    	w.Close()

    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/ask/audio", &buf)
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", w.FormDataContentType())
    	res, err := http.DefaultClient.Do(req)
    	if err != nil {
    		panic(err)
    	}
    	defer res.Body.Close()
    	out, _ := io.ReadAll(res.Body)
    	fmt.Println(string(out))
    }
    ```

=== "C#"

    ```csharp
    using System;
    using System.IO;
    using System.Net.Http;
    using System.Net.Http.Headers;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("MATIH_API_KEY"));
    http.DefaultRequestHeaders.Add("Idempotency-Key", Guid.NewGuid().ToString());

    using var form = new MultipartFormDataContent();
    var file = new ByteArrayContent(await File.ReadAllBytesAsync("question.ogg"));
    file.Headers.ContentType = new MediaTypeHeaderValue("audio/ogg");
    form.Add(file, "file", "question.ogg");
    form.Add(new StringContent("hi-IN"), "language");

    var res = await http.PostAsync("https://workspace.matih.ai/api/v1/ask/audio", form);
    Console.WriteLine(await res.Content.ReadAsStringAsync());
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init("https://workspace.matih.ai/api/v1/ask/audio");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer " . getenv("MATIH_API_KEY"),
            "Idempotency-Key: " . bin2hex(random_bytes(16)),
        ],
        CURLOPT_POSTFIELDS => [
            "file" => new CURLFile("question.ogg", "audio/ogg", "question.ogg"),
            "language" => "hi-IN",
        ],
    ]);
    echo curl_exec($ch);
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "securerandom"

    uri = URI("https://workspace.matih.ai/api/v1/ask/audio")
    req = Net::HTTP::Post.new(uri, {
      "Authorization" => "Bearer #{ENV['MATIH_API_KEY']}",
      "Idempotency-Key" => SecureRandom.uuid
    })
    req.set_form(
      [["file", File.open("question.ogg", "rb"), { filename: "question.ogg", content_type: "audio/ogg" }],
       ["language", "hi-IN"]],
      "multipart/form-data"
    )
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
    puts res.body
    ```

## The response

An Ask response in the language spoken, plus `heard`:

```json
{
  "status": "answered",
  "answer": "पिछले महीने की बिक्री ₹4.2 lakh रही।",
  "language": "hi-IN",
  "conversation_id": "c_123",
  "heard": {"transcript": "पिछले महीने कितने सेल्स हुए?", "language": "hi-IN"}
}
```

Echo `heard.transcript` back to the person (for example "I heard: ...") so they can see a misheard number before they trust the answer. Everything else about the response (`status`, `result`, `follow_ups`, `clarification`, `image_url`) is as for [`/ask`](../concepts/sync-async.md); translation rules are in [Multilingual bots](multilingual.md).

!!! note "Privacy"
    The audio is sent to the speech service to be understood and is never stored.

## Errors

| Status | Code | Meaning | What to do |
|---|---|---|---|
| 415 | `unsupported_audio_type` | Not an audio content type | Convert (see below) |
| 413 | `audio_too_large` | Over 5 MB | Ask the user for a shorter note, or re-encode at a lower bitrate |
| 422 | `not_heard` | Empty file, or no speech in it | Ask the user to try again; do not retry unchanged |
| 503 | `speech_unavailable` | Speech service busy | Retry after a few seconds, with the same `Idempotency-Key` |
| 503 | `language_unavailable` | This deployment has no language service configured | Fall back to text |

Plus the usual [errors](../concepts/errors.md): 401, 402 (credits), 403 `scope`, 429.

## A voice note flow for a chat bot

A typical WhatsApp or Telegram bot does this when a message arrives:

1. If the message has an audio attachment, download it from the chat platform (those links are short-lived and need the platform's token).
2. If it is larger than 5 MB or in an odd container, transcode it (below).
3. Call `/ask/audio`, passing the user's stored language as `language` if you have one.
4. Reply with `heard.transcript` first, then `answer`. If `status` is `clarification`, send the `options` as buttons and answer the tap with a normal text `/ask` in the same `conversation_id`.
5. On `not_heard`, reply with "I could not hear that, could you try again?".

```python
from pathlib import Path

from mitra import CreditsError, Mitra, MitraError

client = Mitra()


def handle_voice_note(path: Path, user_language: str | None, conversation_id: str | None):
    try:
        answer = client.ask_audio(
            path, language=user_language, conversation_id=conversation_id
        )
    except CreditsError:
        return "This workspace is out of credits. Ask an admin to top up."
    except MitraError as err:
        if err.code == "not_heard":
            return "I could not hear that, could you try again?"
        raise
    heard = f"I heard: {answer.heard.transcript}\n\n" if answer.heard else ""
    return heard + (answer.answer or "")
```

## Transcoding with ffmpeg

Most recordings need no conversion. If you have a format the service rejects, or a note over 5 MB, `ffmpeg` gets you a small, compatible file. Mono Opus in an Ogg container is a good default for speech:

```bash
ffmpeg -i input.m4a -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k question.ogg
```

or 16 kHz mono WAV:

```bash
ffmpeg -i input.amr -vn -ac 1 -ar 16000 question.wav
```

## Related

- [Multilingual bots](multilingual.md)
- [Build a WhatsApp or Teams style bot](chat-bot.md)
- [Python SDK](../sdk/python.md), [TypeScript SDK](../sdk/typescript.md)
