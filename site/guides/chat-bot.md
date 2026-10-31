# Build a WhatsApp or Teams style bot

This guide is the pattern behind any chat bot that answers data questions: WhatsApp Business, Microsoft Teams, Telegram, a website widget. The chat platform calls **your** server when someone writes; your server asks Matih; you send the answer back.

For Slack specifically, which has its own SDK, slash commands and file uploads, see [Build a Slack bot](slack-bot.md). The shape of the problem is the same.

!!! info "You need"
    - Products: **Ask** (scope `ask`). Optional: **Webhooks** (`webhooks:manage`, needs **Allow changes**) for slow answers, **Gems** and **Dashboards** for richer replies.
    - One API key from **Settings › API & MCP**, pinned to a single workspace. Anyone who can message the bot can ask that workspace's data, so only expose the bot to people who may see it. For per-person access use [OAuth](oauth.md).

## The moving parts

```text
 user --message--> chat platform --webhook--> YOUR SERVER --POST /ask--> Matih
                                                  |  ^                      |
                                                  |  +------ answer --------+
 user <--reply---- chat platform <--send API------+
```

Four decisions, all covered below:

1. **Acknowledge fast.** Chat platforms expect a `2xx` from your webhook in a few seconds and retry otherwise. Return immediately and do the Matih call in the background.
2. **Remember the conversation.** Keep a map from the chat user (or thread) to Matih's `conversation_id` so "and by region?" works as a follow-up.
3. **Decide sync or async per answer.** Most questions answer in 5 to 30 seconds; for slow ones use `Prefer: respond-async` and a Matih webhook.
4. **Handle clarifications, languages and errors** the way a person would want to read them.

## Ask, and keep the conversation

`POST /ask` takes `question`, and optionally `conversation_id`, `source_id` and `language`. Send an `Idempotency-Key`; a retry with the same key answers once and is charged once.

The reply is an Answer. `status` is one of `answered`, `clarification`, `empty` or `error`. HTTP `200` with `status: "error"` is not an HTTP error.

=== "curl"

    ```bash
    export MATIH_API_KEY=mtk_...
    BASE=https://workspace.matih.ai/api/v1

    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "Top 5 products by revenue last month"}' $BASE/ask

    # Follow-up: reuse the conversation_id from the previous answer
    curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"question": "Now split that by region", "conversation_id": "CONVERSATION_ID"}' $BASE/ask
    ```

=== "Python"

    ```python
    from mitra import Mitra

    client = Mitra()  # reads MATIH_API_KEY
    first = client.ask("Top 5 products by revenue last month")
    print(first.answer)
    second = client.ask("Now split that by region", conversation_id=first.conversation_id)
    print(second.answer)
    ```

=== "TypeScript"

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const first = await mitra.ask("Top 5 products by revenue last month");
    const second = await mitra.ask({
      question: "Now split that by region",
      conversation_id: first.conversation_id,
    });
    console.log(second.answer);
    ```

Keep one question at a time running per conversation. If the same user sends two messages quickly, serialise them per user (a lock or a queue), because the second is a follow-up to the first answer. The API does not answer a second question in a conversation with an error, so this ordering is yours to keep.

## Answers that take a while: respond-async

Add `Prefer: respond-async` ([RFC 7240](https://www.rfc-editor.org/rfc/rfc7240)) and `POST /ask` returns `202` with a Job right away instead of holding the connection. The response header `Preference-Applied: respond-async` confirms it. You then either poll `GET /jobs/{id}` or, better for a bot, register a webhook and let Matih call you. The job's `result` is the Answer.

```bash
curl -si -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -H "Prefer: respond-async" \
  -d '{"question": "Revenue by month for the last 3 years", "conversation_id": "CONVERSATION_ID"}' \
  $BASE/ask
# HTTP/2 202
# Preference-Applied: respond-async
# {"id": "9b1e4c7a02d84f3b8a5e6d7c0f1a2b3c", "kind": "ask", "state": "queued", ...}
```

Register one webhook for the integration once, at deploy time:

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"url": "https://bot.example.com/hooks/matih", "events": ["job.completed"]}' $BASE/webhooks
# the response carries "secret": "whsec_..." exactly once; store it as MATIH_WEBHOOK_SECRET
```

A webhook made with an API key receives only the events of that key's own jobs. When it fires, `data` is the summarised Job (`job_id`, `kind`, `state`, `result`, `error`, `links`) with long strings cut to 500 characters, so fetch the full Answer with `GET /jobs/{id}`. Always verify `Matih-Signature` against the raw body first. Full details in [Webhooks](webhooks.md), job states in [Jobs](../concepts/jobs.md) and the modes in [Sync and async](../concepts/sync-async.md).

!!! note "Do you need async at all?"
    A bot that sends a "thinking..." message first and then replies from a background task is enough for most questions. Add `respond-async` when your platform kills long-lived work (serverless functions with short limits) or when you want the bot process to be stateless across restarts.

## A complete skeleton

The skeleton below has one inbound route that stands in for your chat platform's webhook (`{"user_id": "...", "text": "..."}`) and one route for Matih's webhook. Replace `send_message` with the platform's send API (WhatsApp Cloud API, Teams Bot Framework, Telegram `sendMessage`) and add that platform's own signature check to the inbound route.

=== "Python (FastAPI)"

    ```python
    # pip install fastapi uvicorn mitra-sdk httpx
    # MATIH_API_KEY and MATIH_WEBHOOK_SECRET in the environment; run: uvicorn bot:app
    import asyncio
    import json
    import os
    import time

    import httpx
    from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
    from mitra import (
        AsyncMitra, Answer, CreditsError, MitraError, PermissionDeniedError,
        RateLimitError, verify_webhook,
    )

    app = FastAPI()
    matih = AsyncMitra()                       # reads MATIH_API_KEY
    WEBHOOK_SECRET = os.environ["MATIH_WEBHOOK_SECRET"]

    # user_id -> (conversation_id, last_used). Use Redis or SQL in production, with a TTL.
    conversations: dict[str, tuple[str, float]] = {}
    # job_id -> user_id, for answers that arrive through the Matih webhook.
    pending_jobs: dict[str, str] = {}
    locks: dict[str, asyncio.Lock] = {}
    IDLE_SECONDS = 30 * 60                     # a new topic after 30 idle minutes


    async def send_message(user_id: str, text: str, buttons: list[str] | None = None,
                           image_url: str | None = None) -> None:
        """Replace with your platform's send API."""
        print(f"to {user_id}: {text} buttons={buttons} image={image_url}")


    def conversation_for(user_id: str) -> str | None:
        entry = conversations.get(user_id)
        if entry and time.time() - entry[1] < IDLE_SECONDS:
            return entry[0]
        return None


    async def deliver(user_id: str, answer: Answer) -> None:
        if answer.conversation_id:
            conversations[user_id] = (answer.conversation_id, time.time())
        if answer.status == "clarification" and answer.clarification:
            # The user's tap or reply arrives as the next message and continues this conversation.
            await send_message(user_id, answer.clarification.question,
                               buttons=answer.clarification.options)
        elif answer.status == "answered":
            text = answer.answer or "Done."
            if answer.result and answer.result.rows:
                text += f"\n({answer.result.row_count} rows)"
            await send_message(user_id, text, image_url=answer.image_url)
        elif answer.status == "empty":
            await send_message(user_id, answer.answer or "That matched nothing. Check the dates or filters.")
        else:
            await send_message(user_id, answer.answer or "Something went wrong. Please rephrase.")


    async def handle_message(user_id: str, text: str, language: str | None) -> None:
        lock = locks.setdefault(user_id, asyncio.Lock())   # one request per conversation
        async with lock:
            for attempt in range(3):
                try:
                    answer = await matih.ask(
                        text, conversation_id=conversation_for(user_id), language=language
                    )
                    await deliver(user_id, answer)
                    return
                except RateLimitError as e:
                    await asyncio.sleep(e.retry_after or 5)
                except CreditsError as e:
                    # 402: do not retry. Tell the user; an admin has to add credits.
                    await send_message(user_id, "I am out of credits right now. Please tell an admin.")
                    return
                except PermissionDeniedError as e:
                    await send_message(user_id, f"I am not allowed to do that ({e.code or e.category}).")
                    return
                except MitraError as e:
                    await send_message(user_id, "Sorry, that failed. Please try again.")
                    print("matih error", e.status, e.category, e.request_id)   # log the request id
                    return
            await send_message(user_id, "Still busy, please try again in a minute.")


    @app.post("/chat")
    async def inbound(request: Request, background: BackgroundTasks):
        # Verify your chat platform's signature here first.
        msg = await request.json()
        background.add_task(handle_message, msg["user_id"], msg["text"], msg.get("language"))
        return {"ok": True}                                # acknowledge immediately


    # --- The async path: use this instead of handle_message for slow questions -------------
    async def ask_in_background(user_id: str, text: str) -> None:
        async with httpx.AsyncClient(base_url="https://workspace.matih.ai/api/v1") as http:
            res = await http.post(
                "/ask",
                headers={"Authorization": f"Bearer {os.environ['MATIH_API_KEY']}",
                         "Prefer": "respond-async",
                         "Idempotency-Key": f"{user_id}-{time.time_ns()}"},
                json={"question": text, "conversation_id": conversation_for(user_id)},
            )
        res.raise_for_status()
        pending_jobs[res.json()["id"]] = user_id           # 202 Job


    @app.post("/hooks/matih")
    async def matih_webhook(request: Request, background: BackgroundTasks):
        raw = await request.body()                         # the RAW bytes, before any parsing
        if not verify_webhook(WEBHOOK_SECRET, request.headers.get("Matih-Signature", ""), raw):
            raise HTTPException(400, "bad signature")
        event = json.loads(raw)
        if event["type"] == "job.completed":
            background.add_task(finish_job, event["data"]["job_id"])
        return {"ok": True}                                # 2xx within 10 s; do the work after


    async def finish_job(job_id: str) -> None:
        user_id = pending_jobs.pop(job_id, None)
        if not user_id:
            return                                         # not ours, or a duplicate delivery
        job = await matih.jobs.get(job_id)
        if job.state == "succeeded":
            await deliver(user_id, Answer.model_validate(job.result))
        else:
            await send_message(user_id, "I could not finish that one. Please try again.")
    ```

=== "TypeScript (Express)"

    ```ts
    // npm i express @matihlabs/mitra
    // MATIH_API_KEY and MATIH_WEBHOOK_SECRET in the environment
    import express from "express";
    import { Mitra, CreditsError, RateLimitError, verifyWebhook } from "@matihlabs/mitra";
    import type { Answer } from "@matihlabs/mitra";

    const mitra = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    const WEBHOOK_SECRET = process.env.MATIH_WEBHOOK_SECRET!;
    const IDLE_MS = 30 * 60_000;

    // userId -> conversation. Use Redis or SQL in production.
    const conversations = new Map<string, { id: string; at: number }>();
    const pendingJobs = new Map<string, string>(); // jobId -> userId
    const chains = new Map<string, Promise<void>>(); // one request per user at a time

    async function sendMessage(userId: string, text: string, opts: { buttons?: string[]; imageUrl?: string } = {}) {
      console.log("to", userId, text, opts); // replace with your platform's send API
    }

    function conversationFor(userId: string): string | undefined {
      const c = conversations.get(userId);
      return c && Date.now() - c.at < IDLE_MS ? c.id : undefined;
    }

    async function deliver(userId: string, a: Answer) {
      if (a.conversation_id) conversations.set(userId, { id: a.conversation_id, at: Date.now() });
      if (a.status === "clarification" && a.clarification) {
        await sendMessage(userId, a.clarification.question, { buttons: a.clarification.options });
      } else if (a.status === "answered") {
        await sendMessage(userId, a.answer ?? "Done.", { imageUrl: a.image_url ?? undefined });
      } else if (a.status === "empty") {
        await sendMessage(userId, a.answer ?? "That matched nothing. Check the dates or filters.");
      } else {
        await sendMessage(userId, a.answer ?? "Something went wrong. Please rephrase.");
      }
    }

    async function handleMessage(userId: string, text: string, language?: string) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const answer = await mitra.ask(
            { question: text, conversation_id: conversationFor(userId) },
            { language },
          );
          return await deliver(userId, answer);
        } catch (err) {
          if (err instanceof RateLimitError) await new Promise((r) => setTimeout(r, (err.retryAfter ?? 5) * 1000));
          else if (err instanceof CreditsError) {
            return sendMessage(userId, "I am out of credits right now. Please tell an admin."); // 402: no retry
          } else {
            console.error("matih error", err);
            return sendMessage(userId, "Sorry, that failed. Please try again.");
          }
        }
      }
      await sendMessage(userId, "Still busy, please try again in a minute.");
    }

    const app = express();

    app.post("/chat", express.json(), (req, res) => {
      // Verify your chat platform's signature here first.
      const { user_id, text, language } = req.body;
      const prev = chains.get(user_id) ?? Promise.resolve();
      chains.set(user_id, prev.then(() => handleMessage(user_id, text, language)));
      res.sendStatus(200); // acknowledge immediately
    });

    // The async path: start with Prefer: respond-async, finish in the webhook.
    async function askInBackground(userId: string, text: string) {
      const res = await fetch("https://workspace.matih.ai/api/v1/ask", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MATIH_API_KEY}`,
          "Content-Type": "application/json",
          Prefer: "respond-async",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ question: text, conversation_id: conversationFor(userId) }),
      });
      if (res.status !== 202) throw new Error(`unexpected ${res.status}`);
      pendingJobs.set((await res.json()).id, userId);
    }

    app.post("/hooks/matih", express.raw({ type: "application/json" }), async (req, res) => {
      if (!verifyWebhook(WEBHOOK_SECRET, req.header("Matih-Signature"), req.body)) return res.sendStatus(400);
      res.sendStatus(204); // 2xx within 10 s; work afterwards
      const event = JSON.parse(req.body.toString("utf8"));
      if (event.type !== "job.completed") return;
      const userId = pendingJobs.get(event.data.job_id);
      if (!userId) return; // not ours, or a duplicate delivery
      pendingJobs.delete(event.data.job_id);
      const job = await mitra.jobs.get<Answer>(event.data.job_id);
      if (job.state === "succeeded" && job.result) await deliver(userId, job.result);
      else await sendMessage(userId, "I could not finish that one. Please try again.");
    });

    app.listen(8000);
    ```

!!! warning "Webhook body"
    Verify against the **raw** bytes. Mounting `express.json()` before the Matih route re-serialises the body and the signature will never match. In FastAPI use `await request.body()`, not `request.json()`.

## Clarifications

When Matih is not sure what a question means (which of two revenue metrics, which date column) it returns `status: "clarification"` with `clarification: {"question": "...", "options": ["...", "..."]}`.

- Show the question and the options. WhatsApp has reply buttons (up to three) and list messages; Teams has Adaptive Card actions; elsewhere, number the options in text.
- Do not pick for the user.
- Send their choice, or their free-text reply, as the next `question` with the same `conversation_id`. The skeleton above does that for free, because the mapping already holds the conversation.

## Languages

Matih answers in the language of the question. People often write in Hindi, Tamil, Bengali or mixed Hinglish; do not translate on your side. If your platform tells you the user's locale, pass it as `language` (`hi-IN`) or as `Accept-Language`; otherwise omit both and Matih identifies the language. The response field `language` says what the text came back in. Numbers, column names and SQL are never translated. See [Multilingual bots](multilingual.md) and [Languages](../concepts/languages.md). For voice notes, see [Voice questions](voice.md).

## Pictures

Answers can carry an `image_url`: a signed link that expires in 15 minutes and needs no authentication. Most platforms fetch media from a URL you give them (WhatsApp `image.link`, Teams card `image`), which works directly. If the platform wants an upload instead, download the PNG immediately with `client.download_image(url)` in Python, or plain `fetch` in Node. See [Images](../concepts/images.md), and for dashboards [Dashboard image previews](dashboard-previews.md).

## Errors, rate limits and credits

| What you see | Meaning | What the bot does |
|---|---|---|
| `402` `not_ready` | The workspace pool is empty | Tell the user once; do not retry. An admin adds credits |
| `402` `member_cap` | The member's monthly cap is reached | Tell the user a cap was reached |
| `403` `scope` | **Ask** is off for the key | A deploy problem; alert yourself, tell the user it is unavailable |
| `429` | Rate limited; `Retry-After` gives seconds | Wait at least that long; the SDKs already retry twice |
| `5xx` | Server error | Retry up to 3 times with backoff, then log the `request_id` |

Rate-limit your own users too (a few questions a minute each); one chatty user should not exhaust the workspace's [credits](../concepts/credits.md) or the key's [rate limit](../concepts/rate-limits.md). See [Errors](../concepts/errors.md) for the full list.

## Going to production

- Keep the key and the webhook secret in a secret store; never in the repository.
- Persist the conversation and pending-job maps outside process memory so a restart does not lose them.
- Deduplicate: chat platforms retry webhooks, so key your handler on the platform's message id; Matih's webhook events carry a stable `id`.
- Log `request_id` from every Matih response; it is what support needs.
- Decide who the bot acts as. A shared key means everyone sees the same data; [OAuth](oauth.md) lets each person see only their own.
