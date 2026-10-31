<p align="center"><img src="https://raw.githubusercontent.com/matih-labs/mitra-sdk/main/assets/matih-logo.png" alt="Matih" width="160"></p>

# Embed a Matih dashboard or Gems feed

Show a dashboard (with per-viewer row filters) or a Gems feed inside your own product. Two parts:

1. **Your backend** mints a short-lived token with the SDK (`embeds:create`). The API key stays there.
2. **Your page** shows it with `<matih-embed>` ([`@matihlabs/embed`](../../sdks/embed)). The element puts the token in the URL fragment, and asks your backend for a new token each time the embed says the current one is about to expire.

| Example | Backend | Run |
|---|---|---|
| [`node/`](node) | `node:http` and `@matihlabs/mitra` | `npm start` |
| [`python/`](python) | `http.server` and `mitra-sdk` | `python server.py` |

Both serve the same static page and the same route, `POST /api/matih-embed-token`, which answers `{"token": "met_...", "src": "https://.../embed/...?e=emt_..."}`.

## What you need

- An API key (Matih, Settings › API & MCP) with the **Embeds** product on, i.e. the `embeds:create` scope.
- A dashboard id (`d_...`) or a source id for Gems, readable by the member who owns the key.
- For a dashboard with row-level filters: the names of its embed parameters. Send exactly those, from your session, never from the browser. Gems take no filters.
- The exact origin of the page that holds `<matih-embed>` (`https://app.example.com`; `http://localhost:3000` while developing). Matih sets `frame-ancestors` from it, so no other site can frame the embed.

## Security notes both examples follow

- The token endpoint takes `POST` with `Content-Type: application/json` and checks `Origin`, so another site cannot mint tokens with your visitor's session. Add your own authentication: `viewer_for` / `viewerFor` is a stub that returns a fixed customer.
- Filters come from the server-side session. The request body is read and ignored.
- The response is `Cache-Control: no-store`. Nothing logs the embed (the token is a secret); errors answer the browser with a code only.
- A token lives 5 minutes by default and is never renewed: a refresh mints a new one. Minting is not idempotent and is not retried after a server error.
