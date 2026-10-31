# Contributing

Thanks for helping. This repository holds client-side code only; the API itself is not here.

- **Bugs and ideas:** open an issue. For a security problem, follow [SECURITY.md](SECURITY.md)
  instead.
- **Pull requests:** keep them small and focused. Add or update tests with the change. CI runs
  `pytest` and `ruff` for the Python SDK and the Slack bot, and `vitest` and `tsc` for the
  TypeScript SDK and the `<matih-embed>` package (`sdks/embed`), plus the embed examples; all must pass.
- **The spec is generated.** Do not edit `openapi/openapi.json`; it is synced from the server.
  If the spec is wrong, report it as an issue.
- **Keep both SDKs aligned.** A new method belongs in the Python and the TypeScript client
  with the same name and behaviour.
- **No secrets, no customer data.** Examples and tests use fake keys such as `mtk_test`.
- **Releases:** bump all package versions (`sdks/python/pyproject.toml`, `_version.py`, `sdks/typescript/package.json`, `version.ts`, `sdks/embed/package.json`) and the CHANGELOG, then push the tag `vX.Y.Z`. One tag publishes all three packages; each job refuses a tag that does not match its version.

By contributing you agree your work is licensed under Apache-2.0.
