# Asking questions

MCP: `ask`. REST: `POST /ask`.

Request body:

| Field | Notes |
| --- | --- |
| `question` | required, natural language, any of 22 Indian languages or English |
| `conversation_id` | reuse to continue a conversation |
| `source_id` | which source to query when starting a conversation; defaults to the workspace's active source |
| `language` | BCP-47 such as `hi-IN`; overrides detection for the response |
| `stream` | `true` for server-sent events |

The question is 1 to 4000 characters. `Prefer: respond-async` (or `?async=true`) answers 202 with a Job of kind `ask` instead; its `result` is the Answer.

Response (an Answer):

```json
{
  "status": "answered",
  "answer": "Revenue last month was 1.2 crore, up 8% on the month before.",
  "clarification": null,
  "result": {"columns": [{"name": "month", "type": "DATE"}, {"name": "revenue", "type": "DOUBLE"}], "rows": [["2026-09-01", 12000000.0]], "row_count": 1, "truncated": false},
  "sql": "SELECT ...",
  "image_url": null,
  "follow_ups": ["Break that down by region"],
  "conversation_id": "5c1d0a4e8b7f4e3a9d2c6b1a0f9e8d7c",
  "request_id": "b7e1c2d3a4f5469788a9b0c1d2e3f405",
  "language": "en-IN"
}
```

`status` is `answered`, `empty`, `clarification`, `error` or `cancelled`. Send an `Idempotency-Key` header. Asking costs credits and a retry with the same key answers once and is not charged twice. A failed, cancelled or refused question is never charged. Sync can take tens of seconds for a hard question: set your client's timeout to 90 seconds or more.

## Handling each status

### answered

Present `answer`. Show up to the first handful of `result.rows` as a small table when the user asked for data. If `truncated` is true, say only part of the rows are shown and that `row_count` may reflect the full total. If `image_url` is set it is a chart; show it (a public URL that expires in 15 minutes).

### clarification

Matih is not sure what the user means, for example which of two metrics or which date field. The Answer has `clarification: {"question": "...", "options": ["...", "..."]}`.

1. Put the question to the user, with the options.
2. Do not pick an option on the user's behalf unless they told you a default.
3. Send the chosen option (or their free-text reply) as the next `question` with the same `conversation_id`.

### empty

The query ran and matched nothing. Say that. Suggest checking the time range, filters or spelling of a value. Do not repeat the same question hoping for a different outcome.

### error and cancelled

`answer` explains in plain words. Offer to rephrase, or to pick another source. If the error repeats, report the `request_id` so the user can give it to support.

## Follow-ups and conversations

- Reuse `conversation_id` from the previous Answer for follow-ups such as "now by region" or "only 2025". Without it, Matih treats the question as standalone and loses context.
- Start a new conversation (omit `conversation_id`) when the topic changes or the source changes.
- `follow_ups` are suggestions generated for the answer. Offer at most two; they are not commands.
- `GET /conversations` lists your conversations, most recent first, including those started in Matih's apps; `GET /conversations/{id}` returns one with its `messages`, oldest first (another member's conversation is a 404). Both need `ask`.
- Ask one question at a time in a conversation: wait for the answer before sending the next.

## Language

- The user can ask in English or any of the 22 scheduled Indian languages. Detection is automatic. Do not translate the question yourself; send it as written.
- Answer text, headlines, explanations, follow-ups and clarification questions come back translated into the detected or requested language.
- Data values, column names and figures are never translated. If the user reads Hindi, expect Hindi sentences around English column names and numerals as stored.
- To force a response language send `language` in the body or `Accept-Language`. Example: question in English with `language: "ta-IN"` returns Tamil prose.
- The response field `language` tells you what was used. If it differs from what the user wrote in, say so briefly rather than silently switching.
- When relaying to the user, keep the response language: do not re-translate to English unless asked.

## Audio

`POST /ask/audio` accepts a voice note as multipart form data:

- `file`: the audio (required; any common audio format, 5 MB at most)
- `conversation_id`: optional
- `source_id`: optional
- `language`: optional BCP-47 code; skips detection and names the language spoken (scope `ask`)

Speech is transcribed, language-detected and answered like text; the audio is not stored. The Answer shape is the same, plus `heard`: `{"transcript": "...", "language": "hi-IN"}`. Show the user the transcript so they can catch a mis-hearing, and if it is wrong, ask them to repeat or type the question. Use this when the user attaches or records a voice message. Do not transcribe yourself first.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" \
  -F file=@question.ogg -F source_id=SOURCE_ID \
  https://workspace.matih.ai/api/v1/ask/audio
```

## Streaming

With `"stream": true` or `Accept: text/event-stream` the response is server-sent events:

- `started`: request accepted
- `progress`: `{stage, message, status}`
- `answer`: the final Answer object (same shape as above)
- `error`: a failure; the payload is `{category, message}`. Nothing is charged for it. A 402 is returned before the stream opens

Use streaming for interactive UIs. In scripts the plain JSON response is simpler. After the `answer` event the stream ends. If the stream drops before `answer`, retry with the same `Idempotency-Key`; the question is answered once and charged once.
