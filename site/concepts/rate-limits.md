# Rate limits

Matih limits requests so one integration cannot starve the others. A request over a limit gets:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 7
Content-Type: application/json

{"detail": {"category": "rate_limit", "message": "Too many requests. Wait a moment and try again."}}
```

`Retry-After` is the whole number of seconds to wait. Always read the header.

## The numbers

Every request with a credential is charged to more than one allowance. Each is a token bucket: you may
send `burst` requests at once, then `per second` sustained.

| Allowance | Per second | Burst | Charged to |
|---|---|---|---|
| The member the credential acts as | 10 | 60 | the member, across everything they do in Matih |
| Each API key or OAuth token | 5 | 30 | the key |
| Each API key, per minute | 600 requests a minute | | the key, counted across all servers |
| Anonymous (discovery, media links, OAuth registration) | 2 | 20 | the IP address |

The per-second allowances are counted by each server process on its own, so with several servers you can
see up to that many times the number; treat them as a backstop against one caller monopolising the system,
not a precise quota. The 600 a minute figure is the only one that is shared across servers. These are the
defaults Matih ships with and they can change; do not hard-code them.

`/api/v1` calls are not in the "costly" tier that the app's own chat and upload routes use. What actually
limits Ask, Gems and predictions is [credits](credits.md) and the work itself, not request rate.

## What to do

1. Wait at least `Retry-After` seconds, then retry once.
2. On repeats, back off exponentially (2, 4, 8 seconds) with jitter.
3. Spread work: queue bot questions, and prefer [webhooks](../guides/webhooks.md) over polling jobs.
4. Do not retry credit-spending `POST`s without the same `Idempotency-Key`.

The SDKs retry `429` for you, honouring `Retry-After`, up to `max_retries` (default 2, see the [Python](../sdk/python.md) and [TypeScript](../sdk/typescript.md) references). Past that they raise a
`RateLimitError` that carries the delay.

## Polling politely

| Work | Poll every |
|---|---|
| A quick job (dashboard image) | 2 s (the `Retry-After` on the `202`) |
| Gems and predictions, first minute | 5 s |
| Gems and predictions, after that | 10 to 15 s |
| A source or file being read | 5 to 10 s |

At 5 requests a second a single key can poll far more than it should. Prefer a
[webhook](../guides/webhooks.md) and let the job tell you.

## Seeing your usage

Owners and admins see calls, errors, rate-limited calls and credits per key under
**Settings › API & MCP**. If an integration is being limited often, check there first, then contact
[support@matih.ai](mailto:support@matih.ai) with the key name and the time of a limited request.
