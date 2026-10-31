# Embed example: Python

The same app on the standard library's `http.server` and `mitra-sdk`. The route is one function (`mint`); in FastAPI, Flask or Django it is one route that returns the same two fields. The page is [`public/index.html`](public/index.html).

```bash
pip install -r requirements.txt
(cd ../../../sdks/embed && npm install && npm run build)   # the element served as /matih-embed.js

export MATIH_API_KEY=mtk_...        # never commit this; needs the embeds:create scope
export EMBED_RESOURCE_ID=d_123      # a dashboard id; or a source id with EMBED_RESOURCE_TYPE=gems
export EMBED_FILTER_PARAM=customer_id   # the dashboard's embed parameter (ignored for Gems)
python server.py                    # http://localhost:3000
```

Other settings: `APP_ORIGIN` (the exact origin of the page, default `http://localhost:$PORT`), `PORT` (3000), `MATIH_BASE_URL` (the host only).

`pytest -q` runs the server against a fake Matih (no network, no key, no build).

In your own app, serve `@matihlabs/embed`'s `dist/index.js` (from npm) with your other static files, and replace `viewer_for` with your session lookup.

## FastAPI

```python
from fastapi import Depends, FastAPI, Request
from mitra import AsyncMitra, embed_src

app = FastAPI()
matih = AsyncMitra()  # MATIH_API_KEY from the environment

@app.post("/api/matih-embed-token")
async def embed_token(request: Request, user=Depends(current_user)):
    embed = await matih.embeds.create(
        resource={"type": "dashboard", "id": "d_123"},
        filters={"customer_id": user.customer_id},   # from your session, never from the request
        origins=["https://app.example.com"],
        ttl_seconds=300,
    )
    return {"token": embed.token, "src": embed_src(embed.url)}
```
