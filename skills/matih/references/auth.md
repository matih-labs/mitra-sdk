# Authentication

Every request carries `Authorization: Bearer <credential>`. There are two credential types: keys and OAuth tokens.

## API keys and MCP connector keys (`mtk_...`)

- Created by a workspace admin in Matih under `Settings > API & MCP`.
- Two kinds: an API key works on all of `/api/v1`; an MCP connector key works only on `/api/v1/mcp` and returns 403 elsewhere. Use a connector key for MCP clients (an API key also works there).
- The admin chooses the products the key may use, all on by default: Ask, Data sources, Files, Predictive, Dashboards, Gems, Workspaces, Users & members, Webhooks. A product left off means the matching scopes are missing and calls return 403 `scope`.
- Keys never expire by default. Revoke them in the same screen.
- Pinned to exactly one workspace. Sending an `X-Matih-Workspace` header for a different workspace is refused.
- Act as the member who created the key and never exceed that member's role. A key created by an analyst cannot do admin-only things even if it holds the scope.
- Store in an environment variable, for example `MATIH_API_KEY`. Never commit or echo it.

```bash
export MATIH_API_KEY=mtk_...
curl -s -H "Authorization: Bearer $MATIH_API_KEY" https://workspace.matih.ai/api/v1/workspaces
```

## OAuth 2.1 (`mto_...` access tokens)

- Authorization code flow with PKCE and dynamic client registration. MCP clients (claude.ai, Claude Desktop, Cursor and others) discover and run this automatically.
- Discovery documents:
  - `https://workspace.matih.ai/.well-known/oauth-authorization-server`
  - `https://workspace.matih.ai/.well-known/oauth-protected-resource`
- Refresh tokens (`mtr_...`) rotate: each refresh returns a new refresh token and the old one stops working. Persist the newest one.
- OAuth tokens are not pinned to a workspace until you choose one. Select with the `X-Matih-Workspace` header per request or `PUT /me/workspace`.

## Scopes

| Scope | Allows |
| --- | --- |
| `workspaces:read` | list workspaces |
| `members:read` | list members and pending invitations |
| `members:manage` | invite, change role, remove members, revoke invitations (admin role also required) |
| `sources:read` | list sources and their readiness, connectors |
| `sources:write` | test, add, activate, delete sources (admin role also required to add sources) |
| `files:read` | list files (`GET /files`), file detail (`GET /files/{id}`) |
| `files:write` | upload files (`POST /files`), resolve duplicates (`POST /files/{id}/duplicate`), delete files (`DELETE /files/{id}`) |
| `gems:read` | list and read gems and gem images |
| `gems:generate` | generate gems |
| `ask` | ask questions, conversations |
| `dashboards:read` | list dashboards and render images |
| `predict` | run predictions |
| `webhooks:manage` | create, list, test, delete webhooks and read deliveries |

Job polling (`GET /jobs/{id}`) is allowed for the credential that started the job. A missing scope returns 403 with category `scope`.

## Headers

| Header | Purpose |
| --- | --- |
| `Authorization` | required, `Bearer <credential>` |
| `X-Matih-Workspace` | workspace id for this request (OAuth tokens) |
| `Accept-Language` | response language, BCP-47 such as `hi-IN` |
| `Idempotency-Key` | on credit-costing POSTs; retries are not charged twice |
| `Accept: text/event-stream` | streaming answers from `POST /ask` |

## 401

A 401 carries a `WWW-Authenticate` header. For an API key: the key is wrong or revoked (keys do not expire by default), so ask the user for a fresh one. For OAuth: refresh the token once, and if that fails, restart the login. Do not retry a 401 in a loop.
