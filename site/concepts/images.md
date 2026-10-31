# Images

Answers, Gems and dashboards come with pictures. Matih serves them as PNG.

## Image URLs

`image_url` in an Answer, a Gem or a finished dashboard-image job looks like:

```text
https://workspace.matih.ai/api/v1/media/<token>.png
```

- **No authorization header needed.** The token in the URL (48 hex characters, unguessable) is the authorization, so you can pass it
  straight to Slack, WhatsApp, an email or an `<img>` tag.
- **Short-lived: 15 minutes.** After that the URL answers `404`. Fetch the Gem or the job again to
  get a fresh URL. The picture is served with `Cache-Control: no-store`, so fetch it straight away or pass the URL to a viewer; do not store the URL.
- Treat the URL as a secret while it is valid: anyone who has it can view that picture.

```bash
URL=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" "$BASE/gems/$GEM_ID" | jq -r .image_url)
curl -s -o gem.png "$URL"
```

## Authenticated `.png` endpoints

When you would rather not hand out a URL, fetch the bytes with your credential:

| Endpoint | Returns |
|---|---|
| `GET /api/v1/gems/{id}/image.png` | The Gem's picture; `404` when it has nothing worth drawing |
| `GET /api/v1/dashboards/{id}/image.png` | The dashboard picture (`?width=` 400 to 3200); `303` to the image when one was drawn in the last ten minutes at that width, else `202` with a render Job |

The SDKs wrap both: `client.gems.image(id)` (Python, TypeScript) returns bytes;
`client.dashboards.render(id)` (Python) and `client.dashboards.imageBytes(id)` (TypeScript) wait for the render and
download it. In MCP, images come back as image content.

See [Dashboard image previews](../guides/dashboard-previews.md) and [Gems feed](../guides/gems-feed.md).
