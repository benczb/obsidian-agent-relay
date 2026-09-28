# Design decisions

This is a public-facing summary of architectural choices, not a transcript or record of private infrastructure. Historical revisions of this file may still exist in Git history; review and scan history before making the repository public.

## Shared board and protocol

Use one Obsidian Kanban Markdown file as a shared instruction queue instead of exposing an agent or the whole vault through MCP. Clients write addressed cards; recipients list, claim, and complete them. Card fields `from`, `to`, and `thread` carry routing and conversation context. The board file stays legible in Obsidian.

## MCP and OAuth

Offer Streamable HTTP MCP for local clients. Keep its bearer-token listener private. Cloud MCP clients use a separate public HTTPS OAuth endpoint with owner consent, resource binding, and a redirect-host allowlist. The gateway and private MCP route share board logic, not tokens.

## REST adapter

Provide a REST facade for clients without an MCP transport. It shares the board implementation and lockfile with MCP and has its own revocable bearer token plus an OpenAPI spec. Claim and completion endpoints make handover explicit; moving a card is not a claim.

## Vault operations

The REST facade also supports vault-relative note and attachment operations. Paths reject traversal and symbolic links, and creates do not overwrite files. This is deliberately broader access than the board-scoped MCP server: the REST credential should be treated as a vault credential, not just a board credential.

## Commit history

Commit messages for this project follow the commit-with-prompts format, with sensitive information masked. This file documents decisions without retaining personal prompts, account links, hostnames, private paths, or full conversations.

## Planned agent rows (2026-09-28)

Prompt (verbatim): "Add Claude, WorkBuddy here". The accompanying image shows the README's "Agents that plug in" table.

Added Claude as a planned MCP route and Tencent WorkBuddy with route to be decided. Both are explicitly not connected, matching the intro's existing planned status. Names are text only: no third-party logo was added. The existing verification claims for other agents are unchanged.

## Separate board and notes (2026-09-28)

The board directory and notes vault were separated. The public-facing README now describes the architecture and leaves host-specific paths, private runtime overrides, backups and client test evidence to an operator runbook kept outside Git. Card identities and routes remain part of the handover contract, but names in a table do not assert live connections. These current-file edits do not remove earlier prompt logs or operational details from Git history; review and, if needed, rewrite history before making the repository public.

## Fix the public quick start (2026-09-28)

Prompt (verbatim): "asked claude to eval it to see what my obsidian setup can use.. just sharing one point it flagged fyi

Setup: it's broken as shipped. A file the instructions tell you to copy isn't in the repo, and the vault service crashes on startup (I tested it)."

Prompt (verbatim): "Feedback for the public repo"

Prompt (verbatim): "Fix it"

Decision: add sanitized, tracked deployment templates and correct the combined and standalone Compose wiring. MCP and REST now mount the same board directory, whose lockfile and atomic rename require a writable directory mount; REST alone mounts a separate notes vault and receives its required `OBSIDIAN_VAULT_PATH`. The README creates a fresh board without overwriting an existing file and includes health checks. The Python adapter smoke test now supplies a separate notes root and proves REST note writes as well as the board round trip. No host-specific values or runtime tokens are committed. Docker was unavailable in the test workspace: Node entry-point health, REST/MCP round trip, Compose static wiring and unit tests passed, but container startup remains for a Docker host to verify.

## Public usability audit (2026-09-28)

Prompt (verbatim): "Audit the repo for usability, missing files and make sure it works."

Decision: rechecked every copied file and relative Markdown link in a fresh checkout, the combined and alternative Compose manifests, and the documented local build/smoke commands. The standalone REST guide previously left out the env-file flag, linked to `../deploy.sh` from an instruction that said to run at the root, and named `openapi.yaml` without its `rest-facade/` prefix. Its systemd template still named an old checkout directory and omitted the env file. These are corrected. The standalone MCP example now mounts the board directory rather than treating the notes vault as the board. The OAuth overlay requires an explicit state path rather than silently creating one under the checkout. An obsolete comment claimed an absent setup script prints the REST URL; it is removed. The combined quick start now stops if board or runtime files already exist, instead of risking a rerun that overwrites them. No live host was changed. The audit used scratch configuration and real Node REST/MCP health and round-trip tests; Docker/Compose is unavailable here, so container startup cannot yet be claimed as tested.
