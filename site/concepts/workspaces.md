# Workspaces

A **workspace** holds data sources, files, Gems, dashboards, members and a pool of credits.
Everything you read or ask through the API happens inside exactly one workspace.

## Listing

```bash
curl -s https://workspace.matih.ai/api/v1/workspaces -H "Authorization: Bearer $MATIH_API_KEY"
```

```json
{
  "current": "usr_3f9a",
  "workspaces": [
    {"id": "usr_3f9a", "name": "Acme", "role": "owner", "kind": "email", "own": true},
    {"id": "usr_71c0", "name": "Globex", "role": "viewer", "kind": "email", "own": false}
  ],
  "invitations": []
}
```

`role` is the role of the person the credential acts as in that workspace. `kind` is how the
workspace was made (`email` for a web sign-up, `phone`), and `own` is true for the workspace the
person's own sign-up created. `invitations` lists open invitations addressed to the person; it is
left out for an API key, which sees only the workspace it is pinned to. Needs `workspaces:read`.

## Which workspace does a request run in?

| Credential | Workspace |
|---|---|
| `mtk_` API key or MCP connector | **Pinned** to the workspace it was created in. A different `X-Matih-Workspace` header is refused. |
| `mto_` OAuth access token | The `X-Matih-Workspace` header on the request, else the person's current workspace (change it with `PUT /me/workspace`, or the `use_workspace` MCP tool). |

Source ids, file ids, Gem ids and dashboard ids all belong to one workspace. After switching, list
sources again: an id from the old workspace fails with `403` and category `source_access`.

## Roles

Members have one of four roles, from most to least powerful: `owner`, `admin`, `user`, `viewer`
(an invitation can give `admin`, `user` or `viewer`).
The role is checked on **every request**, not when a key is created. A credential never exceeds the
role of the member it acts as, and if that member is removed or demoted the credential loses
that power at once. Scopes only narrow what the role would allow. For example `members:manage`
still needs an admin member behind it.

See [Switch workspaces](../guides/switch-workspaces.md) and [Credentials and products](credentials.md).
