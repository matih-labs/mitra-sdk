# Security

## Reporting a vulnerability

Email **security@matih.ai** with `[SECURITY]` in the subject. Please do not open a public
issue for a security problem.

## Credentials

Matih API keys are secrets. Keep them in environment variables or a secret manager, never in
source code, issues, or chat. This covers API keys and MCP connector keys (`mtk_`), OAuth
client secrets (`mts_`) and refresh tokens (`mtr_`), and webhook signing secrets (`whsec_`).

If a key is exposed, a workspace owner or admin should revoke it at once under
**Settings › API & MCP** in Matih and create a new one (or rotate it, which keeps the old key
alive for a short overlap you choose). A key stops working the moment it is revoked.
