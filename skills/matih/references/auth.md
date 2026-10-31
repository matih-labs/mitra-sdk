# Authentication

Every request carries `Authorization: Bearer <credential>`. There are two credential types: keys and OAuth tokens.

## API keys and MCP connector keys (`mtk_...`)

- Created by a workspace admin in Matih under `Settings › API & MCP`.
- Two kinds: an API key works on all of `/api/v1`; an MCP connector key works only on `/api/v1/mcp*` and is refused with 401 elsewhere. Use a connector key for MCP clients (an API key also works there).
- The admin chooses the products the key may use, all on by default: Ask, Data sources, Files, Predictive, Dashboards, Gems, Workspaces, Users & members, Webhooks. Each product left off removes its scopes, and those calls return 403 `scope`.
- Keys never expire by default (an admin can set 30 days, 90 days, 1 year or a date). Revoke or rotate them in the same screen. Rotating lets the old key run for an overlap (24 hours by default) so you can switch without a gap.
- Pinned to exactly one workspace. Sending an `X-Matih-Workspace` header for a different workspace is refused (403, category `workspace`).
- Act as the member who created the key and never exceed that member's role. The member is checked on every request: a key made by someone who has since been removed or demoted stops working. A scope only narrows; a key made by a `user` cannot do admin-only things even if it holds the scope.
- Store in an environment variable, for example `MATIH_API_KEY`. Never commit or echo it.

```bash
export MATIH_API_KEY=mtk_...
curl -s -H "Authorization: Bearer $MATIH_API_KEY" https://workspace.matih.ai/api/v1/workspaces
```

## OAuth 2.1 (`mto_...` access tokens)

- Authorization code flow with PKCE (`S256` only) and dynamic client registration (`POST /api/v1/oauth/register`). MCP clients (claude.ai, Claude Desktop, Cursor and others) discover and run this automatically. The person approves access on a consent screen that shows the scopes and a default-workspace picker; the token acts as that person.
- Discovery documents:
  - `https://workspace.matih.ai/.well-known/oauth-authorization-server`
  - `https://workspace.matih.ai/.well-known/oauth-protected-resource`
  - `https://workspace.matih.ai/.well-known/oauth-protected-resource/api/v1/mcp`
- Endpoints: `/api/v1/oauth/authorize`, `/api/v1/oauth/token`, `/api/v1/oauth/revoke`. Access tokens last 1 hour; refresh tokens (`mtr_...`) last 30 days sliding and the grant ends 90 days after consent.
- Refresh tokens rotate: each refresh returns a new refresh token and the old one stops working. Persist the newest one. Presenting an old, rotated one revokes the whole grant, so never retry a refresh without saving the answer. A refresh may narrow `scope`, never widen it.
- OAuth tokens are not pinned to a workspace. They use the default the person picked at consent; select another with the `X-Matih-Workspace` header per request or `PUT /me/workspace`.
- A person can disconnect an app under Settings, Connected apps; its tokens stop at once.

## Scopes

| Scope | Allows |
| --- | --- |
| `workspaces:read` | list workspaces |
| `members:read` | list members and invitations |
| `members:manage` | invite, change role, remove members, revoke invitations (admin role also required) |
| `sources:read` | list sources and their readiness, connectors |
| `sources:write` | test, add, activate, delete sources (admin role also required to test, add and delete) |
| `files:read` | list files (`GET /files`), file detail (`GET /files/{id}`) |
| `files:write` | upload files (`POST /files`), resolve duplicates (`POST /files/{id}/duplicate`), delete files (`DELETE /files/{id}`) |
| `gems:read` | list and read gems and gem images |
| `gems:generate` | generate gems |
| `ask` | ask questions (text and audio), read conversations |
| `dashboards:read` | list and read dashboards and render images |
| `predict` | run predictions |
| `webhooks:manage` | create, list, test, delete webhooks and read deliveries |

Polling and cancelling a job (`GET /jobs/{id}`, `POST /jobs/{id}/cancel`) needs `workspaces:read` plus the scope of the job's kind (`ask`, `gems:generate`, `predict` or `dashboards:read`); a job the credential has no scope for, or one that belongs to someone else, is a 404. A missing scope returns 403 with category `scope`. A scope only narrows: the member's workspace role is checked first.

## Headers

| Header | Purpose |
| --- | --- |
| `Authorization` | required, `Bearer <credential>` |
| `X-Matih-Workspace` | workspace id for this request (OAuth tokens; an API key accepts only its own workspace) |
| `Accept-Language` | response language, BCP-47 such as `hi-IN` |
| `Idempotency-Key` | on `POST /ask` and `POST /predictions` only; a retry answers once and is charged once |
| `Prefer` | `wait=N` or `respond-async` on the long operations; `Preference-Applied` in the reply says what was done |
| `Accept: text/event-stream` | streaming answers from `POST /ask` |

## 401

A 401 carries a `WWW-Authenticate: Bearer resource_metadata=...` header pointing at the OAuth discovery document. For an API key: the key is wrong or revoked (keys do not expire by default), so ask the user for a fresh one. For OAuth: refresh the token once, and if that fails, restart the login. Do not retry a 401 in a loop.
