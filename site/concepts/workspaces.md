# Workspaces

A **workspace** holds data sources, files, Gems, dashboards, members and a pool of credits.
Everything you read or ask through the API happens inside exactly one workspace.

## Listing

```bash
curl -s https://workspace.matih.ai/api/v1/workspaces -H "Authorization: Bearer $MATIH_API_KEY"
```

```json
{
  "current": "ws_123",
  "workspaces": [
    {"id": "ws_123", "name": "Acme Retail", "role": "admin", "kind": "team"}
  ]
}
```

`role` is the role of the person the credential acts as. `kind` separates personal from team
workspaces. Needs `workspaces:read`.

## Which workspace does a request run in?

| Credential | Workspace |
|---|---|
| `mtk_` API key or MCP connector | **Pinned** to the workspace it was created in. A different `X-Matih-Workspace` header is refused. |
| `mto_` OAuth access token | The `X-Matih-Workspace` header on the request, else the person's current workspace (change it with `PUT /me/workspace`, or the `use_workspace` MCP tool). |

Source ids, file ids, Gem ids and dashboard ids all belong to one workspace. After switching, list
sources again: an id from the old workspace fails with `403` and category `source_access`.

## Roles

Members have a role (owner, admin, and lower roles; read the exact values from `GET /members`).
The role is checked on **every request**, not when a key is created. A credential never exceeds the
role of the member it acts as, and if that member is removed or demoted the credential loses
that power at once. Scopes only narrow what the role would allow. For example `members:manage`
still needs an admin member behind it.

See [Switch workspaces](../guides/switch-workspaces.md) and [Credentials and products](credentials.md).
