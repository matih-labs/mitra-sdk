# Gems

Gems are insight cards Matih generates for a source: a headline, an explanation, supporting figures, and an image.

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
      "figures": [],
      "question": "How did weekend sales change?",
      "image_url": "https://...",
      "created_at": "2026-10-30T09:00:00Z"
    }
  ],
  "generated_at": "2026-10-30T09:00:00Z"
}
```

`state` says whether gems exist for the source (for example none yet, generating, or ready). If there are no gems, tell the user and offer to generate them.

## Read one

MCP: `get_gem` with `gem_id`. REST: `GET /gems/{id}`. The `question` field is the question that reproduces the gem; you can send it to `ask` to dig deeper in a conversation.

## Image

`image_url` is a short-lived signed URL (15 minutes, no auth). For bytes with auth use `GET /gems/{id}/image.png`. Via MCP, images come back as image content.

## Generate

MCP: `generate_gems` with `source_id`. REST: `POST /gems/generate {"source_id": "..."}` returns 202 and a Job (`kind: "gems"`).

- Costs credits. Only do it when the user asked, or when the list is empty and they want gems. Send an `Idempotency-Key`.
- Poll the job with `get_job` or `GET /jobs/{id}` every 5 seconds at first, then every 10 to 15 seconds. Gem generation usually finishes in minutes.
- On `succeeded`, call `list_gems` again to read the new gems.
- Alternatively register a `gems.ready` or `job.completed` webhook (REST only).
- Do not start a second generation while one is running; a `409` `busy` means one is in progress.

## Presenting

Lead with `headline`, add `explanation` in one or two sentences, quote `figures` as returned. Show the image when you can. Offer the gem's `question` as a follow-up.
