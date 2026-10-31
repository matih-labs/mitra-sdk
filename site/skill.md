# Agent skill

The **matih skill** teaches an AI agent how to use Matih well: which workspace and source to pick, how to
read each answer status, when to stop on a `402`, how to poll a job politely, and when it must not invite
people or delete sources unless asked. It works through the hosted [MCP server](mcp/index.md) when the
tools are connected, and through REST otherwise.

The skill lives in the repository under
[`skills/matih`](https://github.com/matih-labs/mitra-sdk/tree/main/skills/matih):

| File | Covers |
|---|---|
| `SKILL.md` | The default flow (workspace, source, ask, present, follow up), how to read an answer, language, and when to use each product |
| `references/auth.md` | API keys, OAuth, scopes and headers |
| `references/asking.md` | Request and response shapes, clarification, empty and error results, streaming, audio |
| `references/gems.md` | Reading and generating Gems |
| `references/dashboards.md` | Rendering dashboards as images |
| `references/predictions.md` | Forecasts, job shape and polling cadence |
| `references/sources.md` | Sources, connectors, files, readiness |
| `references/workspaces.md` | Listing and switching workspaces |
| `references/members.md` | Members and invitations (admin work, only when asked) |
| `references/errors.md` | Every error status and what an agent should do |

## Install it

=== "Claude Code (project)"

    ```bash
    git clone https://github.com/matih-labs/mitra-sdk.git
    mkdir -p .claude/skills
    cp -r mitra-sdk/skills/matih .claude/skills/matih
    ```

=== "Claude Code (all projects)"

    ```bash
    git clone https://github.com/matih-labs/mitra-sdk.git
    mkdir -p ~/.claude/skills
    cp -r mitra-sdk/skills/matih ~/.claude/skills/matih
    ```

=== "Other agents"

    Any agent that reads a `SKILL.md` (YAML front matter with `name` and `description`, then instructions)
    can load the folder as is. Otherwise paste `SKILL.md` into the system prompt and give the agent the
    `references/` files as reading material.

Pair it with a connection:

```bash
claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp \
  --header "Authorization: Bearer $MATIH_API_KEY"
```

or give the agent `MATIH_API_KEY` in its environment so it can use REST. Prefer an **MCP connector** key for
the first (it only works on `/api/v1/mcp`; an API key works there too) and an **API key** for the second (see [Credentials and products](concepts/credentials.md)).

## Keep the agent safe

- Create the key with only the products the agent needs. Leave **Allow changes** off unless it must
  invite members, add sources or upload files.
- The skill tells the agent to run write operations only when a person explicitly asks. Your key's product
  switches are the enforcement; the skill is the manners.
- Never paste a key into a chat. See [Security](security.md).
