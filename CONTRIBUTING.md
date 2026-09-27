# Contributing

Thanks for helping improve the Obsidian Kanban agent hub. Read the [handover contract](docs/handover.md) and [code of conduct](CODE_OF_CONDUCT.md) before opening a change.

## Report a problem or suggest an improvement

Open a GitHub issue with the behavior you saw, expected behavior, steps to reproduce, and relevant version or client details. Remove tokens, private URLs, card contents, vault paths, and personal data from logs and screenshots. Do not put security reports with exploit details or live credentials in a public issue; contact the maintainer privately through a channel they list on the repository profile.

## Make a change

1. Fork and branch from the latest `main`.
2. Run `npm ci`, `npm run check`, and `python3 test/adapters-smoke.py`. Tests should use a temporary board, not a real vault.
3. Keep credentials out of code, docs, commits, and test fixtures. Include tests or a clear manual test plan for behavior changes.
4. Open a pull request describing the change, how you tested it, and any compatibility or security impact.

The maintained combined deployment uses `compose.hub.yaml` and `deploy.sh`; standalone examples live in the other Compose files. If you change configuration, update the README and example env files together. Claim semantics and the shared board lock are part of the public handover contract.

This project is available under the [MIT license](LICENSE). By contributing, you agree your contribution can be distributed under that license.
