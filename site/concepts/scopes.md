# Scopes

A scope is a permission a credential carries. Every `/api/v1` route declares the scope it needs, and a
build check fails for any route that declares none. A credential without the scope gets `403` with category
`scope` and nothing runs.

There are exactly 13 scopes.

| Scope | Endpoints that need it |
|---|---|
| `workspaces:read` | `GET /workspaces`, `PUT /me/workspace` (an API key is pinned: naming another workspace is `403` category `workspace`), `GET /jobs/{id}`, `POST /jobs/{id}/cancel` |
| `members:read` | `GET /members`, `GET /invitations` |
| `members:manage` | `POST /invitations`, `DELETE /invitations/{id}`, `PATCH /members/{id}`, `DELETE /members/{id}` |
| `sources:read` | `GET /connectors`, `GET /sources`, `GET /sources/{id}` |
| `sources:write` | `POST /sources/test`, `POST /sources`, `POST /sources/{id}/activate`, `DELETE /sources/{id}` |
| `files:read` | `GET /files`, `GET /files/{id}` |
| `files:write` | `POST /files`, `POST /files/{id}/duplicate`, `DELETE /files/{id}` |
| `gems:read` | `GET /gems`, `GET /gems/{id}`, `GET /gems/{id}/image.png` |
| `gems:generate` | `POST /gems/generate` (spends credits) |
| `ask` | `POST /ask`, `POST /ask/audio`, `GET /conversations`, `GET /conversations/{id}` (spends credits) |
| `dashboards:read` | `GET /dashboards`, `GET /dashboards/{id}`, `POST /dashboards/{id}/image`, `GET /dashboards/{id}/image.png` |
| `predict` | `POST /predictions` (spends credits) |
| `webhooks:manage` | `GET`/`POST /webhooks`, `DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries` |

`GET /media/{token}.png` needs no credential: the unguessable link is the credential.

## Rules

1. **Scopes only narrow.** The workspace role gate runs first, then the scope. A key with
   `members:manage` made by a non-admin still cannot invite anyone, and the key is refused with
   `403` category `workspace_role`.
2. **Admins pick Products, not scopes** when they make an API key or an MCP connector in
   **Settings › API & MCP**. Each Product stands for one or two scopes, and its *Allow changes* switch adds
   the write one. See [Credentials and Products](credentials.md#products-and-the-scopes-they-grant).
3. **Jobs.** `GET /jobs/{id}` and `POST /jobs/{id}/cancel` need `workspaces:read` **and** the scope of
   the job's kind (`ask` for `ask`, `gems:generate`, `predict`, `dashboards:read`). A job the credential
   has no scope for is a `404`, the same as one that does not exist.
4. **MCP.** `tools/list` only offers tools the credential may call. See [MCP tools](../mcp/tools.md).
5. **OAuth apps** ask for scopes by name on the consent screen. If an app names none it gets
   `workspaces:read sources:read gems:read dashboards:read ask`. Today `files:read` and `files:write`
   cannot be requested through OAuth; see [OAuth](../guides/oauth.md).

## Reading the error

```json
{"detail": {"category": "scope", "message": "This credential is not allowed to do that: it needs gems:generate."}}
```

The message names the missing scope. Fix it by switching the matching Product (and *Allow changes*
if it is a write scope) on for the key in **Settings › API & MCP**.
