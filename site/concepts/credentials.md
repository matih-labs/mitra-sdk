# Credentials and products

Send a credential on every request:

```http
Authorization: Bearer <credential>
```

| Prefix | What it is | Accepted on | Workspace |
|---|---|---|---|
| `mtk_` | **API key** or **MCP connector** made by an owner or admin of a workspace | API key: all of `/api/v1`. MCP connector: `/api/v1/mcp` only. | Pinned |
| `mto_` / `mtr_` | OAuth 2.1 access / refresh token (authorization code with PKCE, dynamic client registration) | `/api/v1` | `X-Matih-Workspace`, else the workspace picked on the consent screen, else the person's current one |
| `mrt_` | Short-lived dashboard render token used internally | Not for you: it is minted by Matih for rendering a single dashboard | Pinned |

## API keys and MCP connectors

An owner or admin creates them under **Settings › API & MCP**.

- **Kind.** Both kinds are `mtk_` secrets; the kind decides where it works. An *API key* works on
  every `/api/v1` route its products allow, the MCP endpoint included. An *MCP connector* works only on
  `/api/v1/mcp*` and is refused with `401` on REST routes, which makes it safer to hand to an AI client.
  Neither works on Matih's own app API, so a leaked key cannot mint another.
- **Products.** The admin switches products on or off per key, never raw scopes. All are on to start.
- **Allow changes.** Products with a write side have a switch (also on to start). Off means the read
  scopes only for that product.
- **Expiry.** Never (the default), 30 days, 90 days, 1 year, or a date. A date in the past or more than ten
  years out is refused.
- **Rotate.** Makes a new key for the same integration and lets the old one keep working for an
  overlap (24 hours by default, 0 to 720) so you can switch software without a gap. Rotating again never
  extends the old key's life.
- **Revoke** one key, or remove the whole integration: it stops at once. Revoked and expired keys stay in
  the list, marked. The page shows status (Active, Expired, Revoked), last used and usage.
- **The secret is shown once**, in the answer to the call that makes it. Matih stores only a SHA-256 hash,
  and the list shows just the first 12 characters to tell keys apart.

### Products and the scopes they grant

Admins never see raw scopes. Each product maps to scopes (see [Scopes](scopes.md)):

| Product | Always grants | "Allow changes" adds |
|---|---|---|
| Ask agent | `ask` | |
| Data sources | `sources:read` | `sources:write` |
| Files | `files:read` | `files:write` |
| Predictive analytics | `predict` | |
| Dashboards | `dashboards:read` | |
| Gems | `gems:read` | `gems:generate` |
| Workspaces | `workspaces:read` | |
| Users & members | `members:read` | `members:manage` |
| Webhooks | `webhooks:manage` | |

Ask agent, Predictive analytics, Dashboards, Workspaces and Webhooks have no read/write split, so they
have no *Allow changes* switch. The same list is served to the Settings page by the app, so a product is
never described two ways.

## The key acts as a person

An API key acts as the member who created it, in the workspace it was made in, and has no role of
its own. On every request Matih re-resolves that member and checks their role again. So:

- The key can never do more than its creator could. A scope only narrows.
- Removing the creator from the workspace (`403`), or demoting them below what the key's scopes need
  (`403`, category `workspace_role`), stops the key on its next call, with nothing to revoke by hand.
- `X-Matih-Workspace` cannot move a key to another workspace: a different one is `403`, category
  `workspace`. It is never silently ignored.
- A staff member's key never carries the staff role.

A `401` under `/api/v1` carries `WWW-Authenticate: Bearer resource_metadata="https://workspace.matih.ai/.well-known/oauth-protected-resource"`
so a client can discover how to authenticate.

## OAuth tokens

For an app that acts for **each of its users** rather than for one shared identity, use OAuth 2.1:
authorization code with PKCE, with dynamic client registration (DCR) so your app can register
itself. Access tokens (`mto_`) act as the person who approved, and are accepted on `/api/v1` only.

| | Prefix | Life |
|---|---|---|
| Access token | `mto_` | 1 hour, never past the grant |
| Refresh token | `mtr_` | 30 days sliding; the grant ends 90 days after the person consented |

Refresh tokens rotate: each refresh returns a new one and kills the old one, and presenting an old one again
revokes the whole grant. People see and disconnect the apps they approved under **Connected apps** in Matih's
settings, and admins see the apps acting in their workspace on **Settings › API & MCP**.
See [OAuth for multi-user apps](../guides/oauth.md).

## Which should I use?

| You are building | Use |
|---|---|
| A server-side bot, cron job or integration for one workspace | API key |
| An AI client (Claude, Cursor, VS Code) | MCP connector key, or OAuth sign-in |
| A product where each user connects their own Matih account | OAuth |
| A script that touches several workspaces | OAuth, with `X-Matih-Workspace` |

!!! warning "Never ship an `mtk_` key to a browser or a mobile app"
    Anyone who can read the key can act as its creator. Call Matih from your server and let
    your clients talk to your server. See [Security](../security.md).
