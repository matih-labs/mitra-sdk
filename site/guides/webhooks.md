# Webhooks

Long work (generating Gems, forecasts, dashboard images) finishes minutes after you ask for it. Instead of polling [`GET /api/v1/jobs/{id}`](../concepts/jobs.md), register an HTTPS URL and Matih sends a signed `POST` when something is ready.

!!! info "You need"
    - Product: **Webhooks** (scope `webhooks:manage`) switched on for the key. It has no separate *Allow changes* switch: the one scope lists, creates, tests and deletes.
    - A workspace **admin**: managing webhooks needs the admin role whatever the key's scopes say.
    - A public `https` URL that your server answers.

A webhook made with an integration's API key or OAuth token belongs to that integration: it sees and deletes only its own, and receives the events of that integration's own jobs. A webhook made by signing in to the app (no integration) receives the workspace's events that are not tied to an integration.

## Events

| `type` | Sent when | `data` |
|---|---|---|
| `gems.ready` | Gems finished generating for a source | `source_id`, `gem_count` |
| `prediction.completed` | a prediction finished | `job_id`, `conversation_id`, `state` |
| `job.completed` | any `202` job reached a final state | `job_id`, `kind`, `state` |
| `dashboard_image.ready` | a dashboard image is rendered | `job_id`, `dashboard_id`, `image_url` |
| `ping` | you called `POST /api/v1/webhooks/{id}/test` | `message` |

`data` holds **ids and summary fields only, never rows of your data**, plus `links`: paths on the API to fetch the details, for example `"links": {"job": "/api/v1/jobs/j_123"}`. Take the id from the event, then call the API (with your key) for the content.

## Create a webhook

The secret (`whsec_...`) is in the response of the create call and **only there**. Store it in your secret manager immediately. You can have at most 20 webhooks per workspace.

=== "curl"

    ```bash
    curl -s https://workspace.matih.ai/api/v1/webhooks \
      -H "Authorization: Bearer $MATIH_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"url": "https://example.com/hooks/matih", "events": ["job.completed", "prediction.completed", "gems.ready", "dashboard_image.ready"]}'
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()

    hook = client.webhooks.create(
        "https://example.com/hooks/matih",
        ["job.completed", "prediction.completed", "gems.ready", "dashboard_image.ready"],
    )
    print(hook.id)
    print(hook.secret)  # whsec_..., shown once
    ```

=== "Python async"

    ```python
    import asyncio
    from mitra import AsyncMitra


    async def main():
        async with AsyncMitra() as client:
            hook = await client.webhooks.create(
                "https://example.com/hooks/matih", ["job.completed"]
            )
            print(hook.id, hook.secret)


    asyncio.run(main())
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });

    const hook = await mitra.webhooks.create({
      url: "https://example.com/hooks/matih",
      events: ["job.completed", "prediction.completed", "gems.ready", "dashboard_image.ready"],
    });
    console.log(hook.id, hook.secret); // whsec_..., shown once
    ```

Test it, list recent deliveries, list webhooks and delete:

=== "curl"

    ```bash
    BASE=https://workspace.matih.ai/api/v1
    AUTH="Authorization: Bearer $MATIH_API_KEY"

    # Send a ping now; reports delivered, status, error
    curl -s -X POST -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/test

    # The last 50 deliveries: attempts, state, last status and error (kept 30 days)
    curl -s -H "$AUTH" $BASE/webhooks/WEBHOOK_ID/deliveries

    # List (never shows secrets)
    curl -s -H "$AUTH" $BASE/webhooks

    # Delete, with its secret and history
    curl -s -X DELETE -H "$AUTH" $BASE/webhooks/WEBHOOK_ID
    ```

=== "Python"

    ```python
    print(client.webhooks.test(hook.id))          # {"delivered": true, "status": 204, ...}
    print(client.webhooks.deliveries(hook.id))
    print(client.webhooks.list())
    client.webhooks.delete(hook.id)
    ```

=== "TypeScript"

    ```ts
    console.log(await mitra.webhooks.test(hook.id));
    console.log(await mitra.webhooks.deliveries(hook.id));
    console.log(await mitra.webhooks.list());
    await mitra.webhooks.delete(hook.id);
    ```

!!! tip
    `test` sends a `ping` and never counts toward the three-day auto-disable below. Run it right after creating the webhook to prove your endpoint and signature check work.

## What a delivery looks like

```http
POST /hooks/matih HTTP/1.1
Content-Type: application/json
User-Agent: Matih-Webhooks/1
Matih-Event: gems.ready
Matih-Delivery: whd_0b7e5d2c9a14f3680d21
Matih-Signature: t=1761900000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd

{"created_at":"2026-10-31T11:20:00+00:00","data":{"gem_count":6,"source_id":"c_8f2"},"id":"evt_4f9c1a7b2d03e85a6c11","type":"gems.ready","workspace_id":"w_123"}
```

- `id` is the event's id: the same for every webhook the event goes to and for every retry. **Use it to ignore duplicates.**
- `Matih-Delivery` identifies this delivery to this endpoint (see `GET /api/v1/webhooks/{id}/deliveries`).
- Answer with any `2xx` within **10 seconds**, then do the work. Redirects are **not** followed: a `3xx` is a failure.

## Verify the signature

`Matih-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256>`. The HMAC is over the string `"<t>.<raw request body>"`, keyed with the endpoint's secret, the whole `whsec_...` string including the prefix.

!!! warning "Three rules"
    1. Verify against the **raw bytes** of the body, before any JSON parsing. A re-serialised body will not match.
    2. Compare in **constant time**.
    3. Refuse a timestamp more than **5 minutes** old. That stops replays.

=== "Python"

    With the SDK (Flask shown; any framework works as long as you pass the raw body):

    ```python
    import os

    from flask import Flask, request
    from mitra import verify_webhook

    app = Flask(__name__)
    SECRET = os.environ["MATIH_WEBHOOK_SECRET"]


    @app.post("/hooks/matih")
    def matih_hook():
        raw = request.get_data()  # raw bytes, before request.json
        if not verify_webhook(SECRET, request.headers.get("Matih-Signature"), raw):
            return "bad signature", 400
        event = request.get_json(force=True)
        # ... enqueue event["id"], event["type"], event["data"] and return fast
        return "", 204
    ```

    `assert_webhook(...)` is the same check but raises `WebhookVerificationError` with the reason. Without the SDK:

    ```python
    import hashlib, hmac, time


    def verify(secret: str, signature_header: str, raw_body: bytes, tolerance: int = 300) -> bool:
        parts = dict(p.split("=", 1) for p in signature_header.split(",") if "=" in p)
        try:
            t = int(parts["t"])
        except (KeyError, ValueError):
            return False
        if abs(time.time() - t) > tolerance:
            return False
        expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, parts.get("v1", ""))
    ```

=== "Node"

    Express with the raw body, using the SDK:

    ```js
    import express from "express";
    import { verifyWebhook } from "@matihlabs/mitra";

    const app = express();

    app.post("/hooks/matih", express.raw({ type: "application/json" }), (req, res) => {
      const ok = verifyWebhook(
        process.env.MATIH_WEBHOOK_SECRET,
        req.get("Matih-Signature"),
        req.body, // Buffer, because of express.raw
      );
      if (!ok) return res.sendStatus(400);
      const event = JSON.parse(req.body.toString("utf8"));
      // enqueue event.id / event.type / event.data and return fast
      res.sendStatus(204);
    });

    app.listen(3000);
    ```

    Without the SDK:

    ```js
    const crypto = require("crypto");

    function verify(secret, signatureHeader, rawBody, toleranceSeconds = 300) {
      const parts = Object.fromEntries(
        signatureHeader.split(",").map((p) => {
          const i = p.indexOf("=");
          return [p.slice(0, i), p.slice(i + 1)];
        })
      );
      const t = Number(parts.t);
      if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
      const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
      const given = Buffer.from(parts.v1 || "", "hex");
      const want = Buffer.from(expected, "hex");
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    }
    ```

=== "Java"

    Spring Boot controller. Take the body as `byte[]` so nothing re-encodes it:

    ```java
    import java.nio.charset.StandardCharsets;
    import java.security.MessageDigest;
    import javax.crypto.Mac;
    import javax.crypto.spec.SecretKeySpec;
    import org.springframework.http.ResponseEntity;
    import org.springframework.web.bind.annotation.*;

    @RestController
    public class MatihHook {
        private static final String SECRET = System.getenv("MATIH_WEBHOOK_SECRET");

        @PostMapping("/hooks/matih")
        public ResponseEntity<Void> hook(
                @RequestHeader(value = "Matih-Signature", required = false) String signature,
                @RequestBody byte[] raw) throws Exception {
            if (!verify(SECRET, signature, raw, 300)) {
                return ResponseEntity.badRequest().build();
            }
            // parse raw as JSON, enqueue by event id, return fast
            return ResponseEntity.noContent().build();
        }

        static boolean verify(String secret, String header, byte[] raw, long toleranceSeconds) throws Exception {
            if (header == null) return false;
            long t = -1;
            String v1 = "";
            for (String part : header.split(",")) {
                int i = part.indexOf('=');
                if (i < 0) continue;
                String k = part.substring(0, i).trim();
                String v = part.substring(i + 1).trim();
                if (k.equals("t")) t = Long.parseLong(v);
                else if (k.equals("v1")) v1 = v;
            }
            if (t < 0 || Math.abs(System.currentTimeMillis() / 1000 - t) > toleranceSeconds) return false;

            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((t + ".").getBytes(StandardCharsets.UTF_8));
            String expected = java.util.HexFormat.of().formatHex(mac.doFinal(raw));
            return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8), v1.getBytes(StandardCharsets.UTF_8));
        }
    }
    ```

=== "Go"

    ```go
    package main

    import (
    	"crypto/hmac"
    	"crypto/sha256"
    	"encoding/hex"
    	"io"
    	"math"
    	"net/http"
    	"os"
    	"strconv"
    	"strings"
    	"time"
    )

    func verify(secret, header string, raw []byte, tolerance time.Duration) bool {
    	var t int64 = -1
    	v1 := ""
    	for _, part := range strings.Split(header, ",") {
    		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
    		if !ok {
    			continue
    		}
    		switch k {
    		case "t":
    			n, err := strconv.ParseInt(v, 10, 64)
    			if err != nil {
    				return false
    			}
    			t = n
    		case "v1":
    			v1 = v
    		}
    	}
    	if t < 0 || math.Abs(float64(time.Now().Unix()-t)) > tolerance.Seconds() {
    		return false
    	}
    	mac := hmac.New(sha256.New, []byte(secret))
    	mac.Write([]byte(strconv.FormatInt(t, 10) + "."))
    	mac.Write(raw)
    	expected := hex.EncodeToString(mac.Sum(nil))
    	return hmac.Equal([]byte(expected), []byte(v1))
    }

    func main() {
    	secret := os.Getenv("MATIH_WEBHOOK_SECRET")
    	http.HandleFunc("/hooks/matih", func(w http.ResponseWriter, r *http.Request) {
    		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
    		if err != nil || !verify(secret, r.Header.Get("Matih-Signature"), raw, 5*time.Minute) {
    			http.Error(w, "bad signature", http.StatusBadRequest)
    			return
    		}
    		// enqueue raw for processing, return fast
    		w.WriteHeader(http.StatusNoContent)
    	})
    	http.ListenAndServe(":3000", nil)
    }
    ```

=== "C#"

    ASP.NET Core minimal API:

    ```csharp
    using System.Security.Cryptography;
    using System.Text;

    var app = WebApplication.CreateBuilder(args).Build();
    var secret = Environment.GetEnvironmentVariable("MATIH_WEBHOOK_SECRET")!;

    app.MapPost("/hooks/matih", async (HttpRequest req) =>
    {
        using var ms = new MemoryStream();
        await req.Body.CopyToAsync(ms);
        var raw = ms.ToArray();
        if (!Verify(secret, req.Headers["Matih-Signature"].ToString(), raw, 300))
            return Results.BadRequest();
        // enqueue raw, return fast
        return Results.NoContent();
    });

    static bool Verify(string secret, string header, byte[] raw, long tolerance)
    {
        long t = -1;
        string v1 = "";
        foreach (var part in header.Split(','))
        {
            var i = part.IndexOf('=');
            if (i < 0) continue;
            var k = part[..i].Trim();
            var v = part[(i + 1)..].Trim();
            if (k == "t") t = long.Parse(v);
            else if (k == "v1") v1 = v;
        }
        if (t < 0 || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - t) > tolerance) return false;
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var payload = Encoding.UTF8.GetBytes(t + ".").Concat(raw).ToArray();
        var expected = Convert.ToHexString(hmac.ComputeHash(payload)).ToLowerInvariant();
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(v1));
    }

    app.Run();
    ```

=== "PHP"

    ```php
    <?php
    function verify(string $secret, string $header, string $raw, int $tolerance = 300): bool {
        $t = null; $v1 = "";
        foreach (explode(",", $header) as $part) {
            $kv = explode("=", trim($part), 2);
            if (count($kv) !== 2) continue;
            if ($kv[0] === "t") $t = (int)$kv[1];
            if ($kv[0] === "v1") $v1 = $kv[1];
        }
        if ($t === null || abs(time() - $t) > $tolerance) return false;
        $expected = hash_hmac("sha256", $t . "." . $raw, $secret);
        return hash_equals($expected, $v1);
    }

    $raw = file_get_contents("php://input");
    $header = $_SERVER["HTTP_MATIH_SIGNATURE"] ?? "";
    if (!verify(getenv("MATIH_WEBHOOK_SECRET"), $header, $raw)) {
        http_response_code(400);
        exit;
    }
    http_response_code(204);
    ```

=== "Ruby"

    Sinatra:

    ```ruby
    require "sinatra"
    require "openssl"
    require "json"

    def verify(secret, header, raw, tolerance = 300)
      parts = header.to_s.split(",").map { |p| p.strip.split("=", 2) }.to_h
      t = Integer(parts["t"], exception: false)
      return false if t.nil? || (Time.now.to_i - t).abs > tolerance
      expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{t}.#{raw}")
      v1 = parts["v1"].to_s
      v1.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(expected, v1)
    end

    post "/hooks/matih" do
      raw = request.body.read
      halt 400 unless verify(ENV["MATIH_WEBHOOK_SECRET"], request.env["HTTP_MATIH_SIGNATURE"], raw)
      event = JSON.parse(raw)
      # enqueue event["id"], return fast
      status 204
    end
    ```

=== "curl / openssl"

    A manual check, with the raw body saved to `body.json`:

    ```bash
    SIG='t=1761900000,v1=abc123...'   # value of the Matih-Signature header
    SECRET='whsec_...'
    T=${SIG#t=}; T=${T%%,*}
    V1=${SIG##*v1=}
    EXPECTED=$( { printf '%s.' "$T"; cat body.json; } | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
    [ "$EXPECTED" = "$V1" ] && echo valid || echo INVALID
    ```

## A receiver that does it right

The shape that holds up in production: verify, record the event id, answer, and do the work afterwards.

```python
import os

from flask import Flask, request
from mitra import Mitra, verify_webhook

app = Flask(__name__)
client = Mitra()
SECRET = os.environ["MATIH_WEBHOOK_SECRET"]
seen: set[str] = set()  # use Redis or a database table with a unique key in production


@app.post("/hooks/matih")
def matih_hook():
    if not verify_webhook(SECRET, request.headers.get("Matih-Signature"), request.get_data()):
        return "bad signature", 400
    event = request.get_json(force=True)
    if event["id"] in seen:           # retries and duplicates carry the same id
        return "", 204
    seen.add(event["id"])
    enqueue(event)                    # a queue or background task; do not work inline
    return "", 204                    # inside 10 seconds


def enqueue(event):
    if event["type"] == "prediction.completed":
        job = client.jobs.get(event["data"]["job_id"])
        print(job.state, job.result)
```

!!! tip
    Do not reuse the secret across webhooks or environments. If it leaks, delete the webhook and create it again; the new one has a new secret.

## Retries and automatic disabling

Anything but a `2xx` (an error status, a timeout, a refused connection) is retried with exponential backoff and jitter (about +-20%): after roughly 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours, then Matih gives up on that delivery and it shows as `failed`. Each retry carries the same body and `id`, with a fresh timestamp and signature.

If an endpoint has had **no successful delivery for 3 days**, Matih disables it (`disabled_at` and `disabled_reason` appear on the webhook). Fix the endpoint, delete the webhook and create it again (a new secret).

## Where a webhook may point

Only public `https` URLs. Matih refuses (`422`, code `webhook_url`):

- a URL with a username or password;
- a private, loopback, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade-NAT, multicast or reserved address;
- a name that resolves to any of them.

The check runs when you create the webhook and again on every delivery, and the delivery connects to the address that passed the check, so changing DNS later cannot point it inward. For local development, expose your laptop through a tunnel that gives you a public `https` URL.

## Endpoints

| | |
|---|---|
| `GET /api/v1/webhooks` | list (never shows secrets) |
| `POST /api/v1/webhooks` `{"url", "events": [...]}` | create; the response carries `secret` once |
| `DELETE /api/v1/webhooks/{id}` | delete, with its secret and history |
| `POST /api/v1/webhooks/{id}/test` | send a `ping` now and report `delivered`, `status`, `error` |
| `GET /api/v1/webhooks/{id}/deliveries` | the last 50 deliveries (kept 30 days) |

## Related

- [Jobs](../concepts/jobs.md), [Sync vs async](../concepts/sync-async.md)
- [Predictive questions](predictive.md), [Gems feed](gems-feed.md), [Dashboard image previews](dashboard-previews.md)
- [Security](../security.md)
