# Embeds

Embeds show one dashboard (optionally with row filters per viewer) or one source's Gems inside a customer's own product, in an iframe. This is integration work for a developer, not a way to answer a data question: do not mint tokens unless the user asked for an embed.

Scopes: `embeds:create` to mint and revoke, `embeds:read` to list. REST only (no MCP tool). Free; no credits are used.

## Mint

`POST /embeds`, from a backend (never from a browser: the API key must stay secret).

```json
{
  "resource": {"type": "dashboard", "id": "d_123"},
  "filters": {"customer_id": "C123"},
  "origins": ["https://app.customer.com"],
  "ttl_seconds": 300
}
```

- `resource.type` is `dashboard` or `gems`. For `gems`, `id` is the source id and `filters` must be absent or empty.
- `filters` are exactly the parameters the dashboard declares as embed parameters, with valid typed values. They come from the signed-in viewer's session on the customer's server, never from the browser.
- `origins`: 1 to 10 exact origins `scheme://host[:port]` that may frame the page (no paths, no wildcards, https only; `http://localhost` and `http://127.0.0.1` allowed). It must be the origin of the page that holds the iframe.
- `ttl_seconds`: 60 to 900, default 300. A token is never renewed: mint again.

Response `201`: `id` (`emt_...`, not secret; used to revoke), `token` (`met_...`, a short-lived secret), `expires_at`, `url` (the embed page; the token is in its `#token=` fragment), `resource`, `origins`.

Each call mints a new token. Do not retry after a 5xx without checking `GET /embeds`, and never send an `Idempotency-Key` expecting it to dedupe.

Never print, log or store the `met_` token or the full `url`. Hand the browser the `url` without its fragment plus the token, through the `<matih-embed>` element (`@matihlabs/embed`) or an iframe whose URL is `<url without fragment>#token=<token>`; the element also asks the customer's backend for a fresh token when the page says the current one is expiring.

## List and revoke

- `GET /embeds`: tokens minted by this key (id, resource, origins, created, expires, revoked). Never the secret and never filter values.
- `DELETE /embeds/{id}`: revoke one token of this key by its `emt_...` id. `204`, idempotent. Confirm with the user first.

## Errors

- `422` with `code`: `missing_parameter`, `unknown_parameter`, `invalid_value`, `invalid_origin`, `filters_not_supported`, `no_embed_parameters`. Fix the request.
- `404`: the dashboard or source does not exist or the key's member cannot read it.
- `403`: the member's role no longer allows it, or the key lacks the scope.

SDKs: Python `client.embeds.create(resource=..., filters=..., origins=[...], ttl_seconds=...)`, TypeScript `mitra.embeds.create({ resource, filters, origins, ttlSeconds })`; refusals raise `EmbedRefusedError` (read `code`) and `EmbedNotFoundError`. A working example is in `examples/embed/`.
