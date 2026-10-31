# Credits

Operations that run models or queries against your data spend **credits** from the workspace's pool,
the same pool and the same member caps the Matih app uses. Every charge records the `channel`
(`api`, `mcp`, `web`, `whatsapp`) so the workspace's usage page shows what the API spent.

| Operation | Spends credits | Typical time |
|---|---|---|
| `POST /ask`, `POST /ask/audio` | Yes | 5 to 30 s |
| `POST /gems/generate` | Yes | minutes |
| `POST /predictions` | Yes | 1 to 5 minutes, up to 30 |
| Reading Gems, listing dashboards, sources, members, jobs, webhooks | Free | instant |
| Rendering a dashboard image | Free | seconds |
| Translating and listening (languages, voice) | Not metered separately; the ask's own cost | |
| Inviting a member | Free (it messages a third party) | |

## When credits run out

A `402` with category `not_ready` means the workspace pool is empty: nothing ran and nothing was charged. Stop and tell a workspace admin.
A `402` with category `member_cap` means the member the key acts as has reached their monthly cap.
Neither is fixed by retrying.

```json
{"detail": {"category": "not_ready", "message": "The workspace is out of credits."}}
```

## Avoid paying twice

Send an `Idempotency-Key` on `POST /ask` and `POST /predictions`. A retry (after a timeout, a dropped
connection or a `5xx`) with the same key returns the original result and is charged once. The
Python and TypeScript SDKs generate one for you and reuse it across their own retries. A question that
fails, is cancelled or is refused is never charged. Other credit-spending calls (`POST /gems/generate`,
`POST /ask/audio`) ignore the header, so do not resend one that has already succeeded.

## Budgeting a bot

- Cache answers to repeated questions in your own app when the data does not change by the minute.
- Cap per-user questions in your bot; the workspace pool is shared.
- Reuse `conversation_id` for follow-ups; the context makes shorter, cheaper questions.
- Handle `402` by pausing the bot's replies and alerting an admin instead of looping.
