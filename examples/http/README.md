<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Matih API: plain HTTP examples

One self-contained example per language, each using only that language's standard HTTP client. No SDK and no third-party libraries. They show the same seven things against the public API:

1. Ask a question (with an `Idempotency-Key`, and how to reuse `conversation_id`).
2. List Gems.
3. Start a dashboard image job and wait for `result.image_url`.
4. Run a prediction (can take up to 30 minutes).
5. List sources.
6. Upload a local CSV or Excel file (multipart).
7. Invite a member. This is an admin action, so it only runs when you pass an explicit flag.

| Language | Files | Needs | Run |
| --- | --- | --- | --- |
| Java | `java/MatihExample.java`, `java/WebhookVerify.java` | Java 11+ | `java MatihExample.java` |
| Go | `go/main.go`, `go/webhook.go`, `go/go.mod` | Go 1.21+ | `go run .` |
| JavaScript | `js/example.mjs`, `js/webhook.mjs` | Node 18+ | `node example.mjs` |
| C# | `csharp/Example.cs` | .NET 8+ | console project, see the header of the file, then `dotnet run` |
| PHP | `php/example.php` | PHP 7.4+ with curl and json | `php example.php` |
| Ruby | `ruby/example.rb` | Ruby 2.7+ | `ruby example.rb` |

Run each command from the language's own directory.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `MATIH_API_KEY` | yes | An API key (`mtk_...`) from Settings › API & MCP in Matih. |
| `MATIH_BASE_URL` | no | Defaults to `https://workspace.matih.ai`. The examples append `/api/v1`. |
| `MATIH_ON_DUPLICATE` | no | Sent as the `on_duplicate` form field of the file upload. |
| `MATIH_WEBHOOK_SECRET` | webhooks only | The `whsec_...` secret returned once when you create a webhook. |

```bash
export MATIH_API_KEY=mtk_...
```

## Options

The option syntax follows each language's habit (`--flag` for Java, JavaScript, C#, PHP and Ruby, `-flag` for Go). Shown here with the double dash.

| Option | Effect |
| --- | --- |
| `--skip-predict` | Skip the prediction, which can take a long time and costs credits. |
| `--background` | Run the prediction as a background job (see Sync vs async). |
| `--upload ./sales.csv` | Also upload this file. Needs the `files:write` scope; following its processing needs `files:read`. |
| `--invite you@example.com --role ROLE` | Also invite a member by email, or by phone if the value has no `@`. Needs `members:manage` and an admin role. Take valid roles from `GET /members`. Never runs by default. |

By default the examples call the API with your key, so the ask, background ask and prediction steps spend credits. Use `--skip-predict` for a cheap first run.

## Sync vs async

Long work (dashboard images, predictions, Gem generation, and optionally asking) can either hold the request open for a while or return a Job you poll. Both use the standard `Prefer` header (RFC 7240).

**Sync with a bounded wait: `Prefer: wait=N`** (N up to 60 seconds) on `POST /gems/generate`, `POST /predictions` and `POST /dashboards/{id}/image`. If the work finishes in time the response is `200` or `201` with the result. Otherwise it is `202` with a Job. The dashboard image and predict examples send `wait=30` and fall back to polling `GET /jobs/{id}` on `202`, so the same code handles both outcomes.

**Async: no `Prefer` wait.** `POST /predictions` returns `202` and a Job straight away. Keep the job id and poll `GET /jobs/{id}` later, from this process or another one. Pass `--background` to see this variant for the prediction. You can also skip polling and subscribe to webhooks (`prediction.completed`, `dashboard_image.ready`, `job.completed`, `gems.ready`).

**Ask in the background: `Prefer: respond-async`** on `POST /ask` returns `202` with a Job of kind `ask`. When it succeeds, the Job's `result` is the same Answer the synchronous call returns.

In every case, poll `GET /jobs/{id}` until `state` is `succeeded`, `failed` or `cancelled`. The examples back off from the first delay up to a cap (1 to 8 seconds for quick jobs, 5 to 10 seconds for predictions, giving up after about 31 minutes).

## Errors and rate limits

Errors look like `{"detail": {"category": "...", "message": "..."}}`. The examples print `category` and `message`. Common categories: `scope`, `workspace_role` and `source_access` (403), `credits` and `member_cap` (402), `busy` (409). On a `429` they wait for `Retry-After` and retry once, reusing the same `Idempotency-Key` so a credit-costing call is not charged twice.

## Webhook signature verification

Deliveries carry `Matih-Signature`, `Matih-Event` and `Matih-Delivery` headers. The signature header is:

```
Matih-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">
```

Verify it against the raw request bytes before parsing JSON, reject timestamps more than 300 seconds from now, accept the delivery if any `v1` value matches, and compare in constant time. The key is the whole `whsec_...` string.

| Language | File | Run |
| --- | --- | --- |
| Java | `java/WebhookVerify.java` | `java WebhookVerify.java` for a self-test, `java WebhookVerify.java serve` for a server on `:8080` |
| Go | `go/webhook.go` | `go run . serve-webhook` (same package as `main.go`) |
| JavaScript | `js/webhook.mjs` | `node webhook.mjs` |

The servers listen on `POST /matih/webhook`. Expose one to Matih with a tunnel during development, and register its URL with `POST /webhooks`.

## Notes

- These are teaching examples. They favour readability over completeness: JSON handling in the Java file is a few regex helpers, and nothing is tuned for production.
- Never commit your API key or webhook secret. Keep them in your environment or a secret manager.
- Image URLs (`image_url`) are short-lived signed URLs (15 minutes) and need no `Authorization` header.
- The full machine-readable spec is at `/api/v1/openapi.json` and the interactive docs at `/docs`. Copy-paste curl recipes are in `../curl/README.md`.
