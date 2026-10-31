# Security

How to hold a Matih credential safely, and how to report a problem.

## Report a vulnerability

Email **[security@matih.ai](mailto:security@matih.ai)** with `[SECURITY]` in the subject. Please do not open a public
issue or discussion for a security problem.

## Key handling

!!! warning "An `mtk_` key acts as the person who created it"
    Whoever holds the key can do what that member can do in that workspace, within the products you switched on.

- **Server side only.** Never put a key in a browser bundle, a mobile app, a public repository, an issue or a chat.
- **Environment or secret store.** Read it from an environment variable (`MATIH_API_KEY`) or a secret manager.
  Do not log it. Do not put it in a committed `.mcp.json` or `.env`.
- **Least privilege.** Create one key per integration. Switch on only the products it needs and leave
  **Allow changes** off unless it must write. An **MCP connector** key works only on `/api/v1/mcp`: use that kind for AI clients.
- **One workspace.** A key is pinned to one workspace and a different `X-Matih-Workspace` is refused.
- **Secrets are shown once.** Matih stores only a SHA-256 hash. If you lost the key, rotate it.
- **Image links are bearer links.** A signed `/api/v1/media/{token}.png` URL needs no header and works for 15 minutes.
  Do not post it anywhere that outlives that, and do not treat it as private beyond that.

## Rotation

1. In **Settings › API & MCP** rotate the key (or create a second one).
2. Deploy the new value to your secret store and restart the service.
3. Check **last used** on the old key falls silent, then revoke it.

Rotate on a schedule that fits your policy, whenever someone who knew the key leaves, and at once after any exposure.

## Revocation

An owner or admin can revoke a key at any time on the same page, and it stops working on the next request. Removing
or demoting the member who created a key also takes effect at once, because the member's role is checked on every
request. Matih staff can revoke a key too.

If a key leaks:

1. Revoke it in **Settings › API & MCP**.
2. Create a new one and deploy it.
3. Read the key's usage on that page for calls you do not recognise, and email security@matih.ai if you find any.

## Webhooks

- **Verify every delivery.** Compute `HMAC-SHA256(secret, "{t}.{raw body}")`, compare with `v1` in constant time,
  and refuse a timestamp more than five minutes old. Use the **raw bytes** of the body. See
  [Webhooks](guides/webhooks.md).
- Keep the `whsec_` secret like an API key. It is shown once when you create the webhook.
- Webhook URLs must be public `https` addresses. Matih refuses private, loopback, link-local and metadata addresses,
  and checks again on every delivery.
- Payloads carry ids and summary fields, never rows of your data. Fetch details with your key.
- De-duplicate by event `id`; retries reuse it.

## OAuth tokens

Store access and refresh tokens encrypted at rest, one pair per user. Refresh tokens rotate, so persist the newest
immediately. See [OAuth for multi-user apps](guides/oauth.md).

## What Matih does on its side

- Every request is attributed to a key and a member, with a 90-day request log (request id, key, IP, user agent) that
  staff can use to investigate.
- A credential never exceeds the role of the member it acts as. Scopes only narrow.
- Support staff viewing a customer's workspace cannot use the API or MCP as that customer.

## Building a bot safely

- Anyone in the channel where your bot answers can ask questions of the workspace's data. Add the bot only to channels
  whose members may see that data, or use [OAuth](guides/oauth.md) so each person sees only their own.
- Treat user-supplied text as untrusted when you pass it on to other systems.
- Never echo error bodies that might contain request details to end users. Show `message` and `request_id`.
