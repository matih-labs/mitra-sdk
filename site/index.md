---
hide:
  - navigation
  - toc
---

<p align="center"><img src="assets/logo.png" alt="Matih" width="120"></p>

# Build on Matih

Matih answers questions about your business data in plain language, finds the numbers worth
noticing (Gems), renders dashboards as images and runs forecasts. The public API puts all of it
behind one versioned REST API, a hosted MCP server and signed webhooks, so you can put Matih
inside a Slack bot, a WhatsApp or Teams assistant, a CRM, a cron job or an AI agent.

```text
https://workspace.matih.ai/api/v1
```

<div class="grid cards" markdown>

-   **Quickstart**

    Create a key and get your first answer in five minutes, in curl, Python, TypeScript, Go, Java, C#, PHP or Ruby.

    [:octicons-arrow-right-24: Start](quickstart.md)

-   **Build a chat bot**

    Slack, WhatsApp and Teams-style bots: conversations, clarifications, charts, slow questions.

    [:octicons-arrow-right-24: Slack bot](guides/slack-bot.md) · [Chat bot](guides/chat-bot.md)

-   **Connect Claude, Cursor, VS Code**

    The hosted MCP server at `/api/v1/mcp` gives any MCP client the same operations, scopes and credits.

    [:octicons-arrow-right-24: MCP](mcp/index.md)

-   **API reference**

    Every route, generated live from the OpenAPI 3.1 spec the server publishes.

    [:octicons-arrow-right-24: Open the reference](api-reference.md)

</div>

## What you can do

| You want to | Use | Guide |
|---|---|---|
| Ask a question, get words, rows and a chart | `POST /ask` | [Quickstart](quickstart.md) |
| Ask in Hindi, Tamil or any of 22 Indian languages | `language` or `Accept-Language` | [Multilingual bots](guides/multilingual.md) |
| Ask with a voice note | `POST /ask/audio` | [Voice questions](guides/voice.md) |
| Connect a database or upload a CSV or Excel file | `/sources`, `/files` | [Connect a source](guides/connect-source.md), [Upload a file](guides/upload-file.md) |
| Post what Matih found on its own | `/gems` | [Gems feed](guides/gems-feed.md) |
| Show a dashboard as a picture | `/dashboards/{id}/image` | [Dashboard previews](guides/dashboard-previews.md) |
| Forecast, detect anomalies, run what-ifs | `POST /predictions` | [Predictive questions](guides/predictive.md) |
| Be told when long work finishes | signed webhooks | [Webhooks](guides/webhooks.md) |
| Add people, change roles | `/invitations`, `/members` | [Invite members](guides/invite-members.md) |
| Let each of your users sign in as themselves | OAuth 2.1 with PKCE | [OAuth for multi-user apps](guides/oauth.md) |

## Three ways in, one set of operations

REST, the hosted MCP server and the SDKs all call the same operations with the same scopes,
the same workspace role checks, the same credits and the same metering.

=== "REST"

    Plain HTTPS and JSON. Works from anything that can send a request.

    ```bash
    curl -s https://workspace.matih.ai/api/v1/workspaces \
      -H "Authorization: Bearer $MATIH_API_KEY"
    ```

=== "Python"

    ```bash
    pip install mitra-sdk
    ```

    ```python
    from mitra import Mitra

    client = Mitra()   # reads MATIH_API_KEY
    print(client.ask("How many orders did we get today?").answer)
    ```

=== "TypeScript"

    ```bash
    npm i @matihlabs/mitra
    ```

    ```ts
    import { Mitra } from "@matihlabs/mitra";

    const client = new Mitra({ apiKey: process.env.MATIH_API_KEY });
    console.log((await client.ask("How many orders did we get today?")).answer);
    ```

=== "MCP"

    ```bash
    claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp \
      --header "Authorization: Bearer mtk_..."
    ```

## Principles worth knowing before you build

- **A credential never exceeds the person it acts as.** Every request re-checks the member's
  workspace role, whatever scopes the key carries. See [Credentials and products](concepts/credentials.md).
- **Long work is a job.** Slow operations return `202` and a job you poll or receive by webhook;
  `Prefer: wait=N` makes them answer inline when they finish in time. See [Sync and async](concepts/sync-async.md).
- **Words are translated, numbers never are.** See [Languages](concepts/languages.md).
- **Errors have one shape.** `{"detail": {"category", "message", "code"}}`. See [Errors](concepts/errors.md).
- **Retries are safe on questions and forecasts.** Send an `Idempotency-Key` on `POST /ask` and `POST /predictions`
  and a retried request returns the original instead of running (and charging) twice.

!!! info "Status"
    The versioned API and these SDKs (version 0.1.0) are rolling out to workspace.matih.ai now; they are not
    yet live for every workspace. Create keys under **Settings › API & MCP** once you see that tab.

!!! note "Source of truth"
    These docs are written from the server's contract and the SDK source. If a page and the
    live OpenAPI spec at `https://workspace.matih.ai/api/v1/openapi.json` ever disagree, the spec wins.
    Please [open an issue](https://github.com/matih-labs/mitra-sdk/issues) so we can fix the page.
