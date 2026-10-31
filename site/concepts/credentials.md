# Credentials and products

Send a credential on every request:

```http
Authorization: Bearer <credential>
```

| Prefix | What it is | Accepted on | Workspace |
|---|---|---|---|
| `mtk_` | **API key** or **MCP connector** made by an owner or admin of a workspace | API key: all of `/api/v1`. MCP connector: `/api/v1/mcp` only. | Pinned |
| `mto_` / `mtr_` | OAuth 2.1 access / refresh token (authorization code with PKCE, dynamic client registration) | `/api/v1` | `X-Matih-Workspace`, else the person's current one |
| `mrt_` | Short-lived dashboard render token used internally | Not for you: it is minted by Matih for rendering a single dashboard | Pinned |

## API keys and MCP connectors

An owner or admin creates them under **Settings › API & MCP**.

- **Kind.** *API key* works on every `/api/v1` route the enabled products allow. *MCP connector*
  works only on `/api/v1/mcp` and is refused on REST routes, which makes it safer to hand to an AI client.
- **Products.** The admin switches products on or off per key. All are on by default.
- **Allow changes.** Products with writes have a switch. Off means read-only for that product.
- **Expiry.** None by default; choose a date if you want one.
- **Rotate and revoke** from the same page, which also shows last used and usage.
- **The secret is shown once.** Matih stores only a SHA-256 hash.

### Products and the scopes they grant

Admins never see raw scopes. Each product maps to scopes (see [Scopes](scopes.md)):

| Product | Read-only grants | "Allow changes" adds |
|---|---|---|
| Ask | `ask` | (asking is the product) |
| Data sources | `sources:read` | `sources:write` |
| Files | `files:read` | `files:write` |
| Predictive analytics | `predict` | |
| Dashboards | `dashboards:read` | |
| Gems | `gems:read` | `gems:generate` |
| Workspaces | `workspaces:read` | |
| Users & members | `members:read` | `members:manage` |
| Webhooks | | `webhooks:manage` |

!!! note
    The mapping of "Allow changes" to individual scopes is defined by the server. When in doubt,
    call the route you need and read the scope named in the `403`.

## The key acts as a person

An API key acts as the member who created it. On every request Matih re-resolves that member in
the workspace and checks their role again. So:

- The key can never do more than its creator could.
- Removing or demoting the creator changes the key's power immediately.
- `X-Matih-Workspace` cannot move a key to another workspace.

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
