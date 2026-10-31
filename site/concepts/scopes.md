# Scopes

A scope is a permission a credential carries. Every `/api/v1` route declares the scope it needs;
a credential without it gets `403` with category `scope` and nothing runs.

| Scope | Allows |
|---|---|
| `workspaces:read` | List workspaces; `use_workspace` for OAuth sessions |
| `members:read` | List members and pending invitations |
| `members:manage` | Invite, change role, remove members, revoke invitations (an admin member is also required) |
| `sources:read` | List sources, read readiness, list connector types |
| `sources:write` | Test, add, activate and delete sources (an admin member is also required to add) |
| `files:read` | List and read uploaded files |
| `files:write` | Upload files, answer duplicate prompts, delete files |
| `gems:read` | List and read Gems and their images |
| `gems:generate` | Generate Gems (spends credits) |
| `ask` | Ask questions (text and audio), conversations |
| `dashboards:read` | List dashboards and render them as images |
| `predict` | Run predictions (spends credits) |
| `webhooks:manage` | Create, list, test and delete webhooks, read deliveries (admin member required) |

## Rules

1. **Scopes only narrow.** The workspace role gate runs first, then the scope. A key with
   `members:manage` made by a non-admin still cannot invite anyone.
2. **Admins pick products, not scopes** when making an API key. See [Credentials and products](credentials.md).
3. **Jobs.** `GET /jobs/{id}` needs any one of the scopes that start jobs (`ask`, `predict`,
   `gems:generate`, `dashboards:read`).
4. **MCP.** `tools/list` only offers tools the credential may call. See [MCP tools](../mcp/tools.md).

## Reading the error

```json
{"detail": {"category": "scope", "message": "Missing scope: gems:generate"}}
```

The message names the missing scope. Fix it by switching the matching product (and *Allow changes*
if it is a write scope) on for the key in **Settings › API & MCP**.
