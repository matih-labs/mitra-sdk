# Rate limits

Matih limits requests **per key** (and per OAuth client), counted across all servers, so a burst from one
integration cannot starve the others. When you are over the limit you get:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 7

{"detail": {"category": "...", "message": "Too many requests"}}
```

`Retry-After` is the number of seconds to wait. Limits can change; do not hard-code a number. Read the header.

## What to do

1. Wait at least `Retry-After` seconds, then retry once.
2. On repeats, back off exponentially (2, 4, 8 seconds) with jitter.
3. Spread work: queue bot questions, and prefer [webhooks](../guides/webhooks.md) over polling jobs.
4. Do not retry credit-spending `POST`s without the same `Idempotency-Key`.

The SDKs retry `429` for you, honouring `Retry-After`, up to `max_retries` (default 2, see the [Python](../sdk/python.md) and [TypeScript](../sdk/typescript.md) references). Past that they raise a
`RateLimitError` that carries the delay.

## Polling politely

| Job age | Poll every |
|---|---|
| under 1 minute | 5 s |
| 1 to 5 minutes | 15 s |
| over 5 minutes | 30 to 60 s |

## Seeing your usage

Owners and admins see calls, errors, rate-limited calls and credits per key under
**Settings › API & MCP**. If an integration is being limited often, check there first, then contact
[support@matih.ai](mailto:support@matih.ai) with the `request_id` of a limited request.
