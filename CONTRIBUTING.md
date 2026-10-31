# Contributing

Thanks for helping. This repository holds client-side code only; the API itself is not here.

- **Bugs and ideas:** open an issue. For a security problem, follow [SECURITY.md](SECURITY.md)
  instead.
- **Pull requests:** keep them small and focused. Add or update tests with the change. CI runs
  `pytest` and `ruff` for the Python SDK and the Slack bot, and `vitest` and `tsc` for the
  TypeScript SDK; all must pass.
- **The spec is generated.** Do not edit `openapi/openapi.json`; it is synced from the server.
  If the spec is wrong, report it as an issue.
- **Keep both SDKs aligned.** A new method belongs in the Python and the TypeScript client
  with the same name and behaviour.
- **No secrets, no customer data.** Examples and tests use fake keys such as `mtk_test`.
- **Releases:** tag `py-vX.Y.Z` or `ts-vX.Y.Z` after bumping the version and CHANGELOG.

By contributing you agree your work is licensed under Apache-2.0.
