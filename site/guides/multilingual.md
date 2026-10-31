# Multilingual bots

Matih understands questions in English and the 22 scheduled Indian languages, and answers in the language the person used. Translation happens at the API edge, so you do not have to run your own translation layer: pass the person's language (or nothing at all) and show `answer` as it comes back.

!!! info "You need"
    - Product: **Ask** (scope `ask`). Translation and language identification are not metered separately; you pay the credits of the Ask itself.
    - The deployment must have its language service configured. If it does not, text passes through unchanged and every response says `"language": "en-IN"`.

## Supported languages

Send the short or the full tag: `hi`, `hi-IN` and `hi_in` all work.

| Tag | Language | | Tag | Language |
|---|---|---|---|---|
| `en-IN` | English | | `mai-IN` | Maithili |
| `hi-IN` | Hindi | | `mni-IN` | Manipuri |
| `bn-IN` | Bengali | | `ne-IN` | Nepali |
| `gu-IN` | Gujarati | | `sa-IN` | Sanskrit |
| `kn-IN` | Kannada | | `sat-IN` | Santali |
| `ml-IN` | Malayalam | | `sd-IN` | Sindhi |
| `mr-IN` | Marathi | | `ur-IN` | Urdu |
| `od-IN` | Odia (`or` also accepted) | | `as-IN` | Assamese |
| `pa-IN` | Punjabi | | `brx-IN` | Bodo |
| `ta-IN` | Tamil | | `doi-IN` | Dogri |
| `te-IN` | Telugu | | `kok-IN`, `ks-IN` | Konkani, Kashmiri |

The first eleven (through Telugu) are translated in a natural, code-mixed style: business words and the names in your data stay as they are, and a question typed in Latin letters (Hinglish) is answered in Latin letters. The others are translated formally.

## Choosing the language

You have three ways to say which language the answer should be in. In order of precedence:

1. **Body `language`** on `POST /ask` (and the other calls that take it). The body wins.
2. **`Accept-Language` header.** The first language Matih supports wins, best `q` first. `fr-FR, ta;q=0.8, en;q=0.5` is Tamil; `en-US, hi;q=0.5` is English. An unsupported tag is ignored.
3. **Nothing.** Matih identifies the language of the question. Short text in Latin letters (fewer than three words) is taken as English, because "hi" alone reads as Hindi.

English goes to Ask as it is. Anything else is translated to English first. If that translation fails or takes more than 10 seconds, the question is asked as written and the answer comes back in English.

!!! tip "For a chat bot"
    Store one language per user (from their first message, or from the chat platform's locale) and send it as `language` on every call. That is more reliable than detecting short messages such as "ok" or "sales?".

## Ask in Hindi

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/ask \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"question": "पिछले महीने कितनी बिक्री हुई?", "language": "hi"}'
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY

    answer = client.ask("पिछले महीने कितनी बिक्री हुई?", language="hi")
    print(answer.language)  # hi-IN
    print(answer.answer)
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main():
        async with AsyncMitra() as client:
            answer = await client.ask("पिछले महीने कितनी बिक्री हुई?", language="hi")
            print(answer.language, answer.answer)


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });

    const answer = await mitra.ask(
      { question: "पिछले महीने कितनी बिक्री हुई?", language: "hi" },
    );
    console.log(answer.language, answer.answer);
    ```

=== "JavaScript (fetch)"

    ```js
    const res = await fetch("https://workspace.matih.ai/api/v1/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "पिछले महीने कितनी बिक्री हुई?", language: "hi" }),
    });
    const answer = await res.json();
    console.log(answer.language, answer.answer);
    ```

=== "Java"

    ```java
    import java.net.URI;
    import java.net.http.HttpClient;
    import java.net.http.HttpRequest;
    import java.net.http.HttpResponse;
    import java.nio.charset.StandardCharsets;

    public class AskHindi {
        public static void main(String[] args) throws Exception {
            String body = "{\"question\": \"पिछले महीने कितनी बिक्री हुई?\", \"language\": \"hi\"}";
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://workspace.matih.ai/api/v1/ask"))
                .header("Authorization", "Bearer " + System.getenv("MATIH_API_KEY"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
            HttpResponse<String> res = HttpClient.newHttpClient()
                .send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            System.out.println(res.body());
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
    	body := `{"question": "पिछले महीने कितनी बिक्री हुई?", "language": "hi"}`
    	req, _ := http.NewRequest("POST", "https://workspace.matih.ai/api/v1/ask", strings.NewReader(body))
    	req.Header.Set("Authorization", "Bearer "+os.Getenv("MATIH_API_KEY"))
    	req.Header.Set("Content-Type", "application/json")
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
    using System.Net.Http;
    using System.Net.Http.Headers;
    using System.Text;

    var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("MATIH_API_KEY"));

    var body = "{\"question\": \"पिछले महीने कितनी बिक्री हुई?\", \"language\": \"hi\"}";
    var res = await http.PostAsync(
        "https://workspace.matih.ai/api/v1/ask",
        new StringContent(body, Encoding.UTF8, "application/json"));
    Console.WriteLine(await res.Content.ReadAsStringAsync());
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
        ],
        CURLOPT_POSTFIELDS => json_encode(
            ["question" => "पिछले महीने कितनी बिक्री हुई?", "language" => "hi"],
            JSON_UNESCAPED_UNICODE
        ),
    ]);
    echo curl_exec($ch);
    ```

=== "Ruby"

    ```ruby
    require "net/http"
    require "json"

    uri = URI("https://workspace.matih.ai/api/v1/ask")
    req = Net::HTTP::Post.new(uri, {
      "Authorization" => "Bearer #{ENV['MATIH_API_KEY']}",
      "Content-Type" => "application/json"
    })
    req.body = { question: "पिछले महीने कितनी बिक्री हुई?", language: "hi" }.to_json
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
    puts res.body
    ```

The response:

```json
{
  "status": "answered",
  "answer": "पिछले महीने की बिक्री ₹4.2 lakh रही, 1,284 orders पर।",
  "follow_ups": ["कौन सा product सबसे ज़्यादा बढ़ा?"],
  "sql": "SELECT SUM(amount) FROM orders WHERE ...",
  "result": {
    "columns": [{"name": "sales", "type": "DOUBLE"}],
    "rows": [[420000.0]],
    "row_count": 1,
    "truncated": false
  },
  "language": "hi-IN"
}
```

## Using `Accept-Language`

If your front end already sends the browser or device locale, forward it as the header and leave `language` out of the body.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/ask \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Accept-Language: ta-IN, en;q=0.5" \
      -d '{"question": "Total sales last month"}'
    ```

=== "Python"

    ```python
    from mitra import Mitra

    # Default for every call on this client...
    client = Mitra(language="ta-IN")
    print(client.ask("Total sales last month").answer)

    # ...or per call (sent as Accept-Language, and in the body).
    print(client.ask("Total sales last month", language="te-IN").answer)
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    // Default for every call on this client...
    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY, language: "ta-IN" });
    console.log((await mitra.ask("Total sales last month")).answer);

    // ...or per call.
    console.log((await mitra.ask("Total sales last month", { language: "te-IN" })).answer);
    ```

## What is translated, and what never is

Only the words are translated, field by field: `answer`, `headline`, `explanation`, `question` (including a clarification's), `options`, `follow_ups`, `message`, `title`, `summary`.

Never touched: `sql`, `result` (rows, columns and every value in them), `figures`, ids and URLs.

!!! warning "Numbers are protected"
    A field whose translation does not carry every figure of the English, unchanged, stays in English. A wrong number is worse than an English sentence, so your bot may occasionally show an English sentence inside a Hindi conversation. Check `language` on the response: it says what the text is actually written in, and is `en-IN` when nothing could be translated.

Other behaviour you can rely on:

- Names from your data (products, regions, file names, dotted product codes) are kept as they are.
- Fields are translated together within an 8 second budget; any not finished by then stay in English.
- The same question in the same language is translated once and remembered for a while.
- Clarifications are translated too, so when `status` is `clarification` the `options` you show as buttons are in the person's language. Send the button text back as the next `question`.

## Hinglish

A question typed in Latin letters, such as `pichle mahine kitni sales hui`, is understood as Hindi and the answer comes back in Latin letters too. Because Latin text under three words is read as English, set `language: "hi"` explicitly for Hindi speakers who type in Latin script.

## Voice

The same rules apply to voice notes: see [Voice questions](voice.md).

## Related

- [Concepts: languages](../concepts/languages.md)
- [Build a WhatsApp or Teams style bot](chat-bot.md)
- [Errors](../concepts/errors.md)
