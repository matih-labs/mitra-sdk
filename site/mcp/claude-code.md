# Claude Code

!!! info "You need"
    A Matih MCP connector key (Settings › API & MCP), or a Matih account for OAuth sign-in. See [MCP overview](index.md).

## With a connector key

```bash
export MATIH_API_KEY=mtk_...
claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp \
  --header "Authorization: Bearer $MATIH_API_KEY"
```

The shell expands `$MATIH_API_KEY` when you run the command, so the key is stored in your Claude Code config. If you would rather keep it out of the config entirely, use the project file with environment variable expansion (below).

## With OAuth sign-in instead of a key

```bash
claude mcp add --transport http matih https://workspace.matih.ai/api/v1/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate** for `matih`. A browser opens; sign in to Matih and approve. You act as yourself, in the default workspace you choose on the consent screen. To disconnect later, use Settings › Connected apps in Matih.

## Scope of the config

| Flag | Where it is stored |
|---|---|
| (default) `--scope local` | Just you, in this project |
| `--scope user` | You, in every project |
| `--scope project` | A shared `.mcp.json` in the repo, for the team |

For a shared `.mcp.json`, never write a literal key. Use environment variable expansion so each person supplies their own:

```json
{
  "mcpServers": {
    "matih": {
      "type": "http",
      "url": "https://workspace.matih.ai/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${MATIH_API_KEY}" }
    }
  }
}
```

## Check it works

```bash
claude mcp list
```

Then in Claude Code:

> Use Matih to list my data sources, then ask: what were the top 5 products by revenue last month?

Claude calls `list_sources`, then `ask`. Follow-ups reuse the `conversation_id`.

## Add the skill too

The [agent skill](../skill.md) teaches Claude Code when to use which tool, how to handle clarifications and what never to do (such as inviting people unprompted). It makes the assistant noticeably more reliable.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` on connect | Wrong, revoked or expired key; or the OAuth sign-in has not been completed. Run `/mcp` and authenticate. |
| Tool missing from the list | The key's product is switched off. Edit the key in Settings › API & MCP. |
| Tool error naming a scope | Same, or the key was made without that product's **Allow changes**. |
| Tool error about credits | The workspace's credit pool or your monthly cap is empty. See [Credits](../concepts/credits.md). |

## Remove it

```bash
claude mcp remove matih
```

## Related

[Tools](tools.md), [Claude Desktop](claude-desktop.md), [Cursor](cursor.md), [VS Code](vscode.md)
