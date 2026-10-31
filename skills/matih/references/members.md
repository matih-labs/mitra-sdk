# Members and invitations

Admin territory. Read operations are safe; every write needs an explicit user request and, where destructive, a confirmation.

## Scopes

- `members:read`: list members (viewer role) and pending invitations (admin role).
- `members:manage`: invite, change roles, remove members, revoke invitations. The credential's owner must also hold an admin role in the workspace; a scope only narrows, the role is checked first. Otherwise you get 403 `workspace_role`.

## Endpoints and tools

| Action | MCP tool | REST | Scope |
| --- | --- | --- | --- |
| List members | `list_members` | `GET /members` | `members:read` |
| Invite | `invite_member` | `POST /invitations` with `{"email": ..., "role": ...}` or `{"phone": ..., "role": ...}` | `members:manage` |
| List pending invitations | (REST only) | `GET /invitations` | `members:read` |
| Revoke an invitation | (REST only) | `DELETE /invitations/{id}` (returns `{revoked}`) | `members:manage` |
| Change a role | (REST only) | `PATCH /members/{id}` with `{"role": "viewer" \| "user" \| "admin"}` | `members:manage` |
| Remove a member | (REST only) | `DELETE /members/{id}` (returns `{removed}`) | `members:manage` |

Invite with exactly one of `email` or `phone` (with country code, for example `+919876543210`). `role` is `viewer`, `user` (the default) or `admin`; never `owner`, which is handed on in the app. The invited role cannot be higher than your own. Optional `whatsapp_only: true` invites a number to use Matih on WhatsApp only (not with admin). An email invitation is sent by Matih; a phone invitation returns `join_code`, `join_message` and `join_url` once, in that response only, for you to pass to the person. An invitation lapses after a while (`expires_at`). `GET /members` rows carry `can_change_role` and `can_remove`: check them before offering a change.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"email": "teammate@example.com", "role": "user"}' \
  https://workspace.matih.ai/api/v1/invitations
```

## Rules

- Only act when the user explicitly asks ("invite Priya as admin"). Never invite, promote or remove as a side effect of another task.
- Before a role change or removal, say who is affected and what changes, and get a yes. Before inviting, repeat the address or number and role back.
- Granting the admin role is a privilege escalation. State it plainly when confirming.
- Owners are made and removed in the app, not here: inviting as `owner`, making someone owner, or removing yourself is refused (400, category `workspace`).
- Do not demote the credential owner unless the user clearly says so.
- Revoking an invitation that was already accepted, declined or revoked answers 409.
- Treat emails and phone numbers as personal data. Show only what the user needs, and do not copy them into other tools.
- After a write, call `list_members` or `GET /invitations` to confirm the new state and report it.

## Errors

- 403 `workspace_role`: the caller is not an admin. Say so; do not retry.
- 403 `scope`: the credential lacks `members:read` or `members:manage`.
- 404 or 4xx on an id: the member or invitation no longer exists. List again.

See `errors.md` for the full table.
