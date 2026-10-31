# Workspaces

A workspace holds sources, gems, dashboards, members and credits. Everything you query is scoped to one workspace.

## List

MCP: `list_workspaces`. REST:

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" https://workspace.matih.ai/api/v1/workspaces
```

Response:

```json
{
  "current": "usr_3f9a",
  "workspaces": [
    {"id": "usr_3f9a", "name": "Acme Retail", "role": "admin", "kind": "email", "own": true}
  ],
  "invitations": []
}
```

`role` is the caller's role in that workspace (`viewer` < `user` < `admin` < `owner`). `kind` is how the workspace was made (`email` or `phone`), and `own` is true for the one the caller's own sign-up created. `invitations` lists open invitations addressed to a signed-in person; it is left out for a key.

## Switch

Two ways, use one:

1. Persistent default. MCP: `use_workspace` with `workspace_id`. REST: `PUT /me/workspace` with `{"workspace_id": "usr_71c0"}`. Later requests without a header use this workspace. It answers `{current, name}`.
2. Per request. Send `X-Matih-Workspace: usr_71c0`. Good for scripts that touch several workspaces without changing the user's default.

After switching, call `list_sources` again. Source ids differ per workspace and a `source_id` from the old workspace will fail with `source_access`.

## API keys cannot switch

An API key is pinned to the workspace it was created in. A different `X-Matih-Workspace` header is refused (403, category `workspace`), and `use_workspace` cannot move it. To work in another workspace the user must create a key there (`Settings › API & MCP`), or connect through OAuth.

## Members

Who is in the workspace and what role each has is covered in `members.md` (`list_members`, `GET /members`, needs `members:read`). Check your own `role` here first: many admin actions need the admin role.

## Guidance

- When the user says "in the Sales workspace", match by `name` case-insensitively. If more than one matches, ask.
- Tell the user which workspace you are now using after a switch.
- Prefer the per-request header over changing the default when the switch is temporary, so you do not surprise the user in their next session.
- If a request returns 403 with category `workspace_role`, the user lacks the role for that action in that workspace. Do not try another workspace to work around it.
