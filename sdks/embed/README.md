# @matihlabs/embed

`<matih-embed>`: a Matih dashboard, Gems feed or Ask box inside your own product, in an iframe, with the signed embed token kept out of the URL query and renewed from your backend before it expires.

No runtime dependencies. Plain TypeScript compiled to ESM. Works in any framework, or none.

> Version 0.1.1. The embeds API (`POST /api/v1/embeds`) is live on `workspace.matih.ai` with the rest of `/api/v1`.

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
| `src` | The `url` from the mint response, without `#token=...`. It includes `?e=emt_...`, which the embed page needs. For a token you sign yourself it is `https://workspace.matih.ai/embed/dashboards/d_123?e=<your integration id>`. Required unless the token provider also returns it. Must be an absolute `https` URL (`http` only for `localhost` and `127.0.0.1`), without credentials, and with no JWT in its query: a viewer token carries the viewer's email, phone and attributes, which must never reach access logs, `Referer` headers or history (a `src` that has one fails with `invalid_src`). |
| `token` | The `met_...` token from the same mint, or the JWT your backend signed for the viewer, used for the first load. It goes only in the iframe URL's fragment. Optional when a provider is set. |
| `token-endpoint` | A URL on your site. The element `POST`s `application/json` to it (`{}` first, then `{"embed":"emt_..."}` on refresh, cookies sent same-origin) and expects `{"token": "met_...", "src": "..."}`. `src` is only read when the `src` attribute is not set. |
| `getToken` (property) | `(request: {embed?: string}) => string | {token, src?} | Promise<...>`. Takes precedence over `token-endpoint`. |
| `height` | The initial height, and the fallback: a number (pixels) or a length in `px`, `vh`, `rem`, `em`, `%`. Default `640px`. Once the embed page reports its content height (`matih:resize`) the frame follows it. |
| `title` | Accessible title of the frame. Default `Matih embed`. |

The frame resizes itself: the embed page posts `{type:"matih:resize", height}` (pixels) and the element applies it, rounded up and capped at 20,000 px. It only listens to its own frame at its own origin. Setting `height` again puts the frame back to that value until the next resize.

A `token` attribute is used once. When the element is moved in the DOM or `src` changes, and a provider exists, it asks the provider for a fresh token instead of reusing the old one (tokens are never renewable and may have expired).

### The Ask box (`kind="ask"`)

A question field, three steps of progress and one answer, in the same iframe and with the same token handshake. Mint with `resource: {"type": "ask", "id": "<source id>"}`; the `url` it returns is `.../embed/ask/<source id>?e=emt_...`.

```html
<matih-embed
  kind="ask"
  token-endpoint="/api/matih-ask-token"
  theme="auto"
  accent="#2750cc"
  heading="Ask about your orders"
  placeholder="Ask anything about your orders"
  suggestions="Revenue by month|Top customers|Orders this week"
></matih-embed>
```

Or from a script, which also takes the options as plain values:

```ts
import { mountAsk } from "@matihlabs/embed";

mountAsk(document.getElementById("ask")!, {
  getToken: async () => (await fetch("/api/matih-ask-token", { method: "POST" })).json(), // { token, src }
  theme: "dark",
  accent: "#7c3aed",
  suggestions: ["Revenue by month", "Top customers"],
});
```

| Attribute | Meaning |
|---|---|
| `kind` | `ask` for the Ask box. Without it the options below are ignored. |
| `theme` | `light`, `dark` or `auto` (the visitor's own setting; the default). |
| `accent` | A hex colour (`#2750cc`, `2750cc` or `#25c`). It colours the send button, the focus ring and the chart's lead colour, and nothing else. |
| `font` | A plain font stack such as `Georgia, serif` (letters, digits, spaces and `, ' " -`, at most 80 characters). The default is a system sans-serif. |
| `heading`, `placeholder` | The line above the field (80 characters) and the field's placeholder (100). |
| `suggestions` | Up to three questions shown as chips, separated by `\|`. When none are set, the box offers the visitor's own recent questions. |

Each option is held to what the page accepts and anything else is left out, so the page shows its own default. They go in the page's query (they are not secret); the token still goes only in the fragment. An Ask frame starts at `280px` (`height` changes that) and follows its own content from there.

The box has no navigation, history list, settings or technical detail; the Matih mark at its foot names the product and links to matih.ai. Questions are limited to 20 an hour per viewer and 300 an hour per integration; past that the box says so in words and tells the visitor to try later. Pass `viewer` when you mint, or sign a viewer token, so each visitor's conversations stay their own (without one, everyone who uses the same embed token shares its conversations).

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

## Performance

- **Size.** One file, `dist/index.js`, about 16 KB (5 KB gzipped), no dependencies and no source map. The CI size budget fails if it grows past 20 KB.
- **No work until the tag is used.** Importing registers the element and does nothing else; the iframe loads when it nears the viewport (`loading="lazy"`), so a page with several embeds below the fold pays for none of them up front.
- **One token call at a time.** With `token-endpoint` or `getToken` the element asks your backend when it mounts, and again only when the frame reports `matih:token-expiring`; a burst of expiry messages shares one call. Each call has a 15 second timeout.
- **Mint late.** With a fixed `token` attribute, a token minted long before a lazy frame is first scrolled into view can expire first; mint it when the page is shown, or use `token-endpoint` or `getToken` so the element refreshes it.

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
