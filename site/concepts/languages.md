# Languages

Ask in your language and get the answer in it. Matih supports English and the 22 scheduled Indian
languages, using Sarvam AI (the same service the WhatsApp channel uses).

- Send `language` in the request body, or an `Accept-Language` header. The body wins.
- With neither, Matih identifies the language of the question.
- Only the **words** are translated: `answer`, `headline`, `explanation`, `question` (including a
  clarification's), `options`, `follow_ups`, `message`, `title` and `summary`.
- **Never translated:** `sql`, `result` (rows, columns, every value), figures, ids and URLs.
- A sentence whose translation does not carry every figure of the English stays English. A wrong
  number is worse than an English sentence.
- `language` on the response says what the text is written in, and is `en-IN` when nothing could be
  translated (including when a deployment has no translation configured).
- In `Accept-Language` the first supported language, best `q` first, wins: `fr-FR, ta;q=0.8, en;q=0.5` is
  Tamil. An unsupported tag is ignored. Without either, a short question in Latin letters (fewer than
  three words) is taken as English.
- A question in another language is translated to English first. If that fails or takes over 10 seconds
  it is asked as written and the answer comes back in English; answer fields are translated within an
  8 second budget and any not finished stay English.
- The first eleven languages (through Telugu) are translated in a natural, code-mixed style and keep
  business words and the names in your data; a question in Latin letters (Hinglish) is answered in Latin
  letters. The others are translated formally.

```http
POST /api/v1/ask
Accept-Language: ta;q=0.9, en;q=0.5
```

Tags can be short or full (`hi`, `hi-IN`, `hi_in`). The full list, how `Accept-Language` is resolved,
Hinglish handling and voice questions are in [Multilingual bots](../guides/multilingual.md) and
[Voice questions](../guides/voice.md).
