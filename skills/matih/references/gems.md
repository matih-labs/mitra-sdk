# Gems

Gems are insight cards Matih generates for a source: a headline, an explanation, supporting figures, and an image. Text follows `Accept-Language`; `figures` and ids are never translated.

Scopes: `gems:read` to read, `gems:generate` to generate.

## List

MCP: `list_gems` with optional `source_id`. REST: `GET /gems?source_id=...`.

```json
{
  "state": "ready",
  "gems": [
    {
      "id": "gem_1",
      "kind": "trend",
      "headline": "Weekend sales are up 14%",
      "explanation": "...",
      "figures": [{"label": "Change", "value": "14%"}],
      "question": "How did weekend sales change?",
      "source_id": "conn_41d2",
      "image_url": "https://...",
      "created_at": "2026-10-30T09:00:00Z"
    }
  ],
  "generated_at": "2026-10-30T09:00:00Z"
}
```

`state` is one of `none`, `running`, `ready`, `partial`, `empty`, `insufficient`, `failed`, `not_ready` or `no_source`. `none` means no Gems yet: tell the user and offer to generate them. `running` means they are being prepared. `no_source` and `not_ready` mean the source is missing or still being read (check `source_status`). `ready` and `partial` are usable. Leave out `source_id` to use the active source.

## Read one

MCP: `get_gem` with `gem_id`. REST: `GET /gems/{id}?source_id=...` (a 404 means it is not in that source's feed). The `question` field is the question that reproduces the gem; you can send it to `ask` to dig deeper in a conversation.

## Image

`image_url` is a public, unguessable URL that expires after 15 minutes and needs no auth. For the bytes with a credential use `GET /gems/{id}/image.png` (404 when the Gem has nothing worth drawing). Via MCP, images come back as image content.

## Generate

MCP: `generate_gems` with optional `source_id`. REST: `POST /gems/generate {"source_id": "..."}` (the body and `source_id` are optional; the default is the active source) returns 202 and a Job (`kind: "gems"`). Add `?wait=30` (or `Prefer: wait=30`) to get the finished Job back when it takes less than that. A finished Job's `result` is `{source_id, state, gem_count}`.

- Costs credits. Only do it when the user asked, or when the list is empty and they want gems. The endpoint does not honour `Idempotency-Key`, so do not retry it blindly: read the Job you got, or call `GET /gems` and check `state`.
- Poll the job with `get_job` or `GET /jobs/{id}` every 10 to 15 seconds. Gem generation takes from a minute to several; the server gives up after 20 minutes (`failed`, category `timeout`).
- On `succeeded`, call `list_gems` again to read the new gems.
- Alternatively register a `gems.ready` or `job.completed` webhook (REST only).
- Do not start a second generation while one is running: check `GET /gems` for `state: "running"` first.

## Presenting

Lead with `headline`, add `explanation` in one or two sentences, quote `figures` as returned. Show the image when you can. Offer the gem's `question` as a follow-up.
