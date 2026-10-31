# Members and invitations

Admin territory. Read operations are safe; every write needs an explicit user request and, where destructive, a confirmation.

## Scopes

- `members:read`: list members and pending invitations.
- `members:manage`: invite, change roles, remove members, revoke invitations. The credential's owner must also hold an admin role in the workspace. Otherwise you get 403 `workspace_role`.

## Endpoints and tools

| Action | MCP tool | REST | Scope |
| --- | --- | --- | --- |
| List members | `list_members` | `GET /members` | `members:read` |
| Invite | `invite_member` | `POST /invitations` with `{"email": ..., "role": ...}` or `{"phone": ..., "role": ...}` | `members:manage` |
| List pending invitations | (REST only) | `GET /invitations` | `members:read` |
| Revoke an invitation | (REST only) | `DELETE /invitations/{id}` | `members:manage` |
| Change a role | (REST only) | `PATCH /members/{id}` with `{role}` | `members:manage` |
| Remove a member | (REST only) | `DELETE /members/{id}` | `members:manage` |

Invite with exactly one of `email` or `phone`. `role` must be one of the roles shown by `list_members` for the workspace. Do not invent role names; read them from existing members.

```bash
curl -s -H "Authorization: Bearer $MATIH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"email": "teammate@example.com", "role": "member"}' \
  https://workspace.matih.ai/api/v1/invitations
```

## Rules

- Only act when the user explicitly asks ("invite Priya as admin"). Never invite, promote or remove as a side effect of another task.
- Before a role change or removal, say who is affected and what changes, and get a yes. Before inviting, repeat the address or number and role back.
- Granting the admin role is a privilege escalation. State it plainly when confirming.
- Do not remove the last admin, and do not remove or demote yourself (the credential owner) unless the user clearly says so.
- Invitations may cost a seat. A 402 with category `member_cap` means the workspace is at its member limit; an admin has to raise the cap or free a seat.
- Treat emails and phone numbers as personal data. Show only what the user needs, and do not copy them into other tools.
- After a write, call `list_members` or `GET /invitations` to confirm the new state and report it.

## Errors

- 403 `workspace_role`: the caller is not an admin. Say so; do not retry.
- 403 `scope`: the credential lacks `members:read` or `members:manage`.
- 402 `member_cap`: no seats left.
- 404 or 4xx on an id: the member or invitation no longer exists. List again.

See `errors.md` for the full table.
