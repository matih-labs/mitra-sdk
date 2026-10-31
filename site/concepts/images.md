# Images

Answers, Gems and dashboards come with pictures. Matih serves them as PNG.

## Signed image URLs

`image_url` in an Answer, a Gem or a finished dashboard-image job looks like:

```text
https://workspace.matih.ai/api/v1/media/<token>.png
```

- **No authorization header needed.** The token in the URL is the authorization, so you can pass it
  straight to Slack, WhatsApp, an email or an `<img>` tag.
- **Short-lived: 15 minutes.** After that the URL returns an error. Fetch the Gem or the job again to
  get a fresh URL.
- Treat the URL as a secret while it is valid: anyone who has it can view that picture.

```bash
URL=$(curl -s -H "Authorization: Bearer $MATIH_API_KEY" "$BASE/gems/$GEM_ID" | jq -r .image_url)
curl -s -o gem.png "$URL"
```

## Authenticated `.png` endpoints

When you would rather not hand out a URL, fetch the bytes with your credential:

| Endpoint | Returns |
|---|---|
| `GET /api/v1/gems/{id}/image.png` | The Gem's picture |
| `GET /api/v1/dashboards/{id}/image.png` | The dashboard picture; redirects to a fresh image when one is cached, else `202` with a render Job |

The SDKs wrap both: `client.gems.image(id)` (Python, TypeScript) returns bytes;
`client.dashboards.render(id)` (Python) and `client.dashboards.imageBytes(id)` (TypeScript) wait for the render and
download it. In MCP, images come back as image content.

See [Dashboard image previews](../guides/dashboard-previews.md) and [Gems feed](../guides/gems-feed.md).
