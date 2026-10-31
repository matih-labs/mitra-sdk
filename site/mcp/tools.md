# MCP tools

One tool per operation. Each needs the scope shown, as the matching REST route does, and is **listed only to credentials that have it**. A credential without the scope gets a tool error naming it, and nothing runs. A scope only narrows: the workspace role still decides first (`invite_member` needs an admin member whatever the key's scopes say).

!!! info "You need"
    A connection from [Claude Code](claude-code.md), [Claude Desktop](claude-desktop.md), [Cursor](cursor.md), [VS Code](vscode.md) or any MCP client. See the [overview](index.md).

## The tools

| Tool | Scope | What it does | Cost |
|---|---|---|---|
| `list_workspaces` | `workspaces:read` | The workspaces the person belongs to, their role, which is current | free |
| `use_workspace(workspace_id)` | `workspaces:read` | Make a workspace the one later calls work in (not for API keys) | free |
| `list_members` | `members:read` | People in the workspace and their roles | free |
| `invite_member(email \| phone, role)` | `members:manage` | Invite by email or phone; admin or owner only | free, messages a third party |
| `list_sources` | `sources:read` | Data sources the person may use | free |
| `source_status(source_id)` | `sources:read` | Has Matih finished reading a source, so Ask can use it | free |
| `list_gems(source_id?)` | `gems:read` | The numbers and trends Matih found on its own | free |
| `get_gem(gem_id)` | `gems:read` | One Gem in full, with its picture as image content | free |
| `generate_gems(source_id?)` | `gems:generate` | Write new Gems; returns a job | credits, minutes |
| `ask(question, conversation_id?, source_id?, language?)` | `ask` | Answer in words, first 50 rows as a markdown table, the chart as image content | credits, 5 to 30 s |
| `list_dashboards` | `dashboards:read` | The person's dashboards | free |
| `dashboard_image(dashboard_id)` | `dashboards:read` | PNG of a dashboard: waits up to 20 s and returns it as image content plus a 15-minute link, else a job id | free |
| `predict(question, source_id?, language?)` | `predict` | Forecast, anomaly, segmentation or what-if; returns a job id | credits, 1 to 5 min |
| `get_job(job_id)` | any of `ask`, `predict`, `gems:generate`, `dashboards:read` | State of a job; when finished, its result and any picture | free |
| `list_files` | `files:read` | Uploaded files and whether they are read | free |

`?` marks an optional argument.

!!! note "File upload is not a tool"
    Files are binary, so upload with `POST /api/v1/files` (multipart) on the REST API ([Upload a file](../guides/upload-file.md)), then check it with `list_files` or `source_status`.

## What a key can see

`tools/list` offers only the tools the caller's credential may call. Every product an admin switches off for a key (Ask, predictions, Gems, dashboards, files, members, sources, workspaces) takes its scopes away, and those tools disappear from the list for that key. Calling one by name anyway is refused with a tool error naming the scope.

| Product switched off | Tools that disappear |
|---|---|
| Ask | `ask` (and `get_job` only if no other job scope remains) |
| Predictive analytics | `predict` |
| Gems | `list_gems`, `get_gem`, `generate_gems` |
| Dashboards | `list_dashboards`, `dashboard_image` |
| Files | `list_files` |
| Data sources | `list_sources`, `source_status` |
| Workspaces | `list_workspaces`, `use_workspace` |
| Users & members | `list_members`, `invite_member` |

An **Allow changes** switch off for a product removes its write scope: for example, with Users & members on but changes off, `list_members` remains and `invite_member` goes. For a read-only analyst assistant, leave changes off everywhere.

OAuth sign-in through the app's own session carries no credential scopes and sees all tools; the workspace role still decides what runs.

## Slow tools return jobs

`generate_gems` and `predict` return a job id. The model should call `get_job` until it finishes, as with the REST API's [jobs](../concepts/jobs.md). `dashboard_image` waits up to 20 seconds itself, so most calls return the picture directly. `ask` runs inline (5 to 30 seconds).

## Annotations

- `list_*`, `get_*` and `source_status` are `readOnlyHint: true`.
- `ask`, `predict`, `generate_gems` and `invite_member` carry `openWorldHint: true`: they read the person's own systems or message someone.
- None is `destructiveHint`: nothing here deletes.
- `use_workspace`, `dashboard_image` and the reads are idempotent.

Clients that ask for approval per tool call use these hints. A good setup auto-approves the reads and prompts for `ask`, `predict`, `generate_gems` and `invite_member`, because those spend credits or message people.

## Errors

Errors are MCP tool errors (`isError: true`) with the app's own words:

| What happened | Meaning | What the assistant should do |
|---|---|---|
| Missing scope | The key's product is off | Tell the user which product to enable; do not retry |
| Workspace role refusal | The person the key acts as lacks the role (for example `invite_member` as a non-admin) | Tell the user; do not work around |
| Empty credit pool, or a member's monthly cap (the 402 cases) | Out of credits | Stop and say so; an admin must add credits |
| Source not allowed | The member may not use that `source_id`, or it is in another workspace | Call `list_sources` again and pick from the list |

A missing or bad credential is an HTTP `401` with `WWW-Authenticate: Bearer`, from the auth layer, not a tool error. For clients using OAuth, that triggers re-authentication.

## The server's instructions

The server tells the model to pick a workspace first when needed; use `ask` for questions about what happened, `predict` for forecasts and what-ifs, Gems for "what is interesting", and `dashboard_image` for pictures; and to answer in the person's language.

## Example conversation

> **You:** What were sales by region last month, and what do we expect next quarter?
>
> **Assistant:** (calls `list_sources`, then `ask("sales by region last month")`) Sales were ₹4.2 lakh, led by the West. (shows a table and chart) For the forecast I will start a prediction. (calls `predict`, then `get_job` until done) ...

## Related

- [Scopes](../concepts/scopes.md), [Credits](../concepts/credits.md), [Jobs](../concepts/jobs.md)
- [Agent skill](../skill.md)
- The REST equivalents: [Quickstart](../quickstart.md)
