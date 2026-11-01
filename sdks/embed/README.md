# @matihlabs/embed

`<matih-embed>`: a Matih dashboard or Gems feed inside your own product, in an iframe, with the signed embed token kept out of the URL query and renewed from your backend before it expires.

No runtime dependencies. Plain TypeScript compiled to ESM. Works in any framework, or none.

> Version 0.1.0. The embeds API (`POST /api/v1/embeds`) is live on `workspace.matih.ai` with the rest of `/api/v1`.

## How it fits together

```
your backend                     your page                         Matih
  POST /api/v1/embeds  ------>  (API key stays here)
  <- { id, token, url } ------>  <matih-embed src=... token=...>   iframe  {src}#token=met_...
                                      ^   matih:token-expiring  <----------------+
                                      +-- getToken() / token-endpoint -> your backend mints again
                                      +-- {type:"matih:token", token} ---------> posted to the frame's origin
```

1. Your backend mints a token with `mitra.embeds.create(...)` (TypeScript SDK) or `client.embeds.create(...)` (Python SDK). The API key never reaches the browser.
2. Your page gives the element the mint response's `url` (without its `#token=...`) and its `token`, or a way to get them.
3. The element loads the page with the token in the URL **fragment** (never sent to a server, not in the `Referer`, not in logs).
4. About a minute before the 5 minute token expires the embed page asks the parent for a new one. The element asks your backend, and posts the answer back to the frame's exact origin.

## Install

```bash
npm install @matihlabs/embed
```

```ts
import "@matihlabs/embed"; // registers <matih-embed>
```

Or in a page with no build step, from your own host or a CDN you trust:

```html
<script type="module" src="/vendor/matih-embed.js"></script>
```

## Use

With the values your backend minted, rendered into the page:

```html
<matih-embed
  src="https://workspace.matih.ai/embed/dashboards/d_123?e=emt_Ab12"
  token="met_..."
  token-endpoint="/api/matih-embed-token"
  height="640"
  title="Sales dashboard"
></matih-embed>
```

Or let the element fetch everything from your backend, which is what you want when the page is static:

```html
<matih-embed token-endpoint="/api/matih-embed-token" height="640"></matih-embed>
```

Or with a function:

```ts
const el = document.querySelector("matih-embed")!;
el.getToken = async ({ embed }) => {
  // `embed` is the emt_... id of the token that is about to expire (absent on the first call)
  const res = await fetch("/api/matih-embed-token", { method: "POST" });
  return res.json(); // { token, src? }
};
```

### Attributes and properties

| Name | Meaning |
|---|---|
| `src` | The `url` from the mint response, without `#token=...`. It includes `?e=emt_...`, which the embed page needs. Required unless the token provider also returns it. Must be an absolute `https` URL (`http` only for `localhost` and `127.0.0.1`), without credentials. |
| `token` | The `met_...` token from the same mint, used for the first load. Optional when a provider is set. |
| `token-endpoint` | A URL on your site. The element `POST`s `application/json` to it (`{}` first, then `{"embed":"emt_..."}` on refresh, cookies sent same-origin) and expects `{"token": "met_...", "src": "..."}`. `src` is only read when the `src` attribute is not set. |
| `getToken` (property) | `(request: {embed?: string}) => string | {token, src?} | Promise<...>`. Takes precedence over `token-endpoint`. |
| `height` | The initial height, and the fallback: a number (pixels) or a length in `px`, `vh`, `rem`, `em`, `%`. Default `640px`. Once the embed page reports its content height (`matih:resize`) the frame follows it. |
| `title` | Accessible title of the frame. Default `Matih embed`. |

The frame resizes itself: the embed page posts `{type:"matih:resize", height}` (pixels) and the element applies it, rounded up and capped at 20,000 px. It only listens to its own frame at its own origin. Setting `height` again puts the frame back to that value until the next resize.

A `token` attribute is used once. When the element is moved in the DOM or `src` changes, and a provider exists, it asks the provider for a fresh token instead of reusing the old one (tokens are never renewable and may have expired).

### Events

Both bubble and cross shadow DOM boundaries.

| Event | `detail` | When |
|---|---|---|
| `matih:ready` | none | The embed page said it is ready (if it sends that message). |
| `matih:error` | `{code, message?, source}` | `source: "element"`: `missing_src`, `invalid_src`, `missing_token`, `no_token_provider`, `token_unavailable`. `source: "frame"`: the `code` the embed page reported (at most 64 characters). |

```ts
el.addEventListener("matih:error", (e) => console.warn(e.detail.code));
```

## What it will and will not do

- **Token only in the fragment.** `src` is a mint URL without its token; any `#...` in it is dropped.
- **Origin pinned, never `"*"`.** It answers `matih:token-expiring` only when `event.source` is the element's own iframe window **and** `event.origin` equals the origin of `src`. The reply goes to that exact origin. Anything else (other frames, extensions, the page itself) is ignored.
- **Bounded messages.** Unknown message types are ignored; a resize must be a positive finite number; error codes are length-capped and a frame cannot put its own text into `message`.
- **One refresh at a time.** A burst of `matih:token-expiring` shares one call to your backend.
- **A removed or reloaded frame gets nothing.** If the frame changed while your backend was minting, the new token is dropped.
- **Mint on your backend only.** The element never holds an API key and never calls `POST /api/v1/embeds` itself.

### The iframe

```html
<iframe sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" loading="lazy">
```

- `allow-scripts`: the embed page is a script-driven app.
- `allow-same-origin`: without it the frame has an opaque origin, its messages arrive with origin `"null"`, and the token handshake could only be addressed with `"*"`, which the contract forbids. The pair is safe because the frame is on Matih's origin, not yours.
- Not granted: popups, forms, top navigation, downloads, modals.
- `referrerpolicy="no-referrer"`: your page URL (which may carry customer data) is not sent to Matih.
- `loading="lazy"`: frames below the fold load when they are about to be seen.

Matih also restricts who may frame the page: `frame-ancestors` is set from the origins you passed to `embeds.create`. Pass the exact origin of the page that holds `<matih-embed>`.

## Several tag names, SSR

`defineMatihEmbed("my-embed")` registers a second tag (a subclass, since one constructor can be registered once). Importing the module on a server, where there is no `HTMLElement`, does nothing.

## Develop

```bash
npm install
npm run typecheck
npm test        # vitest on jsdom
npm run build   # dist/
```

## License

Apache-2.0.
