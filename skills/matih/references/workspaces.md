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
  "current": "ws_123",
  "workspaces": [
    {"id": "ws_123", "name": "Acme Retail", "role": "admin", "kind": "team"}
  ]
}
```

`role` is the caller's role in that workspace. `kind` distinguishes personal and team workspaces.

## Switch

Two ways, use one:

1. Persistent default. MCP: `use_workspace` with `workspace_id`. REST: `PUT /me/workspace` with `{"workspace_id": "ws_456"}`. Later requests without a header use this workspace.
2. Per request. Send `X-Matih-Workspace: ws_456`. Good for scripts that touch several workspaces without changing the user's default.

After switching, call `list_sources` again. Source ids differ per workspace and a `source_id` from the old workspace will fail with `source_access`.

## API keys cannot switch

An API key is pinned to the workspace it was created in. A different `X-Matih-Workspace` header is refused, and `use_workspace` cannot move it. To work in another workspace the user must create a key there (`Settings › API & MCP`), or connect through OAuth.

## Members

Who is in the workspace and what role each has is covered in `members.md` (`list_members`, `GET /members`, needs `members:read`). Check your own `role` here first: many admin actions need the admin role.

## Guidance

- When the user says "in the Sales workspace", match by `name` case-insensitively. If more than one matches, ask.
- Tell the user which workspace you are now using after a switch.
- Prefer the per-request header over changing the default when the switch is temporary, so you do not surprise the user in their next session.
- If a request returns 403 with category `workspace_role`, the user lacks the role for that action in that workspace. Do not try another workspace to work around it.
