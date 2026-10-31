# Embed example: Node

A plain `node:http` server (no framework) that mints with `@matihlabs/mitra` and serves a page using `<matih-embed>`. Read it top to bottom in [`server.mjs`](server.mjs); the page is [`public/index.html`](public/index.html).

```bash
# in this repository the two packages are linked from ../../../sdks; build them first
(cd ../../../sdks/typescript && npm install && npm run generate && npm run build)
(cd ../../../sdks/embed && npm install && npm run build)
npm install

export MATIH_API_KEY=mtk_...        # never commit this; needs the embeds:create scope
export EMBED_RESOURCE_ID=d_123      # a dashboard id; or a source id with EMBED_RESOURCE_TYPE=gems
export EMBED_FILTER_PARAM=customer_id   # the dashboard's embed parameter (ignored for Gems)
npm start                           # http://localhost:3000
```

Once the packages are published, replace the two `file:` entries in `package.json` with `^0.1.0` and skip the builds.

Other settings: `APP_ORIGIN` (the exact origin of the page, default `http://localhost:$PORT`), `PORT` (3000), `MATIH_BASE_URL` (the host only).

`npm test` runs the server against a fake Matih (no network, no key).

In your own app, serve `node_modules/@matihlabs/embed/dist/index.js` with your other static files, or bundle it, and replace `viewerFor` with your session lookup.
